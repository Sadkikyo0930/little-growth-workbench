-- VERBATIM production source of public.r5_publish_today (captured read-only 2026-11-14).
-- prosrc md5 in production: b0d8d2deb58ab5240c9207e6b5081ea3
-- Only the function name changes: r5_publish_today -> r5_publish_today_legacy.
-- Kept for (a) reviewer diff, (b) rollback, (c) parity test.
CREATE OR REPLACE FUNCTION public.r5_publish_today_legacy(p_family_id text, p_day_index integer, p_no_tasks boolean DEFAULT false)
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
END $function$
