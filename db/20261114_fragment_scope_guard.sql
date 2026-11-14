-- ============================================================================
-- 20261114_fragment_scope_guard.sql  (v3, step 2 of 3, **未执行**)
--
-- 前置：先执行 20261114_fragment_server_authority.sql（建了 r5_backend_role /
--       r5_reward_config / r5_vehicle_recipe 三张表并写入种子）。
--
-- 这一版针对 PR #3 四条发布阻断项的改动，逐条对应：
--
--   阻断 1「空 JWT claims 直接放行」
--     旧写法：claims 为空 → RETURN true（把「没带身份」当成「可信服务端」）。
--     新写法：**先判定数据库连接角色**，再看 claims。
--       · 特权角色（r5_backend_role 白名单 / superuser / BYPASSRLS）→ 放行；
--         r5-racing-save 走云 API ExecutePGSql，就是这一类。
--       · anon / authenticated / 未知角色 → claims 为空一律拒绝；
--         有 claims 也只有「是该家庭的 owner/parent/grandparent」才放行。
--       · claims 里的 role=service_role **不再具备任何效力**（伪造无效，
--         证据是它只能来自 GUC role，而 GUC role 改不了）。
--     为什么不用 current_user：SECURITY DEFINER 内 current_user 会变成函数属主，
--     这就是旧实现不敢用它、转而看 claims 的原因。改用 GUC `role`——
--     它在 SECURITY DEFINER 内不被改写（隔离库实测，见 docs）。
--
--   阻断 2「设备 UID 不等于已验证认证」
--     旧写法：anon + 认识某个 device_uid → 放行。
--     新写法：**非特权连接完全不能走设备路径**，设备领取只走已鉴权的赛车网关
--     （网关在服务端用 r5_device 反查家庭、签 HMAC 再调云函数）。
--     特权连接如果声称了设备，设备必须确实绑定在该家庭且未撤销——
--     这是纵深防御：网关有 bug 也跨不了家庭。
--
--   阻断 3「领取/组装相信调用方参数」
--     r5_fragment_claim 的 p_cfg 与 r5_fragment_assemble 的 p_cost **全部不再采信**：
--       · 记录是否存在 / 属于哪个家庭 / 哪一天 / 什么类型 —— 查 growth_learning_records；
--       · 掉落概率 / 每日上限 / 保底 / 碎片 id —— 查 r5_reward_config；
--       · 车辆白名单 / 获取方式 / 成本 —— 查 r5_vehicle_recipe。
--     两个参数保留在签名里只为兼容既有调用方（云函数不用改），函数体一个字都不读它。
--
--   阻断 4「底层表可绕过 RPC 直接读写」
--     第 6 节：r5_fragment_state / r5_fragment_drops / r5_racing_events / r5_racing_saves
--     全部开 RLS + 收回 anon/authenticated 的所有权限，只留 service_role 与属主。
--     不再写成「可选注释」。
--
-- 赛车兼容性（先核实过才敢这么写）
--   链路：浏览器 x-r5-device → r5-gateway（服务端查 r5_device 反查家庭、签 r5_identity）
--         → 云函数 r5-racing-save（服务端调云 API ExecutePGSql）
--   两个云函数都不用 PostgREST 的 anon key，ExecutePGSql 是账号级凭据、库属主身份。
--   所以「anon 不能再用设备 UID 直接打 RPC」不影响赛车；赛车从来不走那条路。
--   落地前请先跑 authority 文件第 6 节的角色探针，确认返回值是 postgres/true。
--
-- 回滚
--   三个函数用 pg_get_functiondef 原文重建（原文存 db/isolated/functions-before.sql），
--   表权限按第 7 节的反向语句恢复。数据一行都不会动。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. 范围判断（唯一入口，三个旧函数 + 两个新函数共用）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_scope_ok(p_family text, p_device text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_privileged boolean;
  v_claims     jsonb;
  v_uid        text;
  v_dev        text;
BEGIN
  IF p_family IS NULL OR p_family = '' THEN
    RETURN false;
  END IF;
  IF p_family !~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$' THEN
    RETURN false;
  END IF;

  v_privileged := public.r5_fragment_is_privileged();
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;

  -- ===== ① 非特权连接：只认 JWT 里的成员身份 =====
  IF NOT v_privileged THEN
    -- 没有 claims 就是没有身份。**绝不因为「没带 claims」而放行**（阻断项 1 的核心）。
    IF v_claims IS NULL OR v_claims = '{}'::jsonb THEN
      RETURN false;
    END IF;
    -- 说明：claims->>'role' 在这里完全没有用。伪造 role=service_role 也进不来，
    -- 因为数据库角色仍然是 anon/authenticated。
    v_uid := NULLIF(v_claims ->> 'sub', '');
    IF v_uid IS NULL THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.growth_family_members m
       WHERE m.user_id = v_uid
         AND m.family_id = p_family
         AND m.member_role IN ('owner', 'parent', 'grandparent')
    );
  END IF;

  -- ===== ② 特权连接（云函数 / 迁移 / service_role）=====
  v_dev := NULLIF(p_device, '');
  IF v_dev IS NULL THEN
    RETURN true;                       -- 服务端直连且不声称任何设备
  END IF;

  -- 家长身份路径的审计标记 v6:<uid>：uid 必须是该家庭的家长成员
  IF left(v_dev, 3) = 'v6:' THEN
    v_uid := NULLIF(substr(v_dev, 4), '');
    IF v_uid IS NULL THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.growth_family_members m
       WHERE m.user_id = v_uid
         AND m.family_id = p_family
         AND m.member_role IN ('owner', 'parent', 'grandparent')
    );
  END IF;

  -- 声称了设备：设备必须真的绑定在这个家庭且未撤销（纵深防御，不是认证）
  IF v_dev !~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.r5_device d
     WHERE d.device_uid = v_dev
       AND d.family_id = p_family
       AND d.revoked_at IS NULL
  );
