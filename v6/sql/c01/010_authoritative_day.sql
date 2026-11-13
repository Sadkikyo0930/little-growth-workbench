-- =============================================================================
-- C0.1 candidate 010 — authoritative learning day, state + derivation
-- =============================================================================
-- Deployment status: NOT APPLIED. This file is a reviewable candidate for S3.
-- Applying it to the shared CloudBase instance requires separate written approval
-- (it creates tables and functions in public schema).
--
-- Guarantees:
--   * NEVER writes, updates or deletes public.growth_learning_records.
--     (grep-able: the only references are SELECTs.)
--   * NEVER changes r5_parent_settings / 1800s quota / racing save tables.
--   * Idempotent: safe to run twice (IF NOT EXISTS / CREATE OR REPLACE).
--   * Reversible by 900_rollback.sql without touching any child record.
--
-- Rollback: 900_rollback.sql
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- 1. r5_family_progress — the single source of truth for "which day is active"
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.r5_family_progress (
  family_id         text PRIMARY KEY,
  authoritative_day integer NOT NULL DEFAULT 1,
  last_advanced_on  date,
  previous_day      integer,
  revision          bigint NOT NULL DEFAULT 0,
  initialized_on    date NOT NULL DEFAULT (timezone('Asia/Shanghai', clock_timestamp()))::date,
  initialized_from  text NOT NULL DEFAULT 'manual',
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT r5_family_progress_day_range CHECK (authoritative_day BETWEEN 1 AND 30),
  CONSTRAINT r5_family_progress_prev_range CHECK (previous_day IS NULL OR previous_day BETWEEN 1 AND 30),
  CONSTRAINT r5_family_progress_revision_nonneg CHECK (revision >= 0)
);

COMMENT ON TABLE public.r5_family_progress IS
  'C0.1: authoritative learning day per family. authority = MAX(published plan day), never device-local state.';
COMMENT ON COLUMN public.r5_family_progress.authoritative_day IS
  'Day index of the plan that is allowed to be published / graded next. Monotonic: never decreases.';
COMMENT ON COLUMN public.r5_family_progress.last_advanced_on IS
  'Asia/Shanghai date of the last advance. Same-day repeat advance is a no-op (idempotency key).';
COMMENT ON COLUMN public.r5_family_progress.initialized_from IS
  'Provenance of the initial value: latest_published_plan_max_day | default_day_1 | manual.';

