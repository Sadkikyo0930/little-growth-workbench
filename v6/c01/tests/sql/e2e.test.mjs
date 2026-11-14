/* C0.1 SQL end-to-end suite — runs the DEPLOYMENT CANDIDATE (010 + 020) against a
 * real PostgreSQL 18 engine (PGlite/WASM), not a Python model.
 *
 * Every scenario is a real family with real rows: publish, upload, gate, waiver,
 * advance, rollback. The child-record table is never written by the candidate,
 * which the "zero record loss" checks prove by fingerprint.
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
const ROLLBACK_SQL = read('candidate/sql/900_rollback.sql');

/* The pre-migration state must look like production, where both functions
 * already exist and already carry an explicit ACL (no PUBLIC grant anywhere).
 * The legacy files are the same bytes under a _legacy name. */
const deLegacy = (src, from, to) => src.replace(`FUNCTION public.${from}(`, `FUNCTION public.${to}(`);
const PROD_GATE = deLegacy(LEGACY_GATE, 'r5_gate_status_core_legacy', 'r5_gate_status_core');
const PROD_PUB = deLegacy(LEGACY_PUB, 'r5_publish_today_legacy', 'r5_publish_today');

/* Every EXECUTE grant in the schema, canonicalised, so "same ACL" is a set
 * comparison rather than a regex over pg_proc's array literal. */
const aclLines = async (db) => (await db.query(`
  SELECT p.proname || '(' || oidvectortypes(p.proargtypes) || ')'
         || '|' ||
         CASE WHEN a.grantee = 0 THEN 'PUBLIC'
              WHEN a.grantee = p.proowner THEN 'OWNER'
              ELSE pg_get_userbyid(a.grantee) END
         || ':' || a.privilege_type AS line
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   WHERE n.nspname = 'public'
   ORDER BY 1`)).rows.map((r) => r.line);

const suite = createSuite('sql-e2e');
const num = (v) => (v === null || v === undefined ? v : Number(v));
const PROD_GATE_MD5 = 'f78aceeba9c934fa8f4b5c754daba101';
const PROD_PUB_MD5 = 'b0d8d2deb58ab5240c9207e6b5081ea3';

async function newDb({ candidate = true } = {}) {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(PROD_GATE);
  await db.exec(PROD_PUB);
  await db.exec(PROD_ACL);
  if (candidate) {
    await db.exec(M010);
    await db.exec(LEGACY_GATE);
    await db.exec(LEGACY_PUB);
    await db.exec(M020);
  }
  return db;
}

/* The grants the instance has BEFORE the migration — the target a rollback has
 * to reproduce. Captured once from a throwaway instance so H10 compares against
 * production's state and not against the candidate's own output. */
const PRE_MIGRATION_ACL = await (async () => {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(PROD_GATE);
  await db.exec(PROD_PUB);
  await db.exec(PROD_ACL);
  const lines = await aclLines(db);
  await db.close();
  return lines;
})();

async function today(db) {
  const r = await db.query("SELECT (timezone('Asia/Shanghai', clock_timestamp()))::date::text AS d");
  return r.rows[0].d;
}

const CLAIMS_PARENT = `SET request.jwt.claims = '{"sub":"u-parent","role":"authenticated"}'`;
const CLAIMS_CHILD = `SET request.jwt.claims = '{"sub":"u-child","role":"authenticated"}'`;

async function asParent(db) { await db.exec(CLAIMS_PARENT); }
async function asChild(db) { await db.exec(CLAIMS_CHILD); }

async function seedFamily(db, { id, day = 1, child = true } = {}) {
  await asParent(db);   // r5_assert_member reads request.jwt.claims
  await db.query('INSERT INTO growth_families(family_id) VALUES ($1)', [id]);
  await db.query("INSERT INTO growth_family_members(family_id,user_id,member_role) VALUES ($1,'u-parent','parent')", [id]);
  if (child) {
    await db.query("INSERT INTO growth_family_members(family_id,user_id,member_role) VALUES ($1,'u-child','grandparent')", [id]);
  }
  await db.query('INSERT INTO r5_parent_settings(family_id,daily_seconds,bonus_seconds) VALUES ($1,1800,0)', [id]);
  await db.query("INSERT INTO r5_family_progress(family_id,authoritative_day) VALUES ($1,$2)", [id, day]);
}

