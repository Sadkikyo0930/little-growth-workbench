-- 回滚 20261115_r5_anon_privilege_hardening.sql
-- 恢复 anon 在这 5 张表上的 SELECT，回到迁移前的实际状态。
-- 只有在确认某个匿名路径确实需要读这些表时才执行；正常情况下不该需要。

BEGIN;
SET LOCAL lock_timeout = '5s';

GRANT SELECT ON TABLE public.r5_family_progress     TO anon;
GRANT SELECT ON TABLE public.r5_plan_audit          TO anon;
GRANT SELECT ON TABLE public.r5_credential_snapshot TO anon;
GRANT SELECT ON TABLE public.r5_day_confirmation    TO anon;
GRANT SELECT ON TABLE public.r5_acl_baseline        TO anon;

COMMIT;