END;
$function$;

COMMENT ON FUNCTION public.r5_fragment_scope_ok(text, text) IS
  '碎片函数的唯一范围判定：特权角色放行；非特权角色必须持家庭成员 JWT；设备 UID 不再单独作为凭证。';

REVOKE ALL ON FUNCTION public.r5_fragment_scope_ok(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_fragment_scope_ok(text, text) TO anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. 无守卫的内部快照（只给属主与上面这些 SECURITY DEFINER 函数用）
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

REVOKE ALL ON FUNCTION public.r5_fragment_snapshot_internal(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.r5_fragment_snapshot_internal(text) FROM anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. 对外快照（签名不变，老调用方无需改）
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


-- ---------------------------------------------------------------------------
-- 4. 领取（服务端权威：记录 / 概率 / 上限 / 保底 / 碎片 id 全部查表）
--    p_cfg 保留只为签名兼容，函数体不再读它任何一个字段。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_claim(p_family text, p_device text, p_record_id text, p_cfg jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cfg         public.r5_reward_config;
  v_kind        text;
  v_subject     text;
  v_day         date;
  v_today       date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_prev        public.r5_fragment_drops;
  v_state       public.r5_fragment_state;
  v_cap         int;
  v_pity_target int;
  v_frag        text;
  v_rare_frag   text;
  v_pity        int;
  v_daily       int;
  v_daily_rare  int;
  v_pity_exempt boolean := false;
  v_outcome     text;
  v_count       int := 0;
  v_rare_count  int := 0;
  v_pity_after  int := 0;
  v_daily_index int := 0;
  v_rev         bigint;
BEGIN
  -- ▼ 入口守卫（读写之前）：非特权连接必须持家庭成员 JWT
  IF NOT public.r5_fragment_scope_ok(p_family, p_device) THEN
    RETURN jsonb_build_object('status', 'FORBIDDEN_SCOPE', 'zero_write', true);
  END IF;
  -- ▲

  IF p_family IS NULL OR p_family = '' THEN
    RETURN jsonb_build_object('status', 'BAD_FAMILY', 'zero_write', true);
  END IF;
  IF p_record_id IS NULL OR p_record_id = '' OR length(p_record_id) > 160 THEN
    RETURN jsonb_build_object('status', 'BAD_RECORD_ID', 'zero_write', true);
  END IF;

  -- 幂等：同一条记录只结算一次
  SELECT * INTO v_prev FROM public.r5_fragment_drops d
   WHERE d.family_id = p_family AND d.source_record_id = p_record_id;
  IF FOUND THEN
    RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object(
      'status', 'ALREADY_CLAIMED', 'outcome', v_prev.outcome,
      'granted_normal', v_prev.fragment_count, 'granted_rare', v_prev.rare_count,
      'fragment_id', v_prev.fragment_id, 'rare_fragment_id', v_prev.rare_fragment_id,
      'pity_points', COALESCE((SELECT pity_points FROM public.r5_fragment_state WHERE family_id = p_family), 0),
      'claimed_at', v_prev.created_at, 'zero_write', true);
  END IF;

  -- ▼ 服务端验证真实学习记录（阻断项 3 的核心）
  SELECT r.record_type,
         COALESCE(r.subject, ''),
         (r.created_at AT TIME ZONE 'Asia/Shanghai')::date
    INTO v_kind, v_subject, v_day
    FROM public.growth_learning_records r
   WHERE r.record_id = p_record_id
     AND r.family_id = p_family;
  IF NOT FOUND THEN
    RETURN public.r5_fragment_snapshot_internal(p_family)
      || jsonb_build_object('status', 'RECORD_NOT_FOUND', 'zero_write', true);
  END IF;
  IF v_day <> v_today THEN
    RETURN public.r5_fragment_snapshot_internal(p_family)
      || jsonb_build_object('status', 'NOT_TODAY', 'record_day', v_day::text, 'zero_write', true);
  END IF;
  -- ▲

  -- ▼ 服务端配置（掉落概率 / 上限 / 保底 / 碎片 id）
  SELECT * INTO v_cfg FROM public.r5_reward_config c WHERE c.family_id = p_family;
  IF NOT FOUND THEN
    SELECT * INTO v_cfg FROM public.r5_reward_config c WHERE c.family_id = '*';
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'CONFIG_MISSING', 'zero_write', true);
  END IF;

  -- Explicit parent approval is a hard authorization gate, not merely a UI label.
  -- Must exit before any claim row, pity counter, fragment event or save revision write.
  -- A zero drop percent is NOT a substitute: pity and rare awards have separate paths.
  IF v_cfg.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object(
      'status', 'REWARD_NOT_ACTIVE',
      'config_status', v_cfg.status,
      'zero_write', true
    );
  END IF;

  v_cap := GREATEST(0, v_cfg.daily_cap);
  v_pity_target := GREATEST(2, v_cfg.pity_target);
  v_frag := NULLIF(v_cfg.common_fragment_id, '');
  v_rare_frag := NULLIF(v_cfg.rare_fragment_id, '');
  -- ▲

  SELECT s.revision INTO v_rev FROM public.r5_racing_saves s
   WHERE s.family_id = p_family FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'SAVE_NOT_INITIALIZED', 'zero_write', true);
  END IF;

  INSERT INTO public.r5_fragment_state (family_id) VALUES (p_family)
  ON CONFLICT (family_id) DO NOTHING;
  SELECT * INTO v_state FROM public.r5_fragment_state st
   WHERE st.family_id = p_family FOR UPDATE;

  IF v_state.daily_day = v_today THEN
    v_pity := v_state.pity_points;
    v_daily := v_state.daily_normal_count;
    v_daily_rare := v_state.daily_rare_count;
  ELSE
    v_pity := v_state.pity_points;
    v_daily := 0;
    v_daily_rare := 0;
  END IF;

  -- 记录类型不在白名单 → 不产出、也不消耗保底
  IF NOT (v_kind = ANY (v_cfg.eligible_record_types)) THEN
    v_outcome := 'none';
    v_pity_exempt := true;
  ELSIF v_daily >= v_cap THEN
    v_outcome := 'capped';
    v_pity_exempt := true;
  ELSIF (random() * 100) < v_cfg.drop_percent THEN
    v_outcome := 'drop';
  ELSE
    v_outcome := 'none';
  END IF;

  IF v_outcome = 'drop' THEN
    v_count := 1;
    v_daily_index := v_daily + 1;
    v_pity_after := 0;
  ELSIF v_outcome = 'none' THEN
    IF v_pity_exempt THEN
      v_pity_after := v_pity;
    ELSE
      v_pity_after := v_pity + 1;
      IF v_pity_after >= v_pity_target THEN
        v_outcome := 'pity';
        v_count := 1;
        v_daily_index := v_daily + 1;
        v_pity_after := 0;
      END IF;
    END IF;
  ELSE
    v_pity_after := v_pity;
  END IF;

  IF v_kind = ANY (v_cfg.rare_record_types)
     AND v_rare_frag IS NOT NULL
     AND v_daily_rare < v_cfg.rare_daily_cap THEN
    v_rare_count := 1;
  END IF;

  INSERT INTO public.r5_fragment_drops (
    family_id, source_record_id, record_day, record_kind, subject, outcome,
    fragment_id, fragment_count, rare_fragment_id, rare_count,
    pity_before, pity_after, daily_index, device)
  VALUES (
    p_family, p_record_id, v_day, v_kind, v_subject, v_outcome,
    CASE WHEN v_count > 0 THEN v_frag ELSE NULL END, v_count,
    CASE WHEN v_rare_count > 0 THEN v_rare_frag ELSE NULL END, v_rare_count,
    v_pity, v_pity_after, v_daily_index, COALESCE(p_device, ''))
  ON CONFLICT (family_id, source_record_id) DO NOTHING;

  IF NOT FOUND THEN
    SELECT * INTO v_prev FROM public.r5_fragment_drops d
     WHERE d.family_id = p_family AND d.source_record_id = p_record_id;
    RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object(
      'status', 'ALREADY_CLAIMED', 'outcome', v_prev.outcome,
      'granted_normal', v_prev.fragment_count, 'granted_rare', v_prev.rare_count,
      'zero_write', true);
  END IF;

  IF v_count > 0 AND v_frag IS NOT NULL THEN
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'frag:' || p_record_id, 'fragment_change', 0,
      jsonb_build_object('item_id', v_frag, 'quantity_delta', v_count, 'source', 'study',
                         'record_id', p_record_id, 'record_kind', v_kind, 'subject', v_subject,
                         'record_day', v_day::text, 'outcome', v_outcome, 'pity_after', v_pity_after),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END IF;

  IF v_rare_count > 0 AND v_rare_frag IS NOT NULL THEN
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'frag:' || p_record_id || ':rare', 'fragment_change', 0,
      jsonb_build_object('item_id', v_rare_frag, 'quantity_delta', v_rare_count, 'source', 'study-rare',
                         'record_id', p_record_id, 'record_kind', v_kind, 'subject', v_subject,
                         'record_day', v_day::text),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END IF;

  UPDATE public.r5_fragment_state st
     SET pity_points = v_pity_after,
         pity_total = st.pity_total + CASE WHEN v_outcome = 'pity' THEN 1 ELSE 0 END,
         daily_day = v_today,
         daily_normal_count = v_daily + v_count,
         daily_rare_count = v_daily_rare + v_rare_count,
         updated_at = now()
   WHERE st.family_id = p_family;

  UPDATE public.r5_racing_saves s
     SET revision = s.revision + 1, updated_at = now(), updated_by_device = COALESCE(p_device, '')
   WHERE s.family_id = p_family;

  RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object(
    'status', 'CLAIMED', 'outcome', v_outcome,
    'granted_normal', v_count, 'granted_rare', v_rare_count,
    'fragment_id', CASE WHEN v_count > 0 THEN v_frag ELSE NULL END,
    'rare_fragment_id', CASE WHEN v_rare_count > 0 THEN v_rare_frag ELSE NULL END,
    'pity_points', v_pity_after, 'pity_before', v_pity,
    'daily_normal_count', v_daily + v_count, 'daily_rare_count', v_daily_rare + v_rare_count,
    'daily_index', v_daily_index, 'record_day', v_day::text, 'record_kind', v_kind,
    'zero_write', false);
END;
$function$;


-- ---------------------------------------------------------------------------
-- 5. 组装（服务端权威：车辆白名单 / 获取方式 / 成本全部查表）
--    p_cost 保留只为签名兼容，函数体不再读它。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_assemble(p_family text, p_device text, p_vehicle_id text, p_cost jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_recipe public.r5_vehicle_recipe;
  v_cost   jsonb;
  v_owned  jsonb;
  v_rev    bigint;
  v_bal    jsonb;
  v_deficit jsonb := '{}'::jsonb;
  v_k      text;
  v_q      int;
  v_have   bigint;
BEGIN
  -- ▼ 入口守卫（读写之前）
  IF NOT public.r5_fragment_scope_ok(p_family, p_device) THEN
    RETURN jsonb_build_object('status', 'FORBIDDEN_SCOPE', 'zero_write', true);
  END IF;
  -- ▲

  IF p_vehicle_id IS NULL OR p_vehicle_id !~ '^[a-z0-9][a-z0-9_-]{1,40}$' THEN
    RETURN jsonb_build_object('status', 'BAD_VEHICLE_ID', 'zero_write', true);
  END IF;

  -- 前缀类限定车无法枚举，只能按前缀拒绝
  IF p_vehicle_id LIKE 'pink-newyear%' OR p_vehicle_id LIKE 'pink-new-year%' THEN
    RETURN jsonb_build_object('status', 'BIRTHDAY_VEHICLE_FORBIDDEN', 'zero_write', true);
  END IF;

  -- ▼ 车辆白名单 / 获取方式（服务端表）
  SELECT * INTO v_recipe FROM public.r5_vehicle_recipe r WHERE r.vehicle_id = p_vehicle_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'UNKNOWN_VEHICLE', 'zero_write', true);
  END IF;
  -- 先判获取方式（更具体的拒绝原因），再看开关
  CASE v_recipe.obtainable_via
    WHEN 'fragment' THEN
      NULL;
    WHEN 'birthday' THEN
      RETURN jsonb_build_object('status', 'BIRTHDAY_VEHICLE_FORBIDDEN', 'zero_write', true);
    WHEN 'coin' THEN
      RETURN jsonb_build_object('status', 'COIN_VEHICLE_FORBIDDEN', 'zero_write', true);
    WHEN 'retired' THEN
      RETURN jsonb_build_object('status', 'LEGACY_SLOT_RETIRED', 'zero_write', true);
    ELSE
      RETURN jsonb_build_object('status', 'VEHICLE_NOT_ASSEMBLABLE', 'zero_write', true);
  END CASE;
  IF NOT v_recipe.enabled THEN
    RETURN jsonb_build_object('status', 'VEHICLE_DISABLED', 'zero_write', true);
  END IF;

  -- 成本只认表里的，客户端传什么都不看
  v_cost := v_recipe.cost;
  IF v_cost IS NULL OR jsonb_typeof(v_cost) <> 'object' OR v_cost = '{}'::jsonb THEN
    RETURN jsonb_build_object('status', 'RECIPE_INVALID', 'zero_write', true);
  END IF;
  -- ▲

  SELECT s.owned, s.revision INTO v_owned, v_rev FROM public.r5_racing_saves s
   WHERE s.family_id = p_family FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'SAVE_NOT_INITIALIZED', 'zero_write', true);
  END IF;

  IF v_owned ? p_vehicle_id THEN
    RETURN public.r5_fragment_snapshot_internal(p_family)
      || jsonb_build_object('status', 'ALREADY_OWNED', 'vehicle_id', p_vehicle_id, 'zero_write', true);
  END IF;

  IF EXISTS (SELECT 1 FROM public.r5_racing_events e
              WHERE e.family_id = p_family AND e.event_id = 'asm:' || p_vehicle_id) THEN
    RETURN public.r5_fragment_snapshot_internal(p_family)
      || jsonb_build_object('status', 'ALREADY_ASSEMBLED', 'vehicle_id', p_vehicle_id, 'zero_write', true);
  END IF;

  SELECT COALESCE(jsonb_object_agg(t.k, t.q), '{}'::jsonb) INTO v_bal FROM (
    SELECT x.payload->>'item_id' AS k, GREATEST(0, sum((x.payload->>'quantity_delta')::bigint)) AS q
    FROM public.r5_racing_events x
    WHERE x.family_id = p_family AND x.kind = 'fragment_change'
      AND x.payload ? 'item_id' AND x.payload ? 'quantity_delta'
    GROUP BY 1
  ) t;

  FOR v_k, v_q IN SELECT key, (value)::int FROM jsonb_each_text(v_cost) LOOP
    v_have := COALESCE((v_bal->>v_k)::bigint, 0);
    IF v_have < v_q THEN
      v_deficit := v_deficit || jsonb_build_object(v_k, v_q - v_have);
    END IF;
  END LOOP;

  IF v_deficit <> '{}'::jsonb THEN
    RETURN public.r5_fragment_snapshot_internal(p_family)
      || jsonb_build_object('status', 'INSUFFICIENT_FRAGMENTS', 'vehicle_id', p_vehicle_id,
                            'required', v_cost, 'deficit', v_deficit, 'zero_write', true);
  END IF;

  FOR v_k, v_q IN SELECT key, (value)::int FROM jsonb_each_text(v_cost) LOOP
    INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
    VALUES (p_family, 'asm:' || p_vehicle_id || ':' || v_k, 'fragment_change', 0,
      jsonb_build_object('item_id', v_k, 'quantity_delta', -v_q, 'source', 'assemble', 'vehicle_id', p_vehicle_id),
      COALESCE(p_device, ''), now(), NULL)
    ON CONFLICT (family_id, event_id) DO NOTHING;
  END LOOP;

  INSERT INTO public.r5_racing_events (family_id, event_id, kind, coin_delta, payload, device, applied_at, result_balance)
  VALUES (p_family, 'asm:' || p_vehicle_id, 'grant', 0,
    jsonb_build_object('vehicle_id', p_vehicle_id, 'source', 'fragment-assembly', 'cost', v_cost),
    COALESCE(p_device, ''), now(), NULL)
  ON CONFLICT (family_id, event_id) DO NOTHING;

  UPDATE public.r5_racing_saves s
     SET owned = COALESCE(s.owned, '{}'::jsonb) || jsonb_build_object(p_vehicle_id,
           jsonb_build_object('at', (extract(epoch from now())*1000)::bigint,
                              'source', 'fragment-assembly', 'note', '碎片组装')),
         revision = s.revision + 1, updated_at = now(), updated_by_device = COALESCE(p_device, '')
   WHERE s.family_id = p_family;

  RETURN public.r5_fragment_snapshot_internal(p_family) || jsonb_build_object(
    'status', 'ASSEMBLED', 'vehicle_id', p_vehicle_id, 'cost', v_cost, 'zero_write', false);