async function putPlan(db, id, date, dayIndex, subjects) {
  await db.query('INSERT INTO r5_daily_plan(family_id,study_date,day_index,subjects,published) VALUES ($1,$2,$3,$4::jsonb,true)',
    [id, date, dayIndex, JSON.stringify(subjects)]);
}

let seq = 0;
async function addAnswer(db, id, subject, day, correct, date, track = '课程', index = null) {
  const rid = `rec-${id}-${seq++}`;
  await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
    VALUES ($1,$2,'answer',$3,$4,$5::jsonb)`,
    [rid, id, subject, day, JSON.stringify({ answer: { correct: correct ? 'true' : 'false', date, track, index: index ?? seq } })]);
  return rid;
}

async function addCompletion(db, id, subject, day, completedAt) {
  const rid = `rec-${id}-${seq++}`;
  await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
    VALUES ($1,$2,'course-complete',$3,$4,$5::jsonb)`,
    [rid, id, subject, day, JSON.stringify(completedAt ? { completed_at: completedAt } : {})]);
  return rid;
}

async function status(db, id) {
  return (await db.query('SELECT public.r5_status($1) AS s', [id])).rows[0].s;
}

async function fingerprint(db, id) {
  const r = await db.query(`SELECT count(*)::int AS n,
    md5(string_agg(record_id||'|'||coalesce(subject,'~')||'|'||coalesce(learning_day::text,'~')||'|'||record_data::text, E'\\n' ORDER BY record_id)) AS fp
    FROM growth_learning_records WHERE family_id=$1`, [id]);
  return { n: r.rows[0].n, fp: r.rows[0].fp };
}

