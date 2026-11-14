-- ============================================================================
-- 20261114_fragment_save_ensure.sql
-- 碎片领取 / 组装：家庭首次接触时初始化赛车云存档行
--
-- 缺陷（2026-11-14 上线冒烟时发现）：
--   r5_fragment_claim / r5_fragment_assemble 都要求 public.r5_racing_saves
--   里已经有该家庭的行 —— claim 用它做 FOR UPDATE 串行化，assemble 读 owned。
--   正式家庭 little-growth-family-001 从来没有云存档（saves=0、events=0），
--   于是孩子今天三条真实 course-complete 记录全部返回
--       {"status":"SAVE_NOT_INITIALIZED","zero_write":true}
--   碎片永远发不出来，车也永远组装不了。
--
--   云函数 r5-racing-save 自己早就有 sqlEnsure()：
--     INSERT INTO r5_racing_saves (family_id, schema_version, revision,
--                                  coins_balance, updated_by_device)
--     VALUES (..., 1, 0, 0, '') ON CONFLICT (family_id) DO NOTHING
--   只是 V6 直连 RPC 这条路径漏了这一步。本次补齐，语义与云函数完全一致。
--
-- 为什么改 member 层而不是两个底层函数：
--   Web 客户端只经过 r5_fragment_member_claim / r5_fragment_member_assemble，
--   云函数路径已有 sqlEnsure 兜底。改在 member 层，核心 claim / assemble
--   逻辑一行不动，改动面最小。
--   r5_fragment_member_snapshot 是 STABLE 只读函数，不能在其中写库，
--   所以不放它；member_claim 本来就会先调它拿 family，之后再补这一行。
--
-- 安全性：
--   * ON CONFLICT (family_id) DO NOTHING —— 已有存档一行都不会被改，
--     绝不重置 revision / 金币 / 车辆 / 剧情进度；
--   * 新建的行 revision=0、coins_balance=0、owned 取列默认值，即空存档；
--   * 不改表结构、不改底层函数、不动 growth_* 与生日车相关表；
--   * SAVE_NOT_INITIALIZED 仍然保留为并发兜底返回。
--
-- 回滚：按 db/isolated/functions-before.sql 里的原文重建这两个 member 函数。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 组装：身份 → 家庭之后，确保存档行存在，再把工作交给 r5_fragment_assemble
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_member_assemble(p_vehicle_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    text;
  v_fams   text[];
  v_family text;
  v_device text;
BEGIN
  v_uid := NULLIF(auth.jwt() ->> 'sub', '');
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'UNAUTHENTICATED', 'zero_write', true);
  END IF;

  SELECT array_agg(DISTINCT m.family_id) INTO v_fams
    FROM public.growth_family_members m
   WHERE m.user_id = v_uid
     AND m.member_role IN ('owner', 'parent', 'grandparent');

  IF v_fams IS NULL THEN
    RETURN jsonb_build_object('status', 'NOT_MEMBER', 'zero_write', true);
  END IF;
  IF array_length(v_fams, 1) <> 1 THEN
    RETURN jsonb_build_object('status', 'AMBIGUOUS_MEMBER', 'zero_write', true);
  END IF;
  v_family := v_fams[1];
  IF v_family IS NULL OR v_family !~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$' THEN
    RETURN jsonb_build_object('status', 'BAD_FAMILY', 'zero_write', true);
  END IF;

  -- 车辆 ID 形态先过一遍（与旧函数同一套正则），避免把奇怪字符串带进事件 ID。
  -- 不在白名单 / 不是碎片车 / 成本多少，全部由 r5_fragment_assemble 查
  -- public.r5_vehicle_recipe 决定；本函数不揣任何成本，也不允许调用方自带价格。
  IF p_vehicle_id IS NULL OR p_vehicle_id !~ '^[a-z0-9][a-z0-9_-]{1,40}$' THEN
    RETURN jsonb_build_object('status', 'BAD_VEHICLE_ID', 'zero_write', true);
  END IF;

  -- 首次接触碎片系统时按云函数 sqlEnsure() 的方式建一行空存档。
  -- 没有这一步，没玩过云存档的家庭组装永远返回 SAVE_NOT_INITIALIZED。
  INSERT INTO public.r5_racing_saves
         (family_id, schema_version, revision, coins_balance, updated_by_device)
  VALUES (v_family, 1, 0, 0, '')
  ON CONFLICT (family_id) DO NOTHING;

  -- 设备列只做审计，不参与授权（身份已经是家长本人）
  v_device := 'v6:' || v_uid;

  RETURN public.r5_fragment_assemble(v_family, v_device, p_vehicle_id, '{}'::jsonb);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. 领取：只认已经落库的学习记录；先补存档行，再走服务端领取逻辑
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_member_claim(p_record_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_snapshot jsonb;
  v_family text;
  v_uid text;
BEGIN
  v_snapshot := public.r5_fragment_member_snapshot();
  IF v_snapshot IS NULL OR v_snapshot->>'status' IS DISTINCT FROM 'OK' THEN
    RETURN jsonb_build_object(
      'status', COALESCE(v_snapshot->>'status','UNAUTHENTICATED'),
      'zero_write', true
    );
  END IF;
  v_family := NULLIF(v_snapshot->>'family_id', '');
  v_uid := NULLIF(auth.jwt()->>'sub','');
  IF v_family IS NULL OR v_uid IS NULL THEN
    RETURN jsonb_build_object('status','FORBIDDEN_SCOPE','zero_write',true);
  END IF;

  -- 同上：首次领取时先建空存档行，已有存档不受影响。
  INSERT INTO public.r5_racing_saves
         (family_id, schema_version, revision, coins_balance, updated_by_device)
  VALUES (v_family, 1, 0, 0, '')
  ON CONFLICT (family_id) DO NOTHING;

  RETURN public.r5_fragment_claim(v_family,'v6:' || v_uid,p_record_id,'{}'::jsonb);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. 重设授权：平台在 CREATE FUNCTION 时会显式给 anon 授 EXECUTE，
--    必须点名收回，否则 REVOKE FROM PUBLIC 收不到这条显式授权。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.r5_fragment_member_assemble(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.r5_fragment_member_claim(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.r5_fragment_member_assemble(text) FROM anon;
REVOKE ALL ON FUNCTION public.r5_fragment_member_claim(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.r5_fragment_member_assemble(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.r5_fragment_member_claim(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. 自检
-- ---------------------------------------------------------------------------
SELECT p.oid::regprocedure::text AS function,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS svc_exec
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('r5_fragment_member_assemble', 'r5_fragment_member_claim')
 ORDER BY 1;
