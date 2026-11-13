-- =============================================================================
-- Test environment: production-shaped schema (subset), for PGlite / PostgreSQL 18
-- =============================================================================
-- This file is TEST SCAFFOLDING, not a migration. It rebuilds the tables and the
-- functions that the C0.1 candidate interacts with, using the column types,
-- constraints and defaults observed read-only on the live CloudBase instance
-- (information_schema / pg_constraint, 2026-11-14).
--
-- r5_claim_answers and r5_parent_waive are copied VERBATIM from production so the
-- end-to-end tests exercise the real concurrency + waiver rules.
--
-- r5_assert_member / r5_override_active are minimal stand-ins (they are unchanged
-- by C0.1): membership is read from growth_family_members using the same
-- request.jwt.claims contract. Override is always false unless a test sets
-- r5_parent_override rows (not part of this change set).
-- =============================================================================

CREATE TABLE public.growth_families (
  family_id      text PRIMARY KEY,
  child_nickname text NOT NULL DEFAULT '小小赛车手',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.growth_family_members (
  family_id   text NOT NULL REFERENCES public.growth_families(family_id),
  user_id     text NOT NULL,
  member_role text NOT NULL CHECK (member_role IN ('owner','parent','grandparent')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id)
);

CREATE TABLE public.growth_learning_records (
  record_id    text PRIMARY KEY,
  family_id    text NOT NULL REFERENCES public.growth_families(family_id),
  record_type  text NOT NULL,
  subject      text,
  learning_day integer,
  record_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.r5_daily_plan (
  family_id  text NOT NULL,
  study_date date NOT NULL,
  day_index  integer NOT NULL,
  subjects   jsonb NOT NULL CHECK (jsonb_typeof(subjects) = 'array' AND jsonb_array_length(subjects) <= 2),
  published  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (family_id, study_date)
);

CREATE TABLE public.r5_parent_settings (
  family_id     text PRIMARY KEY,
  enabled       boolean NOT NULL DEFAULT true,
  daily_seconds integer NOT NULL DEFAULT 1800 CHECK (daily_seconds BETWEEN 60 AND 10800),
  bonus_seconds integer NOT NULL DEFAULT 0 CHECK (bonus_seconds BETWEEN 0 AND 7200),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text
);

CREATE TABLE public.r5_parent_waiver (
  family_id  text NOT NULL,
  study_date date NOT NULL,
  subject    text NOT NULL,
  reason     text NOT NULL DEFAULT 'parent_waiver',
  actor      text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (family_id, study_date, subject)
);

CREATE TABLE public.r5_daily_usage (
  family_id  text NOT NULL,
  play_date  date NOT NULL,
  used_ms    bigint NOT NULL DEFAULT 0 CHECK (used_ms >= 0),
  active     boolean NOT NULL DEFAULT false,
  last_beat  timestamptz,
  PRIMARY KEY (family_id, play_date)
);

CREATE TABLE public.r5_subject_template (
  day_index integer PRIMARY KEY CHECK (day_index BETWEEN 1 AND 30),
  subjects  jsonb NOT NULL CHECK (jsonb_typeof(subjects) = 'array' AND jsonb_array_length(subjects) = 2)
);

CREATE TABLE public.r5_answer_dedupe (
  family_id   text NOT NULL,
  subject     text NOT NULL,
  answer_date date NOT NULL,
  track       text NOT NULL,
  q_index     integer NOT NULL,
  record_id   text NOT NULL,
  device_key  text,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, subject, answer_date, track, q_index)
);

CREATE TABLE public.r5_parent_audit (
  audit_id   bigserial PRIMARY KEY,
  family_id  text NOT NULL,
  action     text NOT NULL,
  play_date  date,
  actor      text,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- ------------------------------------------------------------------ functions
CREATE OR REPLACE FUNCTION public.r5_assert_member(p_family_id text, p_require_parent boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  uid text;
  role_now text;
BEGIN
  uid := COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'sub', '');
  IF uid = '' THEN
    RAISE EXCEPTION 'R5_AUTH_REQUIRED' USING ERRCODE = '28000';
  END IF;
  SELECT member_role INTO role_now
    FROM public.growth_family_members
   WHERE family_id = p_family_id AND user_id = uid;
  IF role_now IS NULL THEN
    RAISE EXCEPTION 'R5_MEMBER_DENIED' USING ERRCODE = '42501';
  END IF;
  IF p_require_parent AND role_now NOT IN ('owner', 'parent') THEN
    RAISE EXCEPTION 'R5_MEMBER_DENIED' USING ERRCODE = '42501';
  END IF;
  RETURN uid;
END;
$function$;

CREATE OR REPLACE FUNCTION public.r5_override_active(p_family_id text, p_user_id text, p_entry boolean)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT false;
$function$;

CREATE OR REPLACE FUNCTION public.r5_status(p_family_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  RETURN public.r5_gate_status(p_family_id, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.r5_gate_status(p_family_id text, p_entry boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  RETURN public.r5_gate_status_core(p_family_id, p_entry, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.r5_child_entry(p_family_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  PERFORM public.r5_assert_member(p_family_id, false);
  RETURN public.r5_gate_status(p_family_id, true)
         || jsonb_build_object('server_time', clock_timestamp());
END;
$function$;

-- ---- verbatim production r5_claim_answers -----------------------------------
CREATE OR REPLACE FUNCTION public.r5_claim_answers(p_family_id text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid      text;
  v_dev      text;
  v_item     jsonb;
  v_subject  text;
  v_date     date;
  v_track    text;
  v_index    integer;
  v_record   text;
  v_old_id   text;
  v_old_at   timestamptz;
  v_old_dev  text;
  v_new_id   text;
  v_claimed  text[] := ARRAY[]::text[];
  v_reclaim  text[] := ARRAY[]::text[];
  v_dup      text[] := ARRAY[]::text[];
  v_bad      text[] := ARRAY[]::text[];
BEGIN
  -- 家庭成员或已绑定设备都可提交（与 r5_status 的放行口径一致）
  v_uid := public.r5_assert_member(p_family_id, false);
  v_dev := md5(v_uid);

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('claimed', '[]'::jsonb, 'reclaimed', '[]'::jsonb,
                              'duplicates', '[]'::jsonb, 'invalid', '[]'::jsonb,
                              'error', 'R5_BAD_PAYLOAD');
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_record  := nullif(v_item->>'record_id', '');
    v_subject := nullif(v_item->>'subject', '');
    v_track   := coalesce(nullif(v_item->>'track', ''), '__course__');
    BEGIN
      v_date  := (v_item->>'date')::date;
      v_index := coalesce((v_item->>'index')::integer, 0);
    EXCEPTION WHEN others THEN
      v_bad := v_bad || coalesce(v_record, '?');
      CONTINUE;
    END;

    IF v_record IS NULL OR v_subject IS NULL OR v_date IS NULL THEN
      v_bad := v_bad || coalesce(v_record, '?');
      CONTINUE;
    END IF;

    /* ① 第一次抢占：并发下只有一台能 RETURNING 到行 */
    v_new_id := NULL;
    INSERT INTO public.r5_answer_dedupe
      (family_id, subject, answer_date, track, q_index, record_id, device_key)
    VALUES
      (p_family_id, v_subject, v_date, v_track, v_index, v_record, v_dev)
    ON CONFLICT (family_id, subject, answer_date, track, q_index) DO NOTHING
    RETURNING record_id INTO v_new_id;

    IF v_new_id IS NOT NULL THEN
      v_claimed := v_claimed || v_record;
      CONTINUE;
    END IF;

    /* ② 被别人占了：把占位方的信息读出来 */
    v_old_id  := NULL;
    v_old_at  := NULL;
    v_old_dev := NULL;
    SELECT d.record_id, d.claimed_at, d.device_key
      INTO v_old_id, v_old_at, v_old_dev
      FROM public.r5_answer_dedupe d
     WHERE d.family_id = p_family_id AND d.subject = v_subject
       AND d.answer_date = v_date AND d.track = v_track AND d.q_index = v_index;

    IF v_old_id IS NULL THEN
      /* 极端并发（占位刚被删）：这一条这次没抢到，下次同步再试，不算失败 */
      v_dup := v_dup || v_record;
      CONTINUE;
    END IF;

    /* ③ 自己抢过、但没来得及落库 → 允许重复认领。
     *    判据是「同一台设备 + 同一个 record_id」：两者都相同说明这就是自己
     *    上次留下的占位；record_id 相同意味着重复 POST 是幂等的，不会多出一条。 */
    IF v_old_id = v_record AND v_old_dev = v_dev THEN
      v_new_id := NULL;
      UPDATE public.r5_answer_dedupe d
         SET claimed_at = now()
       WHERE d.family_id = p_family_id AND d.subject = v_subject
         AND d.answer_date = v_date AND d.track = v_track AND d.q_index = v_index
         AND d.record_id = v_record AND d.device_key = v_dev
      RETURNING d.record_id INTO v_new_id;

      IF v_new_id IS NOT NULL THEN
        v_reclaim := v_reclaim || v_record;
        v_claimed := v_claimed || v_record;
      ELSE
        v_dup := v_dup || v_record;
      END IF;
      CONTINUE;
    END IF;

    /* ④ 孤儿占位接管：占位方 10 分钟内没把记录传上来，允许别的设备接管。
     *    必须用 CAS：WHERE 里带上「读到的旧 record_id + 旧 claimed_at」，
     *    两台设备同时接管时，后到的那台因为 claimed_at 已被改而匹配不到行，
     *    只会拿到 0 行 → 判为 duplicates。这是并发安全的真正来源。 */
    IF v_old_at < now() - interval '10 minutes' THEN
      v_new_id := NULL;
      UPDATE public.r5_answer_dedupe d
         SET record_id = v_record, device_key = v_dev, claimed_at = now()
       WHERE d.family_id = p_family_id AND d.subject = v_subject
         AND d.answer_date = v_date AND d.track = v_track AND d.q_index = v_index
         AND d.record_id = v_old_id
         AND d.claimed_at = v_old_at
         AND NOT EXISTS (SELECT 1 FROM public.growth_learning_records g
                          WHERE g.record_id = d.record_id)
      RETURNING d.record_id INTO v_new_id;

      IF v_new_id IS NOT NULL THEN
        v_claimed := v_claimed || v_record;
      ELSE
        /* 被别人抢先接管了 / 记录刚好落库了 → 这台不传 */
        v_dup := v_dup || v_record;
      END IF;
    ELSE
      /* 占位还新鲜，说明对方正在传；这台先不传，下次同步再判断 */
      v_dup := v_dup || v_record;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'claimed',    to_jsonb(v_claimed),
    'reclaimed',  to_jsonb(v_reclaim),
    'duplicates', to_jsonb(v_dup),
    'invalid',    to_jsonb(v_bad)
  );
END $function$;

-- ---- verbatim production r5_parent_waive ------------------------------------
CREATE OR REPLACE FUNCTION public.r5_parent_waive(p_family_id text, p_subject text, p_reason text DEFAULT 'parent_waiver'::text, p_revoke boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE today_date date := timezone('Asia/Shanghai',clock_timestamp())::date;
 actor text; finished boolean;
BEGIN
 actor := public.r5_assert_member(p_family_id,true);
 IF COALESCE(p_subject,'')='' THEN RAISE EXCEPTION 'R5_INVALID_SUBJECT'; END IF;
 IF p_revoke THEN
   DELETE FROM public.r5_parent_waiver
    WHERE family_id=p_family_id AND study_date=today_date AND subject=p_subject;
   INSERT INTO public.r5_parent_audit(family_id,action,play_date,actor,detail)
   VALUES (p_family_id,'waiver_revoke',today_date,actor,
           jsonb_build_object('subject',p_subject,'reason',p_reason));
   RETURN public.r5_status(p_family_id);
 END IF;
 -- Require real completion evidence: a waiver can never replace actually doing the lesson.
 SELECT EXISTS (
   SELECT 1 FROM public.growth_learning_records r
   WHERE r.family_id=p_family_id AND r.record_type='course-complete'
     AND r.subject=p_subject
     AND CASE WHEN r.record_data->>'completed_at' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T'
              THEN ((r.record_data->>'completed_at')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
              ELSE NULL::date END = today_date
 ) INTO finished;
 IF NOT finished THEN
   RAISE EXCEPTION 'R5_NO_COMPLETION_EVIDENCE';
 END IF;
 INSERT INTO public.r5_parent_waiver(family_id,study_date,subject,reason,actor)
 VALUES (p_family_id,today_date,p_subject,COALESCE(p_reason,'parent_waiver'),actor)
 ON CONFLICT (family_id,study_date,subject)
 DO UPDATE SET reason=excluded.reason, actor=excluded.actor, created_at=clock_timestamp();
 INSERT INTO public.r5_parent_audit(family_id,action,play_date,actor,detail)
 VALUES (p_family_id,'waiver_grant',today_date,actor,
         jsonb_build_object('subject',p_subject,'reason',p_reason));
 RETURN public.r5_status(p_family_id);
END $function$;

-- ------------------------------------------------------------------ seed data
INSERT INTO public.r5_subject_template (day_index, subjects) VALUES
 (1,'["英语","科学"]'::jsonb),  (2,'["语文","数学"]'::jsonb),
 (3,'["数学","英语"]'::jsonb),  (4,'["语文","英语"]'::jsonb),
 (5,'["数学","科学"]'::jsonb),  (6,'["语文","数学"]'::jsonb),
 (7,'["语文","英语"]'::jsonb),  (8,'["英语","科学"]'::jsonb),
 (9,'["语文","数学"]'::jsonb),  (10,'["数学","英语"]'::jsonb),
 (11,'["语文","英语"]'::jsonb), (12,'["数学","科学"]'::jsonb),
 (13,'["语文","数学"]'::jsonb), (14,'["语文","英语"]'::jsonb),
 (15,'["英语","科学"]'::jsonb), (16,'["语文","数学"]'::jsonb),
 (17,'["数学","英语"]'::jsonb), (18,'["语文","英语"]'::jsonb),
 (19,'["数学","科学"]'::jsonb), (20,'["语文","数学"]'::jsonb),
 (21,'["语文","英语"]'::jsonb), (22,'["英语","科学"]'::jsonb),
 (23,'["语文","数学"]'::jsonb), (24,'["数学","英语"]'::jsonb),
 (25,'["语文","英语"]'::jsonb), (26,'["数学","科学"]'::jsonb),
 (27,'["语文","数学"]'::jsonb), (28,'["语文","英语"]'::jsonb),
 (29,'["英语","科学"]'::jsonb), (30,'["语文","数学"]'::jsonb);
