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
--   * NEVER decides the authoritative day by itself. This migration inserts no
--     row into r5_family_progress. A family becomes initialised only through
--     r5_initialize_authoritative_day(), which requires (a) the runtime
--     read-only snapshot to be clean and (b) an explicit, verified parent
--     confirmation. Without both, every write path stops with
--     R5_DAY_NOT_INITIALIZED instead of guessing from history.
--
-- Privileges:
--   * every new table is REVOKE ALL / ENABLE ROW LEVEL SECURITY (no policy):
--     accessible only through the SECURITY DEFINER functions below.
--   * every new function is REVOKE ALL FROM PUBLIC. Only the client-facing API
--     is GRANTed to `authenticated`; internal helpers stay owner-only.
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
  'C0.1: authoritative learning day per family. Set only by a verified parent confirmation or for a brand-new family. Never derived from MAX(plan day).';
COMMENT ON COLUMN public.r5_family_progress.authoritative_day IS
  'Day index of the plan that is allowed to be published / graded next. Monotonic: never decreases.';
COMMENT ON COLUMN public.r5_family_progress.last_advanced_on IS
  'Asia/Shanghai date of the last advance. Same-day repeat advance is a no-op (idempotency key).';
COMMENT ON COLUMN public.r5_family_progress.initialized_from IS
  'Provenance of the initial value: parent_confirmed | new_family_day_1. There is deliberately no "max published plan day" provenance.';

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
-- 4. Initialise authoritative day — NOT here, and never automatically
-- -----------------------------------------------------------------------------
-- The previous draft derived the starting value from MAX(r5_daily_plan.day_index).
-- That is wrong for the real family: its plan history tops out at day 2, but the
-- parent has already moved to day 3. Initialising at 2 would (a) reopen day 2 and
-- (b) let the guard reject the day-3 plan. So this migration inserts NO row.
--
-- A family becomes initialised in exactly two ways:
--   1. brand-new family (no plan row, no learning record) -> r5_progress_ensure()
--      inserts day 1 with provenance 'new_family_day_1';
--   2. existing family -> an operator runs r5_initialize_authoritative_day() with
--      the runtime snapshot fingerprint and an explicit parent-confirmed day.
--      Missing confirmation / device disagreement / thin evidence block it.
-- Anything else stops with R5_DAY_NOT_INITIALIZED.
CREATE TABLE IF NOT EXISTS public.r5_day_confirmation (
  confirmation_id    bigserial PRIMARY KEY,
  family_id          text NOT NULL,
  confirmed_day      integer NOT NULL,
  confirmed_by       text NOT NULL,
  confirmed_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  snapshot           jsonb NOT NULL,
  snapshot_fingerprint text NOT NULL,
  CONSTRAINT r5_day_confirmation_day_range CHECK (confirmed_day BETWEEN 1 AND 30),
  CONSTRAINT r5_day_confirmation_actor_not_blank CHECK (btrim(confirmed_by) <> '')
);

CREATE INDEX IF NOT EXISTS r5_day_confirmation_family_time_idx
  ON public.r5_day_confirmation (family_id, confirmed_at DESC);

COMMENT ON TABLE public.r5_day_confirmation IS
  'C0.1: append-only record of accepted initialisations, with the exact read-only snapshot they were judged against. A refused attempt raises and is therefore NOT persisted (an exception rolls the whole function body back); the refusal is identified by its error code.';

