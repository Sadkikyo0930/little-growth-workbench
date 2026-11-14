-- ============================================================================
-- 20261114_fragment_scope_guard.sql
-- 给**旧三个碎片函数**加「调用者范围校验」—— **未执行**，需单独批准
--
-- 为什么必须有这一层
--   20261114_fragment_member_scope.sql 只是新增了两个安全封装，它**不会**
--   让旧函数变安全：旧函数依旧对 anon 可执行、参数里依旧有 p_family。
--   只要有人拿着站点里的 anon key 直接 POST /rest/v1/rpc/r5_fragment_snapshot
--   并传 {"p_family":"别人家"},依然能读到别人家。本文件就是把这条路关掉。
--
-- 封堵方式：不改信任模型，只在函数入口加一次「你凭什么碰这个 family」的判断
--   public.r5_fragment_scope_ok(p_family, p_device) 为真才继续：
--     ① 特权角色（云函数 / 迁移 / 平台角色）→ 放行
--        理由：r5-racing-save 与 r5-gateway 都是用服务端身份连库，
--        family 由它们自己从设备绑定表反查，本来就不采信客户端字段。
--     ② 有 JWT 的登录用户 → 必须是 p_family 的 owner / parent / grandparent
--        理由：成员表是唯一事实来源，一个账号只归属一个家庭。
--     ③ 匿名调用 → 必须持有**已绑定到该 family 且未撤销**的设备令牌（p_device）
--        理由：这正是赛车游戏现有的信任模型（r5_device.device_uid），
--        所以赛车那条路一行代码都不用改、也不需要换密钥。
--
-- 与赛车网关的兼容性
--   · 网关 /racing/fragment/claim|assemble 把 r5_identity.device 原样递给云函数，
--     云函数再作为 p_device 传给本函数 —— 与 r5_device.device_uid 同一套值
--     （线上事件表 device 列里就是 r5dev_… / r5-demo-device-0001 这类 UID）。
--   · 云函数是特权连接，走①；即使哪天改成低权限连接，只要 p_device 照传，走③也仍然通。
--   · 因此**不需要**改网关、不需要改云函数、不需要重新绑定任何设备。
--
-- 为什么没有直接 REVOKE anon
--   REVOKE anon 是最省事的写法，但它同时会掐死「设备令牌直连」这条老路，
--   而我没有拿到「云函数一定用 service_role 连库」的运行时证据，
--   贸然收回可能让孩子的赛车在线上直接 403。所以本轮选择「保留 EXECUTE + 入口校验」：
--   行为等价于收紧，但不会因为身份没对上而误伤。等拿到云函数连接身份的确认
--   （见文末第 5 节的自检 SQL）后，再决定是否补一刀 REVOKE。
--
-- 实现细节
--   旧函数内部互相调用 r5_fragment_snapshot(p_family) 的地方，改成调用
--   r5_fragment_snapshot_internal(p_family)（无守卫、只对特权角色开放），
--   否则「组装成功后返回快照」会被自己的守卫再拦一次。
--
-- 回滚：把三个函数按 pg_get_functiondef 的原始定义重建即可（本文件第 6 节附原文备份方式）。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. 范围判断（唯一的判定入口，三个函数共用）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_scope_ok(p_family text, p_device text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_claims jsonb;
  v_role   text;
  v_uid    text;
  v_dev    text;
BEGIN
  IF p_family IS NULL OR p_family = '' THEN
    RETURN false;
  END IF;

  v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;

  -- ① 没有 JWT claims：不是从 PostgREST 进来的（云函数直连 / 迁移 / psql）→ 特权，放行。
  --    这也是 r5-racing-save 的实际情况：它用服务端凭据连库，family 由自己反查。
  IF v_claims IS NULL OR v_claims = '{}'::jsonb THEN
    RETURN true;
  END IF;

  v_role := v_claims ->> 'role';
  IF v_role = 'service_role' THEN
    RETURN true;                                   -- 服务端密钥，等价于特权
  END IF;

  -- ② 登录用户：必须是这个家庭的家长成员
  v_uid := NULLIF(v_claims ->> 'sub', '');
  IF v_uid IS NOT NULL THEN
    RETURN EXISTS (
      SELECT 1 FROM public.growth_family_members m
       WHERE m.user_id = v_uid
         AND m.family_id = p_family
         AND m.member_role IN ('owner', 'parent', 'grandparent')
    );
  END IF;

  -- ③ 匿名（含「authenticated 但没有 sub」这种畸形令牌）：只能靠设备令牌
  v_dev := NULLIF(p_device, '');
  IF v_dev IS NULL OR v_dev !~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.r5_device d
     WHERE d.device_uid = v_dev
       AND d.family_id  = p_family
       AND d.revoked_at IS NULL
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.r5_fragment_scope_ok(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_fragment_scope_ok(text, text) TO anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. 无守卫的内部快照（只给特权角色与上面两个函数用）
--    函数体与线上 r5_fragment_snapshot 完全一致，只改了名字。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_snapshot_internal(p_family text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'fragments', COALESCE((
      SELECT jsonb_object_agg(t.k, t.q) FROM (
        SELECT x.payload->>'item_id' AS k, GREATEST(0, sum((x.payload->>'quantity_delta')::bigint)) AS q
        FROM public.r5_racing_events x
        WHERE x.family_id = p_family AND x.kind = 'fragment_change'
          AND x.payload ? 'item_id' AND x.payload ? 'quantity_delta'
        GROUP BY 1
      ) t), '{}'::jsonb),
    'owned', COALESCE((SELECT s.owned FROM public.r5_racing_saves s WHERE s.family_id = p_family), '{}'::jsonb),
    'revision', COALESCE((SELECT s.revision FROM public.r5_racing_saves s WHERE s.family_id = p_family), 0),
    'pity_points', COALESCE((SELECT st.pity_points FROM public.r5_fragment_state st WHERE st.family_id = p_family), 0),
    'pity_total', COALESCE((SELECT st.pity_total FROM public.r5_fragment_state st WHERE st.family_id = p_family), 0),
    'daily_day', COALESCE((SELECT st.daily_day::text FROM public.r5_fragment_state st WHERE st.family_id = p_family), ''),
    'daily_normal_count', COALESCE((SELECT st.daily_normal_count FROM public.r5_fragment_state st WHERE st.family_id = p_family), 0),
    'daily_rare_count', COALESCE((SELECT st.daily_rare_count FROM public.r5_fragment_state st WHERE st.family_id = p_family), 0),
    'drops_total', COALESCE((SELECT count(*) FROM public.r5_fragment_drops d WHERE d.family_id = p_family), 0)
  );
$function$;

-- 内部版不直接对外开放：只有特权角色（以及 SECURITY DEFINER 的调用方）能用
REVOKE ALL ON FUNCTION public.r5_fragment_snapshot_internal(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.r5_fragment_snapshot_internal(text) FROM anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. 带守卫的对外快照（签名不变，老调用方无需改）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_snapshot(p_family text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.r5_fragment_scope_ok(p_family, NULL) THEN
    RETURN jsonb_build_object('status', 'FORBIDDEN_SCOPE', 'zero_write', true);
  END IF;
  RETURN public.r5_fragment_snapshot_internal(p_family);
END;
$function$;

-- 权限保持原样（anon 仍可执行，但都会被 r5_fragment_scope_ok 拦掉）


-- ---------------------------------------------------------------------------
-- 4. 带守卫的领取（函数体除「入口守卫 + 内部快照改名」外与线上一致）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_claim(p_family text, p_device text, p_record_id text, p_cfg jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_day date := COALESCE((p_cfg->>'record_day')::date, (now() AT TIME ZONE 'Asia/Shanghai')::date);
  v_cap int := GREATEST(1, COALESCE((p_cfg->>'daily_cap')::int, 2));
  v_pity_target int := GREATEST(2, COALESCE((p_cfg->>'pity_target')::int, 5));
  v_frag text := NULLIF(p_cfg->>'fragment_id', '');
  v_rare_frag text := NULLIF(p_cfg->>'rare_fragment_id', '');
  v_want_rare boolean := COALESCE((p_cfg->>'rare')::boolean, false);
  v_pity_exempt boolean := COALESCE((p_cfg->>'pity_exempt')::boolean, false);
  v_want text := CASE WHEN p_cfg->>'want' = 'drop' THEN 'drop' ELSE 'none' END;
  v_kind text := COALESCE(p_cfg->>'record_kind', '');
  v_subject text := COALESCE(p_cfg->>'subject', '');
  v_prev public.r5_fragment_drops;
  v_state public.r5_fragment_state;
  v_pity int; v_daily int; v_daily_rare int; v_capped boolean;
  v_outcome text; v_count int := 0; v_rare_count int := 0; v_pity_after int;
  v_daily_index int := 0; v_rev bigint;
BEGIN
  -- ▼ 新增：调用者范围校验（在任何读写之前）
  IF NOT public.r5_fragment_scope_ok(p_family, p_device) THEN
    RETURN jsonb_build_object('status','FORBIDDEN_SCOPE','zero_write',true);
  END IF;
  -- ▲ 新增结束

  IF p_family IS NULL OR p_family = '' THEN RETURN jsonb_build_object('status','BAD_FAMILY'); END IF;
  IF p_record_id IS NULL OR p_record_id = '' OR length(p_record_id) > 160 THEN RETURN jsonb_build_object('status','BAD_RECORD_ID'); END IF;

  SELECT * INTO v_prev FROM public.r5_fragment_drops d WHERE d.family_id = p_family AND d.source_record_id = p_record_id;
  IF FOUND THEN
    RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object('status','ALREADY_CLAIMED','outcome',v_prev.outcome,'granted_normal',v_prev.fragment_count,'granted_rare',v_prev.rare_count,'fragment_id',v_prev.fragment_id,'rare_fragment_id',v_prev.rare_fragment_id,'pity_points',COALESCE((SELECT pity_points FROM public.r5_fragment_state WHERE family_id = p_family),0),'claimed_at',v_prev.created_at,'zero_write',true);
  END IF;

  SELECT s.revision INTO v_rev FROM public.r5_racing_saves s WHERE s.family_id = p_family FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','SAVE_NOT_INITIALIZED','zero_write',true); END IF;

  INSERT INTO public.r5_fragment_state (family_id) VALUES (p_family) ON CONFLICT (family_id) DO NOTHING;
  SELECT * INTO v_state FROM public.r5_fragment_state st WHERE st.family_id = p_family FOR UPDATE;

  IF v_state.daily_day = v_day THEN
    v_pity := v_state.pity_points; v_daily := v_state.daily_normal_count; v_daily_rare := v_state.daily_rare_count;
  ELSE
    v_pity := v_state.pity_points; v_daily := 0; v_daily_rare := 0;
  END IF;

  v_capped := v_daily >= v_cap;
  IF v_capped THEN v_outcome := 'capped';
  ELSIF v_want = 'none' THEN v_outcome := 'none';
  ELSE v_outcome := 'drop'; END IF;

  IF v_outcome = 'drop' THEN
    v_count := 1; v_daily_index := v_daily + 1; v_pity_after := 0;
  ELSIF v_outcome = 'none' THEN
    IF v_pity_exempt THEN
      v_pity_after := v_pity;
    ELSE
      v_pity_after := v_pity + 1;
      IF v_pity_after >= v_pity_target THEN
        v_outcome := 'pity'; v_count := 1; v_daily_index := v_daily + 1; v_pity_after := 0;
      END IF;
    END IF;
  ELSE
    v_pity_after := v_pity;
  END IF;

  IF v_want_rare AND v_rare_frag IS NOT NULL AND v_daily_rare < 1 THEN
    v_rare_count := 1;
  END IF;

  INSERT INTO public.r5_fragment_drops (family_id, source_record_id, record_day, record_kind, subject, outcome, fragment_id, fragment_count, rare_fragment_id, rare_count, pity_before, pity_after, daily_index, device)
  VALUES (p_family, p_record_id, v_day, v_kind, v_subject, v_outcome,
    CASE WHEN v_count > 0 THEN v_frag ELSE NULL END, v_count,
    CASE WHEN v_rare_count > 0 THEN v_rare_frag ELSE NULL END, v_rare_count,
    v_pity, v_pity_after, v_daily_index, COALESCE(p_device, ''))
  ON CONFLICT (family_id, source_record_id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT * INTO v_prev FROM public.r5_fragment_drops d WHERE d.family_id = p_family AND d.source_record_id = p_record_id;
    RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object('status','ALREADY_CLAIMED','outcome',v_prev.outcome,'granted_normal',v_prev.fragment_count,'granted_rare',v_prev.rare_count,'zero_write',true);
  END IF;

  IF v_count > 0 AND v_frag IS NOT NULL THEN
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'frag:' || p_record_id, 'fragment_change', 0,
      jsonb_build_object('item_id', v_frag, 'quantity_delta', v_count, 'source', 'study', 'record_id', p_record_id, 'record_kind', v_kind, 'subject', v_subject, 'record_day', v_day::text, 'outcome', v_outcome, 'pity_after', v_pity_after),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END IF;

  IF v_rare_count > 0 AND v_rare_frag IS NOT NULL THEN
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'frag:' || p_record_id || ':rare', 'fragment_change', 0,
      jsonb_build_object('item_id', v_rare_frag, 'quantity_delta', v_rare_count, 'source', 'study-rare', 'record_id', p_record_id, 'record_kind', v_kind, 'subject', v_subject, 'record_day', v_day::text),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END IF;

  UPDATE public.r5_fragment_state st
     SET pity_points = v_pity_after,
         pity_total = st.pity_total + CASE WHEN v_outcome = 'pity' THEN 1 ELSE 0 END,
         daily_day = v_day,
         daily_normal_count = v_daily + v_count,
         daily_rare_count = v_daily_rare + v_rare_count,
         updated_at = now()
   WHERE st.family_id = p_family;

  UPDATE public.r5_racing_saves s
     SET revision = s.revision + 1, updated_at = now(), updated_by_device = COALESCE(p_device, '')
   WHERE s.family_id = p_family;

  RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object('status','CLAIMED','outcome',v_outcome,'granted_normal',v_count,'granted_rare',v_rare_count,'fragment_id',CASE WHEN v_count > 0 THEN v_frag ELSE NULL END,'rare_fragment_id',CASE WHEN v_rare_count > 0 THEN v_rare_frag ELSE NULL END,'pity_points',v_pity_after,'pity_before',v_pity,'daily_normal_count',v_daily + v_count,'daily_rare_count',v_daily_rare + v_rare_count,'daily_index',v_daily_index,'record_day',v_day::text,'zero_write',false);
END;
$function$;


-- ---------------------------------------------------------------------------
-- 5. 带守卫的组装
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_assemble(p_family text, p_device text, p_vehicle_id text, p_cost jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owned jsonb; v_rev bigint; v_bal jsonb; v_deficit jsonb := '{}'::jsonb;
  v_k text; v_q int; v_have bigint; v_n int := 0; v_cost_ok boolean;
BEGIN
  -- ▼ 新增：调用者范围校验（在任何读写之前）
  IF NOT public.r5_fragment_scope_ok(p_family, p_device) THEN
    RETURN jsonb_build_object('status','FORBIDDEN_SCOPE','zero_write',true);
  END IF;
  -- ▲ 新增结束

  -- 车辆 ID：小写字母开头，允许数字 / 短横线 / 下划线（占位车带下划线）
  IF p_vehicle_id IS NULL OR p_vehicle_id !~ '^[a-z0-9][a-z0-9_-]{1,40}$' THEN
    RETURN jsonb_build_object('status','BAD_VEHICLE_ID','zero_write',true);
  END IF;

  -- 生日 / 限定车：永久隔离
  IF p_vehicle_id IN ('birthday-star-6','six-star-supercar-2026')
     OR p_vehicle_id LIKE 'pink-newyear%' OR p_vehicle_id LIKE 'pink-new-year%' THEN
    RETURN jsonb_build_object('status','BIRTHDAY_VEHICLE_FORBIDDEN','zero_write',true);
  END IF;

  -- 既有取得方式的车辆：金币购买 / 剧情解锁。碎片系统不得提供第二条路径
  IF p_vehicle_id IN ('moto','turtle') THEN
    RETURN jsonb_build_object('status','COIN_VEHICLE_FORBIDDEN','zero_write',true);
  END IF;

  -- v1 遗留槽位已冻结
  IF p_vehicle_id = 'scholar' THEN
    RETURN jsonb_build_object('status','LEGACY_SLOT_RETIRED','zero_write',true);
  END IF;

  -- 成本：非空对象，键必须是 frag_*，值必须是 1..200 的整数，条目数 1..4。
  IF p_cost IS NULL OR jsonb_typeof(p_cost) <> 'object' OR p_cost = '{}'::jsonb THEN
    RETURN jsonb_build_object('status','BAD_COST','zero_write',true);
  END IF;
  SELECT bool_and(c.k ~ '^frag_[a-z0-9_]{1,40}$' AND c.v ~ '^[0-9]{1,3}$'), count(*)
    INTO v_cost_ok, v_n
    FROM jsonb_each_text(p_cost) AS c(k, v);
  IF NOT COALESCE(v_cost_ok, false) OR v_n < 1 OR v_n > 4 THEN
    RETURN jsonb_build_object('status','BAD_COST','zero_write',true);
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(p_cost) AS c(k, v) WHERE c.v::int < 1 OR c.v::int > 200) THEN
    RETURN jsonb_build_object('status','BAD_COST','zero_write',true);
  END IF;

  SELECT s.owned, s.revision INTO v_owned, v_rev FROM public.r5_racing_saves s
   WHERE s.family_id = p_family FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','SAVE_NOT_INITIALIZED','zero_write',true); END IF;

  IF v_owned ? p_vehicle_id THEN
    RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object('status','ALREADY_OWNED','vehicle_id',p_vehicle_id,'zero_write',true);
  END IF;

  IF EXISTS (SELECT 1 FROM public.r5_racing_events e WHERE e.family_id = p_family AND e.event_id = 'asm:' || p_vehicle_id) THEN
    RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object('status','ALREADY_ASSEMBLED','vehicle_id',p_vehicle_id,'zero_write',true);
  END IF;

  SELECT COALESCE(jsonb_object_agg(t.k, t.q), '{}'::jsonb) INTO v_bal FROM (
    SELECT x.payload->>'item_id' AS k, GREATEST(0, sum((x.payload->>'quantity_delta')::bigint)) AS q
    FROM public.r5_racing_events x
    WHERE x.family_id = p_family AND x.kind = 'fragment_change'
      AND x.payload ? 'item_id' AND x.payload ? 'quantity_delta'
    GROUP BY 1
  ) t;

  FOR v_k, v_q IN SELECT key, (value)::int FROM jsonb_each_text(p_cost) LOOP
    v_have := COALESCE((v_bal->>v_k)::bigint, 0);
    IF v_have < v_q THEN
      v_deficit := v_deficit || jsonb_build_object(v_k, v_q - v_have);
    END IF;
  END LOOP;

  IF v_deficit <> '{}'::jsonb THEN
    RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object('status','INSUFFICIENT_FRAGMENTS','vehicle_id',p_vehicle_id,'required',p_cost,'deficit',v_deficit,'zero_write',true);
  END IF;

  FOR v_k, v_q IN SELECT key, (value)::int FROM jsonb_each_text(p_cost) LOOP
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'asm:' || p_vehicle_id || ':' || v_k, 'fragment_change', 0,
      jsonb_build_object('item_id', v_k, 'quantity_delta', -v_q, 'source', 'assemble', 'vehicle_id', p_vehicle_id),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END LOOP;

  INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
  VALUES (p_family, 'asm:' || p_vehicle_id, 'grant', 0,
    jsonb_build_object('vehicle_id', p_vehicle_id, 'source', 'fragment-assembly', 'cost', p_cost),
    COALESCE(p_device, ''), now(), NULL)
  ON CONFLICT (family_id, event_id) DO NOTHING;

  UPDATE public.r5_racing_saves s
     SET owned = COALESCE(s.owned, '{}'::jsonb) || jsonb_build_object(p_vehicle_id, jsonb_build_object('at', (extract(epoch from now())*1000)::bigint, 'source', 'fragment-assembly', 'note', '碎片组装')),
         revision = s.revision + 1, updated_at = now(), updated_by_device = COALESCE(p_device, '')
   WHERE s.family_id = p_family;

  RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object('status','ASSEMBLED','vehicle_id',p_vehicle_id,'cost',p_cost,'zero_write',false);
END;
$function$;


-- ---------------------------------------------------------------------------
-- 6. 可选（需**再次**单独批准）：把两张「无 RLS、且 authenticated 可写」的表收紧
--    现状：public.r5_fragment_state / public.r5_fragment_drops
--          · RLS 未开启
--          · anon 有 SELECT，authenticated 有 arwdDxtm（含 INSERT/UPDATE/DELETE）
--    风险：登录家长可以直接 POST /rest/v1/r5_fragment_drops 删除自己家的一行，
--          再用同一条学习记录重新领取 —— 事件表里就会出现第二条发放记录。
--    为什么不在本轮直接执行：涉及正式库表权限，且要确认网关/云函数不是以
--    authenticated 身份读写这两张表（当前证据显示它们是服务端身份）。
--
--  ALTER TABLE public.r5_fragment_state ENABLE ROW LEVEL SECURITY;
--  ALTER TABLE public.r5_fragment_drops ENABLE ROW LEVEL SECURITY;
--  REVOKE ALL ON public.r5_fragment_state FROM anon;
--  REVOKE ALL ON public.r5_fragment_drops FROM anon;
--  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.r5_fragment_state FROM authenticated;
--  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.r5_fragment_drops FROM authenticated;
--  -- 回滚：
--  -- ALTER TABLE public.r5_fragment_state DISABLE ROW LEVEL SECURITY;
--  -- ALTER TABLE public.r5_fragment_drops DISABLE ROW LEVEL SECURITY;
--  -- GRANT SELECT ON public.r5_fragment_state, public.r5_fragment_drops TO anon;
--  -- GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_fragment_state, public.r5_fragment_drops TO authenticated;
--
-- 7. 自检（应用后跑，三条都应为 false / 0）
--  SELECT has_function_privilege('anon','public.r5_fragment_snapshot_internal(text)','EXECUTE');  -- 期望 false
--  SET ROLE anon;
--    SELECT public.r5_fragment_snapshot('little-growth-family-001')->>'status';                  -- 期望 FORBIDDEN_SCOPE
--  RESET ROLE;
--
-- 8. 回滚方式
--    三个函数用 pg_get_functiondef 的原文重建（本轮已把原文存档在
--    evidence/db/functions-before.json），删掉 r5_fragment_snapshot_internal 与
--    r5_fragment_scope_ok 即可回到旧行为。数据一行都不会动。
-- ============================================================================