END;
$function$;


-- ---------------------------------------------------------------------------
-- 6. 表权限收紧（阻断项 4，不再是「可选注释」）
--    思路：奖励相关的表只有「属主（迁移/云函数通道）」和 service_role 能碰，
--    anon / authenticated 一律没有任何权限；RLS 同时开启，双保险。
--    不改任何一行的数据，也不删表。
-- ---------------------------------------------------------------------------
ALTER TABLE public.r5_fragment_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_fragment_drops  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_racing_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_racing_saves   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_device          ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.r5_fragment_state  FROM PUBLIC;
REVOKE ALL ON public.r5_fragment_drops  FROM PUBLIC;
REVOKE ALL ON public.r5_racing_events   FROM PUBLIC;
REVOKE ALL ON public.r5_racing_saves    FROM PUBLIC;
REVOKE ALL ON public.r5_device          FROM PUBLIC;

REVOKE ALL ON public.r5_fragment_state  FROM anon, authenticated;
REVOKE ALL ON public.r5_fragment_drops  FROM anon, authenticated;
REVOKE ALL ON public.r5_racing_events   FROM anon, authenticated;
REVOKE ALL ON public.r5_racing_saves    FROM anon, authenticated;
REVOKE ALL ON public.r5_device          FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_fragment_state TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_fragment_drops TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_racing_events  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_racing_saves   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.r5_device         TO service_role;