const dstr = (v) => (v == null ? null
  : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

async function derive(db, id) {
  const rows = (await db.query(
    'SELECT * FROM public.r5_credential_derive($1) ORDER BY learning_day_raw, subject_canonical, record_date',
    [id])).rows;
  return rows.map((r) => ({ ...r, record_date: dstr(r.record_date) }));
}

/* =========================================================================
 * K. Deployment-candidate integrity
 * ========================================================================= */
{
  const db = await newDb();
  const md5 = async (name) => (await db.query(
    `SELECT md5(prosrc) AS m FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=$1`, [name])).rows[0].m;

  suite.check('K1', 'legacy copy of r5_gate_status_core is byte-identical to production',
    (await md5('r5_gate_status_core_legacy')) === PROD_GATE_MD5, await md5('r5_gate_status_core_legacy'));
  suite.check('K2', 'legacy copy of r5_publish_today is byte-identical to production',
    (await md5('r5_publish_today_legacy')) === PROD_PUB_MD5, await md5('r5_publish_today_legacy'));
  suite.check('K3', 'new r5_gate_status_core differs from legacy (substitution added)',
    (await md5('r5_gate_status_core')) !== PROD_GATE_MD5);

  const sig = async (name) => (await db.query(
    `SELECT pg_get_function_identity_arguments(p.oid) AS a FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [name])).rows.map((r) => r.a);
  suite.equals('K4', 'r5_publish_today keeps (text, integer, boolean)',
    await sig('r5_publish_today'), ['p_family_id text, p_day_index integer, p_no_tasks boolean']);
  suite.equals('K5', 'r5_gate_status_core keeps (text, boolean, boolean)',
    await sig('r5_gate_status_core'), ['p_family_id text, p_entry boolean, p_ignore_override boolean']);
  suite.check('K6', 'r5_status / r5_child_entry / r5_claim_answers / r5_parent_waive are untouched',
    (await sig('r5_status')).length === 1 && (await sig('r5_child_entry')).length === 1
    && (await sig('r5_claim_answers')).length === 1 && (await sig('r5_parent_waive')).length === 1);
  suite.check('K7', 'candidate never issues DML against growth_learning_records',
    ![M010, M020].some((s) => /(insert\s+into|update|delete\s+from)\s+public\.growth_learning_records/i.test(s)));
  suite.check('K8', 'candidate never alters r5_parent_settings or racing saves',
    !/alter\s+table\s+public\.(r5_parent_settings|r5_racing_saves)/i.test(M010 + M020));
  await db.close();
}

/* =========================================================================
 * A. Day 2 -> day 3 : completion, advance, same-day idempotency, no rollback
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-a';
  const T = await today(db);
  await seedFamily(db, { id, day: 2 });
  await putPlan(db, id, T, 2, ['语文', '数学']);
  for (let i = 0; i < 5; i++) await addAnswer(db, id, '语文', 2, i < 5, T);
  for (let i = 0; i < 5; i++) await addAnswer(db, id, '数学', 2, i < 4, T);
  await addCompletion(db, id, '语文', 2, `${T}T02:00:00.000Z`);
  await addCompletion(db, id, '数学', 2, `${T}T02:10:00.000Z`);
  const before = await fingerprint(db, id);

  const s1 = await status(db, id);
  suite.check('A1', 'day 2 with both subjects at/above 80% unlocks', s1.allowed === true && s1.study_passed === true, s1.reason);
  suite.check('A2', 'day 2 modules report real accuracy', s1.modules.length === 2
    && num(s1.modules.find((m) => m.subject === '数学').accuracy_pct) === 80, JSON.stringify(s1.modules));
  suite.check('A3', 'quota is still 1800s + 1800 remaining', s1.daily_seconds === 1800 && s1.remaining_seconds === 1800);
  suite.check('A4', 'authoritative_day is reported by r5_status', s1.authoritative_day === 2, s1.authoritative_day);

  const adv1 = (await db.query('SELECT public.r5_advance_day($1,2) AS r', [id])).rows[0].r;
  suite.check('A5', 'first advance moves 2 -> 3', adv1.result === 'advance_day' && adv1.to === 3, JSON.stringify(adv1));
  const adv2 = (await db.query('SELECT public.r5_advance_day($1,3) AS r', [id])).rows[0].r;
  suite.check('A6', 'same-day repeat advance is a no-op', adv2.result === 'already_advanced', JSON.stringify(adv2));

  const s2 = await status(db, id);
  suite.check('A7', 'today\'s plan stays day 2 after the advance', s2.study_day === 2, s2.study_day);
  suite.check('A8', 'next day is exposed as authoritative_day 3', s2.authoritative_day === 3, s2.authoritative_day);

  let locked = null;
  try { await db.query('SELECT public.r5_publish_today($1,2,false)', [id]); } catch (e) { locked = e.message; }
  suite.check('A9', 're-publishing today is locked (no silent rewrite)', /R5_TODAY_PLAN_ALREADY_PUBLISHED/.test(locked || ''), locked);

  /* simulate the next calendar day: yesterday keeps the day-2 plan */
  await db.query('UPDATE r5_daily_plan SET study_date = ($2::date - 1) WHERE family_id=$1 AND study_date=$2', [id, T]);
  await db.query('UPDATE r5_family_progress SET last_advanced_on = NULL WHERE family_id=$1', [id]);
  const pub = (await db.query('SELECT public.r5_publish_today($1,2,false) AS r', [id])).rows[0].r;
  suite.check('A10', 'next day publishes day 3 from the authoritative day', pub.study_day === 3, JSON.stringify(pub));
  suite.check('A11', 'the stale client day is flagged, not obeyed', pub.stale_client === true && pub.client_day === 2);
  suite.check('A12', 'day-3 subjects come from the cloud template', JSON.stringify(pub.subjects) === JSON.stringify(['数学', '英语']));
  suite.check('A13', 'advance did not run twice on rollover', (await db.query(
    'SELECT authoritative_day FROM r5_family_progress WHERE family_id=$1', [id])).rows[0].authoritative_day === 3);
  const after = await fingerprint(db, id);
  suite.check('A14', 'zero learning-record loss across the whole day transition',
    after.n === before.n && after.fp === before.fp, `${after.n}/${before.n}`);
  await db.close();
}

/* =========================================================================
 * B. Stale device reopens the next day
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-b';
  const T = await today(db);
  await seedFamily(db, { id, day: 3 });
  await putPlan(db, id, T, 3, ['数学', '英语']);
  const before = await fingerprint(db, id);
  const pubs = [];
  for (const d of [1, 1, 2]) {
    pubs.push((await db.query('SELECT public.r5_publish_today($1,$2,false) AS r', [id, d])).rows[0].r);
  }
  suite.check('B1', 'every stale publish resolves to day 3', pubs.every((p) => p.study_day === 3), JSON.stringify(pubs));
  suite.check('B2', 'every stale publish is flagged', pubs.every((p) => p.stale_client === true));
  suite.check('B3', 'stale publish is idempotent, not an error', pubs.every((p) => p.idempotent === true || p.published === true));
  const planRows = (await db.query('SELECT day_index, subjects::text AS s FROM r5_daily_plan WHERE family_id=$1', [id])).rows;
  suite.check('B4', 'exactly one plan row exists for today', planRows.length === 1);
  suite.check('B5', 'no day-1 or day-2 plan was written', planRows[0].day_index === 3, planRows[0].day_index);

  const s = await status(db, id);
  suite.check('B6', 'a stale device cannot unlock day 3 with day-1 work', s.allowed === false, s.reason);
  const after = await fingerprint(db, id);
  suite.check('B7', 'stale devices wrote zero learning records', after.n === before.n && after.fp === before.fp);
  await db.close();
}

/* =========================================================================
 * C. Five devices with divergent local days (1 / 2 / 6 / 9 / 3)
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-c';
  const T = await today(db);
  await seedFamily(db, { id, day: 3 });
  await putPlan(db, id, T, 3, ['数学', '英语']);
  const results = [];
  for (const d of [1, 2, 6, 9, 3]) {
    results.push({ d, r: (await db.query('SELECT public.r5_publish_today($1,$2,false) AS r', [id, d])).rows[0].r });
  }
  suite.check('C1', 'all five devices are answered with day 3',
    results.every((x) => x.r.study_day === 3), JSON.stringify(results.map((x) => x.r.study_day)));
  suite.check('C2', 'only the aligned device (3) is not flagged stale',
    results.filter((x) => x.r.stale_client === false).length === 1
    && results.find((x) => x.d === 3).r.stale_client === false);
  suite.check('C3', 'devices ahead (6, 9) are also refused, not obeyed',
    results.filter((x) => x.d > 3).every((x) => x.r.study_day === 3));
  suite.check('C4', 'a single plan row survives five publishes',
    (await db.query('SELECT count(*)::int AS n FROM r5_daily_plan WHERE family_id=$1', [id])).rows[0].n === 1);
  suite.check('C5', 'audit records the stale rejections',
    (await db.query("SELECT count(*)::int AS n FROM r5_plan_audit WHERE family_id=$1 AND event IN ('reject_stale_day','publish_idempotent')", [id])).rows[0].n >= 4);
  suite.check('C6', 'no record row was created by publishes',
    (await db.query('SELECT count(*)::int AS n FROM growth_learning_records WHERE family_id=$1', [id])).rows[0].n === 0);
  suite.check('C7', 'authoritative day never moved', (await db.query(
    'SELECT authoritative_day FROM r5_family_progress WHERE family_id=$1', [id])).rows[0].authoritative_day === 3);
  suite.check('C8', 'the guard trigger blocks a direct stale plan insert',
    await (async () => {
      try {
        await db.query('INSERT INTO r5_daily_plan(family_id,study_date,day_index,subjects,published) VALUES ($1,$2,1,$3::jsonb,true)',
          [id, T, JSON.stringify(['英语', '科学'])]);
        return false;
      } catch (e) { return /R5_PLAN_DAY_REGRESSION/.test(e.message); }
    })());
  await db.close();
}

/* =========================================================================
 * D. Two subjects complete -> unlock; E. one subject unsynced -> locked
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-d';
  const T = await today(db);
  await seedFamily(db, { id, day: 3 });
  await putPlan(db, id, T, 3, ['数学', '英语']);

  for (let i = 0; i < 6; i++) await addAnswer(db, id, '数学', 3, i < 6, T);
  await addCompletion(db, id, '数学', 3, `${T}T03:00:00.000Z`);
  let s = await status(db, id);
  suite.check('D1', 'one finished subject is not enough', s.allowed === false, s.reason);
  suite.check('D2', 'the finished subject shows 100%', num(s.modules.find((m) => m.subject === '数学').accuracy_pct) === 100);
  suite.check('D3', 'the missing subject is NOT_COMPLETED',
    s.modules.find((m) => m.subject === '英语').evidence === 'NOT_COMPLETED');

  for (let i = 0; i < 6; i++) await addAnswer(db, id, '英语', 3, i < 5, T);
  await addCompletion(db, id, '英语', 3, `${T}T03:10:00.000Z`);
  s = await status(db, id);
  suite.check('D4', 'two finished subjects unlock the gate', s.allowed === true && s.study_passed === true, s.reason);
  suite.check('D5', 'reason is STUDY_PASSED', s.reason === 'STUDY_PASSED', s.reason);
  suite.check('D6', '5/6 = 83.3% still passes the 80% rule',
    num(s.modules.find((m) => m.subject === '英语').accuracy_pct) === 83.3);
  suite.check('D7', 'both modules carry SCORED evidence',
    s.modules.every((m) => m.evidence === 'SCORED'));
  suite.check('D8', 'advance is allowed after both subjects pass',
    (await db.query('SELECT public.r5_advance_day($1,3) AS r', [id])).rows[0].r.result === 'advance_day');

  /* E: brand-new day, completion without score */
  const id2 = 'fam-e';
  await seedFamily(db, { id: id2, day: 4 });
  await putPlan(db, id2, T, 4, ['语文', '英语']);
  await addCompletion(db, id2, '语文', 4, `${T}T04:00:00.000Z`);
  const nBefore = (await db.query('SELECT count(*)::int AS n FROM growth_learning_records WHERE family_id=$1', [id2])).rows[0].n;
  const se = await status(db, id2);
  suite.check('E1', 'completed-but-unscored keeps its real state',
    se.modules.find((m) => m.subject === '语文').evidence === 'COMPLETED_UNSCORED');
  suite.check('E2', 'completed-but-unscored does not unlock', se.allowed === false);
  const creds = await derive(db, id2);
  const chinese = creds.find((c) => c.subject_canonical === '语文');
  suite.check('E3', 'credential status is PENDING_SCORE_SYNC', chinese.verification_status === 'PENDING_SCORE_SYNC', chinese.verification_status);
  suite.check('E4', 'pending reason names the missing score',
    chinese.pending_reasons.includes('COURSE_COMPLETED_BUT_SCORE_NOT_SYNCED'), JSON.stringify(chinese.pending_reasons));
  suite.check('E5', 'no answer row was fabricated', (await db.query(
    'SELECT count(*)::int AS n FROM growth_learning_records WHERE family_id=$1', [id2])).rows[0].n === nBefore);
  for (let i = 0; i < 5; i++) await addAnswer(db, id2, '语文', 4, true, T);
  const se2 = await status(db, id2);
  suite.check('E6', 'after the real score syncs, the subject clears',
    se2.modules.find((m) => m.subject === '语文').evidence === 'SCORED');
  suite.check('E7', 'the credential flips to VALID_SCORED',
    (await derive(db, id2)).find((c) => c.subject_canonical === '语文' && c.record_date === T).verification_status === 'VALID_SCORED');
  suite.check('E8', 'gate still locked because 英语 is missing', se2.allowed === false);
  await db.close();
}

/* =========================================================================
 * F. Parent waiver: evidence required, alias never silently passes
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-f';
  const T = await today(db);
  await seedFamily(db, { id, day: 4 });
  await putPlan(db, id, T, 4, ['语文', '英语']);
  await asParent(db);

  let err = null;
  try { await db.query("SELECT public.r5_parent_waive($1,'语文')", [id]); } catch (e) { err = e.message; }
  suite.check('F1', 'waiver without completion evidence is refused',
    /R5_NO_COMPLETION_EVIDENCE/.test(err || ''), err);

  await addCompletion(db, id, '语文', 4, `${T}T05:00:00.000Z`);
  const w = (await db.query("SELECT public.r5_parent_waive($1,'语文') AS r", [id])).rows[0].r;
  suite.check('F2', 'waiver is granted once a real completion exists',
    !!w && Array.isArray(w.modules) && w.modules.some((m) => m.waived === true), JSON.stringify(w && w.modules));
  const s = await status(db, id);
  suite.check('F3', 'waived subject passes with COMPLETED_UNSCORED_WAIVED',
    s.modules.find((m) => m.subject === '语文').evidence === 'COMPLETED_UNSCORED_WAIVED');
  suite.check('F4', 'waiver is reported as any_waived', s.any_waived === true);
  suite.check('F5', 'the other subject still blocks the unlock', s.allowed === false);
  const cred = (await derive(db, id)).find((c) => c.subject_canonical === '语文');
  suite.check('F6', 'waived credential is VALID_WAIVED', cred.verification_status === 'VALID_WAIVED');
  suite.check('F7', 'waiver writes no learning record', (await db.query(
    "SELECT count(*)::int AS n FROM growth_learning_records WHERE family_id=$1 AND record_type='answer'", [id])).rows[0].n === 0);
  suite.check('F8', 'waiver is audited', (await db.query(
    "SELECT count(*)::int AS n FROM r5_parent_audit WHERE family_id=$1 AND action='waiver_grant'", [id])).rows[0].n === 1);

  /* alias waiver: completion stored as "chinese", waiver on "chinese" */
  const id2 = 'fam-f2';
  await seedFamily(db, { id: id2, day: 4 });
  await putPlan(db, id2, T, 4, ['语文', '英语']);
  await addCompletion(db, id2, 'chinese', 4, `${T}T05:30:00.000Z`);
  await db.query("SELECT public.r5_parent_waive($1,'chinese')", [id2]);
  const s2 = await status(db, id2);
  const mods = s2.modules.find((m) => m.subject === '语文');
  suite.check('F9', 'an alias completion does not satisfy the exact-subject predicate',
    mods.evidence === 'NOT_COMPLETED' && mods.passed === false, JSON.stringify(mods));
  suite.check('F10', 'the alias waiver does not unlock the gate', s2.allowed === false);
  const cred2 = (await derive(db, id2)).find((c) => c.subject_canonical === '语文');
  suite.check('F11', 'alias waiver is reported, never silently honoured',
    cred2.waiver_alias_mismatch === true && cred2.verification_status === 'PENDING_VERIFICATION',
    JSON.stringify(cred2.verification_status));
  suite.check('F12', 'alias subject keeps its raw value for review',
    JSON.stringify(cred2.subject_raw) === JSON.stringify(['chinese']), JSON.stringify(cred2.subject_raw));
  await db.close();
}

/* =========================================================================
 * G. Historical attribution: the formal 73 records stay unattributed
 * ========================================================================= */
{
  const db = await newDb();
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/readonly-baseline.json'), 'utf8'));
  const F = baseline.formal_family;
  const id = F.family_id;
  await seedFamily(db, { id, day: 1 });
  await db.query('DELETE FROM r5_family_progress WHERE family_id=$1', [id]);

  for (const p of F.plans) await putPlan(db, id, p.study_date, p.day_index, p.subjects);
  for (const g of F.record_groups) {
    for (let i = 0; i < (g.n || 1); i++) {
      if (g.record_type === 'answer') {
        await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
          VALUES ($1,$2,'answer',$3,$4,$5::jsonb)`,
          [`f-${seq++}`, id, g.subject, g.learning_day,
            JSON.stringify({ answer: { correct: i < (g.correct ?? 0) ? 'true' : 'false', date: g.answer_date } })]);
      } else if (g.record_type === 'course-complete') {
        await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
          VALUES ($1,$2,'course-complete',$3,$4,$5::jsonb)`,
          [`f-${seq++}`, id, g.subject, g.learning_day, JSON.stringify({ completed_at: g.completed_at })]);
      } else {
        await db.query(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
          VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`, [`f-${seq++}`, id, g.record_type, g.subject, g.learning_day]);
      }
    }
  }
  const before = await fingerprint(db, id);
  const T = await today(db);

  /* re-run 010 now that the family + plans exist: it must NOT initialise anyone.
   * (The old draft took MAX(day_index) here, which is exactly the defect.) */
  await db.exec(M010);
  const prog = (await db.query('SELECT authoritative_day, initialized_from FROM r5_family_progress WHERE family_id=$1', [id])).rows[0];
  suite.check('G1', 're-running the migration initialises nobody (no MAX(day_index) value)',
    prog === undefined, JSON.stringify(prog));
  const snap = (await db.query('SELECT public.r5_initialization_snapshot($1) AS s', [id])).rows[0].s;
  suite.check('G2', 'the snapshot demands a verified confirmation instead of guessing (history max 2, correction window [3,3])',
    snap.plan_max_day === 2 && snap.allowed_min_day === 3 && snap.allowed_max_day === 3
    && snap.confirmation_required === true,
    JSON.stringify({ max: snap.plan_max_day, win: [snap.allowed_min_day, snap.allowed_max_day],
      corr: snap.corrections_required }));

  const creds = await derive(db, id);
  suite.check('G3', '73 records produce exactly 4 credential groups', creds.length === 4, creds.length);
  suite.check('G4', 'no historical group is attributed to any authoritative day',
    creds.every((c) => c.attributed === false && c.authoritative_day === null),
    JSON.stringify(creds.map((c) => [c.learning_day_raw, c.authoritative_day])));
  suite.check('G5', 'every group is PENDING_VERIFICATION or PENDING_SCORE_SYNC',
    creds.every((c) => ['PENDING_VERIFICATION', 'PENDING_SCORE_SYNC'].includes(c.verification_status)),
    JSON.stringify(creds.map((c) => c.verification_status)));
  suite.check('G6', 'ZERO groups are folded into day 3',
    creds.every((c) => c.authoritative_day !== 3));
  suite.check('G7', 'the real scores are preserved as evidence',
    creds.some((c) => c.subject_canonical === '科学' && c.answer_correct === 5 && c.answer_total === 5)
    && creds.some((c) => c.subject_canonical === '英语' && c.answer_total === 14 && c.answer_correct === 14)
    && creds.some((c) => c.subject_canonical === '语文' && c.answer_total === 47 && c.answer_correct === 37),
    JSON.stringify(creds.map((c) => [c.subject_canonical, c.answer_correct, c.answer_total])));
  suite.check('G8', '语文 78.7% is reported as below threshold, never rounded up',
    num(creds.find((c) => c.subject_canonical === '语文').accuracy_pct) === 78.7);
  suite.check('G9', 'the sync-test record is excluded from credentials',
    !creds.some((c) => c.subject_canonical === '系统检测'));

  await putPlan(db, id, T, 2, ['语文', '数学']);
  const s = await status(db, id);
  suite.check('G10', 'mis-attributed history never unlocks today\'s gate', s.allowed === false, s.reason);
  suite.check('G11', 'gate modules carry no CREDENTIAL_FROM_HISTORY',
    s.modules.every((m) => m.evidence !== 'CREDENTIAL_FROM_HISTORY'));
  suite.check('G12', 'raw subject values are preserved for review',
    creds.every((c) => Array.isArray(c.subject_raw) && c.subject_raw.length >= 1));

  /* now the operator path: a verified parent confirmation of day 3.
   * The snapshot is re-read because today's plan was published in G10 — the
   * fingerprint is meant to change whenever the evidence does. */
  const snapNow = (await db.query('SELECT public.r5_initialization_snapshot($1) AS s', [id])).rows[0].s;
  await db.exec('RESET request.jwt.claims');   // operator session, not an app session
  await db.query("SELECT public.r5_initialize_authoritative_day($1,3,'u-parent',$2)",
    [id, snapNow.snapshot_fingerprint]);
  await asParent(db);
  const prog3 = (await db.query('SELECT authoritative_day, initialized_from FROM r5_family_progress WHERE family_id=$1', [id])).rows[0];
  const creds3 = await derive(db, id);
  suite.check('G14', 'a verified confirmation of day 3 initialises the real family at 3',
    prog3.authoritative_day === 3 && prog3.initialized_from === 'parent_confirmed', JSON.stringify(prog3));
  suite.check('G15', 'even after initialising at 3, no historical group is folded into day 3',
    creds3.every((c) => c.authoritative_day === null && c.attributed === false),
    JSON.stringify(creds3.map((c) => c.authoritative_day)));

  const after = await fingerprint(db, id);
  suite.check('G13', '73 records are byte-identical after derive + gate',
    after.n === 73 && after.fp === before.fp, `${after.n}/${before.n}`);
  await db.close();
}

