/* Production rehearsal — does the candidate accept the REAL family, and does
 * the REAL family then get a working day 3?
 *
 * This is not another synthetic scenario. It reproduces the live family's exact
 * shape, read read-only from production on 2026-11-14:
 *
 *   plan rows   11-08 d1 / 11-09 d1 / 11-10 d1 / 11-11 d2 / 11-12 d2 / 11-13 d1
 *   records     73 total: day1 科学 5 answers + 1 completion (11-11),
 *               day1 英语 14 answers + 1 completion (11-12),
 *               day6 数学 2 answers (11-06), day9 语文 47 answers / 37 correct
 *               (11-09), 3 sync-test rows with no learning_day
 *   members     owner + parent + grandparent
 *   settings    1800s, bonus 0, enabled
 *
 * Counts, dates, subjects and correctness splits are the live ones. Record ids
 * are synthetic: the point is behaviour, not row identity.
 *
 * The parent has confirmed: day 1 done, day 2 done (complete in the cloud is
 * missing), day 3 in progress (数学 + 英语). The rehearsal asserts the candidate
 * lands exactly there and nowhere else.
 *
 * Run: node tests/isolated/rehearsal.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createSuite, writeJson } from '../lib/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const BASE = read('fixtures/schema/base-schema.sql');
const PROD_ACL = read('fixtures/schema/production-acl.sql');
const M010 = read('candidate/sql/010_authoritative_day.sql');
const LEGACY_GATE = read('candidate/sql/legacy/r5_gate_status_core.production.sql');
const LEGACY_PUB = read('candidate/sql/legacy/r5_publish_today.production.sql');
const M020 = read('candidate/sql/020_gate_and_publish.sql');

const deLegacy = (src, from, to) => src.replace(`FUNCTION public.${from}(`, `FUNCTION public.${to}(`);
const PROD_GATE = deLegacy(LEGACY_GATE, 'r5_gate_status_core_legacy', 'r5_gate_status_core');
const PROD_PUB = deLegacy(LEGACY_PUB, 'r5_publish_today_legacy', 'r5_publish_today');

const FAM = 'little-growth-family-001';
const suite = createSuite('production-rehearsal');
const check = (...a) => suite.check(...a);
const grab = async (fn) => {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, message: e.message || String(e) }; }
};
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];

/* ---------------------------------------------------------------- seed ---- */
async function seed(db) {
  await db.query('INSERT INTO growth_families(family_id) VALUES ($1)', [FAM]);
  await db.query(`INSERT INTO growth_family_members(family_id,user_id,member_role) VALUES
    ($1,'u-owner','owner'), ($1,'u-parent','parent'), ($1,'u-grandma','grandparent')`, [FAM]);
  await db.query('INSERT INTO r5_parent_settings(family_id,daily_seconds,bonus_seconds,enabled) VALUES ($1,1800,0,true)', [FAM]);
  // the family is NOT initialised: no r5_family_progress row exists yet

  const plans = [
    ['2026-11-08', 1, ['英语', '科学']],
    ['2026-11-09', 1, ['英语', '科学']],
    ['2026-11-10', 1, ['英语', '科学']],
    ['2026-11-11', 2, ['语文', '数学']],
    ['2026-11-12', 2, ['语文', '数学']],
    ['2026-11-13', 1, ['英语', '科学']],
  ];
  for (const [d, day, subj] of plans) {
    await db.query('INSERT INTO r5_daily_plan(family_id,study_date,day_index,subjects,published) VALUES ($1,$2,$3,$4::jsonb,true)',
      [FAM, d, day, JSON.stringify(subj)]);
  }

  let n = 0;
  const answer = async (subject, day, correct, date, extra = {}) => {
    const id = `${FAM}-r${String(++n).padStart(3, '0')}`;
    await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
      VALUES ($1,$2,'answer',$3,$4,$5::jsonb)`,
      [id, FAM, subject, day, JSON.stringify({ index: n, answer: { date, correct, ...extra }, source: 'v6', version: 1 })]);
  };
  const complete = async (subject, day, completedAt) => {
    const id = `${FAM}-r${String(++n).padStart(3, '0')}`;
    await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
      VALUES ($1,$2,'course-complete',$3,$4,$5::jsonb)`,
      [id, FAM, subject, day, JSON.stringify({ day, source: 'v6', version: 1, completed_at: completedAt })]);
  };
  const syncTest = async (date) => {
    const id = `${FAM}-r${String(++n).padStart(3, '0')}`;
    await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
      VALUES ($1,$2,'sync-test','系统检测',NULL,$3::jsonb)`,
      [id, FAM, JSON.stringify({ test: true, version: 1 })]);
  };

  for (let i = 0; i < 5; i += 1) await answer('科学', 1, true, '2026-11-11');
  await complete('科学', 1, '2026-11-11T10:19:38.551Z');
  for (let i = 0; i < 14; i += 1) await answer('英语', 1, true, '2026-11-12');
  await complete('英语', 1, '2026-11-12T11:27:49.852Z');
  for (let i = 0; i < 2; i += 1) await answer('数学', 6, true, '2026-11-06');
  for (let i = 0; i < 47; i += 1) await answer('语文', 9, i < 37, '2026-11-09');
  await syncTest('2026-11-06');
  await syncTest('2026-11-09');
  await syncTest('2026-11-06');
  return n;
}

const recordFingerprint = async (db, family) => one(db, `SELECT count(*)::int AS n,
    md5(string_agg(record_id||'|'||coalesce(subject,'~')||'|'||coalesce(learning_day::text,'~')||'|'||record_data::text, E'\\n' ORDER BY record_id)) AS fp
  FROM growth_learning_records WHERE family_id=$1`, [family]);

const planFingerprint = async (db, family) => one(db, `SELECT count(*)::int AS n,
    md5(string_agg(study_date::text||'|'||day_index::text||'|'||subjects::text||'|'||published::text, E'\\n' ORDER BY study_date)) AS fp
  FROM r5_daily_plan WHERE family_id=$1`, [family]);

/* --------------------------------------------------------------- build ---- */
const db = new PGlite();
await db.exec(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;`);
await db.exec(BASE);
await db.exec(PROD_GATE);
await db.exec(PROD_PUB);
await db.exec(PROD_ACL);