-- -----------------------------------------------------------------------------
-- 2. r5_plan_audit — every publish / advance / stale-client attempt
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.r5_plan_audit (
  audit_id          bigserial PRIMARY KEY,
  family_id         text NOT NULL,
  occurred_on       date NOT NULL DEFAULT (timezone('Asia/Shanghai', clock_timestamp()))::date,
  event             text NOT NULL,
  client_day        integer,
  authoritative_day integer,
  plan_date         date,
  actor             text,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS r5_plan_audit_family_time_idx
  ON public.r5_plan_audit (family_id, created_at DESC);

COMMENT ON TABLE public.r5_plan_audit IS
  'C0.1: append-only audit of plan publication and day advancement. No child data.';

-- -----------------------------------------------------------------------------
-- 3. r5_credential_snapshot — materialised view of derived credentials (audit only)
-- -----------------------------------------------------------------------------
-- The gate NEVER reads this table: it always derives live from
-- growth_learning_records, so a stale snapshot can never unlock the racing gate.
CREATE TABLE IF NOT EXISTS public.r5_credential_snapshot (
  family_id            text NOT NULL,
  snapshot_date        date NOT NULL,
  credential_key       text NOT NULL,
  verification_status  text NOT NULL,
  learning_day_raw     integer,
  subject_canonical    text NOT NULL,
  record_date          date,
  authoritative_day    integer,
  pending_reasons      text[] NOT NULL DEFAULT '{}',
  payload              jsonb NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (family_id, snapshot_date, credential_key)
);

COMMENT ON TABLE public.r5_credential_snapshot IS
  'C0.1: reviewable snapshot of derived completion credentials. Audit only — never a gate input.';

-- -----------------------------------------------------------------------------
-- 4. Initialise authoritative day from the strongest existing evidence
-- -----------------------------------------------------------------------------
-- Evidence used: MAX(day_index) over already published r5_daily_plan rows.
-- This is monotonic by construction, so a later stale row cannot pull it back.
-- It is NOT derived from learning records: records carry device-local learning
-- days (1 / 6 / 9) and must never be folded into an authoritative day.
INSERT INTO public.r5_family_progress
  (family_id, authoritative_day, initialized_from)
SELECT f.family_id,
       COALESCE((SELECT MAX(p.day_index) FROM public.r5_daily_plan p
                  WHERE p.family_id = f.family_id), 1),
       CASE WHEN EXISTS (SELECT 1 FROM public.r5_daily_plan p WHERE p.family_id = f.family_id)
            THEN 'latest_published_plan_max_day'
            ELSE 'default_day_1' END
FROM public.growth_families f
ON CONFLICT (family_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 5. r5_subject_canonical — alias normalisation used ONLY for attribution
-- -----------------------------------------------------------------------------
-- Raw subject values in growth_learning_records are never rewritten. Production's
-- predicate compares subject names with exact equality, so an alias never grants a
-- pass on its own: the gate reports WAIVER_SUBJECT_ALIAS_MISMATCH / UNKNOWN_SUBJECT
-- and fails closed.
CREATE OR REPLACE FUNCTION public.r5_subject_canonical(p_raw text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 PARALLEL SAFE
AS $function$
  SELECT CASE lower(btrim(coalesce(p_raw, '')))
    WHEN '语文' THEN '语文'
    WHEN 'chinese' THEN '语文'
    WHEN 'yuwen' THEN '语文'
    WHEN '国文' THEN '语文'
    WHEN '國文' THEN '语文'
    WHEN 'yw' THEN '语文'
    WHEN '数学' THEN '数学'
    WHEN 'math' THEN '数学'
    WHEN 'maths' THEN '数学'
    WHEN 'mathematics' THEN '数学'
    WHEN 'shuxue' THEN '数学'
    WHEN 'sx' THEN '数学'
    WHEN '英语' THEN '英语'
    WHEN 'english' THEN '英语'
    WHEN 'yingyu' THEN '英语'
    WHEN 'en' THEN '英语'
    WHEN 'yy' THEN '英语'
    WHEN '科学' THEN '科学'
    WHEN 'science' THEN '科学'
    WHEN 'kexue' THEN '科学'
    WHEN 'kx' THEN '科学'
    ELSE NULL
  END;
$function$;

-- -----------------------------------------------------------------------------
-- 6. r5_credential_derive — the corrected effective-completion rule
-- -----------------------------------------------------------------------------
-- Pure derivation. Reads growth_learning_records + r5_daily_plan + r5_parent_waiver.
-- Writes nothing. Returns one row per (learning_day, canonical subject, record date).
--
-- Rule (superset of production, never weaker):
--   L1 score:  answer rows for the SAME learning_day, SAME record date,
--              exact subject match, correct in ('true','false'), >= 80%.
--   L2 course: a course-complete for the SAME learning_day whose
--              completed_at (Asia/Shanghai) lands on the same record date.
--   waiver:    ONLY when finished AND zero scored answers AND an exact-subject
--              waiver row exists for that date (same as production r5_parent_waive).
--   States are preserved, not invented:
--     COMPLETED_UNSCORED          -> PENDING_SCORE_SYNC   (real completion, no score yet)
--     unattributable learning day -> PENDING_VERIFICATION  (never folded into day 3)
--     alias waiver / bad ISO ts   -> PENDING_VERIFICATION
--   Nothing is written back, so no record is fabricated or re-dated.
CREATE OR REPLACE FUNCTION public.r5_credential_derive(
  p_family_id text,
  p_explicit_map jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (
  credential_key        text,
  learning_day_raw      integer,
  subject_canonical     text,
  subject_raw           text[],
  subject_known         boolean,
  record_date           date,
  date_evidence         text,
  answer_rows           integer,
  answer_total          integer,
  answer_correct        integer,
  accuracy_pct          numeric,
  course_complete_rows  integer,
  finished              boolean,
  completed_at_valid    boolean,
  waived                boolean,
  waiver_alias_mismatch boolean,
  evidence              text,
  verification_status   text,
  attributed            boolean,
  attribution_source    text,
  authoritative_day     integer,
  pending_reasons       text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
WITH norm AS (
  SELECT r.learning_day AS ld,
         public.r5_subject_canonical(r.subject) AS canon,
         r.subject AS raw,
         r.record_type AS rt,
         CASE
           WHEN r.record_type = 'answer' THEN
             CASE WHEN (r.record_data #>> '{answer,date}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                  THEN left(r.record_data #>> '{answer,date}', 10)::date
                  ELSE NULL::date END
           WHEN r.record_type = 'course-complete' THEN
             CASE WHEN (r.record_data->>'completed_at') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T'
                  THEN ((r.record_data->>'completed_at')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
                  ELSE NULL::date END
           ELSE NULL::date
         END AS rdate,
         CASE WHEN r.record_type = 'answer'
              THEN (r.record_data #>> '{answer,correct}') END AS correct_flag,
         CASE WHEN r.record_type = 'course-complete'
              THEN NOT ((r.record_data->>'completed_at') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T')
              ELSE false END AS broken_ts
  FROM public.growth_learning_records r
  WHERE r.family_id = p_family_id
    AND r.record_type IN ('answer', 'course-complete')
    AND r.learning_day IS NOT NULL
),
grp AS (
  SELECT n.ld, n.canon, n.rdate,
         bool_or(n.canon IS NOT NULL)                      AS known_any,
         array_agg(DISTINCT n.raw ORDER BY n.raw)          AS raws,
         count(*) FILTER (WHERE n.rt = 'answer')::integer  AS arows,
         count(*) FILTER (WHERE n.rt = 'answer'
                            AND n.correct_flag IN ('true','false'))::integer AS atotal,
         count(*) FILTER (WHERE n.rt = 'answer'
                            AND n.correct_flag = 'true')::integer            AS acorrect,
         count(*) FILTER (WHERE n.rt = 'course-complete')::integer           AS crows,
         bool_or(n.broken_ts)                              AS any_broken
  FROM norm n
  GROUP BY n.ld, n.canon, n.rdate
),
calc AS (
  SELECT g.*,
         (g.crows > 0 AND g.rdate IS NOT NULL) AS finished,
         (g.crows > 0 AND g.rdate IS NOT NULL AND g.atotal > 0
          AND g.acorrect * 100 >= 80 * g.atotal) AS item_pass,
         (g.crows > 0 AND g.rdate IS NOT NULL AND g.atotal = 0
          AND EXISTS (SELECT 1 FROM public.r5_parent_waiver w
                       WHERE w.family_id = p_family_id
                         AND w.study_date = g.rdate
                         AND w.subject = g.canon)) AS waived_exact,
         (g.crows > 0 AND g.rdate IS NOT NULL AND g.atotal = 0
          AND NOT EXISTS (SELECT 1 FROM public.r5_parent_waiver w
                           WHERE w.family_id = p_family_id
                             AND w.study_date = g.rdate
                             AND w.subject = g.canon)
          AND EXISTS (SELECT 1 FROM public.r5_parent_waiver w
                       WHERE w.family_id = p_family_id
                         AND w.study_date = g.rdate
                         AND public.r5_subject_canonical(w.subject) = g.canon)) AS alias_only_waiver
  FROM grp g
),
attr AS (
  SELECT c.*,
         NULLIF(canonical.explicit_day, '') AS explicit_day_text,
         (SELECT count(DISTINCT p.day_index)
            FROM public.r5_daily_plan p
           WHERE p.family_id = p_family_id
             AND c.rdate IS NOT NULL
             AND p.study_date = c.rdate
             AND p.published
             AND p.day_index = c.ld
             AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.subjects) s
                          WHERE public.r5_subject_canonical(s) = c.canon)) AS plan_matches
  FROM calc c
  CROSS JOIN LATERAL (
    SELECT p_explicit_map ->> (c.ld::text || ':' || c.canon) AS explicit_day
  ) canonical
),
state AS (
  SELECT a.*,
         CASE
           WHEN a.item_pass AND a.atotal > 0 THEN 'SCORED'
           WHEN a.waived_exact THEN 'COMPLETED_UNSCORED_WAIVED'
           WHEN a.atotal > 0 THEN 'SCORED_BELOW_THRESHOLD'
           WHEN a.finished THEN 'COMPLETED_UNSCORED'
           ELSE 'NOT_COMPLETED'
         END AS ev,
         -- A parent waiver takes the place of the missing score, exactly like the
         -- deployed predicate (item_pass := true when waived).
         (a.item_pass OR a.waived_exact) AS passed,
         (a.explicit_day_text IS NOT NULL OR a.plan_matches = 1) AS is_attributed
  FROM attr a
)
SELECT
  md5(coalesce(s.ld::text, '~') || '|' || coalesce(s.canon, '~') || '|' || coalesce(s.rdate::text, '~')),
  s.ld,
  coalesce(s.canon, s.raws[1]),
  s.raws,
  s.known_any,
  s.rdate,
  CASE WHEN s.rdate IS NOT NULL THEN 'UNIQUE_DATE' ELSE 'NO_DATE_EVIDENCE' END,
  s.arows,
  s.atotal,
  s.acorrect,
  CASE WHEN s.atotal > 0 THEN round(s.acorrect * 100.0 / s.atotal, 1) END,
  s.crows,
  s.finished,
  NOT s.any_broken,
  s.waived_exact,
  s.alias_only_waiver,
  s.ev,
  -- Status precedence:
  --   1. a completion whose day is known and whose ONLY gap is the missing score
  --      keeps its real state as PENDING_SCORE_SYNC (never guessed, never filled);
  --   2. anything a human has to resolve (unknown day, unknown subject, broken
  --      timestamp, alias waiver) is PENDING_VERIFICATION;
  --   3. otherwise the credential is VALID_* or INVALID.
  CASE
    WHEN s.ev = 'COMPLETED_UNSCORED' AND s.is_attributed AND s.known_any
         AND NOT s.any_broken AND NOT s.alias_only_waiver THEN 'PENDING_SCORE_SYNC'
    WHEN s.rdate IS NULL OR NOT s.known_any OR s.any_broken
         OR s.alias_only_waiver OR NOT s.is_attributed THEN 'PENDING_VERIFICATION'
    WHEN s.passed AND s.ev = 'SCORED' THEN 'VALID_SCORED'
    WHEN s.passed AND s.ev = 'COMPLETED_UNSCORED_WAIVED' THEN 'VALID_WAIVED'
    ELSE 'INVALID'
  END,
  s.is_attributed,
  CASE
    WHEN s.explicit_day_text IS NOT NULL THEN 'PARENT_CONFIRMED_MAP'
    WHEN s.plan_matches = 1 THEN 'SINGLE_PLAN_ON_RECORD_DATE'
    WHEN s.plan_matches > 1 THEN 'AMBIGUOUS_PLAN_MAPPING'
    WHEN s.rdate IS NULL THEN 'NO_DATE_EVIDENCE'
    ELSE 'NO_DETERMINISTIC_DAY_ATTRIBUTION'
  END,
  coalesce(s.explicit_day_text::integer, CASE WHEN s.plan_matches = 1 THEN s.ld END),
  array_remove(ARRAY[
    CASE WHEN s.rdate IS NULL THEN 'NO_DATE_EVIDENCE' END,
    CASE WHEN NOT s.known_any THEN 'UNKNOWN_SUBJECT' END,
    CASE WHEN s.any_broken THEN 'COMPLETED_AT_NOT_ISO' END,
    CASE WHEN s.alias_only_waiver THEN 'WAIVER_SUBJECT_ALIAS_MISMATCH' END,
    CASE WHEN s.plan_matches > 1 THEN 'AMBIGUOUS_PLAN_MAPPING' END,
    CASE WHEN s.plan_matches = 0 AND s.rdate IS NOT NULL
              AND s.explicit_day_text IS NULL THEN 'NO_DETERMINISTIC_DAY_ATTRIBUTION' END,
    CASE WHEN s.ev = 'COMPLETED_UNSCORED' THEN 'COURSE_COMPLETED_BUT_SCORE_NOT_SYNCED' END,
    CASE WHEN s.ev IN ('SCORED_BELOW_THRESHOLD', 'NOT_COMPLETED') THEN s.ev END
  ], NULL)
FROM state s;
$function$;

COMMENT ON FUNCTION public.r5_credential_derive(text, jsonb) IS
  'C0.1: corrected effective-completion rule. Read-only; preserves PENDING_SCORE_SYNC and PENDING_VERIFICATION states.';

COMMIT;
