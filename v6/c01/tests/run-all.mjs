/* C0.1 master runner — runs every suite in a child process and aggregates the
 * evidence. Designed to work in a fresh, empty directory that contains ONLY the
 * files of this delivery (no reference to any sibling project folder).
 *
 *   npm install      # one dependency: @electric-sql/pglite (real PostgreSQL/WASM)
 *   node tests/run-all.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const SUITES = [
  { id: 'pre-s2', file: 'tests/pre-s2.test.mjs', needsDb: false },
  { id: 'bridge', file: 'tests/unit/bridge.test.mjs', needsDb: false },
  { id: 'sw-cache', file: 'tests/unit/sw.test.mjs', needsDb: false },
  { id: 'sql-e2e', file: 'tests/sql/e2e.test.mjs', needsDb: true },
  { id: 'live-assets', file: 'tests/live-assets.mjs', needsDb: false },
];

let pglite = true;
try { require.resolve('@electric-sql/pglite'); } catch { pglite = false; }

const summary = { started_at: new Date().toISOString(), node: process.version, pglite, suites: [] };

for (const s of SUITES) {
  if (s.needsDb && !pglite) {
    console.log(`\n### ${s.id}: SKIPPED — @electric-sql/pglite is not installed (run: npm install)`);
    summary.suites.push({ suite: s.id, status: 'SKIPPED', reason: 'PGLITE_UNAVAILABLE', total: 0, passed: 0, failed: 0 });
    continue;
  }
  console.log(`\n### ${s.id}`);
  const res = spawnSync(process.execPath, [path.join(ROOT, s.file)], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, C01_SUITE: s.id },
  });
  const evidenceFile = path.join(ROOT, 'evidence', `${s.id}-results.json`);
  let parsed = null;
  if (fs.existsSync(evidenceFile)) {
    try { parsed = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')); } catch { parsed = null; }
  }
  const failed = parsed ? parsed.failed : (res.status === 0 ? 0 : 1);
  summary.suites.push({
    suite: s.id,
    status: failed === 0 ? 'PASS' : 'FAIL',
    exit_code: res.status,
    total: parsed ? parsed.total : 0,
    passed: parsed ? parsed.passed : 0,
    failed,
    skipped: parsed ? parsed.skipped : 0,
    verified: parsed && 'verified' in parsed ? parsed.verified : null,
    failures: parsed ? parsed.failures : [],
  });
}

const totals = summary.suites.reduce((a, s) => ({
  total: a.total + (s.total || 0),
  passed: a.passed + (s.passed || 0),
  failed: a.failed + (s.failed || 0),
  skipped: a.skipped + (s.skipped || 0),
}), { total: 0, passed: 0, failed: 0, skipped: 0 });

summary.totals = totals;
summary.verdict = totals.failed === 0 && summary.suites.every((s) => s.status !== 'SKIPPED') ? 'PASS' : 'INCOMPLETE';
summary.finished_at = new Date().toISOString();

console.log('\n================ C0.1 TEST SUMMARY ================');
for (const s of summary.suites) {
  console.log(`${s.status.padEnd(8)} ${s.suite.padEnd(12)} ${s.passed}/${s.total} passed, ${s.failed} failed, ${s.skipped} skipped`
    + (s.reason ? ` (${s.reason})` : ''));
}
console.log(`TOTAL    ${totals.passed}/${totals.total} passed, ${totals.failed} failed, ${totals.skipped} skipped`);
console.log(`VERDICT  ${summary.verdict}`);
if (summary.suites.some((s) => s.verified === false)) {
  console.log('NOTE     live-assets ran in UNVERIFIED mode (network unavailable); no cached result was used.');
}

fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'evidence/run-all-summary.json'),
  JSON.stringify(summary, null, 2) + '\n', 'utf8');

if (totals.failed > 0) process.exitCode = 1;
