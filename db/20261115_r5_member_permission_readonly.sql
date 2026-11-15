-- V6 家庭成员权限事故：只读排查；不改变授权、学习日或学习记录。
-- 故障证据: permission denied for table growth_family_members (2026-11-15)
-- 使用管理员只读会话，且只共享结果中的角色/权限布尔值，不暴露 UID/JWT。
BEGIN TRANSACTION READ ONLY;

-- 1. 哪一个 RPC 函数是在谁的权限下执行？owner 是否可读取成员表？
SELECT
 p.proname AS function_name,
 pg_get_function_identity_arguments(p.oid) AS arguments,
 pg_get_userbyid(p.proowner) AS function_owner,
 p.prosecdef AS security_definer,
 CASE WHEN to_regclass('public.growth_family_members') IS NOT NULL
    THEN has_table_privilege(p.proowner,'public.growth_family_members','SELECT')
    ELSE NULL END AS owner_can_select_family_members,
 has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
 has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('r5_assert_member','r5_auto_rollover_day','r5_status',
                    'growth_is_family_member','r5_gate_status_core',
                    'r5_next_day_state_impl')
ORDER BY p.proname, arguments;

-- 2. 成员表所有者、RLS 状态与已配置授权（不读取成员个人数据）。
SELECT
 c.relname AS table_name,
 pg_get_userbyid(c.relowner) AS table_owner,
 c.relrowsecurity AS rls_enabled,
 c.relforcerowsecurity AS force_rls,
 has_table_privilege('authenticated',c.oid,'SELECT') AS authenticated_can_read,
 has_table_privilege('anon',c.oid,'SELECT') AS anon_can_read
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname='growth_family_members';

-- 3. 实际 policy（只读输出名称和适用角色，不输出用户数据）。
SELECT policyname,cmd,roles,permissive
FROM pg_policies
WHERE schemaname='public' AND tablename='growth_family_members'
ORDER BY policyname;

-- 4. 请结合 CloudBase 真实失败请求的 SQLSTATE / RPC 名称 / 函数调用栈
--    判断报错源头。没有真实 caller JWT 不执行 r5_auto_rollover_day。
COMMIT;
