-- ============================================================================
-- 20261114_fragment_member_scope.sql  (v3, step 3 of 3, **未执行**)
-- 「按登录身份读/组装碎片」的服务端封装
--
-- v3 改动（对应 PR #3 审查阻断项 3）
--   · r5_fragment_member_assemble 不再自带成本白名单：成本与车辆白名单只认
--     public.r5_vehicle_recipe（由 step 1 建立、step 2 的 assemble 读取）；
--     本函数只负责「把身份换成家庭」，然后把 p_cost 传空对象下去。
--   · r5_fragment_member_snapshot 额外返回 program（服务端目录），
--     前端不再依赖自己那份 catalog.mjs 作为事实来源。
--
-- 执行顺序：先 step 1 authority，再 step 2 scope_guard，最后本文件。
--
-- 成员模型（重要，别搞反）
--   public.growth_family_members 主键 = (family_id, user_id)
--   → 一个家庭可以有**多名成员**（爸爸 owner / 妈妈 parent / 外婆 grandparent 都合法）；
--   → 约束是「**每个登录账号的家庭归属唯一**」：同一个 user_id 只能落在 1 个 family_id 上，
--     落到 2 个家庭时本函数拒绝（AMBIGUOUS_MEMBER），不替家长二选一。
--   本文件**不 INSERT / UPDATE / DELETE 任何成员行**，三名家长的成员资格原样保留。
--
-- 回滚：DROP FUNCTION 两个新函数即可；既有数据、成员表都不受影响。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 只读：按登录身份取家庭碎片
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_member_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    text;
  v_fams   text[];
  v_family text;
  v_role   text;
BEGIN
  v_uid := NULLIF(auth.jwt() ->> 'sub', '');
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'UNAUTHENTICATED');
  END IF;

  -- 同一账号在同一家庭只能有一行（主键约束），这里仍用 DISTINCT：
  -- 防的是「一个账号挂多个家庭」，不是「一个家庭有多名成员」。
  SELECT array_agg(DISTINCT m.family_id)
    INTO v_fams
    FROM public.growth_family_members m
   WHERE m.user_id = v_uid
     AND m.member_role IN ('owner', 'parent', 'grandparent');

  IF v_fams IS NULL THEN
    RETURN jsonb_build_object('status', 'NOT_MEMBER');
  END IF;
  IF array_length(v_fams, 1) <> 1 THEN
    -- 一个账号挂多个家庭时不替用户选，交给家长入口处理
    RETURN jsonb_build_object('status', 'AMBIGUOUS_MEMBER', 'families', to_jsonb(v_fams));
  END IF;

  v_family := v_fams[1];
  IF v_family IS NULL OR v_family !~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$' THEN
    RETURN jsonb_build_object('status', 'BAD_FAMILY');
  END IF;

  -- role 只用于页面标注「以什么身份查看」，不参与授权判断（授权只看成员行是否存在）
  SELECT m.member_role INTO v_role
    FROM public.growth_family_members m
   WHERE m.user_id = v_uid AND m.family_id = v_family;

  -- 只读：直接复用既有快照函数，不在这里重新算余额
  RETURN public.r5_fragment_snapshot(v_family)
    || jsonb_build_object(
         'status', 'OK',
         'family_id', v_family,
         'family_source', 'growth_family_members',
         'member_role', v_role,
         'member_uid', v_uid,
         'zero_write', true,
         -- 服务端目录：车辆白名单 / 成本 / 掉落参数都来自 r5_vehicle_recipe 与 r5_reward_config
         'program', public.r5_fragment_program_json()
       );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. 组装：只负责「身份 → 家庭」，成本与白名单交给服务端配方表
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

  -- 设备列只做审计，不参与授权（身份已经是家长本人）
  v_device := 'v6:' || v_uid;

  RETURN public.r5_fragment_assemble(v_family, v_device, p_vehicle_id, '{}'::jsonb);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. 授权：只给已登录用户。anon 一律没有执行权。
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.r5_fragment_member_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.r5_fragment_member_assemble(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r5_fragment_member_snapshot() TO authenticated;
GRANT EXECUTE ON FUNCTION public.r5_fragment_member_assemble(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. 预检（只读，跑完看清楚再决定是否继续）
-- ---------------------------------------------------------------------------
-- 4.1 正式家庭的成员：**应当是 3 行**（owner / parent / grandparent），
--     并且每个 user_id 只能出现在 1 个家庭里。期望输出：
--       little-growth-family-001 | owner       | 1
--       little-growth-family-001 | parent      | 1
--       little-growth-family-001 | grandparent | 1
--       (0 rows)  ← 第二段「一个账号挂多个家庭」必须是空
--
-- SELECT family_id, member_role, count(*) AS members
--   FROM public.growth_family_members
--  WHERE family_id = 'little-growth-family-001'
--  GROUP BY 1, 2 ORDER BY 2;
--
-- SELECT user_id, count(DISTINCT family_id) AS families
--   FROM public.growth_family_members
--  GROUP BY 1 HAVING count(DISTINCT family_id) > 1;
--
-- 4.2 正式家庭当前的碎片/车辆（应当是 0 片、无车）
-- SELECT public.r5_fragment_snapshot('little-growth-family-001');
--
-- 4.3 应用后自检：两个新函数的权限（anon 必须没有）
-- SELECT p.proname,
--        has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('r5_fragment_member_snapshot','r5_fragment_member_assemble');
--
-- 5. 旧函数的 p_family 口子：**不在本文件处理**，见
--    20261114_fragment_scope_guard.sql（同样未执行，需要单独批准）。
-- ============================================================================
