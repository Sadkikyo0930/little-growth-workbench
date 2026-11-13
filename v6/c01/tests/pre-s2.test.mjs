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

const summary = suite.print();
writeJson(path.join(ROOT, 'evidence/pre-s2-results.json'), { ...summary, results: suite.results });
if (summary.failed > 0) process.exitCode = 1;
