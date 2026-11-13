/* C0.1 Pre-S2 gate — 15 static/reviewable gates that must hold BEFORE any
 * deployment is requested. These are the checks that used to be entangled with
 * post-deployment assertions (the S2 circular dependency).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSuite, writeJson } from './lib/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const M010 = read('candidate/sql/010_authoritative_day.sql');
const M020 = read('candidate/sql/020_gate_and_publish.sql');
const M900 = read('candidate/sql/900_rollback.sql');
const LEG_GATE = read('candidate/sql/legacy/r5_gate_status_core.production.sql');
const BRIDGE = read('candidate/v6/r5-bridge.js');
const SW = read('candidate/v6/sw.js');
const SW_SELF = read('candidate/v6-selftest/sw.js');

const suite = createSuite('pre-s2');

const DML_RECORDS = /(insert\s+into|update|delete\s+from|truncate)\s+(public\.)?growth_learning_records/i;

suite.check('P1', '010 never writes child records', !DML_RECORDS.test(M010));
suite.check('P2', '020 never writes child records', !DML_RECORDS.test(M020));
suite.check('P3', 'rollback never writes child records', !DML_RECORDS.test(M900));

suite.check('P4', 'r5_publish_today keeps its exact 3-argument signature',
  /FUNCTION public\.r5_publish_today\(p_family_id text, p_day_index integer, p_no_tasks boolean DEFAULT false\)/.test(M020));
suite.check('P5', 'r5_gate_status_core keeps its exact 3-argument signature',
  /FUNCTION public\.r5_gate_status_core\(p_family_id text, p_entry boolean, p_ignore_override boolean\)/.test(M020));
suite.check('P6', 'r5_status / r5_gate_status / r5_child_entry / r5_claim_answers are not redefined',
  !/FUNCTION public\.(r5_status|r5_gate_status|r5_child_entry|r5_claim_answers)\s*\(/.test(M020));

const bodyOf = (src, fn) => {
  const i = src.indexOf(`FUNCTION public.${fn}(`);
  if (i < 0) return null;
  const a = src.indexOf('AS $function$', i) + 'AS $function$'.length;
  const b = src.indexOf('$function$', a);
  return src.slice(a, b).replace(/\r\n/g, '\n').trim();
};
suite.check('P7', 'rollback restores the byte-identical production gate body',
  bodyOf(M900, 'r5_gate_status_core') === bodyOf(LEG_GATE, 'r5_gate_status_core_legacy'));

suite.check('P8', 'the 1800s quota chain is untouched',
  !/update\s+(public\.)?r5_parent_settings/i.test(M010 + M020 + M900)
  && !/daily_seconds\s*:=/i.test(M020)
  && !/1800/.test(BRIDGE));

suite.check('P9', 'bridge keeps every legacy RPC name and parameter',
  ['r5_status', 'r5_publish_today', 'r5_claim_answers'].every((n) => BRIDGE.includes(n))
  && BRIDGE.includes('p_family_id') && BRIDGE.includes('p_day_index')
  && BRIDGE.includes('p_no_tasks') && BRIDGE.includes('p_items'));

const staleIdx = BRIDGE.indexOf("state: 'stale_device_day'");
const uploadIdx = BRIDGE.indexOf('await upload(rows, who)');
suite.check('P10', 'the stale-device gate runs before any upload call',
  staleIdx > 0 && uploadIdx > 0 && staleIdx < uploadIdx, `${staleIdx}/${uploadIdx}`);

suite.check('P11', 'bridge never rewrites a learning_day to the cloud day',
  !/learning_day\s*:\s*(cloudDay|ds\.today|day0\.today)/.test(BRIDGE));

suite.check('P12', 'the two service workers use disjoint cache prefixes',
  /const PREFIX='little-growth-v6-pwa-'/.test(SW)
  && /const PREFIX='little-growth-v6-selftest-pwa-'/.test(SW_SELF)
  && SW.includes("'./november-subject-schedule.js'")
  && SW_SELF.includes("'./november-subject-schedule.js'"));

suite.check('P13', 'rollback only drops objects this change creates',
  !/drop\s+table\s+(if\s+exists\s+)?public\.(growth_learning_records|r5_daily_plan|r5_parent_settings|r5_racing_saves)/i.test(M900)
  && /DROP TABLE IF EXISTS public\.r5_family_progress/.test(M900));

const SECRET = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|token|secret)\s*[:=]\s*["'][^"']{8,})/i;
const files = ['candidate/sql/010_authoritative_day.sql', 'candidate/sql/020_gate_and_publish.sql',
  'candidate/sql/900_rollback.sql', 'candidate/v6/r5-bridge.js', 'candidate/v6/sw.js',
  'candidate/v6-selftest/sw.js'];
suite.check('P14', 'candidate files contain no credentials or secrets',
  files.every((f) => !SECRET.test(read(f))));

const required = [
  'candidate/v6/r5-bridge.js',
  'candidate/v6/sw.js',
  'candidate/v6-selftest/sw.js',
  'candidate/sql/010_authoritative_day.sql',
  'candidate/sql/020_gate_and_publish.sql',
  'candidate/sql/900_rollback.sql',
  'candidate/sql/legacy/r5_gate_status_core.production.sql',
  'candidate/sql/legacy/r5_publish_today.production.sql',
];
suite.check('P15', 'the deliverable contains every deployment-candidate file',
  required.every((f) => fs.existsSync(path.join(ROOT, f))),
  required.filter((f) => !fs.existsSync(path.join(ROOT, f))).join(','));

/* ---------------------------------------------------------------------------
 * P16–P22 — the two blockers from the independent review, as static gates.
 * These run before anything is deployed, so a regression cannot reach S3.
 * ------------------------------------------------------------------------- */