/* =========================================================================
 * H. Fail-closed, rollback and zero record loss
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-h';
  const T = await today(db);
  await seedFamily(db, { id, day: 3 });
  await putPlan(db, id, T, 3, ['数学', '英语']);
  for (let i = 0; i < 5; i++) await addAnswer(db, id, '数学', 3, true, T);
  const before = await fingerprint(db, id);

  await db.exec('BEGIN');
  await addAnswer(db, id, '数学', 3, false, T);
  await db.exec('ROLLBACK');
  const afterRollback = await fingerprint(db, id);
  suite.check('H1', 'a failed transaction leaves no partial record',
    afterRollback.n === before.n && afterRollback.fp === before.fp);

  await db.exec('BEGIN');
  let guardError = null;
  try { await putPlan(db, id, T, 1, ['英语', '科学']); } catch (e) { guardError = e.message; }
  await db.exec('ROLLBACK');
  suite.check('H2', 'a rejected plan insert leaves no partial plan',
    /R5_PLAN_DAY_REGRESSION/.test(guardError || '')
    && (await db.query('SELECT day_index FROM r5_daily_plan WHERE family_id=$1 AND study_date=$2', [id, T])).rows[0].day_index === 3,
    guardError);

  await db.exec(ROLLBACK_SQL);

  const restoredGate = (await db.query(
    `SELECT md5(prosrc) AS m FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='r5_gate_status_core'`)).rows[0].m;
  const restoredPub = (await db.query(
    `SELECT md5(prosrc) AS m FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='r5_publish_today'`)).rows[0].m;
  suite.check('H3', 'rollback restores the production gate function byte-for-byte',
    restoredGate === PROD_GATE_MD5, restoredGate);
  suite.check('H4', 'rollback restores the production publish function byte-for-byte',
    restoredPub === PROD_PUB_MD5, restoredPub);

  const gone = await db.query(`SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN ('r5_family_progress','r5_plan_audit','r5_credential_snapshot','r5_day_confirmation')`);
  suite.check('H5', 'rollback drops every table created by 010', gone.rows[0].n === 0, gone.rows[0].n);
  const leftover = await db.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('r5_day_passed','r5_advance_day','r5_subject_canonical',
    'r5_credential_derive','r5_credential_derive_impl','r5_progress_ensure','r5_progress_maybe_advance',
    'r5_guard_plan_day','r5_initialization_snapshot','r5_initialization_snapshot_impl',
    'r5_initialize_authoritative_day','r5_refresh_credential_snapshot',
    'r5_gate_status_core_legacy','r5_publish_today_legacy')`);
  suite.check('H6', 'rollback drops every helper function', leftover.rows[0].n === 0, leftover.rows[0].n);
  const trig = await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='r5_daily_plan_day_guard'`);
  suite.check('H7', 'rollback drops the plan guard trigger', trig.rows[0].n === 0);
  const after = await fingerprint(db, id);
  suite.check('H8', 'zero learning-record loss across rollback', after.n === before.n && after.fp === before.fp);
  const s = await status(db, id);
  suite.check('H9', 'after rollback the legacy gate still evaluates the same rows',
    s.study_day === 3 && s.allowed === false, `${s.study_day}/${s.reason}`);
  /* H10 — the grants are half of the rollback. Production has no PUBLIC grant on
   * either function (r5_gate_status_core is service_role + owner only), so the
   * rollback must restore exactly the grants that existed before the migration,
   * not a remembered default. */
  const aclAfterRollback = await aclLines(db);
  const aclDelta = aclAfterRollback.filter((l) => !PRE_MIGRATION_ACL.includes(l))
    .concat(PRE_MIGRATION_ACL.filter((l) => !aclAfterRollback.includes(l)));
  suite.check('H10', 'rollback restores the pre-migration ACL of every function, grant for grant',
    aclDelta.length === 0, aclDelta.join(' | '));
  const gateGrantLine = (l) => l.startsWith('r5_gate_status_core(');
  suite.check('H11', 'after rollback no function is reachable by PUBLIC — least of all the gate',
    !aclAfterRollback.some((l) => l.includes('|PUBLIC:')),
    aclAfterRollback.filter((l) => l.includes('|PUBLIC:')).join(' | '));
  suite.check('H12', 'the restored gate is service_role + owner only',
    aclAfterRollback.filter(gateGrantLine).map((l) => l.split('|')[1]).sort().join(',')
      === 'OWNER:EXECUTE,service_role:EXECUTE',
    aclAfterRollback.filter(gateGrantLine).join(' | '));
  await db.close();
}

const summary = suite.print();
writeJson(path.join(ROOT, 'evidence/sql-e2e-results.json'), { ...summary, results: suite.results });
if (summary.failed > 0) process.exitCode = 1;
