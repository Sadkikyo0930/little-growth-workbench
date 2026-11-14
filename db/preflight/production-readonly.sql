-- V6 fragment garage: read-only PRE-FLIGHT for a verified PostgreSQL protocol session.
-- Review before running; operator retains any output privately. Never upload it to a public PR.
-- This is a *read-only catalog inspection*, NOT a backup, migration, role grant or deployment.
-- IMPORTANT: CloudBase ExecutePGSql only supports one SQL per request; this file is intended
-- for native PostgreSQL connections (psql or a single verified pg.Client), not a multi-call API.
BEGIN READ ONLY;
SELECT current_database() AS database_name, current_user AS effective_user,
       session_user AS login_user, current_setting('role', true) AS selected_role,
       pg_backend_pid() AS backend_pid, current_setting('server_version') AS pg_version;
SELECT rolname, rolsuper, rolbypassrls, rolinherit, rolcanlogin
  FROM pg_roles
 WHERE rolname IN ('anon','authenticated','service_role')
    OR rolname = current_user OR rolname = session_user
 ORDER BY rolname;
-- Object existence, ownership, raw ACL and RLS: NULL ACL is not the same catalog value as owner-only GRANT.
SELECT c.oid::regclass::text AS relation_name, c.relkind, pg_get_userbyid(c.relowner) AS owner,
       c.relacl::text AS raw_acl, c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public'
   AND c.relname IN (
     'growth_family_members','growth_learning_records',
     'r5_fragment_state','r5_fragment_drops','r5_racing_events',
     'r5_racing_saves','r5_device','r5_backend_role',
     'r5_reward_config','r5_vehicle_recipe')
 ORDER BY c.relname;
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname='public'
   AND tablename IN ('r5_fragment_state','r5_fragment_drops',
                     'r5_racing_events','r5_racing_saves','r5_device',
                     'growth_family_members','growth_learning_records')
 ORDER BY tablename, policyname;
-- Collect signatures and privilege metadata, not full function bodies in public logs.
SELECT p.oid::regprocedure::text AS signature, pg_get_userbyid(p.proowner) AS owner,
       p.proacl::text AS raw_acl, p.prosecdef AS security_definer,
       p.proconfig AS function_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public'
   AND p.proname IN ('r5_fragment_snapshot','r5_fragment_claim',
                    'r5_fragment_assemble','r5_fragment_member_snapshot',
                    'r5_fragment_member_assemble','r5_fragment_scope_ok',
                    'r5_fragment_caller_role','r5_fragment_is_privileged')
 ORDER BY signature;
-- Never infer the cloud function's effective database role from this operator session alone.
-- Probe each runtime identity independently using the approved non-mutating route.
COMMIT;
