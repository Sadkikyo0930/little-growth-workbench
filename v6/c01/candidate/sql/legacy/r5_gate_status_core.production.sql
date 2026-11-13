-- VERBATIM production source of public.r5_gate_status_core, captured read-only from
-- CloudBase PostgreSQL (normal-goose-d5g4qyzr8bb389a4a, ap-shanghai, public schema)
-- on 2026-11-14 via pg_get_functiondef().
--
-- prosrc md5 in production: f78aceeba9c934fa8f4b5c754daba101
-- The ONLY change in this file is the function name: r5_gate_status_core -> r5_gate_status_core_legacy.
-- Everything inside $function$ is byte-identical, so md5(prosrc) must stay f78aceeba9c934fa8f4b5c754daba101.
-- tests/sql/01_legacy_parity.test.mjs asserts exactly that.
--
-- Why keep a copy: the new authoritative-day engine must not rewrite the 1800s quota /
-- fail-closed / override predicate. It delegates to this unchanged body and only layers
-- historical-credential substitution on top.
CREATE OR REPLACE FUNCTION public.r5_gate_status_core_legacy(p_family_id text, p_entry boolean, p_ignore_override boolean)
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
$function$