const seededRows = await seed(db);
check('P0', 'the rehearsal starts from exactly 73 records and 6 plan rows',
  seededRows === 73 && (await planFingerprint(db, FAM)).n === 6, `records=${seededRows}`);

const recBefore = await recordFingerprint(db, FAM);
const planBefore = await planFingerprint(db, FAM);

/* ------------------------------------------------- deploy 010 + 020 ------ */
await db.exec(M010);
await db.exec(LEGACY_GATE);
await db.exec(LEGACY_PUB);
await db.exec(M020);

const todayRow = await one(db, "SELECT (timezone('Asia/Shanghai', clock_timestamp()))::date::text AS d");
const TODAY = todayRow.d;

const asParent = () => db.exec(`SET request.jwt.claims = '{"sub":"u-parent","role":"authenticated"}'`);
const asOwner = () => db.exec(`SET request.jwt.claims = '{"sub":"u-owner","role":"authenticated"}'`);
const asAdmin = () => db.exec('RESET request.jwt.claims');

/* B0 — the deployment alone locks the publish path, which is why B and F must
 * share one maintenance window. */
await asParent();
const publishBeforeInit = await grab(() => one(db, 'SELECT public.r5_publish_today($1,$2,$3) AS r', [FAM, 1, false]));
check('B0', 'between deploy and initialisation the family cannot publish a plan (R5_DAY_NOT_INITIALIZED)',
  !publishBeforeInit.ok && /R5_DAY_NOT_INITIALIZED/.test(publishBeforeInit.message),
  publishBeforeInit.ok ? 'publish unexpectedly succeeded' : publishBeforeInit.message);

/* B1 — the gate keeps answering during that window, degraded. */
const statusInWindow = await grab(() => one(db, 'SELECT public.r5_status($1) AS s', [FAM]));
check('B1', 'the gate still answers in the deploy→init window (degraded, not a 500)',
  statusInWindow.ok && typeof statusInWindow.value.s.allowed === 'boolean',
  statusInWindow.ok ? 'ok' : statusInWindow.message);

