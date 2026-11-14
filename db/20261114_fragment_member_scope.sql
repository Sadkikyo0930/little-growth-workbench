-- ============================================================================
-- 20261114_fragment_member_scope.sql
-- 「按登录身份读/组装碎片」的服务端封装 —— **未执行**，等家长批准后再 apply
--
-- 为什么需要它
--   现在线上三个碎片函数（r5_fragment_snapshot / claim / assemble）都是
--   SECURITY DEFINER 且对 anon 可执行，参数里带 p_family。也就是说：
--   **谁能直接调这些函数，谁就能指定任何一个 family_id。**
--   前端这一轮已经把「家庭从哪来」改成只认成长成员表（RLS 自读），但那只约束
--   我们自己的页面；真正把口子关掉，必须让服务端自己从 JWT 推家庭。
--
-- 这个文件做的事
--   1. r5_fragment_member_snapshot()  只读，不接受任何 family 参数
--   2. r5_fragment_member_assemble(v) 组装，成本由函数内的白名单决定，不接受客户端传成本
--   3. 两者都只授权给 authenticated，anon 无权限
--   4. 不修改任何既有表、既有函数、既有数据（纯新增 + 授权）
--
-- 应用前提（家长批准后）
--   · 在正式环境 normal-goose-d5g4qyzr8bb389a4a 执行；
--   · 执行前先跑本文末尾的「预检」两条 SQL，确认成员表里正式家庭只有一个成员行；
--   · 前端把 member-fragments.mjs 里的 RPC 名换成 member_ 版本即可，不需要改页面。
--   · 回滚：DROP FUNCTION 两个新函数即可，既有函数与数据不受影响。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 只读：按登录身份取家庭碎片
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_member_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   text;
  v_fams  text[];
  v_family text;
BEGIN
  v_uid := auth.jwt() ->> 'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('status', 'UNAUTHENTICATED');
  END IF;

  SELECT array_agg(m.family_id) INTO v_fams
    FROM public.growth_family_members m
   WHERE m.user_id = v_uid
     AND m.member_role IN ('owner', 'parent', 'grandparent');

  IF v_fams IS NULL THEN
    RETURN jsonb_build_object('status', 'NOT_MEMBER');
  END IF;
  IF array_length(v_fams, 1) <> 1 THEN
    -- 一个账号挂多个家庭时不替用户选，交给家长入口处理
    RETURN jsonb_build_object('status', 'AMBIGUOUS_MEMBER');
  END IF;

  v_family := v_fams[1];

  -- 只读：直接复用既有快照函数，不在这里重新算余额
  RETURN public.r5_fragment_snapshot(v_family)
    || jsonb_build_object(
         'status', 'OK',
         'family_id', v_family,
         'family_source', 'growth_family_members'
       );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. 组装：成本由服务端白名单决定，客户端不能自带价格
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_fragment_member_assemble(p_vehicle_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid    text;
  v_fams   text[];
  v_family text;
  v_cost   jsonb;
  v_device text;
BEGIN
  v_uid := auth.jwt() ->> 'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RETURN jsonb_build_object('status', 'UNAUTHENTICATED', 'zero_write', true);
  END IF;

  SELECT array_agg(m.family_id) INTO v_fams
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

  -- 目录白名单：只有这两辆碎片车，成本写死在服务端
  CASE p_vehicle_id
    WHEN 'frag_car_common_01' THEN v_cost := '{"frag_common": 12}'::jsonb;
    WHEN 'frag_car_rare_01'   THEN v_cost := '{"frag_scholar": 8}'::jsonb;
    ELSE
      RETURN jsonb_build_object('status', 'NOT_ASSEMBLABLE', 'zero_write', true);
  END CASE;

  -- 设备列只做审计，不参与授权（身份已经是家长本人）
  v_device := 'v6:' || v_uid;

  -- 余额、已拥有、生日车、金币车、遗留槽位等判断全部沿用既有函数
  RETURN public.r5_fragment_assemble(v_family, v_device, p_vehicle_id, v_cost);
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
-- 4.1 正式家庭的成员与角色（应当只有 1 行，且角色属于 owner/parent/grandparent）
-- SELECT family_id, member_role, count(*)
--   FROM public.growth_family_members
--  WHERE family_id = 'little-growth-family-001'
--  GROUP BY 1, 2;
--
-- 4.2 正式家庭当前的碎片/车辆（应当是 0 片、无车）
-- SELECT public.r5_fragment_snapshot('little-growth-family-001');
--
-- 5. 可选但建议（需要单独批准，会影响现有调用方）：
--    收紧既有三个函数的 anon 执行权，让「直接传 p_family」这条路彻底走不通。
--    REVOKE EXECUTE ON FUNCTION public.r5_fragment_snapshot(text) FROM anon;
--    REVOKE EXECUTE ON FUNCTION public.r5_fragment_claim(text,text,text,jsonb) FROM anon;
--    REVOKE EXECUTE ON FUNCTION public.r5_fragment_assemble(text,text,text,jsonb) FROM anon;
--    执行前必须确认 r5-gateway / r5-racing-save 用的是 service_role 身份，
--    否则赛车游戏里的「去组装」会跟着一起坏掉。
