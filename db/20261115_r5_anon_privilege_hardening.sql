-- 2026-11-15 家庭成员权限事故：附带的最小权限收口（可回滚）
--
-- 这不是 42501 的成因，也不是它的修复。42501 的成因在客户端传输层：
-- app.rdb() 把请求代理给本环境不存在的云函数 httpOverCallFunction，且不带家长身份，
-- 网关按匿名角色执行，anon 对 growth_family_members 无任何权限（这是对的）。
-- 修复办法是客户端显式携带家长 JWT（v6/r5/rdb-client.mjs），
-- 绝不通过给 anon / authenticated 补表权限来解决。
--
-- 本脚本只做一件事，且只会减少权限：
-- C0.1 010 建表时执行了 REVOKE ALL FROM PUBLIC，但 CloudBase 的默认权限
-- 同时把这些表的 SELECT 给了 anon。这些表都启用了 RLS 且没有任何 policy，
-- 所以今天 anon 读到的仍是 0 行；但「默认有权、靠 RLS 挡住」是随时会被
-- 一条新 policy 击穿的脚枪，而 010 的设计意图就是 deny by default。
-- 因此把 anon 的残留授权一并收回。
--
-- 影响面：
--   * authenticated / service_role / 表 owner 的权限一字未改；
--   * 这 5 张表没有任何客户端直读路径，全部经 SECURITY DEFINER 函数访问；
--   * 跨家庭读取范围不变（本来就只有 owner 能读）。
-- 回滚见 20261115_r5_anon_privilege_hardening_rollback.sql。

BEGIN;
SET LOCAL lock_timeout = '5s';

REVOKE ALL ON TABLE public.r5_family_progress     FROM anon;
REVOKE ALL ON TABLE public.r5_plan_audit          FROM anon;
REVOKE ALL ON TABLE public.r5_credential_snapshot FROM anon;
REVOKE ALL ON TABLE public.r5_day_confirmation    FROM anon;
REVOKE ALL ON TABLE public.r5_acl_baseline        FROM anon;

COMMIT;