/* ------------------------------------------------------------- snapshot -- */
/* the snapshot is a client API: it checks membership, so read it as the parent */
await asParent();
const snap = (await one(db, 'SELECT public.r5_initialization_snapshot($1) AS s', [FAM])).s;
const ev = (k) => snap[k];

suite.equals('B2', 'plan history is read as the live rows [1,1,1,2,2,1]', ev('plan_days'), [1, 1, 1, 2, 2, 1]);
suite.equals('B3', 'plan_max_day is 2, latest_plan_day is 1, high-water date is 11-11',
  [ev('plan_max_day'), ev('latest_plan_day'), ev('plan_high_water_date')], [2, 1, '2026-11-11']);
suite.equals('B4', 'exactly one rollback row (11-13 day1) is detected',
  (ev('rollback_plan_rows') || []).map((r) => [r.date, r.day]), [['2026-11-13', 1]]);
suite.equals('B5', 'the rollback is classified as correctable, not blocking',
  [ev('corrections_required'), ev('blocking')], [['PLAN_HISTORY_ROLLBACK'], []]);
suite.equals('B6', 'the confirmation window collapses to [3,3]',
  [ev('allowed_min_day'), ev('allowed_max_day')], [3, 3]);
suite.equals('B7', 'the record day set is [1,6,9] and nothing is dated on the latest plan date',
  [ev('record_learning_days'), ev('latest_plan_date_record_days')], [[1, 6, 9], []]);

/* the day-6 / day-9 rows must not be mistaken for a device disagreement */
check('B8', 'day6/day9 records do not raise DEVICE_DAY_DISAGREEMENT or RECORD_DAY_AHEAD_OF_PLAN',
  !ev('blocking').includes('DEVICE_DAY_DISAGREEMENT') && !ev('blocking').includes('RECORD_DAY_AHEAD_OF_PLAN'),
  JSON.stringify(ev('blocking')));

/* B9 — the only accepted value is 3, and the function says so itself */
const fp = ev('snapshot_fingerprint');
const byOperator = 'parent:little-growth-family-001:2026-11-14';
/* the initialisation itself is an operator action, refused for app sessions */
await asAdmin();
const tryInit = (day, corr) => grab(() => one(db,
  'SELECT public.r5_initialize_authoritative_day($1,$2,$3,$4,$5::jsonb) AS r', [FAM, day, byOperator, fp, corr ? JSON.stringify(corr) : null]));

const r2 = await tryInit(2);
check('B9', 'confirming day 2 is refused (it would reopen a day already lived through)',
  !r2.ok && /R5_INIT_|R5_DAY_NOT_IN|22023|40001/.test(String(r2.message)),
  r2.ok ? 'day 2 accepted' : r2.message);
const r4 = await tryInit(4);
check('B10', 'confirming day 4 is refused (no skipping an unplayed day)',
  !r4.ok, r4.ok ? 'day 4 accepted' : 'refused');
const r3raw = await tryInit(3, null);
check('B11', 'confirming day 3 without acknowledging the rollback is refused',
  !r3raw.ok && /R5_INIT_CORRECTION_REQUIRED/.test(String(r3raw.message)),
  r3raw.ok ? 'accepted without correction' : r3raw.message);

/* ------------------------------------------------------------ initialise - */
const r3 = await tryInit(3, {
  acknowledged: ['PLAN_HISTORY_ROLLBACK'],
  reason: '家长确认：第一、二学习日已完成，第三天正在学数学+英语；云端 11-13 计划因旧设备回写成 day1，按家长确认纠正为 day3。',
});
check('B12', 'confirming day 3 with the acknowledged correction succeeds',
  r3.ok && Number(r3.value.r.authoritative_day) === 3,
  r3.ok ? JSON.stringify(r3.value.r) : r3.message);

const prog = await one(db, 'SELECT * FROM public.r5_family_progress WHERE family_id=$1', [FAM]);
check('B13', 'the progress row holds day 3 and records how it was reached',
  Number(prog.authoritative_day) === 3 && prog.initialized_from === 'parent_confirmed',
  JSON.stringify({ day: prog.authoritative_day, from: prog.initialized_from }));
