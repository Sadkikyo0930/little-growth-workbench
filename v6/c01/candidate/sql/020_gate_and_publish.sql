-- =============================================================================
-- C0.1 candidate 020 — authoritative publish path + gate wrapper
-- =============================================================================
-- Deployment status: NOT APPLIED. Candidate for S6 (function replacement).
-- Requires 010. Reversible by 900_rollback.sql.
--
-- Replaced functions keep their EXACT production signatures, so old clients
-- (V6 build 2026-11-09, racing page) keep working without a redeploy:
--   r5_publish_today(text, integer, boolean)      <- same 3 args
--   r5_gate_status_core(text, boolean, boolean)   <- same 3 args
--   r5_status / r5_gate_status / r5_child_entry   <- untouched
--   r5_claim_answers / r5_parent_waive            <- untouched
--
-- Guarantees:
--   * growth_learning_records is only ever SELECTed here.
--   * 1800s quota / fail-closed / override predicate: delegated to
--     r5_gate_status_core_legacy (byte-identical production body).
--   * Day advancement is monotonic and idempotent per Asia/Shanghai date.
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- 1. r5_day_passed — conservative replay of one specific date
-- -----------------------------------------------------------------------------
-- Used ONLY to decide whether the authoritative day may advance. It replays the
-- production predicate for that date's own plan and that plan's own day index.
-- It does NOT consult historical credentials and does NOT look at other days:
-- advancement can therefore never be driven by a mis-attributed record.
CREATE OR REPLACE FUNCTION public.r5_day_passed(p_family_id text, p_date date)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  plan record; subject_name text; total_count integer; correct_count integer;
  finished boolean; waived boolean;