const ALL_SQL = M010 + M020;

/* P16 — the migration must never decide the day by itself. Every write into
 * r5_family_progress has to be a literal VALUES (a parameter or the constant 1),
 * never a SELECT that aggregates plan history. MAX(day_index) may still appear as
 * a *reported* snapshot field; what is forbidden is turning it into authority. */
{
  const inserts = [...ALL_SQL.matchAll(/INSERT\s+INTO\s+public\.r5_family_progress[\s\S]{0,240}/gi)]
    .map((m) => m[0]);
  const selectDriven = inserts.filter((s) => !/VALUES\s*\(/i.test(s));
  suite.check('P16', '010 never initialises authoritative_day from plan history',
    inserts.length >= 2 && selectDriven.length === 0
    && !/latest_published_plan_max_day|initialized_from\s*,\s*[^)]*day_index/i.test(ALL_SQL),
    `inserts=${inserts.length} select_driven=${selectDriven.length}`);
}

/* P17 — every SECURITY DEFINER function must pin search_path. */
{
  const definers = [...ALL_SQL.matchAll(/CREATE OR REPLACE FUNCTION ([\s\S]*?)\$function\$/g)]
    .map((m) => m[1])
    .filter((body) => /SECURITY DEFINER/i.test(body));
  const unpinned = definers.filter((body) => !/SET search_path TO 'pg_catalog', 'public'/i.test(body));
  suite.check('P17', 'every SECURITY DEFINER function pins search_path',
    definers.length >= 10 && unpinned.length === 0,
    `definers=${definers.length} unpinned=${unpinned.length}`);
}

/* P18 — no function or table may be opened to PUBLIC. */
suite.check('P18', 'no candidate statement grants anything to PUBLIC except the rollback restore',
  !/GRANT\s+[A-Z ,]+\s+ON\s+(FUNCTION|TABLE|SEQUENCE)[\s\S]{0,80}?\sTO\s+PUBLIC/i.test(ALL_SQL)
  && /REVOKE ALL ON FUNCTION %s FROM PUBLIC/.test(M010)
  && /REVOKE ALL ON FUNCTION %s FROM PUBLIC/.test(M020));

/* P19 — RLS must be enabled on all four new tables, never disabled. */
{
  const enabled = [...ALL_SQL.matchAll(/ALTER TABLE (public\.\w+)\s+ENABLE ROW LEVEL SECURITY/gi)].map((m) => m[1]);
  suite.check('P19', 'RLS is enabled on every new table and never disabled',
    enabled.length === 4
    && ['r5_family_progress', 'r5_plan_audit', 'r5_credential_snapshot', 'r5_day_confirmation']
      .every((t) => enabled.includes('public.' + t))
    && !/DISABLE ROW LEVEL SECURITY/i.test(ALL_SQL),
    enabled.join(','));
}

/* P20 — the identity of the caller must be checked in every client-facing body. */
suite.check('P20', 'every client-facing function authenticates before touching a family',
  /CREATE OR REPLACE FUNCTION public\.r5_credential_derive\([\s\S]{0,3000}?PERFORM public\.r5_assert_member/.test(M010)
  && /CREATE OR REPLACE FUNCTION public\.r5_advance_day\([\s\S]{0,1200}?r5_assert_member\(p_family_id, true\)/.test(M020)
  && /RAISE EXCEPTION 'R5_AUTH_REQUIRED'/.test(M020));

/* P21 — the privileged initialiser must stay out of the client API. */
suite.check('P21', 'r5_initialize_authoritative_day is never granted to authenticated/anon',
  !/GRANT EXECUTE ON FUNCTION public\.r5_initialize_authoritative_day/i.test(ALL_SQL)
  && /public\.r5_initialize_authoritative_day\(text,integer,text,text\)/.test(M010)
  && /internal_fns text\[\] := ARRAY\[[\s\S]*?r5_initialize_authoritative_day/.test(M010));

/* P22 — a family with history must fail closed, not be created at day 1. */
suite.check('P22', 'progress_ensure refuses to invent a day for a family that already has history',
  /R5_DAY_NOT_INITIALIZED/.test(M020)
  && /FROM public\.r5_daily_plan WHERE family_id = p_family_id/.test(M020)
  && /FROM public\.growth_learning_records WHERE family_id = p_family_id/.test(M020));

/* P23 — the rollback must remove everything the candidate adds. */
{
  const mustDrop = ['r5_initialize_authoritative_day', 'r5_initialization_snapshot',
    'r5_initialization_snapshot_impl', 'r5_credential_derive_impl', 'r5_day_confirmation'];
  suite.check('P23', 'rollback drops every new function and table, and restores the PUBLIC default',
    mustDrop.every((n) => new RegExp(`DROP (FUNCTION|TABLE) IF EXISTS public\\.${n}`, 'i').test(M900))
    && /GRANT EXECUTE ON FUNCTION public\.r5_publish_today\(text, integer, boolean\) TO PUBLIC/.test(M900),
    mustDrop.filter((n) => !new RegExp(`DROP (FUNCTION|TABLE) IF EXISTS public\\.${n}`, 'i').test(M900)).join(','));
}

const summary = suite.print();
writeJson(path.join(ROOT, 'evidence/pre-s2-results.json'), { ...summary, results: suite.results });
if (summary.failed > 0) process.exitCode = 1;