check('B14', 'day advancement is NOT pre-stamped (last_advanced_on is null)',
  prog.last_advanced_on === null, String(prog.last_advanced_on));

const conf = await one(db, `SELECT confirmed_day, corrections_applied, correction_reason, confirmed_by
  FROM public.r5_day_confirmation WHERE family_id=$1`, [FAM]);
check('B15', 'the confirmation audit row stores day 3, the correction code and the written reason',
  Number(conf.confirmed_day) === 3
  && JSON.stringify(conf.corrections_applied) === JSON.stringify(['PLAN_HISTORY_ROLLBACK'])
  && String(conf.correction_reason || '').length >= 8,
  JSON.stringify(conf));

/* B16 — nothing was invented: no record, no plan, no score was written */
const recAfter = await recordFingerprint(db, FAM);
const planAfter = await planFingerprint(db, FAM);
check('B16', 'initialisation writes no learning record and no plan row (fingerprints unchanged)',
  recAfter.n === recBefore.n && recAfter.fp === recBefore.fp
  && planAfter.n === planBefore.n && planAfter.fp === planBefore.fp,
  `records ${recBefore.n}/${recBefore.fp} -> ${recAfter.n}/${recAfter.fp}`);
check('B17', 'no record was re-dated to day 3 and no day-2 score was fabricated',
  (await one(db, `SELECT count(*)::int AS n FROM growth_learning_records
     WHERE family_id=$1 AND learning_day=3`, [FAM])).n === 0,
  'day-3 record count');

/* --------------------------------------------------- stale device guard -- */
await asParent();
const staleInsert = await grab(() => db.query(
  'INSERT INTO r5_daily_plan(family_id,study_date,day_index,subjects,published) VALUES ($1,$2,1,$3::jsonb,true)',
  [FAM, TODAY, JSON.stringify(['英语', '科学'])]));
check('B18', 'a stale device cannot write today\'s plan as day 1 (trigger refuses it)',
  !staleInsert.ok && /R5_PLAN_DAY_REGRESSION/.test(String(staleInsert.message)),
  staleInsert.ok ? 'day 1 plan accepted' : staleInsert.message);

/* ---------------------------------------------------------- publish day3 - */
const pub = await grab(() => one(db, 'SELECT public.r5_publish_today($1,$2,$3) AS r', [FAM, 1, false]));
check('B19', 'a client that still believes it is day 1 publishes day 3 and is told it is stale',
  pub.ok && Number(pub.value.r.study_day) === 3 && pub.value.r.stale_client === true
  && JSON.stringify(pub.value.r.subjects) === JSON.stringify(['数学', '英语']),
  pub.ok ? JSON.stringify(pub.value.r) : pub.message);
check('B20', 'the stored plan for today is day 3 with 数学 + 英语',
  JSON.stringify((await one(db, `SELECT day_index, subjects FROM r5_daily_plan
     WHERE family_id=$1 AND study_date=$2`, [FAM, TODAY]))) === JSON.stringify({ day_index: 3, subjects: ['数学', '英语'] }),
  'today plan');

/* ------------------------------------------------------------- the gate -- */
const gate = async () => (await one(db, 'SELECT public.r5_gate_status_core($1,$2,$3) AS g', [FAM, true, false])).g;

const g0 = await gate();
check('B21', 'with no day-3 evidence the gate is closed',
  g0.allowed === false && Number(g0.authoritative_day) === 3, JSON.stringify({ allowed: g0.allowed, why: g0.reason }));
check('B22', 'day-1 English is NOT borrowed as day-3 English',
  g0.modules.every((m) => m.evidence !== 'CREDENTIAL_FROM_HISTORY'),
  JSON.stringify(g0.modules.map((m) => [m.subject, m.passed, m.evidence || null])));

/* only 数学 has been done -> still closed */
await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
  VALUES ($1,$2,'answer','数学',3,$3::jsonb)`, [`${FAM}-d3-ma`, FAM,
  JSON.stringify({ answer: { date: TODAY, correct: true } })]);
await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
  VALUES ($1,$2,'course-complete','数学',3,$3::jsonb)`, [`${FAM}-d3-ma-c`, FAM,
  JSON.stringify({ day: 3, completed_at: `${TODAY}T10:00:00.000Z` })]);
