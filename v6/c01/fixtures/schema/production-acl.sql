-- =============================================================================
-- Production ACL baseline — the grants CloudBase carries TODAY
-- =============================================================================
-- Source of truth: a read-only `SELECT ... FROM pg_proc ... aclexplode(proacl)`
-- against CloudBase PostgreSQL environment normal-goose-d5g4qyzr8bb389a4a
-- (ap-shanghai, public schema, owner role cloudbase_postgres_postgres_130fh140)
-- on 2026-11-14. Nothing was written there.
--
-- Why this file exists: `base-schema.sql` creates functions with the PostgreSQL
-- default ACL (`EXECUTE` to PUBLIC). Production does NOT look like that — every
-- r5_* function carries an explicit ACL with no PUBLIC entry at all, and the two
-- gate functions are narrowed further:
--
--   r5_gate_status_core(text,boolean,boolean) : service_role + owner
--   r5_gate_status(text,boolean)              : service_role + owner
--   r5_override_active(text,text,boolean)     : service_role + owner
--   r5_publish_today(text,integer,boolean)    : authenticated + service_role + owner
--   everything else in this fixture           : authenticated + service_role + owner
--
-- Without this file the isolated environment starts from an ACL that production
-- never had, and a rollback test can "pass" while restoring a privilege
-- (PUBLIC EXECUTE on the gate) that production deliberately does not have.
--
-- This fixture is applied AFTER `base-schema.sql` and after the two production
-- function bodies exist, and BEFORE any candidate migration.
-- =============================================================================
DO $acl$
DECLARE
  v_owner text := current_user;
  v_spec  record;
  v_role  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;

  FOR v_spec IN
    SELECT * FROM (VALUES
      ('r5_assert_member(text,boolean)',            ARRAY['authenticated', 'service_role']),
      ('r5_child_entry(text)',                      ARRAY['authenticated', 'service_role']),
      ('r5_claim_answers(text,jsonb)',              ARRAY['authenticated', 'service_role']),
      ('r5_parent_waive(text,text,text,boolean)',   ARRAY['authenticated', 'service_role']),
      ('r5_publish_today(text,integer,boolean)',    ARRAY['authenticated', 'service_role']),
      ('r5_status(text)',                           ARRAY['authenticated', 'service_role']),
      ('r5_gate_status(text,boolean)',              ARRAY['service_role']),
      ('r5_gate_status_core(text,boolean,boolean)', ARRAY['service_role']),
      ('r5_override_active(text,text,boolean)',     ARRAY['service_role'])
    ) AS t(sig, grantees)
  LOOP
    -- start from "nobody", then grant exactly what production grants
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', v_spec.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM anon', v_spec.sig);
    FOREACH v_role IN ARRAY v_spec.grantees LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO %I', v_spec.sig, v_role);
    END LOOP;
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO %I', v_spec.sig, v_owner);
  END LOOP;
END;
$acl$;