-- -----------------------------------------------------------------------------
-- 5. r5_subject_canonical — alias normalisation used ONLY for attribution
-- -----------------------------------------------------------------------------
-- Deliberately left callable by everyone: it is IMMUTABLE, takes no family_id,
-- reads no table and returns only the normalised name (or NULL for an unknown
-- subject), so it cannot leak or change anything.
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
-- 6. r5_credential_derive_impl — the corrected effective-completion rule (body)
-- -----------------------------------------------------------------------------
-- INTERNAL. Shares the exact same semantics as before, but is not callable by
-- clients: it takes any family_id and therefore must never be reachable directly
-- (that would be a cross-family read of another child's records). The public
-- entry point r5_credential_derive() adds the membership check.
--
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
CREATE OR REPLACE FUNCTION public.r5_credential_derive_impl(
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

COMMENT ON FUNCTION public.r5_credential_derive_impl(text, jsonb) IS
  'C0.1 INTERNAL: corrected effective-completion rule body. Owner-only EXECUTE; call r5_credential_derive() instead.';

-- -----------------------------------------------------------------------------
-- 7. r5_credential_derive — public entry point (membership enforced)
-- -----------------------------------------------------------------------------
-- Same signature the candidate already published, so the gate wrapper and any
-- future caller keep working. The ONLY addition is r5_assert_member(): a member
-- of family A can no longer derive family B's credentials.
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  PERFORM public.r5_assert_member(p_family_id, false);
  RETURN QUERY SELECT * FROM public.r5_credential_derive_impl(p_family_id, p_explicit_map);
END;
$function$;

COMMENT ON FUNCTION public.r5_credential_derive(text, jsonb) IS
  'C0.1: membership-checked wrapper around r5_credential_derive_impl. Read-only; preserves PENDING_SCORE_SYNC and PENDING_VERIFICATION states.';

-- -----------------------------------------------------------------------------
-- 8. r5_initialization_snapshot_impl — runtime read-only evidence snapshot
-- -----------------------------------------------------------------------------
-- INTERNAL (no EXECUTE grant). Reads, never writes. Everything the initialisation
-- decision is judged on, computed at call time — never cached, never stored first.
--
-- Blocking reasons (any one of them stops initialisation):
--   PLAN_NOT_MONOTONIC         the highest-day plan is not the latest plan row
--                              (a newer row with an older day is stale writeback)
--   DEVICE_DAY_DISAGREEMENT    records dated on the latest plan date carry more
--                              than one learning_day (two devices disagree)
--   RECORD_DAY_AHEAD_OF_PLAN   a record on that date claims a day the plan never
--                              published (device ran ahead: cannot be confirmed)
--   NO_PUBLISHED_PLAN_BUT_RECORDS  records exist but no plan was ever published
--   PLAN_DAY_OUT_OF_RANGE      highest plan day outside 1..30
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_initialization_snapshot_impl(p_family_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_plan_max integer;
  v_plan_days integer[];
  v_latest_date date;
  v_latest_day integer;
  v_rec_days integer[];
  v_latest_rec_days integer[];
  v_block text[] := ARRAY[]::text[];
  v_min integer;
  v_max integer;
  v_evidence jsonb;
  v_payload jsonb;
BEGIN
  SELECT array_agg(p.day_index ORDER BY p.study_date, p.day_index), max(p.day_index)
    INTO v_plan_days, v_plan_max
    FROM public.r5_daily_plan p
   WHERE p.family_id = p_family_id AND p.published;

  SELECT p.study_date, p.day_index
    INTO v_latest_date, v_latest_day
    FROM public.r5_daily_plan p
   WHERE p.family_id = p_family_id AND p.published
   ORDER BY p.study_date DESC, p.day_index DESC
   LIMIT 1;

  SELECT array_agg(DISTINCT r.learning_day ORDER BY r.learning_day)
    INTO v_rec_days
    FROM public.growth_learning_records r
   WHERE r.family_id = p_family_id AND r.learning_day IS NOT NULL;

  IF v_latest_date IS NOT NULL THEN
    SELECT array_agg(DISTINCT r.learning_day ORDER BY r.learning_day)
      INTO v_latest_rec_days
      FROM public.growth_learning_records r
     WHERE r.family_id = p_family_id
       AND r.learning_day IS NOT NULL
       AND (CASE
              WHEN r.record_type = 'course-complete'
               AND (r.record_data->>'completed_at') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T'
              THEN ((r.record_data->>'completed_at')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
              WHEN r.record_type = 'answer'
               AND (r.record_data #>> '{answer,date}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
              THEN left(r.record_data #>> '{answer,date}', 10)::date
              ELSE NULL::date END) = v_latest_date;
  END IF;

  IF v_plan_max IS NOT NULL AND (v_plan_max < 1 OR v_plan_max > 30) THEN
    v_block := array_append(v_block, 'PLAN_DAY_OUT_OF_RANGE');
  END IF;
  IF v_plan_max IS NOT NULL AND v_latest_day IS DISTINCT FROM v_plan_max THEN
    v_block := array_append(v_block, 'PLAN_NOT_MONOTONIC');
  END IF;
  IF coalesce(array_length(v_latest_rec_days, 1), 0) > 1 THEN
    v_block := array_append(v_block, 'DEVICE_DAY_DISAGREEMENT');
  END IF;
  IF v_plan_max IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(coalesce(v_latest_rec_days, ARRAY[]::integer[])) d
                  WHERE d > v_plan_max) THEN
    v_block := array_append(v_block, 'RECORD_DAY_AHEAD_OF_PLAN');
  END IF;
  IF v_plan_max IS NULL AND coalesce(array_length(v_rec_days, 1), 0) > 0 THEN
    v_block := array_append(v_block, 'NO_PUBLISHED_PLAN_BUT_RECORDS');
  END IF;

  -- The confirmation window is a CONSTRAINT, not a derivation: the parent value
  -- must sit inside it. It forbids writing back an already published day
  -- (confirmed < plan_max) and forbids skipping an unplayed day
  -- (confirmed > plan_max + 1).
  v_min := COALESCE(v_plan_max, 1);
  v_max := CASE WHEN v_plan_max IS NULL THEN 1 ELSE least(v_plan_max + 1, 30) END;

  v_evidence := jsonb_build_object(
    'family_id', p_family_id,
    'plan_days', to_jsonb(coalesce(v_plan_days, ARRAY[]::integer[])),
    'plan_max_day', v_plan_max,
    'latest_plan_date', v_latest_date,
    'latest_plan_day', v_latest_day,
    'record_learning_days', to_jsonb(coalesce(v_rec_days, ARRAY[]::integer[])),
    'latest_plan_date_record_days', to_jsonb(coalesce(v_latest_rec_days, ARRAY[]::integer[])),
    'allowed_min_day', v_min,
    'allowed_max_day', v_max,
    'blocking', to_jsonb(v_block)
  );

  v_payload := v_evidence || jsonb_build_object(
    'evidence_ok', (array_length(v_block, 1) IS NULL),
    'confirmation_required', true,
    'snapshot_fingerprint', md5(v_evidence::text),
    'generated_at', to_char(timezone('Asia/Shanghai', clock_timestamp()), 'YYYY-MM-DD"T"HH24:MI:SS'));

  RETURN v_payload;
END;
$function$;

COMMENT ON FUNCTION public.r5_initialization_snapshot_impl(text) IS
  'C0.1 INTERNAL: read-only initialisation evidence snapshot. Owner-only EXECUTE.';

-- -----------------------------------------------------------------------------
-- 9. r5_initialization_snapshot — membership-checked read-only view for review
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.r5_initialization_snapshot(p_family_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  PERFORM public.r5_assert_member(p_family_id, false);
  RETURN public.r5_initialization_snapshot_impl(p_family_id);
END;
$function$;

COMMENT ON FUNCTION public.r5_initialization_snapshot(text) IS
  'C0.1: membership-checked, read-only snapshot used to review a family before initialising. Never writes.';

-- -----------------------------------------------------------------------------
-- 10. r5_initialize_authoritative_day — the ONLY way an existing family starts
-- -----------------------------------------------------------------------------
-- ADMIN ONLY: no EXECUTE grant to `authenticated` or `anon`. Run it as the
-- database owner during the maintenance window, never from a client session.
--
-- Refuses unless ALL of the following hold:
--   * an operator-supplied confirmed day inside the snapshot window;
--   * a non-blank confirmer identity;
--   * the snapshot fingerprint re-computed NOW matches the one that was reviewed
--     (evidence cannot drift between review and write);
--   * the snapshot has zero blocking reasons;
--   * the family is not initialised yet (never overwrites, never lowers).
-- A refusal raises a specific error (R5_INIT_BLOCKED / _REGRESSION_REJECTED /
-- _JUMP_REJECTED / _SNAPSHOT_STALE / _CONFIRMATION_REQUIRED) and writes nothing:
-- it runs in one statement, so an audit row would be rolled back with it.
CREATE OR REPLACE FUNCTION public.r5_initialize_authoritative_day(
  p_family_id text,
  p_confirmed_day integer,
  p_confirmed_by text,
  p_snapshot_fingerprint text
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  today_date date := timezone('Asia/Shanghai', clock_timestamp())::date;
  snap jsonb;
  cur record;
  reasons text[];
  v_min integer;
  v_max integer;
BEGIN
  -- Defence in depth: this is an operator function, so it also refuses a client
  -- session even if a future migration accidentally grants EXECUTE to it.
  IF (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb->>'role')
     = 'authenticated' THEN
    RAISE EXCEPTION 'R5_ADMIN_ONLY' USING ERRCODE = '42501',
      DETAIL = 'initialisation runs as the database owner, never from an app session';
  END IF;

  IF p_confirmed_day IS NULL OR p_confirmed_day < 1 OR p_confirmed_day > 30 THEN
    RAISE EXCEPTION 'R5_INIT_INVALID_DAY' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_confirmed_by), '') = '' THEN
    RAISE EXCEPTION 'R5_INIT_CONFIRMATION_REQUIRED' USING ERRCODE = '22023',
      DETAIL = 'a named parent confirmation is mandatory';
  END IF;

  SELECT * INTO cur FROM public.r5_family_progress WHERE family_id = p_family_id;
  IF FOUND THEN
    RETURN jsonb_build_object('result', 'already_initialized',
                              'authoritative_day', cur.authoritative_day,
                              'initialized_from', cur.initialized_from);
  END IF;

  snap := public.r5_initialization_snapshot_impl(p_family_id);

  IF p_snapshot_fingerprint IS NULL
     OR p_snapshot_fingerprint <> (snap->>'snapshot_fingerprint') THEN
    RAISE EXCEPTION 'R5_INIT_SNAPSHOT_STALE' USING ERRCODE = '40001',
      DETAIL = format('reviewed %s, current %s', coalesce(p_snapshot_fingerprint, '~'),
                                              snap->>'snapshot_fingerprint');
  END IF;

  reasons := ARRAY(SELECT jsonb_array_elements_text(coalesce(snap->'blocking', '[]'::jsonb)));
  IF array_length(reasons, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'R5_INIT_BLOCKED' USING ERRCODE = '40001',
      DETAIL = array_to_string(reasons, ',');
  END IF;

  v_min := (snap->>'allowed_min_day')::integer;
  v_max := (snap->>'allowed_max_day')::integer;

  IF p_confirmed_day < v_min THEN
    RAISE EXCEPTION 'R5_INIT_REGRESSION_REJECTED' USING ERRCODE = '22023',
      DETAIL = format('confirmed %s < published plan max %s', p_confirmed_day, v_min);
  END IF;

  IF p_confirmed_day > v_max THEN
    RAISE EXCEPTION 'R5_INIT_JUMP_REJECTED' USING ERRCODE = '22023',
      DETAIL = format('confirmed %s > allowed max %s', p_confirmed_day, v_max);
  END IF;

  INSERT INTO public.r5_family_progress
    (family_id, authoritative_day, initialized_on, initialized_from)
  VALUES (p_family_id, p_confirmed_day, today_date, 'parent_confirmed')
  ON CONFLICT (family_id) DO NOTHING;

  INSERT INTO public.r5_day_confirmation
    (family_id, confirmed_day, confirmed_by, snapshot, snapshot_fingerprint)
  VALUES (p_family_id, p_confirmed_day, p_confirmed_by, snap, snap->>'snapshot_fingerprint');

  INSERT INTO public.r5_plan_audit
    (family_id, occurred_on, event, authoritative_day, actor, detail)
  VALUES (p_family_id, today_date, 'initialize_authoritative_day', p_confirmed_day,
          p_confirmed_by,
          jsonb_build_object('confirmed_day', p_confirmed_day,
                             'plan_max_day', snap->>'plan_max_day',
                             'snapshot_fingerprint', snap->>'snapshot_fingerprint'));

  RETURN jsonb_build_object('result', 'initialized',
                            'authoritative_day', p_confirmed_day,
                            'initialized_from', 'parent_confirmed',
                            'snapshot', snap);
END;
$function$;

COMMENT ON FUNCTION public.r5_initialize_authoritative_day(text, integer, text, text) IS
  'C0.1 ADMIN ONLY: initialise authoritative day from a clean snapshot + verified parent confirmation. Never called by clients.';

-- -----------------------------------------------------------------------------
-- 11. Privileges — deny by default, grant the client API only
-- -----------------------------------------------------------------------------
-- Tables: no direct access for anyone but the owner. No RLS policy exists, so
-- even a hypothetical grant would return nothing; all access is via the
-- SECURITY DEFINER functions above.
REVOKE ALL ON TABLE public.r5_family_progress     FROM PUBLIC;
REVOKE ALL ON TABLE public.r5_plan_audit          FROM PUBLIC;
REVOKE ALL ON TABLE public.r5_credential_snapshot FROM PUBLIC;
REVOKE ALL ON TABLE public.r5_day_confirmation    FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.r5_plan_audit_audit_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.r5_day_confirmation_confirmation_id_seq FROM PUBLIC;

ALTER TABLE public.r5_family_progress     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_plan_audit          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_credential_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.r5_day_confirmation    ENABLE ROW LEVEL SECURITY;

DO $priv$
DECLARE
  fn text;
  api_fns text[] := ARRAY[
    'public.r5_credential_derive(text,jsonb)',
    'public.r5_initialization_snapshot(text)'
  ];
  internal_fns text[] := ARRAY[
    'public.r5_credential_derive_impl(text,jsonb)',
    'public.r5_initialization_snapshot_impl(text)',
    'public.r5_initialize_authoritative_day(text,integer,text,text)'
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
    -- PostgREST exposes r5_* only to `authenticated`; the functions themselves
    -- then enforce family membership. `anon` deliberately gets nothing.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END IF;
  END LOOP;
END;
$priv$;

COMMIT;