const g1 = await gate();
check('B23', 'one of two subjects is not enough — the gate stays closed',
  g1.allowed === false && g1.all_pass === false,
  JSON.stringify({ allowed: g1.allowed, all_pass: g1.all_pass, modules: g1.modules.map((m) => [m.subject, m.passed]) }));

/* English below threshold -> still closed */
for (let i = 0; i < 5; i += 1) {
  await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
    VALUES ($1,$2,'answer','英语',3,$3::jsonb)`,
    [`${FAM}-d3-en-${i}`, FAM, JSON.stringify({ answer: { date: TODAY, correct: i < 3 } })]);
}
await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
  VALUES ($1,$2,'course-complete','英语',3,$3::jsonb)`, [`${FAM}-d3-en-c`, FAM,
  JSON.stringify({ day: 3, completed_at: `${TODAY}T10:30:00.000Z` })]);
const g2 = await gate();
check('B24', '60% accuracy does not unlock the gate',
  g2.allowed === false, JSON.stringify({ allowed: g2.allowed, why: g2.reason }));

/* raise English to >=80% -> unlocked */
await db.query(`UPDATE growth_learning_records SET record_data = jsonb_set(record_data, '{answer,correct}', 'true')
  WHERE record_id LIKE $1`, [`${FAM}-d3-en-%`]);
const g3 = await gate();
check('B25', 'both subjects complete and at/above threshold unlocks the gate (racing entry)',
  g3.allowed === true && g3.all_pass === true && g3.study_passed === true,
  JSON.stringify({ allowed: g3.allowed, why: g3.reason, modules: g3.modules.map((m) => [m.subject, m.passed]) }));

/* B26 — day 4 is not handed out on its own */
const prog2 = await one(db, 'SELECT authoritative_day, last_advanced_on FROM public.r5_family_progress WHERE family_id=$1', [FAM]);
check('B26', 'finishing day 3 does NOT auto-advance to day 4',
  Number(prog2.authoritative_day) === 3 && prog2.last_advanced_on === null,
  JSON.stringify(prog2));

/* B27 — re-publishing the same day is idempotent and still day 3 */
await asOwner();
const pub2 = await grab(() => one(db, 'SELECT public.r5_publish_today($1,$2,$3) AS r', [FAM, 3, false]));
check('B27', 'a second publish on the same day stays on day 3',
  pub2.ok && Number(pub2.value.r.study_day) === 3 && pub2.value.r.idempotent === true,
  pub2.ok ? JSON.stringify(pub2.value.r) : pub2.message);

/* B28 — the historical rows are still untouched after the whole run */
/* the eight day-3 rows are the child's real new work; the historical set must
 * be the untouched original 73 */
const historical = await one(db, `SELECT count(*)::int AS n,
    md5(string_agg(record_id||'|'||coalesce(subject,'~')||'|'||coalesce(learning_day::text,'~')||'|'||record_data::text, E'\n' ORDER BY record_id)) AS fp
  FROM growth_learning_records WHERE family_id=$1 AND learning_day IS DISTINCT FROM 3`, [FAM]);
check('B28', 'the 73 historical records are byte-identical at the end of the run',
  historical.n === 73 && historical.fp === recBefore.fp, `${historical.n}/${historical.fp} want 73/${recBefore.fp}`);

/* B29 — 1800s quota untouched */
const quota = await one(db, 'SELECT daily_seconds, bonus_seconds, enabled FROM r5_parent_settings WHERE family_id=$1', [FAM]);
suite.equals('B29', 'the 1800s quota and parent switch are unchanged',
  [quota.daily_seconds, quota.bonus_seconds, quota.enabled], [1800, 0, true]);

const s = suite.print();
await db.close();
writeJson(path.join(ROOT, 'evidence/production-rehearsal-results.json'), {
  generated_at: new Date().toISOString(),
  family_shape: {
    plan_rows: 6, plan_days: [1, 1, 1, 2, 2, 1], records: 73,
    source: 'read-only export of normal-goose-d5g4qyzr8bb389a4a on 2026-11-14',
  },
  summary: s,
  results: suite.results,
});
process.exit(s.failed === 0 ? 0 : 1);
