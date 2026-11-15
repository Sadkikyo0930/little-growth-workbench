-- V6 learning day auto-rollover, C0.1 r3 extension (040).
-- DEPENDENCIES: apply and verify user-supplied 010_authoritative_day.sql,
-- 020_gate_and_publish.sql, and 030_cross_day.sql BEFORE applying this file.
-- Never initialize an existing family from MAX(day_index). Do not run on
-- production until existing family progress has been verified and confirmed.
-- No production data, family IDs, passwords, or test child scores embedded.
-- All dates use Asia/Shanghai; no client-provided day or calendar date.
BEGIN;
DO $preflight$
BEGIN
  IF to_regclass('public.r5_family_progress') IS NULL
    OR to_regclass('public.r5_plan_audit') IS NULL
    OR to_regclass('public.r5_daily_plan') IS NULL
    OR to_regclass('public.r5_subject_template') IS NULL
    OR to_regprocedure('public.r5_day_passed(text,date)') IS NULL
    OR to_regprocedure('public.r5_guard_plan_day()') IS NULL
    OR to_regprocedure('public.r5_assert_member(text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'R5_AUTO_DAY_C01_R3_REQUIRED' USING ERRCODE='P0001';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.r5_auto_rollover_day(p_family_id text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE
  today_date date := timezone('Asia/Shanghai', clock_timestamp())::date;
  actor_uid text; prog record; plan record; evidence jsonb;
  latest_plan date; latest_day integer; passed boolean; result_state text;
  current_day integer; from_day integer; to_day integer; desired jsonb;
BEGIN
  -- A grandparent is a valid family member; authorization never depends on
  -- which device reaches the server first. Anonymous/cross-family denied.
  actor_uid := public.r5_assert_member(p_family_id, false);

  -- Single serializable decision per family: all concurrent devices wait on
  -- the same row lock and then recheck today's result. No +2 after midnight.
  SELECT * INTO prog
    FROM public.r5_family_progress
   WHERE family_id=p_family_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result','day_not_initialized',
      'advanced',false,'published',false,'authoritative_day',NULL);
  END IF;
  current_day := prog.authoritative_day;
  IF current_day NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'R5_AUTO_DAY_INVALID_PROGRESS' USING ERRCODE='23514';
  END IF;

  SELECT * INTO plan FROM public.r5_daily_plan
   WHERE family_id=p_family_id AND study_date=today_date;
  IF FOUND THEN
    IF plan.day_index <> current_day THEN
      RETURN jsonb_build_object('result','plan_progress_mismatch',
        'advanced',false,'published',false,'plan_day',plan.day_index,
        'authoritative_day',current_day);
    END IF;
    RETURN jsonb_build_object('result','already_published',
      'advanced',false,'published',plan.published,
      'study_day',plan.day_index,'authoritative_day',current_day,
      'study_date',today_date);
  END IF;

  -- Check only real records of the current authoritative learning day.
  -- A yesterday plan is required, and it must pass the server's existing
  -- day evidence test. Never infer correctness from browser-only progress.
  -- Use the REAL C0.1 server-side two-subject evidence function, never a
  -- fixture-only r5_day_evidence or browser completedDays.
  SELECT study_date, day_index INTO latest_plan, latest_day
    FROM public.r5_daily_plan
   WHERE family_id=p_family_id AND study_date<today_date
   ORDER BY study_date DESC
   LIMIT 1;
  passed := latest_plan IS NOT NULL
    AND latest_day=current_day
    AND public.r5_day_passed(p_family_id,latest_plan);
  from_day := current_day;
  to_day := current_day;
  result_state := 'carry_over';

  IF latest_plan IS NOT NULL AND latest_day=current_day AND passed
     AND prog.last_advanced_on IS DISTINCT FROM today_date
     AND current_day < 30 THEN
    to_day := current_day + 1;
    UPDATE public.r5_family_progress
       SET authoritative_day=to_day,
           previous_day=current_day,
           last_advanced_on=today_date,
           revision=prog.revision+1,
           updated_at=clock_timestamp()
     WHERE family_id=p_family_id;
    INSERT INTO public.r5_plan_audit
      (family_id,occurred_on,event,authoritative_day,plan_date,actor,detail)
    VALUES
      (p_family_id,today_date,'auto_advance',to_day,latest_plan,actor_uid,
       jsonb_build_object('from',current_day,'to',to_day,
         'source','server_verified_next_calendar_day',
         'evidence_plan_date',latest_plan,
         'evidence_passed',passed));
    result_state := 'advanced';
  ELSIF current_day >= 30 THEN
    result_state := 'max_day_reached';
  ELSIF latest_plan IS NOT NULL AND latest_day<>current_day THEN
    result_state := 'previous_plan_day_mismatch';
  ELSIF latest_plan IS NOT NULL AND NOT passed THEN
    result_state := 'previous_day_incomplete';
  ELSIF latest_plan IS NULL THEN
    result_state := 'no_previous_plan';
  ELSIF prog.last_advanced_on = today_date THEN
    result_state := 'already_advanced_today';
  END IF;

  -- Publish the selected day and its canonical two subjects *in the same
  -- transaction*. No fabricated answer, no parent waiver, no quota mutation.
  SELECT subjects INTO desired
    FROM public.r5_subject_template
   WHERE day_index=to_day;
  IF desired IS NULL OR jsonb_typeof(desired) <> 'array' THEN
    RAISE EXCEPTION 'R5_AUTO_DAY_TEMPLATE_MISSING' USING ERRCODE='P0001';
  END IF;
  INSERT INTO public.r5_daily_plan
      (family_id,study_date,day_index,subjects,published)
    VALUES (p_family_id,today_date,to_day,desired,true);

  INSERT INTO public.r5_plan_audit
      (family_id,occurred_on,event,authoritative_day,plan_date,actor,detail)
    VALUES (p_family_id,today_date,'auto_publish',to_day,today_date,actor_uid,
            jsonb_build_object('rollover_result',result_state,
              'from',from_day,'to',to_day,
              'evidence_plan_date',latest_plan));

  RETURN jsonb_build_object('result',result_state,
    'advanced',to_day>from_day,'published',true,
    'from',from_day,'to',to_day,'study_day',to_day,
    'authoritative_day',to_day,'study_date',today_date,
    'subjects',desired,'evidence_plan_date',latest_plan);
END;
$function$;

COMMENT ON FUNCTION public.r5_auto_rollover_day(text) IS
'V6 040: next-calendar-day atomic server-verified rollover. Idempotent under family row lock; authenticated member can trigger; no automatic initialization or score mutation.';

REVOKE ALL ON FUNCTION public.r5_auto_rollover_day(text) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.r5_auto_rollover_day(text) FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.r5_auto_rollover_day(text) TO authenticated;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION public.r5_auto_rollover_day(text) TO service_role;
  END IF;
END;
$grant$;
COMMIT;
