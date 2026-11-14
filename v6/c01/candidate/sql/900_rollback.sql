-- =============================================================================
-- C0.1 candidate 900 — rollback for 010 + 020
-- =============================================================================
-- Restores production behaviour EXACTLY and removes every object created by 010/020.
--
-- Properties:
--   * Touches no child data: growth_learning_records, growth_family_members,
--     r5_parent_settings, r5_racing_saves, r5_parent_waiver are not modified.
--   * Drops only tables that 010 created (progress / audit / snapshot /
--     day-confirmation). Losing them is safe for the child's data: the tables hold
--     no learning record, and a re-deploy re-initialises through the verified
--     parent confirmation — never by re-deriving from published plans.
--     Child records are never affected.
--   * Re-creates r5_gate_status_core and r5_publish_today from the verbatim
--     production bodies (md5 f78aceeba9c934fa8f4b5c754daba101 / b0d8d2deb58ab5240c9207e6b5081ea3).
--   * Restores the EXACT pre-migration EXECUTE grants of those two functions
--     (step 5). It never grants anything to PUBLIC unconditionally: production
--     has no PUBLIC grant on either function, and r5_gate_status_core accepts
--     p_ignore_override from its caller.
--
-- Order matters: drop the guard trigger BEFORE dropping progress, restore the
-- real functions BEFORE dropping the helper they depended on, and restore the
-- ACL BEFORE dropping the table that captured it.
-- =============================================================================
BEGIN;

-- 1. remove the stale-device guard first (it references r5_family_progress)
DROP TRIGGER IF EXISTS r5_daily_plan_day_guard ON public.r5_daily_plan;
DROP FUNCTION IF EXISTS public.r5_guard_plan_day();

