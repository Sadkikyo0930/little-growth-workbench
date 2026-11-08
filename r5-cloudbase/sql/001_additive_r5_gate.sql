-- R5 v0.1 additive migration. NEVER touches V6 history or existing policies.
-- Stage after read-only preflight and explicit database deployment permission.
BEGIN;
DO $guard$
BEGIN
 IF to_regclass('public.growth_learning_records') IS NULL OR to_regclass('public.growth_family_members') IS NULL
    OR to_regprocedure('public.growth_is_family_member(text)') IS NULL THEN
   RAISE EXCEPTION 'Existing V6 family schema absent: abort R5 installation';
 END IF;
 IF EXISTS (
   SELECT 1 FROM (VALUES
     ('growth_learning_records','family_id'),('growth_learning_records','record_type'),
     ('growth_learning_records','record_data'),('growth_learning_records','subject'),
     ('growth_learning_records','learning_day'),
     ('growth_family_members','family_id'),('growth_family_members','user_id'),
     ('growth_family_members','member_role')
   ) AS required(table_name,column_name)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema='public' AND c.table_name=required.table_name
       AND c.column_name=required.column_name)
 ) THEN RAISE EXCEPTION 'Expected V6 columns absent: abort R5 installation'; END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS public.r5_daily_plan (
 family_id text NOT NULL, study_date date NOT NULL, day_index integer NOT NULL,
 subjects jsonb NOT NULL CHECK (jsonb_typeof(subjects)='array'
   AND jsonb_array_length(subjects) <= 2),
 published boolean NOT NULL DEFAULT true,
 PRIMARY KEY(family_id,study_date)
);
CREATE TABLE IF NOT EXISTS public.r5_parent_settings (
 family_id text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true,
 daily_seconds integer NOT NULL DEFAULT 1800 CHECK (daily_seconds BETWEEN 60 AND 10800),
 bonus_seconds integer NOT NULL DEFAULT 0 CHECK (bonus_seconds BETWEEN 0 AND 7200),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by text
);
CREATE TABLE IF NOT EXISTS public.r5_daily_usage (
 family_id text NOT NULL, play_date date NOT NULL,
 used_ms bigint NOT NULL DEFAULT 0 CHECK (used_ms>=0),
 active boolean NOT NULL DEFAULT false, last_beat timestamptz,
 PRIMARY KEY(family_id,play_date)
);
-- Private backend state. All access is through verified RPCs.
REVOKE ALL ON public.r5_daily_plan, public.r5_parent_settings, public.r5_daily_usage
 FROM PUBLIC, anon, authenticated;
ALTER TABLE public.r5_daily_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_parent_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_daily_usage ENABLE ROW LEVEL SECURITY;

-- The V6 published 30-day plan, starting November 9. Never overwrite edits.
WITH schedule AS (
 SELECT subjects, ordinality::integer AS day_index
 FROM jsonb_array_elements('[["英语","科学"],["语文","数学"],["数学","英语"],["语文","英语"],["数学","科学"],["语文","数学"],["语文","英语"],["英语","科学"],["语文","数学"],["数学","英语"],["语文","英语"],["数学","科学"],["语文","数学"],["语文","英语"],["英语","科学"],["语文","数学"],["数学","英语"],["语文","英语"],["数学","科学"],["语文","数学"],["语文","英语"],["英语","科学"],["语文","数学"],["数学","英语"],["语文","英语"],["数学","科学"],["语文","数学"],["语文","英语"],["英语","科学"],["语文","数学"]]'::jsonb)
 WITH ORDINALITY AS x(subjects,ordinality)
)
INSERT INTO public.r5_daily_plan(family_id,study_date,day_index,subjects,published)
SELECT 'little-growth-family-001', date '2026-11-09'+(day_index-1),
       day_index,subjects,true FROM schedule