BEGIN
  SELECT day_index, subjects, published INTO plan
    FROM public.r5_daily_plan
   WHERE family_id = p_family_id AND study_date = p_date;
  IF NOT FOUND OR NOT plan.published THEN RETURN false; END IF;
  IF jsonb_array_length(plan.subjects) = 0 THEN RETURN false; END IF;

  FOR subject_name IN SELECT jsonb_array_elements_text(plan.subjects) LOOP
    SELECT count(*)::integer,
           count(*) FILTER (WHERE r.record_data #>> '{answer,correct}' = 'true')::integer
      INTO total_count, correct_count
      FROM public.growth_learning_records r
     WHERE r.family_id = p_family_id AND r.record_type = 'answer'
       AND r.subject = subject_name AND r.learning_day = plan.day_index
       AND left(r.record_data #>> '{answer,date}', 10) = p_date::text
       AND r.record_data #>> '{answer,correct}' IN ('true', 'false');

    SELECT EXISTS (
      SELECT 1 FROM public.growth_learning_records r
       WHERE r.family_id = p_family_id AND r.record_type = 'course-complete'
         AND r.subject = subject_name AND r.learning_day = plan.day_index
         AND CASE WHEN r.record_data->>'completed_at' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T'
                  THEN ((r.record_data->>'completed_at')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
                  ELSE NULL::date END = p_date
    ) INTO finished;

    waived := false;
    IF finished AND total_count = 0 THEN
      PERFORM 1 FROM public.r5_parent_waiver w
       WHERE w.family_id = p_family_id AND w.study_date = p_date
         AND w.subject = subject_name;
      waived := FOUND;
    END IF;

    IF NOT (finished AND ((total_count > 0 AND correct_count * 100 >= 80 * total_count)
                          OR (total_count = 0 AND waived))) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 2. r5_progress_ensure — create the row lazily, never overwrite, never guess
-- -----------------------------------------------------------------------------
-- INTERNAL: no EXECUTE grant. Only reachable from the SECURITY DEFINER functions
-- in this file (publish / advance), which authenticate first.
--
-- It may create day 1 for a brand-new family only (no plan row, no learning
-- record). A family that already has history is NOT initialised here: guessing
-- from history is exactly the C0.1 defect (real family: plans top out at day 2
-- while the parent is on day 3). Such a family stops with R5_DAY_NOT_INITIALIZED
-- until r5_initialize_authoritative_day() is run with a verified confirmation.
CREATE OR REPLACE FUNCTION public.r5_progress_ensure(p_family_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.r5_family_progress WHERE family_id = p_family_id) THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.r5_daily_plan WHERE family_id = p_family_id)
     OR EXISTS (SELECT 1 FROM public.growth_learning_records WHERE family_id = p_family_id) THEN
    RAISE EXCEPTION 'R5_DAY_NOT_INITIALIZED' USING ERRCODE = 'P0001',
      DETAIL = 'family has plan/record history; the authoritative day must come from a verified parent confirmation, not from history';
  END IF;

  INSERT INTO public.r5_family_progress (family_id, authoritative_day, initialized_from)
  VALUES (p_family_id, 1, 'new_family_day_1')
  ON CONFLICT (family_id) DO NOTHING;
END;
$function$;

COMMENT ON FUNCTION public.r5_progress_ensure(text) IS
  'C0.1 INTERNAL: creates day 1 for a brand-new family only. Existing history without a confirmation raises R5_DAY_NOT_INITIALIZED.';

-- -----------------------------------------------------------------------------
-- 3. r5_progress_maybe_advance — server-side advance on the first publish of a new date
-- -----------------------------------------------------------------------------
-- Called from r5_publish_today when there is no plan for today yet.
-- Advances by exactly ONE day, and only if the most recent earlier plan
--   (a) carries the current authoritative day, and
--   (b) actually passed on its own date.
-- Idempotent per date via last_advanced_on.
CREATE OR REPLACE FUNCTION public.r5_progress_maybe_advance(p_family_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  today_date date := timezone('Asia/Shanghai', clock_timestamp())::date;
  prog record; last_plan record; new_day integer;
BEGIN
  SELECT * INTO prog FROM public.r5_family_progress
   WHERE family_id = p_family_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'no_progress'); END IF;

  IF prog.last_advanced_on IS NOT NULL AND prog.last_advanced_on >= today_date THEN
    RETURN jsonb_build_object('result', 'already_advanced', 'authoritative_day', prog.authoritative_day);
  END IF;
  IF prog.authoritative_day >= 30 THEN
    RETURN jsonb_build_object('result', 'max_day_reached', 'authoritative_day', prog.authoritative_day);
  END IF;

  SELECT day_index, study_date INTO last_plan
    FROM public.r5_daily_plan
   WHERE family_id = p_family_id AND study_date < today_date
   ORDER BY study_date DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'no_previous_plan', 'authoritative_day', prog.authoritative_day);
  END IF;
  IF last_plan.day_index <> prog.authoritative_day THEN
    -- The previous plan belongs to another day (e.g. a stale row): never guess.
    RETURN jsonb_build_object('result', 'previous_plan_day_mismatch',
                              'authoritative_day', prog.authoritative_day,
                              'previous_plan_day', last_plan.day_index);
  END IF;
  IF NOT public.r5_day_passed(p_family_id, last_plan.study_date) THEN
    RETURN jsonb_build_object('result', 'previous_day_not_passed',
                              'authoritative_day', prog.authoritative_day,
                              'previous_plan_date', last_plan.study_date);
  END IF;

  new_day := prog.authoritative_day + 1;
  UPDATE public.r5_family_progress
     SET authoritative_day = new_day,
         previous_day = prog.authoritative_day,
         last_advanced_on = today_date,
         revision = revision + 1,
         updated_at = clock_timestamp()
   WHERE family_id = p_family_id;

  INSERT INTO public.r5_plan_audit
    (family_id, occurred_on, event, authoritative_day, plan_date, detail)
  VALUES
    (p_family_id, today_date, 'auto_advance', new_day, last_plan.study_date,
     jsonb_build_object('from', prog.authoritative_day, 'to', new_day,
                        'evidence_plan_date', last_plan.study_date));

  RETURN jsonb_build_object('result', 'advance_day',
                            'from', prog.authoritative_day, 'to', new_day,
                            'authoritative_day', new_day);
END;
$function$;

-- -----------------------------------------------------------------------------
-- 4. r5_advance_day — explicit, idempotent advance (bridge / parent retry)
-- -----------------------------------------------------------------------------
-- Client-facing, so it authenticates on its own:
--   * membership is required (R5_MEMBER_DENIED otherwise);
--   * the caller must be owner/parent — a grandparent or child session can no
--     longer move the authoritative day (p_require_parent = true);
--   * a family that is not initialised yet is refused with a result instead of
--     being silently created here.
CREATE OR REPLACE FUNCTION public.r5_advance_day(p_family_id text, p_expected_day integer DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  today_date date := timezone('Asia/Shanghai', clock_timestamp())::date;
  prog record; new_day integer;
BEGIN
  PERFORM public.r5_assert_member(p_family_id, true);
  SELECT * INTO prog FROM public.r5_family_progress
   WHERE family_id = p_family_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'day_not_initialized',
                              'message', 'authoritative day has not been initialised for this family');
  END IF;

  IF p_expected_day IS NOT NULL AND p_expected_day <> prog.authoritative_day THEN
    RETURN jsonb_build_object('result', 'stale_expected_day',
                              'expected', p_expected_day,
                              'authoritative_day', prog.authoritative_day);
  END IF;
  IF prog.last_advanced_on = today_date THEN
    RETURN jsonb_build_object('result', 'already_advanced',
                              'authoritative_day', prog.authoritative_day);
  END IF;
  IF prog.authoritative_day >= 30 THEN
    RETURN jsonb_build_object('result', 'max_day_reached',
                              'authoritative_day', prog.authoritative_day);
  END IF;
  IF NOT public.r5_day_passed(p_family_id, today_date) THEN
    RETURN jsonb_build_object('result', 'not_all_passed',
                              'authoritative_day', prog.authoritative_day);
  END IF;

  new_day := prog.authoritative_day + 1;
  UPDATE public.r5_family_progress
     SET authoritative_day = new_day,
         previous_day = prog.authoritative_day,
         last_advanced_on = today_date,
         revision = revision + 1,
         updated_at = clock_timestamp()
   WHERE family_id = p_family_id;

  INSERT INTO public.r5_plan_audit
    (family_id, occurred_on, event, authoritative_day, plan_date, detail)
  VALUES (p_family_id, today_date, 'advance_day', new_day, today_date,
          jsonb_build_object('from', prog.authoritative_day, 'to', new_day,
                             'source', 'explicit'));

  RETURN jsonb_build_object('result', 'advance_day',
                            'from', prog.authoritative_day, 'to', new_day,
                            'authoritative_day', new_day);
END;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Guard: a stale device must never insert today's plan with an older day
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_guard_plan_day()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  today_date date := timezone('Asia/Shanghai', clock_timestamp())::date;
  prog record;
BEGIN
  -- Only today's plan is guarded: historical rows/backfills are untouched.
  IF NEW.study_date <> today_date THEN RETURN NEW; END IF;
  SELECT authoritative_day, last_advanced_on INTO prog
    FROM public.r5_family_progress WHERE family_id = NEW.family_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  -- Allow re-inserting the plan that was just completed today (progress already
  -- points at tomorrow but last_advanced_on is today).
  IF prog.last_advanced_on = today_date THEN RETURN NEW; END IF;
  IF NEW.day_index < prog.authoritative_day THEN
    RAISE EXCEPTION 'R5_PLAN_DAY_REGRESSION' USING ERRCODE = '23514',
      DETAIL = format('plan day %s < authoritative day %s', NEW.day_index, prog.authoritative_day);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS r5_daily_plan_day_guard ON public.r5_daily_plan;
CREATE TRIGGER r5_daily_plan_day_guard
  BEFORE INSERT OR UPDATE ON public.r5_daily_plan
  FOR EACH ROW EXECUTE FUNCTION public.r5_guard_plan_day();

-- -----------------------------------------------------------------------------
-- 6. r5_publish_today — SAME signature, authoritative day instead of client day
-- -----------------------------------------------------------------------------
-- Behaviour change (the actual fix):
--   * p_day_index is treated as a CLIENT HINT only. The day that gets published
--     is r5_family_progress.authoritative_day.
--   * A stale client (day 1 while cloud is day 3) no longer writes a day-1 plan
--     and no longer raises for a foreign day: it receives the authoritative plan
--     plus {'stale_client': true, 'client_day': 1} and must stop uploading.
--   * A plan already published today for a different day is still locked
--     (R5_TODAY_PLAN_ALREADY_PUBLISHED) — nothing is silently rewritten.
CREATE OR REPLACE FUNCTION public.r5_publish_today(p_family_id text, p_day_index integer, p_no_tasks boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  today_date date := timezone('Asia/Shanghai', clock_timestamp())::date;
  claims jsonb; uid text; role_now text;
  prog record; desired jsonb; existing record; auth_day integer; stale boolean;
BEGIN
  -- --- unchanged authentication / authorisation -----------------------------
  claims := COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  uid := claims->>'sub';
  IF (claims->>'role') IS DISTINCT FROM 'authenticated' OR uid IS NULL THEN
    RAISE EXCEPTION 'R5_AUTH_REQUIRED' USING ERRCODE = '28000';
  END IF;
  SELECT m.member_role INTO role_now
    FROM public.growth_family_members m
   WHERE m.family_id = p_family_id AND m.user_id = uid;
  IF role_now IS NULL
     OR role_now NOT IN ('owner', 'parent', 'grandparent')
     OR (coalesce(p_no_tasks, false) AND role_now NOT IN ('owner', 'parent')) THEN
    RAISE EXCEPTION 'R5_MEMBER_DENIED' USING ERRCODE = '42501';
  END IF;
  IF p_no_tasks IS NULL THEN RAISE EXCEPTION 'R5_INVALID_PLAN'; END IF;
  IF p_day_index IS NULL OR p_day_index NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'R5_INVALID_DAY';
  END IF;

  -- --- authoritative day ----------------------------------------------------
  PERFORM public.r5_progress_ensure(p_family_id);
  PERFORM public.r5_progress_maybe_advance(p_family_id);
  SELECT * INTO prog FROM public.r5_family_progress WHERE family_id = p_family_id;
  auth_day := prog.authoritative_day;
  stale := (p_day_index <> auth_day);

  IF p_no_tasks THEN
    desired := '[]'::jsonb;
  ELSE
    SELECT subjects INTO desired FROM public.r5_subject_template WHERE day_index = auth_day;
    IF desired IS NULL THEN RAISE EXCEPTION 'R5_INVALID_DAY'; END IF;
  END IF;

  SELECT * INTO existing FROM public.r5_daily_plan
   WHERE family_id = p_family_id AND study_date = today_date;

  IF FOUND THEN
    IF existing.day_index <> auth_day
       OR existing.subjects <> desired
       OR NOT existing.published THEN
      INSERT INTO public.r5_plan_audit
        (family_id, occurred_on, event, client_day, authoritative_day, plan_date, actor, detail)
      VALUES (p_family_id, today_date, 'reject_plan_locked', p_day_index, auth_day,
              today_date, uid,
              jsonb_build_object('existing_day', existing.day_index,
                                 'requested_subjects', desired));
      RAISE EXCEPTION 'R5_TODAY_PLAN_ALREADY_PUBLISHED';
    END IF;
    INSERT INTO public.r5_plan_audit
      (family_id, occurred_on, event, client_day, authoritative_day, plan_date, actor, detail)
    VALUES (p_family_id, today_date,
            CASE WHEN stale THEN 'reject_stale_day' ELSE 'publish_idempotent' END,
            p_day_index, auth_day, today_date, uid, '{}'::jsonb);
    RETURN jsonb_build_object(
      'date', today_date, 'study_day', auth_day, 'subjects', desired, 'published', true,
      'authoritative_day', auth_day, 'client_day', p_day_index,
      'stale_client', stale, 'idempotent', true);
  END IF;

  INSERT INTO public.r5_daily_plan (family_id, study_date, day_index, subjects, published)
  VALUES (p_family_id, today_date, auth_day, desired, true);

  INSERT INTO public.r5_plan_audit
    (family_id, occurred_on, event, client_day, authoritative_day, plan_date, actor, detail)
  VALUES (p_family_id, today_date,
          CASE WHEN stale THEN 'reject_stale_day' ELSE 'publish' END,
          p_day_index, auth_day, today_date, uid,
          jsonb_build_object('subjects', desired, 'client_day', p_day_index));

  RETURN jsonb_build_object(
    'date', today_date, 'study_day', auth_day, 'subjects', desired, 'published', true,
    'authoritative_day', auth_day, 'client_day', p_day_index,
    'stale_client', stale);
END;
$function$;

-- -----------------------------------------------------------------------------
-- 7. r5_gate_status_core — SAME signature, delegates then adds credentials
-- -----------------------------------------------------------------------------
-- The 1800s quota, fail-closed behaviour and override semantics come from the
-- untouched production body (r5_gate_status_core_legacy). This wrapper only:
--   * substitutes a historical credential when today has NO evidence at all
--     (no answer row, no course-complete) — never overriding today's real data;
--   * surfaces PENDING_SCORE_SYNC / PENDING_VERIFICATION instead of guessing;
--   * adds authoritative_day + credential_engine markers.
CREATE OR REPLACE FUNCTION public.r5_gate_status_core(p_family_id text, p_entry boolean, p_ignore_override boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  base jsonb;
  auth_day integer;
  prog_day integer;
  prog record;
  item jsonb;
  out_modules jsonb := '[]'::jsonb;
  cred record;
  any_waived boolean := false;
  all_pass boolean := true;
  why text;
  plan_unpublished boolean;
  cfg record;
  remaining integer;
  override_active boolean;
  study_ok boolean;
BEGIN
  base := public.r5_gate_status_core_legacy(p_family_id, p_entry, p_ignore_override);
  plan_unpublished := (base->>'reason') = 'PLAN_UNPUBLISHED';
  all_pass := COALESCE((base->>'all_pass')::boolean, NOT plan_unpublished);
  any_waived := COALESCE((base->>'any_waived')::boolean, false);

  auth_day := NULLIF(base->>'study_day', '')::integer;
  SELECT authoritative_day INTO prog_day FROM public.r5_family_progress
   WHERE family_id = p_family_id;
  IF auth_day IS NULL THEN
    auth_day := prog_day;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(base->'modules', '[]'::jsonb)) LOOP
    IF COALESCE((item->>'passed')::boolean, false) = false
       AND COALESCE((item->>'total')::integer, 0) = 0
       AND COALESCE((item->>'completed')::boolean, false) = false
       AND auth_day IS NOT NULL THEN
      cred := NULL;
      SELECT * INTO cred
        FROM public.r5_credential_derive_impl(p_family_id) c
       WHERE c.authoritative_day = auth_day
         AND c.subject_canonical = (item->>'subject')
         AND c.verification_status IN ('VALID_SCORED', 'VALID_WAIVED',
                                       'PENDING_SCORE_SYNC', 'PENDING_VERIFICATION')
       ORDER BY CASE c.verification_status WHEN 'VALID_SCORED' THEN 0
                                           WHEN 'VALID_WAIVED' THEN 0
                                           WHEN 'PENDING_SCORE_SYNC' THEN 1
                                           ELSE 2 END,
                c.record_date DESC NULLS LAST
       LIMIT 1;

      IF cred.verification_status IN ('VALID_SCORED', 'VALID_WAIVED') THEN
        item := item || jsonb_build_object(
          'passed', true,
          'evidence', 'CREDENTIAL_FROM_HISTORY',
          'credential_status', cred.verification_status,
          'credential_source', cred.attribution_source,
          'credential_record_date', cred.record_date,
          'verification_status', cred.verification_status,
          'waived', cred.verification_status = 'VALID_WAIVED');
        IF cred.verification_status = 'VALID_WAIVED' THEN any_waived := true; END IF;
      ELSIF cred.verification_status IS NOT NULL THEN
        item := item || jsonb_build_object(
          'credential_status', cred.verification_status,
          'pending_score_sync', cred.verification_status = 'PENDING_SCORE_SYNC',
          'pending_verification', cred.verification_status = 'PENDING_VERIFICATION',
          'pending_reasons', to_jsonb(cred.pending_reasons),
          'credential_record_date', cred.record_date);
      END IF;
    END IF;
    IF COALESCE((item->>'waived')::boolean, false) THEN any_waived := true; END IF;
    out_modules := out_modules || jsonb_build_array(item);
    all_pass := all_pass AND COALESCE((item->>'passed')::boolean, false);
  END LOOP;

  IF jsonb_array_length(out_modules) = 0 THEN
    all_pass := NOT plan_unpublished;
  END IF;
  IF plan_unpublished THEN
    all_pass := false;
  END IF;

  SELECT enabled, daily_seconds, bonus_seconds INTO cfg
    FROM public.r5_parent_settings WHERE family_id = p_family_id;
  override_active := COALESCE((base->>'parent_override')::boolean, false);
  remaining := COALESCE((base->>'remaining_seconds')::integer, 0);

  IF plan_unpublished THEN
    why := 'PLAN_UNPUBLISHED';
  ELSIF (base->>'reason') = 'NO_TASKS_TODAY' THEN
    why := 'NO_TASKS_TODAY';
  ELSE
    why := CASE WHEN all_pass
                THEN CASE WHEN any_waived THEN 'STUDY_PASSED_WITH_WAIVER' ELSE 'STUDY_PASSED' END
                ELSE 'STUDY_INCOMPLETE_OR_SCORE_UNVERIFIED' END;
  END IF;

  study_ok := (all_pass AND why <> 'PLAN_UNPUBLISHED') OR override_active;
  IF remaining = 0 THEN why := 'TIME_LIMIT_REACHED';
  ELSIF NOT cfg.enabled THEN why := 'PARENT_CONTROL_DISABLED';
  ELSIF override_active AND NOT (all_pass AND why <> 'PLAN_UNPUBLISHED') THEN
    why := 'STUDY_PASSED_WITH_WAIVER';
  END IF;

  RETURN base || jsonb_build_object(
    'modules', out_modules,
    'all_pass', all_pass,
    'any_waived', any_waived,
    'reason', why,
    'allowed', (NOT cfg.enabled OR study_ok) AND remaining > 0,
    'study_passed', (all_pass AND why <> 'PLAN_UNPUBLISHED'),
    'authoritative_day', COALESCE(prog_day, auth_day),
    'graded_day', auth_day,
    'plan_source', 'authoritative_day',
    'credential_engine', 'c0.1');
END;
$function$;

COMMENT ON FUNCTION public.r5_gate_status_core(text, boolean, boolean) IS
  'C0.1: legacy production predicate + historical credential substitution. Quota chain unchanged.';

-- -----------------------------------------------------------------------------
-- 8. r5_refresh_credential_snapshot — audit helper (never read by the gate)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_refresh_credential_snapshot(p_family_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  today_date date := timezone('Asia/Shanghai', clock_timestamp())::date;
  n integer := 0;
  r record;
BEGIN
  PERFORM public.r5_assert_member(p_family_id, false);
  FOR r IN SELECT * FROM public.r5_credential_derive_impl(p_family_id) LOOP
    INSERT INTO public.r5_credential_snapshot
      (family_id, snapshot_date, credential_key, verification_status, learning_day_raw,
       subject_canonical, record_date, authoritative_day, pending_reasons, payload)
    VALUES
      (p_family_id, today_date, r.credential_key, r.verification_status, r.learning_day_raw,
       r.subject_canonical, r.record_date, r.authoritative_day, r.pending_reasons,
       to_jsonb(r))
    ON CONFLICT (family_id, snapshot_date, credential_key)
    DO UPDATE SET verification_status = excluded.verification_status,
                  authoritative_day = excluded.authoritative_day,
                  pending_reasons = excluded.pending_reasons,
                  payload = excluded.payload,
                  created_at = clock_timestamp();
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$function$;

COMMENT ON FUNCTION public.r5_refresh_credential_snapshot(text) IS
  'C0.1 INTERNAL: refreshes the audit-only credential snapshot. Membership-checked; no EXECUTE grant.';

-- -----------------------------------------------------------------------------
-- 9. Privileges — deny by default, grant the legacy client API only
-- -----------------------------------------------------------------------------
-- Production shipped these functions with the PostgreSQL default (EXECUTE to
-- PUBLIC, which includes `anon`). That is what we are closing: an unauthenticated
-- PostgREST call must not even reach the body. Authentication/authorisation
-- inside the bodies is untouched — 1800s quota, fail-closed and override
-- semantics still come from the verbatim legacy body.
--
-- Client-facing (GRANT authenticated):  r5_publish_today, r5_gate_status_core,
--                                       r5_advance_day
-- Internal (owner-only):                everything else, including the verbatim
--                                       _legacy copies, the day-replay helper and
--                                       the progress writers.
DO $priv$
DECLARE
  fn text;
  -- Client-facing API. Only these two can be reached from a PostgREST session.
  api_fns text[] := ARRAY[
    'public.r5_publish_today(text,integer,boolean)',
    'public.r5_advance_day(text,integer)'
  ];
  -- ``r5_gate_status_core`` belongs here, not above. The production ACL for it
  -- is service_role + owner and deliberately excludes `authenticated`: it takes
  -- p_ignore_override straight from the caller, so exposing it to a browser
  -- session would let a client bypass the parent override. Clients reach the
  -- gate through r5_status() -> r5_gate_status() -> r5_gate_status_core(),
  -- which are all SECURITY DEFINER and therefore run as the owner.
  internal_fns text[] := ARRAY[
    'public.r5_gate_status_core(text,boolean,boolean)',
    'public.r5_gate_status_core_legacy(text,boolean,boolean)',
    'public.r5_publish_today_legacy(text,integer,boolean)',
    'public.r5_day_passed(text,date)',
    'public.r5_progress_ensure(text)',
    'public.r5_progress_maybe_advance(text)',
    'public.r5_refresh_credential_snapshot(text)',
    'public.r5_guard_plan_day()'
  ];
  -- Functions the racing site calls with the service key. Production already
  -- grants these to service_role; a fresh install must reproduce that or the
  -- server-to-server path breaks.
  svc_fns text[] := ARRAY[
    'public.r5_gate_status_core(text,boolean,boolean)',
    'public.r5_publish_today(text,integer,boolean)'
  ];
BEGIN
  FOREACH fn IN ARRAY internal_fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY api_fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY svc_fns LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
  END LOOP;
END;
$priv$;

COMMIT;