-- 2. restore production r5_gate_status_core (verbatim, see legacy/*.production.sql)
CREATE OR REPLACE FUNCTION public.r5_gate_status_core(p_family_id text, p_entry boolean, p_ignore_override boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  today_date date := timezone('Asia/Shanghai', clock_timestamp())::date;
  user_id text; cfg record; plan record; usage record; subject_name text;
  total_count integer; correct_count integer; finished boolean; waived boolean;
  item_pass boolean; all_pass boolean := true; any_waived boolean := false;
  module_states jsonb := '[]'::jsonb;
  limit_seconds integer; used_seconds integer; remaining integer;
  permitted boolean; why text; is_active boolean := false;
  override_active boolean := false; study_ok boolean;
BEGIN
  user_id := public.r5_assert_member(p_family_id, false);
  IF NOT p_ignore_override THEN
    override_active := public.r5_override_active(p_family_id, user_id, p_entry);
  END IF;
  SELECT enabled, daily_seconds, bonus_seconds INTO cfg
    FROM public.r5_parent_settings WHERE family_id = p_family_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'R5_SETTINGS_MISSING'; END IF;
  SELECT day_index, subjects, published INTO plan
    FROM public.r5_daily_plan WHERE family_id = p_family_id AND study_date = today_date;
  IF NOT FOUND OR NOT plan.published THEN
    all_pass := false; why := 'PLAN_UNPUBLISHED';
  ELSIF jsonb_array_length(plan.subjects) = 0 THEN
    why := 'NO_TASKS_TODAY';
  ELSE
    FOR subject_name IN SELECT jsonb_array_elements_text(plan.subjects) LOOP
      waived := false;
      SELECT count(*)::integer,
             count(*) FILTER (WHERE r.record_data #>> '{answer,correct}' = 'true')::integer
      INTO total_count, correct_count
      FROM public.growth_learning_records r
      WHERE r.family_id = p_family_id AND r.record_type = 'answer'
        AND r.subject = subject_name AND r.learning_day = plan.day_index
        AND left(r.record_data #>> '{answer,date}', 10) = today_date::text
        AND r.record_data #>> '{answer,correct}' IN ('true', 'false');
      SELECT EXISTS (
        SELECT 1 FROM public.growth_learning_records r
        WHERE r.family_id = p_family_id AND r.record_type = 'course-complete'
          AND r.subject = subject_name AND r.learning_day = plan.day_index
          AND CASE
            WHEN r.record_data->>'completed_at' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T'
            THEN ((r.record_data->>'completed_at')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
            ELSE NULL::date END = today_date
      ) INTO finished;
      item_pass := finished AND total_count > 0 AND correct_count * 100 >= 80 * total_count;
      IF NOT item_pass AND finished AND total_count = 0 THEN
        PERFORM 1 FROM public.r5_parent_waiver w
         WHERE w.family_id = p_family_id AND w.study_date = today_date AND w.subject = subject_name;
        IF FOUND THEN waived := true; item_pass := true; any_waived := true; END IF;
      END IF;
      all_pass := all_pass AND item_pass;
      module_states := module_states || jsonb_build_array(jsonb_build_object(
        'subject', subject_name, 'completed', finished,
        'correct', correct_count, 'total', total_count,
        'accuracy_pct', CASE WHEN total_count > 0
            THEN round(correct_count * 100.0 / total_count, 1) ELSE NULL END,
        'waived', waived,
        'evidence', CASE
          WHEN total_count > 0 AND item_pass THEN 'SCORED'
          WHEN waived THEN 'COMPLETED_UNSCORED_WAIVED'
          WHEN total_count > 0 THEN 'SCORED_BELOW_THRESHOLD'
          WHEN finished THEN 'COMPLETED_UNSCORED'
          ELSE 'NOT_COMPLETED' END,
        'passed', item_pass));
    END LOOP;
    why := CASE WHEN all_pass THEN
             CASE WHEN any_waived THEN 'STUDY_PASSED_WITH_WAIVER' ELSE 'STUDY_PASSED' END
           ELSE 'STUDY_INCOMPLETE_OR_SCORE_UNVERIFIED' END;
  END IF;
  SELECT used_ms, active INTO usage FROM public.r5_daily_usage
   WHERE family_id = p_family_id AND play_date = today_date;
  IF FOUND THEN
    used_seconds := ceil(usage.used_ms / 1000.0)::integer; is_active := usage.active;
  ELSE
    used_seconds := 0;
  END IF;
  limit_seconds := cfg.daily_seconds + cfg.bonus_seconds;
  remaining := greatest(0, limit_seconds - used_seconds);
  study_ok := (all_pass AND why <> 'PLAN_UNPUBLISHED') OR override_active;
  permitted := (NOT cfg.enabled OR study_ok) AND remaining > 0;
  IF remaining = 0 THEN why := 'TIME_LIMIT_REACHED';
  ELSIF NOT cfg.enabled THEN why := 'PARENT_CONTROL_DISABLED';
  ELSIF override_active AND NOT (all_pass AND why <> 'PLAN_UNPUBLISHED') THEN
    why := 'STUDY_PASSED_WITH_WAIVER';
  END IF;
  RETURN jsonb_build_object(
    'api', 'r5_status', 'date', today_date,
    'allowed', permitted, 'reason', why,
    'parent_control', cfg.enabled,
    'daily_seconds', cfg.daily_seconds, 'bonus_seconds', cfg.bonus_seconds,
    'used_seconds', used_seconds, 'remaining_seconds', remaining,
    'active', is_active,
    'parent_override', override_active,
    'study_passed', (all_pass AND why <> 'PLAN_UNPUBLISHED'),
    'override_single_use', true,
    'session_bound', true,
    'modules', module_states,
    'schedule_published', COALESCE(plan.published, false),
    'study_day', plan.day_index);
END;
$function$;

-- 3. restore production r5_publish_today (verbatim)
CREATE OR REPLACE FUNCTION public.r5_publish_today(p_family_id text, p_day_index integer, p_no_tasks boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE today_date date:=timezone('Asia/Shanghai',clock_timestamp())::date;
 member_id text; expected jsonb; existing record; desired jsonb; claims jsonb; uid text;
BEGIN
 -- Strict: real membership required, device identities are rejected here.
 claims:=COALESCE(NULLIF(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
 uid:=claims->>'sub';
 IF (claims->>'role') IS DISTINCT FROM 'authenticated' OR uid IS NULL THEN
  RAISE EXCEPTION 'R5_AUTH_REQUIRED' USING ERRCODE='28000';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.growth_family_members m
    WHERE m.family_id=p_family_id AND m.user_id=uid
      AND m.member_role IN ('owner','parent','grandparent')
      AND (NOT coalesce(p_no_tasks,false) OR m.member_role IN ('owner','parent'))) THEN
  RAISE EXCEPTION 'R5_MEMBER_DENIED' USING ERRCODE='42501';
 END IF;
 member_id:=uid;
 IF p_no_tasks IS NULL THEN RAISE EXCEPTION 'R5_INVALID_PLAN'; END IF;
 IF p_no_tasks THEN
  desired:='[]'::jsonb;
  IF p_day_index NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'R5_INVALID_DAY'; END IF;
 ELSE
  SELECT subjects INTO expected FROM public.r5_subject_template WHERE day_index=p_day_index;
  IF expected IS NULL THEN RAISE EXCEPTION 'R5_INVALID_DAY'; END IF;
  desired:=expected;
 END IF;
 INSERT INTO public.r5_daily_plan(family_id,study_date,day_index,subjects,published)
 VALUES(p_family_id,today_date,p_day_index,desired,true)
 ON CONFLICT DO NOTHING;
 SELECT * INTO existing FROM public.r5_daily_plan
 WHERE family_id=p_family_id AND study_date=today_date;
 IF existing.day_index<>p_day_index OR existing.subjects<>desired OR NOT existing.published THEN
  RAISE EXCEPTION 'R5_TODAY_PLAN_ALREADY_PUBLISHED';
 END IF;
 RETURN jsonb_build_object('date',today_date,'study_day',p_day_index,
  'subjects',desired,'published',true);
END $function$;

-- 4. drop C0.1 helper functions (deepest dependency first: the SQL-language
--    *_impl bodies depend on r5_subject_canonical and on the 010 tables)
DROP FUNCTION IF EXISTS public.r5_refresh_credential_snapshot(text);
DROP FUNCTION IF EXISTS public.r5_initialize_authoritative_day(text, integer, text, text, jsonb);
DROP FUNCTION IF EXISTS public.r5_initialize_authoritative_day(text, integer, text, text);
DROP FUNCTION IF EXISTS public.r5_initialization_snapshot(text);
DROP FUNCTION IF EXISTS public.r5_initialization_snapshot_impl(text);
DROP FUNCTION IF EXISTS public.r5_credential_derive(text, jsonb);
DROP FUNCTION IF EXISTS public.r5_credential_derive_impl(text, jsonb);
DROP FUNCTION IF EXISTS public.r5_advance_day(text, integer);
DROP FUNCTION IF EXISTS public.r5_progress_maybe_advance(text);
DROP FUNCTION IF EXISTS public.r5_progress_ensure(text);
DROP FUNCTION IF EXISTS public.r5_day_passed(text, date);
DROP FUNCTION IF EXISTS public.r5_subject_canonical(text);
DROP FUNCTION IF EXISTS public.r5_publish_today_legacy(text, integer, boolean);
DROP FUNCTION IF EXISTS public.r5_gate_status_core_legacy(text, boolean, boolean);

-- 5. restore the EXACT pre-migration ACL of the two functions 020 replaced
-- -----------------------------------------------------------------------------
-- Restoring the body is only half a rollback: the grants are part of the
-- contract. `CREATE OR REPLACE FUNCTION` preserves proacl, but 020 deliberately
-- re-wrote it (REVOKE ALL FROM PUBLIC + explicit grants), so the ACL must be put
-- back or the instance keeps the migration's privilege shape forever.
--
-- What it must go back to, read-only from production pg_proc on 2026-11-14:
--
--   r5_gate_status_core(text,boolean,boolean)  service_role + owner
--   r5_publish_today(text,integer,boolean)     authenticated + service_role + owner
--
-- In particular there is NO PUBLIC grant. `CREATE OR REPLACE FUNCTION` on a
-- function that never had one does not add it, and neither may the rollback:
-- `r5_gate_status_core` accepts `p_ignore_override` from its caller, so PUBLIC
-- EXECUTE on it is the parent-override bypass handed to `anon`.
--
-- Two sources, in order of authority:
--   1. public.r5_acl_baseline — what 010 captured while it was still live;
--   2. the literal production ACL above — only when 010 never ran here.
-- Either way the result is read back and compared; a mismatch aborts the whole
-- rollback instead of leaving a wider grant in place.
DO $acl$
DECLARE
  v_fn           record;
  v_have_baseline boolean := to_regclass('public.r5_acl_baseline') IS NOT NULL;
  v_grantee      text;
  v_grantable    boolean;
  v_want         text[];
  v_got          text[];
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _r5_acl_target (
    grantee text, privilege text, grantable boolean) ON COMMIT DROP;

  FOR v_fn IN
    SELECT p.oid, p.proname, p.proowner,
           p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig,
           pg_get_userbyid(p.proowner) AS owner_name
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('r5_gate_status_core', 'r5_publish_today')
  LOOP
    TRUNCATE _r5_acl_target;

    -- (1) the captured pre-migration grants, when 010 left them behind
    IF v_have_baseline THEN
      EXECUTE format(
        'INSERT INTO _r5_acl_target (grantee, privilege, grantable)
           SELECT grantee, privilege, is_grantable
             FROM public.r5_acl_baseline
            WHERE obj_kind = %L AND signature = %L',
        'function', v_fn.sig);
    END IF;

    -- (2) fall back to the production ACL only when nothing was captured
    IF NOT EXISTS (SELECT 1 FROM _r5_acl_target) THEN
      INSERT INTO _r5_acl_target (grantee, privilege, grantable)
      SELECT g, 'EXECUTE', false
        FROM unnest(
          CASE v_fn.proname
            WHEN 'r5_gate_status_core'
              THEN ARRAY[v_fn.owner_name, 'service_role']
            ELSE ARRAY[v_fn.owner_name, 'authenticated', 'service_role']
          END) AS g;
    END IF;

    -- Revoke from every role that currently holds a grant (so a widened ACL can
    -- never survive) plus PUBLIC and every role the target names. Revoking from
    -- a role that holds nothing is a no-op, so this is idempotent.
    FOR v_grantee IN
      SELECT DISTINCT g FROM (
        SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS g
          FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_fn.oid),
                                   acldefault('f', v_fn.proowner))) a
        UNION SELECT grantee FROM _r5_acl_target
        UNION SELECT 'PUBLIC'
      ) s
    LOOP
      IF v_grantee = 'PUBLIC' THEN
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', v_fn.sig);
      ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_grantee) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I', v_fn.sig, v_grantee);
      END IF;
    END LOOP;

    FOR v_grantee, v_grantable IN
      SELECT grantee, grantable FROM _r5_acl_target ORDER BY grantee
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_grantee) THEN
        RAISE EXCEPTION 'R5_ROLLBACK_ACL_ROLE_MISSING: role % no longer exists', v_grantee;
      END IF;
      IF v_grantee = 'PUBLIC' THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO PUBLIC%s', v_fn.sig,
                       CASE WHEN v_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      ELSE
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO %I%s', v_fn.sig, v_grantee,
                       CASE WHEN v_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      END IF;
    END LOOP;

    -- Read it back. Order-insensitive set comparison, per function and per
    -- signature: exactly the grants that existed before the migration, no more.
    SELECT array_agg(g || ':' || p ORDER BY g, p) INTO v_got
      FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                        WHEN a.grantee = v_fn.proowner THEN 'OWNER'
                        ELSE pg_get_userbyid(a.grantee) END AS g,
                   a.privilege_type AS p
              FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_fn.oid),
                                       acldefault('f', v_fn.proowner))) a) s;
    SELECT array_agg(w ORDER BY w) INTO v_want FROM (
      SELECT CASE WHEN grantee = v_fn.owner_name THEN 'OWNER' ELSE grantee END
             || ':' || privilege AS w
        FROM _r5_acl_target) t2;

    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION 'R5_ROLLBACK_ACL_MISMATCH: % expected [%] got [%]',
        v_fn.sig, array_to_string(v_want, ', '), array_to_string(v_got, ', ');
    END IF;
  END LOOP;
END;
$acl$;

-- 6. drop C0.1 tables (no child data inside)
DROP TABLE IF EXISTS public.r5_day_confirmation;
DROP TABLE IF EXISTS public.r5_credential_snapshot;
DROP TABLE IF EXISTS public.r5_plan_audit;
DROP TABLE IF EXISTS public.r5_family_progress;
-- the ACL capture has been consumed above; it belongs to the migration too
DROP TABLE IF EXISTS public.r5_acl_baseline;

COMMIT;