ON CONFLICT DO NOTHING;
INSERT INTO public.r5_parent_settings(family_id)
VALUES ('little-growth-family-001') ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.r5_assert_member(p_family_id text,p_parent boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE claims jsonb; uid text; role_name text;
BEGIN
 claims:=COALESCE(NULLIF(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
 uid:=claims->>'sub'; role_name:=claims->>'role';
 IF role_name IS DISTINCT FROM 'authenticated' OR uid IS NULL OR length(uid)<1 THEN
  RAISE EXCEPTION 'R5_AUTH_REQUIRED' USING ERRCODE='28000';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.growth_family_members m
    WHERE m.family_id=p_family_id AND m.user_id=uid
      AND m.member_role IN ('owner','parent','grandparent')
      AND (NOT p_parent OR m.member_role IN ('owner','parent'))) THEN
  RAISE EXCEPTION 'R5_MEMBER_DENIED' USING ERRCODE='42501';
 END IF;
 RETURN uid;
END $$;

CREATE OR REPLACE FUNCTION public.r5_status(p_family_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE today_date date:=timezone('Asia/Shanghai',clock_timestamp())::date;
 user_id text; cfg record; plan record; usage record; subject_name text;
 total_count integer; correct_count integer; finished boolean;
 item_pass boolean; all_pass boolean:=true; module_states jsonb:='[]'::jsonb;
 limit_seconds integer; used_seconds integer; remaining integer;
 permitted boolean; why text; is_active boolean:=false;
BEGIN
 user_id:=public.r5_assert_member(p_family_id,false);
 SELECT enabled,daily_seconds,bonus_seconds INTO cfg
 FROM public.r5_parent_settings WHERE family_id=p_family_id;
 IF NOT FOUND THEN
  -- Fail closed if no settings, never silently disable parental control.
  RAISE EXCEPTION 'R5_SETTINGS_MISSING';
 END IF;
 SELECT day_index,subjects,published INTO plan
 FROM public.r5_daily_plan WHERE family_id=p_family_id AND study_date=today_date;
 IF NOT FOUND OR NOT plan.published THEN
  all_pass:=false; why:='PLAN_UNPUBLISHED';
 ELSIF jsonb_array_length(plan.subjects)=0 THEN
  why:='NO_TASKS_TODAY';
 ELSE
  FOR subject_name IN SELECT jsonb_array_elements_text(plan.subjects) LOOP
   SELECT count(*)::integer,
          count(*) FILTER (WHERE r.record_data #>> '{answer,correct}' = 'true')::integer
   INTO total_count,correct_count
   FROM public.growth_learning_records r
   WHERE r.family_id=p_family_id AND r.record_type='answer'
     AND r.subject=subject_name AND r.learning_day=plan.day_index
     AND left(r.record_data #>> '{answer,date}',10)=today_date::text
     AND r.record_data #>> '{answer,correct}' IN ('true','false');
   SELECT EXISTS (
    SELECT 1 FROM public.growth_learning_records r
    WHERE r.family_id=p_family_id AND r.record_type='course-complete'
      AND r.subject=subject_name AND r.learning_day=plan.day_index
      AND CASE
       WHEN r.record_data->>'completed_at' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T'
       THEN ((r.record_data->>'completed_at')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
       ELSE NULL::date END = today_date
   ) INTO finished;
   item_pass:=finished AND total_count>0 AND correct_count*100>=80*total_count;
   all_pass:=all_pass AND item_pass;
   module_states:=module_states||jsonb_build_array(jsonb_build_object(
     'subject',subject_name,'completed',finished,'correct',correct_count,
     'total',total_count,'accuracy_pct',CASE WHEN total_count>0
         THEN round(correct_count*100.0/total_count,1) ELSE NULL END,
     'passed',item_pass));
  END LOOP;
  why:=CASE WHEN all_pass THEN 'STUDY_PASSED' ELSE 'STUDY_INCOMPLETE_OR_SCORE_UNVERIFIED' END;
 END IF;
 SELECT used_ms,active INTO usage FROM public.r5_daily_usage
 WHERE family_id=p_family_id AND play_date=today_date;
 IF FOUND THEN
  used_seconds:=ceil(usage.used_ms/1000.0)::integer;is_active:=usage.active;
 ELSE used_seconds:=0; END IF;
 limit_seconds:=cfg.daily_seconds+cfg.bonus_seconds;
 remaining:=greatest(0,limit_seconds-used_seconds);
 permitted:=(NOT cfg.enabled OR (all_pass AND why<>'PLAN_UNPUBLISHED')) AND remaining>0;
 IF remaining=0 THEN why:='TIME_LIMIT_REACHED';
 ELSIF NOT cfg.enabled THEN why:='PARENT_CONTROL_DISABLED'; END IF;
 RETURN jsonb_build_object('api','r5_status','date',today_date,'allowed',permitted,
  'reason',why,'parent_control',cfg.enabled,'daily_seconds',cfg.daily_seconds,
  'bonus_seconds',cfg.bonus_seconds,'used_seconds',used_seconds,
  'remaining_seconds',remaining,'active',is_active,
  'modules',module_states,'schedule_published',
  COALESCE(plan.published,false),'study_day',plan.day_index);
END $$;

-- Heartbeats every ~10s. DB clock is authoritative; no client elapsed time accepted.
-- A missing close request can charge at most 20s on the next call.
CREATE OR REPLACE FUNCTION public.r5_game_action(p_family_id text,p_action text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE today_date date:=timezone('Asia/Shanghai',clock_timestamp())::date;
 now_ts timestamptz:=clock_timestamp(); u record; s jsonb;
 max_ms bigint; elapsed_ms bigint:=0;
BEGIN
 PERFORM public.r5_assert_member(p_family_id,false);
 IF p_action NOT IN ('start','tick','stop','status') THEN
   RAISE EXCEPTION 'R5_INVALID_ACTION';
 END IF;
 IF p_action='status' THEN RETURN public.r5_status(p_family_id); END IF;
 INSERT INTO public.r5_daily_usage(family_id,play_date)
 VALUES(p_family_id,today_date) ON CONFLICT DO NOTHING;
 SELECT * INTO u FROM public.r5_daily_usage
 WHERE family_id=p_family_id AND play_date=today_date FOR UPDATE;
 s:=public.r5_status(p_family_id);
 max_ms:=((s->>'daily_seconds')::bigint+(s->>'bonus_seconds')::bigint)*1000;
 IF u.active AND u.last_beat IS NOT NULL THEN
  elapsed_ms:=least(20000,greatest(0,
    floor(extract(epoch FROM (now_ts-u.last_beat))*1000)::bigint));
 END IF;
 u.used_ms:=least(max_ms,u.used_ms+elapsed_ms);
 IF p_action='stop' THEN u.active:=false;
 ELSIF u.used_ms>=max_ms THEN u.active:=false;
 ELSIF (s->>'allowed')::boolean AND p_action IN ('start','tick') THEN u.active:=true;
 ELSE u.active:=false; END IF;
 UPDATE public.r5_daily_usage
 SET used_ms=u.used_ms,active=u.active,last_beat=now_ts
 WHERE family_id=p_family_id AND play_date=today_date;
 s:=public.r5_status(p_family_id);
 RETURN s||jsonb_build_object('action',p_action,
  'charged_ms',elapsed_ms,'active',u.active);
END $$;

CREATE OR REPLACE FUNCTION public.r5_parent_update(
 p_family_id text,p_enabled boolean,p_daily_seconds integer,p_bonus_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE user_id text;
BEGIN
 user_id:=public.r5_assert_member(p_family_id,true);
 IF p_enabled IS NULL OR p_daily_seconds NOT BETWEEN 60 AND 10800
 OR p_bonus_seconds NOT BETWEEN 0 AND 7200 THEN
  RAISE EXCEPTION 'R5_INVALID_SETTINGS';
 END IF;
 INSERT INTO public.r5_parent_settings
 (family_id,enabled,daily_seconds,bonus_seconds,updated_by,updated_at)
 VALUES(p_family_id,p_enabled,p_daily_seconds,p_bonus_seconds,user_id,clock_timestamp())
 ON CONFLICT(family_id) DO UPDATE SET enabled=excluded.enabled,
 daily_seconds=excluded.daily_seconds,bonus_seconds=excluded.bonus_seconds,
 updated_by=excluded.updated_by,updated_at=excluded.updated_at;
 RETURN public.r5_status(p_family_id);
END $$;

-- CloudBase RPC gateway does not consistently enforce EXECUTE grants.
-- Every SECURITY DEFINER entrypoint checks JWT role + membership internally.
REVOKE ALL ON FUNCTION public.r5_assert_member(text,boolean),
 public.r5_status(text),public.r5_game_action(text,text),
 public.r5_parent_update(text,boolean,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.r5_status(text),
 public.r5_game_action(text,text),
 public.r5_parent_update(text,boolean,integer,integer) TO authenticated;
COMMIT;

-- Read-only postflight, run separately after authorized deployment:
-- SELECT COUNT(*) FROM public.r5_daily_plan WHERE family_id='little-growth-family-001';
-- SELECT proname,prosecdef FROM pg_proc WHERE proname LIKE 'r5_%';