-- 学习记录表**不动**：V6 页面本来就用登录会话读自己的记录，收权会直接打断学习进度。


-- ---------------------------------------------------------------------------
-- 7. apply 后自检（三条都要符合期望值）
-- ---------------------------------------------------------------------------
-- 7.1 角色与特权
-- SELECT public.r5_fragment_caller_role(), public.r5_fragment_is_privileged();   -- 期望 postgres / true
--
-- 7.2 非特权连接必须拿不到东西（在 PostgREST 侧用 anon key 打这两个接口）
--   POST /rest/v1/rpc/r5_fragment_snapshot  {"p_family":"little-growth-family-001"}
--     → {"status":"FORBIDDEN_SCOPE","zero_write":true}
--   POST /rest/v1/rpc/r5_fragment_claim     {"p_family":"...","p_device":"r5dev_...","p_record_id":"..."}
--     → {"status":"FORBIDDEN_SCOPE","zero_write":true}
--   GET  /rest/v1/r5_fragment_drops?select=*     → 空数组或 401（不再是明文数据）
--
-- 7.3 表权限
-- SELECT c.relname,
--        has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
--        has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_insert
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname='public'
--    AND c.relname IN ('r5_fragment_state','r5_fragment_drops','r5_racing_events','r5_racing_saves','r5_device');
--   期望：anon_select 全 false，auth_insert 全 false
--
-- 7.4 函数权限（anon 仍然可以 EXECUTE，但都会在入口被挡；内部快照 anon 必须 false）
-- SELECT has_function_privilege('anon','public.r5_fragment_snapshot_internal(text)','EXECUTE');  -- 期望 false
--
-- 8. 回滚
--   三个函数按 db/isolated/functions-before.sql 里的原文重建；
--   表权限反向执行：
--     GRANT SELECT ON public.r5_fragment_state, public.r5_fragment_drops TO anon;
--     GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.r5_fragment_state, public.r5_fragment_drops TO authenticated;
--     ALTER TABLE public.r5_fragment_state DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.r5_fragment_drops DISABLE ROW LEVEL SECURITY;
-- ============================================================================
