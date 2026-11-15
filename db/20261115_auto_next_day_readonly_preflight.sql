-- V6 C0.1 / 040 read-only production preflight.
-- Execute only with authorized read-only DBA access.
-- NEVER initializes families, publishes plans, advances a day, or changes scores.
-- Do not mistake report evidence for authorization to migrate.
BEGIN TRANSACTION READ ONLY;

DO $audit$
DECLARE
  family_key constant text := 'little-growth-family-001';
  today_date date := timezone('Asia/Shanghai',clock_timestamp())::date;
  objects jsonb := '{}'::jsonb;
  fn text; is_disabled boolean := false;
  progress_row jsonb; today_plan jsonb; yesterday_plan jsonb;
  evidence jsonb; record_count bigint;
BEGIN
  SELECT jsonb_object_agg(name,present) INTO objects FROM (VALUES
    ('r5_family_progress',to_regclass('public.r5_family_progress') IS NOT NULL),
    ('r5_daily_plan',to_regclass('public.r5_daily_plan') IS NOT NULL),
    ('growth_learning_records',to_regclass('public.growth_learning_records') IS NOT NULL),
    ('r5_day_passed',to_regprocedure('public.r5_day_passed(text,date)') IS NOT NULL),
    ('r5_day_evidence',to_regprocedure('public.r5_day_evidence(text,integer)') IS NOT NULL),
    ('r5_next_day_state_impl',to_regprocedure('public.r5_next_day_state_impl(text)') IS NOT NULL),
    ('r5_guard_record_write',to_regprocedure('public.r5_guard_record_write()') IS NOT NULL),
    ('r5_guard_plan_day',to_regprocedure('public.r5_guard_plan_day()') IS NOT NULL),
    ('r5_progress_maybe_advance',to_regprocedure('public.r5_progress_maybe_advance(text)') IS NOT NULL),
    ('r5_auto_rollover_day',to_regprocedure('public.r5_auto_rollover_day(text)') IS NOT NULL)
  ) t(name,present);
  RAISE NOTICE 'OBJECTS %',objects;

  IF to_regprocedure('public.r5_progress_maybe_advance(text)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.r5_progress_maybe_advance(text)'::regprocedure)
      INTO fn;
    is_disabled := position('disabled_requires_parent' in fn)>0;
  END IF;
  RAISE NOTICE 'C01_030_LEGACY_AUTO_ADVANCE_DISABLED %',is_disabled;

  IF to_regclass('public.growth_learning_records') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.growth_learning_records WHERE family_id=$1'
       INTO record_count USING family_key;
    RAISE NOTICE 'FAMILY_LEARNING_RECORDS %',record_count;
  END IF;

  IF to_regclass('public.r5_family_progress') IS NOT NULL THEN
    EXECUTE 'SELECT to_jsonb(p) FROM public.r5_family_progress p WHERE family_id=$1'
      INTO progress_row USING family_key;
    RAISE NOTICE 'FAMILY_PROGRESS %',COALESCE(progress_row::text,'NOT_INITIALIZED');
  END IF;

  IF to_regclass('public.r5_daily_plan') IS NOT NULL THEN
    EXECUTE 'SELECT to_jsonb(p) FROM public.r5_daily_plan p
      WHERE family_id=$1 AND study_date=$2'
      INTO today_plan USING family_key,today_date;
    EXECUTE 'SELECT to_jsonb(p) FROM public.r5_daily_plan p
      WHERE family_id=$1 AND study_date<$2
      ORDER BY study_date DESC LIMIT 1'
      INTO yesterday_plan USING family_key,today_date;
    RAISE NOTICE 'TODAY_DATE %',today_date;
    RAISE NOTICE 'TODAY_PLAN %',COALESCE(today_plan::text,'NONE');
    RAISE NOTICE 'LAST_EARLIER_PLAN %',COALESCE(yesterday_plan::text,'NONE');
  END IF;

  IF progress_row IS NOT NULL
     AND to_regprocedure('public.r5_day_evidence(text,integer)') IS NOT NULL THEN
    EXECUTE 'SELECT public.r5_day_evidence($1,$2)'
      INTO evidence
      USING family_key,(progress_row->>'authoritative_day')::integer;
    RAISE NOTICE 'AUTHORITATIVE_DAY_EVIDENCE %',evidence;
  END IF;

  IF is_disabled IS NOT TRUE AND
     to_regprocedure('public.r5_progress_maybe_advance(text)') IS NOT NULL THEN
    RAISE WARNING 'C0.1 030 NOT VERIFIED: 040 migration MUST NOT proceed';
  END IF;

  RAISE NOTICE 'READ_ONLY_PREFLIGHT_DONE_NO_MUTATIONS';
END;
$audit$;

COMMIT;
