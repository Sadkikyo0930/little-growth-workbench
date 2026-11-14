/* Isolated-environment deployment verification for the C0.1 candidate.
 *
 * What this is: a *deployment*, not a unit test. The SQL files are the exact
 * bytes of the GitHub candidate branch, loaded unmodified into a separate
 * PostgreSQL 18.6 server that listens on its own port and owns its own data
 * directory. Nothing here talks to CloudBase.
 *
 * What it is not: a substitute for a second CloudBase environment. There is no
 * gateway/PostgREST layer here, so "real HTTP API" is still unverified.
 *
 * ACLs are part of what is verified, and they are compared against the grants
 * that CloudBase actually carries (read-only pg_proc query on 2026-11-14), not
 * against a convenient assumption. The pre-migration state is built to match
 * production — `fixtures/schema/production-acl.sql` — so a rollback that leaves
 * a wider grant than production has cannot pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const SRC = process.env.ISO_SRC || 'C:/Users/Administrator/WorkBuddy/2026-11-13-16-11-22/r5-v6-c01/delivery';
const OUT = path.resolve('C:/Users/Administrator/WorkBuddy/2026-11-13-16-11-22/r5-v6-c01/delivery/evidence');
const PORT = Number(process.env.ISO_PORT || 55433);

const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
/* Two layouts hold the same bytes: the delivery bundle (candidate/...) and the
 * repository checkout (v6/sql/c01/...). Whichever is present is used verbatim. */
const pick = (a, b) => (fs.existsSync(path.join(SRC, a)) ? a : b);
const BASE = read(pick('fixtures/schema/base-schema.sql', 'v6/c01/fixtures/schema/base-schema.sql'));
const PROD_ACL = read(pick('fixtures/schema/production-acl.sql', 'v6/c01/fixtures/schema/production-acl.sql'));
const M010 = read(pick('candidate/sql/010_authoritative_day.sql', 'v6/sql/c01/010_authoritative_day.sql'));
const LEG_GATE = read(pick('candidate/sql/legacy/r5_gate_status_core.production.sql', 'v6/sql/c01/legacy/r5_gate_status_core.production.sql'));
const LEG_PUB = read(pick('candidate/sql/legacy/r5_publish_today.production.sql', 'v6/sql/c01/legacy/r5_publish_today.production.sql'));
const M020 = read(pick('candidate/sql/020_gate_and_publish.sql', 'v6/sql/c01/020_gate_and_publish.sql'));
const M900 = read(pick('candidate/sql/900_rollback.sql', 'v6/sql/c01/900_rollback.sql'));

/* The production bodies also have to exist BEFORE the migration — in production
 * they do, and a rollback can only restore an ACL that had somewhere to live.
 * The legacy copies are the same bytes under a `_legacy` name, so renaming the
 * declaration back gives the pre-migration function without duplicating SQL. */
const renameLegacy = (src, from, to) => {
  const needle = `FUNCTION public.${from}(`;
  if (!src.includes(needle)) throw new Error(`cannot de-legacy ${from}: declaration not found`);
  return src.replace(needle, `FUNCTION public.${to}(`);
};
const PROD_GATE = renameLegacy(LEG_GATE, 'r5_gate_status_core_legacy', 'r5_gate_status_core');
const PROD_PUB = renameLegacy(LEG_PUB, 'r5_publish_today_legacy', 'r5_publish_today');

/* Read-only production ACL, 2026-11-14, environment normal-goose-d5g4qyzr8bb389a4a.
 * This is the baseline the isolated instance is built to, and the baseline the
 * rollback is measured against. Kept as data so a divergence is a failed check,
 * not a silent assumption. */
const PROD_ACL_2026_11_14 = {
  'r5_assert_member(text, boolean)': ['OWNER:EXECUTE', 'authenticated:EXECUTE', 'service_role:EXECUTE'],
  'r5_child_entry(text)': ['OWNER:EXECUTE', 'authenticated:EXECUTE', 'service_role:EXECUTE'],
  'r5_claim_answers(text, jsonb)': ['OWNER:EXECUTE', 'authenticated:EXECUTE', 'service_role:EXECUTE'],
  'r5_gate_status(text, boolean)': ['OWNER:EXECUTE', 'service_role:EXECUTE'],
  'r5_gate_status_core(text, boolean, boolean)': ['OWNER:EXECUTE', 'service_role:EXECUTE'],
  'r5_override_active(text, text, boolean)': ['OWNER:EXECUTE', 'service_role:EXECUTE'],
  'r5_parent_waive(text, text, text, boolean)': ['OWNER:EXECUTE', 'authenticated:EXECUTE', 'service_role:EXECUTE'],
  'r5_publish_today(text, integer, boolean)': ['OWNER:EXECUTE', 'authenticated:EXECUTE', 'service_role:EXECUTE'],
  'r5_status(text)': ['OWNER:EXECUTE', 'authenticated:EXECUTE', 'service_role:EXECUTE'],
};


const results = [];
const t0 = Date.now();
let n = 0;
const check = (id, name, ok, detail) => {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail: detail === undefined ? null : String(detail) });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${detail !== undefined && !ok ? ' :: ' + detail : ''}`);
  n++;
};
const bytes = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

const client = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', database: 'postgres' });
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
const exec = async (sql) => { await client.query(sql); };
const grab = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, message: e.message || String(e), code: e.code }; } };

const asRole = (r) => exec(`SET ROLE ${r}`);
const resetRole = () => exec('RESET ROLE');
const claims = (sub) => exec(`SET request.jwt.claims = '${JSON.stringify({ sub, role: 'authenticated' })}'`);
const clearClaims = () => exec('RESET request.jwt.claims');

/* ============================================================ 0. clean slate */
await exec(`
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  GRANT ALL ON SCHEMA public TO PUBLIC;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  END $$;
`);
/* Pre-migration state = the schema production has today: the two gate functions
 * already exist (with their production bodies) and carry their production ACL. */
await exec(BASE);
await exec(PROD_GATE);
await exec(PROD_PUB);
await exec(PROD_ACL);

/* ---------------------------------------------------------------- ACL tooling
 * One canonical signature form (name + identity args, single-spaced) and one
 * canonical grant form (`grantee:PRIVILEGE`), so "same ACL" is a set comparison
 * and never a regex over a text blob. The owner is normalised to OWNER because
 * CloudBase names its owner role after the instance. */
const aclRows = async () => q(`
  SELECT p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS sig,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC'
              WHEN a.grantee = p.proowner THEN 'OWNER'
              ELSE pg_get_userbyid(a.grantee) END AS grantee,
         a.privilege_type AS privilege,
         a.is_grantable  AS grantable
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   WHERE n.nspname = 'public'`);
const aclMap = async () => {
  const out = {};
  for (const r of await aclRows()) {
    (out[r.sig] ||= []).push(`${r.grantee}:${r.privilege}${r.grantable ? ':GRANTABLE' : ''}`);
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
};
const aclOnly = (map, names) => Object.fromEntries(
  Object.entries(map).filter(([sig]) => names.some((n) => sig.startsWith(n + '('))));

/* Canonical, order-independent text form: sorted signatures, each with its
 * already-sorted grant list. Two ACLs are equal iff these strings are equal. */
const aclKey = (map) => Object.keys(map).sort()
  .map((k) => `${k}=[${map[k].join(',')}]`).join(';');
const sameAcl = (a, b) => aclKey(a) === aclKey(b);

const aclPreMigration = await aclMap();

/* D0 — the isolated environment must start from the ACL production really has.
 * A rollback test is worthless if the pre-migration baseline is invented. */
const preAclOfTwo = aclOnly(aclPreMigration, ['r5_gate_status_core', 'r5_publish_today']);
const preAclExpected = {
  'r5_gate_status_core(text, boolean, boolean)': ['OWNER:EXECUTE', 'service_role:EXECUTE'],
  'r5_publish_today(text, integer, boolean)':
    ['OWNER:EXECUTE', 'authenticated:EXECUTE', 'service_role:EXECUTE'],
};
check('D0', 'the pre-migration ACL of the two gate functions equals the production read-only baseline',
  sameAcl(preAclOfTwo, preAclExpected),
  `got ${JSON.stringify(preAclOfTwo)}`);

/* D0b — and the rest of the fixture matches the same read-only baseline,
 * function by function, so nothing about privileges is guessed downstream. */
const preAclDrift = Object.entries(PROD_ACL_2026_11_14)
  .filter(([sig, want]) => JSON.stringify(aclPreMigration[sig] || null) !== JSON.stringify(want))
  .map(([sig, want]) => `${sig}: want ${want} got ${aclPreMigration[sig] || 'absent'}`);
check('D0b', 'every fixture function starts from its production grant set',
  preAclDrift.length === 0, preAclDrift.join(' | '));


/* Pre-migration baseline: what production looks like today. */
const PROD_MD5 = {
  r5_gate_status_core: 'f78aceeba9c934fa8f4b5c754daba101',
  r5_publish_today: 'b0d8d2deb58ab5240c9207e6b5081ea3',
  r5_claim_answers: '45ef62312ed179f299700946c9c7863d',
};

const REAL = 'little-growth-family-001';
const TESTF = 'iso-test-family';        // history [2,2,1]  (the shape you reported)
const REALS = 'iso-real-shape';         // history [1,1,1,2,2,1] (the shape production actually has)
const OTHER = 'iso-control-family';     // ordinary monotonic history

const plans = [
  [REAL, '2026-11-08', 1], [REAL, '2026-11-09', 1], [REAL, '2026-11-10', 1],
  [REAL, '2026-11-11', 2], [REAL, '2026-11-12', 2], [REAL, '2026-11-13', 1],
  [TESTF, '2026-11-11', 2], [TESTF, '2026-11-12', 2], [TESTF, '2026-11-13', 1],
  [REALS, '2026-11-08', 1], [REALS, '2026-11-09', 1], [REALS, '2026-11-10', 1],
  [REALS, '2026-11-11', 2], [REALS, '2026-11-12', 2], [REALS, '2026-11-13', 1],
  [OTHER, '2026-11-11', 1], [OTHER, '2026-11-12', 2], [OTHER, '2026-11-13', 3],
];
await claims('u-parent');
for (const f of [REAL, TESTF, REALS, OTHER]) {
  await q('INSERT INTO growth_families(family_id) VALUES ($1)', [f]);
  await q("INSERT INTO growth_family_members(family_id,user_id,member_role) VALUES ($1,'u-parent','parent')", [f]);
  await q("INSERT INTO growth_family_members(family_id,user_id,member_role) VALUES ($1,'u-child','grandparent')", [f]);
  await q('INSERT INTO r5_parent_settings(family_id,daily_seconds,bonus_seconds) VALUES ($1,1800,0)', [f]);
}
for (const [f, d, day] of plans) {
  await q("INSERT INTO r5_daily_plan(family_id,study_date,day_index,subjects,published) VALUES ($1,$2,$3,'[\"语文\",\"数学\"]'::jsonb,true)", [f, d, day]);
}
/* 73 historical records for the real family, exactly as counted in production. */
let seq = 0;
for (let i = 0; i < 73; i++) {
  const day = i < 40 ? 1 : 2;
  const subj = i % 2 ? '语文' : '数学';
  await q(`INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
    VALUES ($1,$2,'answer',$3,$4,$5::jsonb)`,
  [`real-rec-${seq++}`, REAL, subj, day,
    JSON.stringify({ answer: { correct: 'true', date: i < 40 ? '2026-11-09' : '2026-11-12', track: '课程', index: i } })]);
}
const fpRecords = async (f) => (await q(`SELECT count(*)::int AS n,
  md5(string_agg(record_id||'|'||coalesce(subject,'~')||'|'||coalesce(learning_day::text,'~')||'|'||record_data::text, E'\n' ORDER BY record_id)) AS fp
  FROM growth_learning_records WHERE family_id=$1`, [f]))[0];
const fpPlans = async (f) => (await q(`SELECT count(*)::int AS n,
  md5(string_agg(study_date::text||'|'||day_index||'|'||subjects::text||'|'||published, E'\n' ORDER BY study_date)) AS fp
  FROM r5_daily_plan WHERE family_id=$1`, [f]))[0];
const baseline = {};
for (const f of [REAL, TESTF, REALS, OTHER]) baseline[f] = { rec: await fpRecords(f), plan: await fpPlans(f) };

/* ============================================== 1. deploy the candidate as-is */
await clearClaims();
const deploy = await grab(async () => {
  await exec(M010);
  await exec(LEG_GATE);
  await exec(LEG_PUB);
  await exec(M020);
});
check('D1', '010 + legacy + 020 apply cleanly to the production-shaped schema',
  deploy.ok, deploy.message || `sql sha256 ${bytes(M010 + M020)}`);

const aclAfterDeploy = await aclMap();
/* nothing may gain a grant during deployment: the migration is allowed to
 * narrow (it revokes), never to widen. */
const widenedByDeploy = Object.keys(aclPreMigration).filter((sig) => {
  const before = new Set(aclPreMigration[sig]);
  return (aclAfterDeploy[sig] || []).some((g) => !before.has(g));
});
check('D7b', 'the migration grants no pre-existing function anything new',
  widenedByDeploy.length === 0,
  widenedByDeploy.map((s) => `${s}: ${aclPreMigration[s]} -> ${aclAfterDeploy[s]}`).join(' | '));

const fns = (await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
    coalesce(array_to_string(p.proacl, ' | '), '(default PUBLIC)') AS acl, md5(p.prosrc) AS md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' ORDER BY 1`));
const fn = (name) => fns.filter((r) => r.proname === name);

/* D2 — the production bodies live on as *_legacy and must be byte-identical;
 * the live wrapper must actually delegate to them. */
check('D2', 'r5_gate_status_core_legacy / r5_publish_today_legacy carry the production bodies verbatim',
  fn('r5_gate_status_core_legacy')[0].md5 === PROD_MD5.r5_gate_status_core
  && fn('r5_publish_today_legacy')[0].md5 === PROD_MD5.r5_publish_today,
  `gate ${fn('r5_gate_status_core_legacy')[0].md5} publish ${fn('r5_publish_today_legacy')[0].md5}`);
const wrapperSrc = (await q(`SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='r5_gate_status_core'`))[0].prosrc;
check('D2b', 'the live gate wrapper delegates to the verbatim production body',
  /r5_gate_status_core_legacy/.test(wrapperSrc), wrapperSrc.slice(0, 80).replace(/\s+/g, ' '));

check('D3', 'the untouched production function r5_claim_answers is byte-identical',
  fn('r5_claim_answers')[0].md5 === PROD_MD5.r5_claim_answers,
  fn('r5_claim_answers')[0].md5);

/* D4 — ACL parity with production: gate core is service_role only. */
const coreAcl = fn('r5_gate_status_core')[0].acl;
check('D4', 'r5_gate_status_core is NOT executable by authenticated (production ACL parity)',
  !/authenticated=[A-Za-z]/.test(coreAcl), coreAcl);
check('D5', 'r5_gate_status_core stays executable by service_role',
  /service_role=[A-Za-z]/.test(coreAcl), coreAcl);
const pubAcl = fn('r5_publish_today')[0].acl;
check('D6', 'r5_publish_today is executable by authenticated and service_role',
  /authenticated=[A-Za-z]/.test(pubAcl) && /service_role=[A-Za-z]/.test(pubAcl), pubAcl);

/* D7 — no candidate function carries a PUBLIC grant. */
const candidateNames = ['r5_credential_derive', 'r5_credential_derive_impl', 'r5_initialization_snapshot',
  'r5_initialization_snapshot_impl', 'r5_initialize_authoritative_day', 'r5_day_passed',
  'r5_progress_ensure', 'r5_progress_maybe_advance', 'r5_refresh_credential_snapshot',
  'r5_advance_day', 'r5_guard_plan_day', 'r5_subject_canonical',
  'r5_gate_status_core_legacy', 'r5_publish_today_legacy', 'r5_gate_status_core', 'r5_publish_today'];
const withPublic = fns.filter((r) => candidateNames.includes(r.proname)
  && (r.acl === '(default PUBLIC)' || /(^|,)=[A-Z]*\//.test(r.acl)));
check('D7', 'no candidate function carries a PUBLIC EXECUTE grant',
  withPublic.length === 0, withPublic.map((r) => `${r.proname}:${r.acl}`).join(' | '));

/* D8 — RLS on the new tables, and no policy at all. */
const NEW_TABLES = ['r5_family_progress', 'r5_plan_audit', 'r5_credential_snapshot',
  'r5_day_confirmation', 'r5_acl_baseline'];
const rls = await q(`SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
  AND tablename = ANY($1)`, [NEW_TABLES]);
const policies = await q(`SELECT tablename, count(*)::int AS n FROM pg_policies WHERE schemaname='public'
  AND tablename = ANY($1) GROUP BY tablename`, [NEW_TABLES]);
check('D8', 'every new table has RLS enabled and zero policies',
  rls.length === NEW_TABLES.length && rls.every((r) => r.rowsecurity) && policies.every((p) => p.n === 0),
  `${JSON.stringify(rls)} ${JSON.stringify(policies)}`);

/* D9 — the migration itself wrote nothing. */
const progAfterDeploy = await q('SELECT count(*)::int AS n FROM r5_family_progress');
check('D9', 'the migration does not guess a day: r5_family_progress stays empty',
  progAfterDeploy[0].n === 0, progAfterDeploy[0].n);
const recAfterDeploy = await fpRecords(REAL);
check('D10', 'the 73 historical records are untouched by the migration',
  recAfterDeploy.n === 73 && recAfterDeploy.fp === baseline[REAL].rec.fp,
  `${recAfterDeploy.n}/${recAfterDeploy.fp}`);

/* ================================== 2. initialisation against the real shapes */
const snap = async (f) => { await claims('u-parent'); return (await q('SELECT public.r5_initialization_snapshot($1) AS s', [f]))[0].s; };
const init = async (f, day, by, fp, corr) => {
  const params = [f, day, by, fp];
  const sql = corr === undefined
    ? 'SELECT public.r5_initialize_authoritative_day($1,$2,$3,$4) AS r'
    : 'SELECT public.r5_initialize_authoritative_day($1,$2,$3,$4,$5) AS r';
  if (corr !== undefined) params.push(JSON.stringify(corr));
  await clearClaims();
  return (await q(sql, params))[0].r;
};
const CORR = { acknowledged: ['PLAN_HISTORY_ROLLBACK'], reason: '家长确认：11-13 当天误发 day1 计划，实际已进入第 3 天' };

/* --- shape [2,2,1] — the shape you described */
await claims('u-parent');
const s1 = await snap(TESTF);
check('F1', 'history [2,2,1] classifies as an explainable rollback, not a hard block',
  Array.isArray(s1.corrections_required) && s1.corrections_required.includes('PLAN_HISTORY_ROLLBACK')
  && (s1.blocking || []).length === 0,
  `blocking=${JSON.stringify(s1.blocking)} corrections=${JSON.stringify(s1.corrections_required)}`);
check('F2', 'the rollback row set is exactly the tail row 2026-11-13 / day1',
  (s1.rollback_plan_rows || []).length === 1
  && String(s1.rollback_plan_rows[0].date).slice(0, 10) === '2026-11-13'
  && s1.rollback_plan_rows[0].day === 1,
  JSON.stringify(s1.rollback_plan_rows));
check('F3', 'the correction window collapses to a single value: day 3 only',
  s1.allowed_min_day === 3 && s1.allowed_max_day === 3,
  `${s1.allowed_min_day}..${s1.allowed_max_day}`);

const rNoCorr = await grab(() => init(TESTF, 3, 'u-parent', s1.snapshot_fingerprint));
check('F4', 'confirming day 3 without the correction is refused (CORRECTION_REQUIRED)',
  !rNoCorr.ok && /R5_INIT_CORRECTION_REQUIRED/.test(rNoCorr.message), rNoCorr.message);

const rRegress = await grab(() => init(TESTF, 2, 'u-parent', s1.snapshot_fingerprint, CORR));
check('F5', 'confirming day 2 is refused — a published day is never written back',
  !rRegress.ok && /R5_INIT_REGRESSION_REJECTED/.test(rRegress.message), rRegress.message);

const rJump = await grab(() => init(TESTF, 4, 'u-parent', s1.snapshot_fingerprint, CORR));
check('F6', 'confirming day 4 is refused — no skipping ahead',
  !rJump.ok && /R5_INIT_JUMP_REJECTED/.test(rJump.message), rJump.message);

const rShort = await grab(() => init(TESTF, 3, 'u-parent', s1.snapshot_fingerprint,
  { acknowledged: ['PLAN_HISTORY_ROLLBACK'], reason: '误发' }));
check('F7', 'a token reason is refused (CORRECTION_REASON_REQUIRED)',
  !rShort.ok && /R5_INIT_CORRECTION_REASON_REQUIRED/.test(rShort.message), rShort.message);

const rStale = await grab(() => init(TESTF, 3, 'u-parent', 'deadbeef' , CORR));
check('F8', 'a stale snapshot fingerprint is refused',
  !rStale.ok && /R5_INIT_SNAPSHOT_STALE/.test(rStale.message), rStale.message);

const ok1 = await init(TESTF, 3, 'u-parent', s1.snapshot_fingerprint, CORR);
check('F9', 'the parent-confirmed correction initialises the family at day 3',
  ok1.result === 'initialized' && ok1.authoritative_day === 3,
  `${ok1.result}/${ok1.authoritative_day}`);

const testPlan = await fpPlans(TESTF);
check('F10', 'the correction did not rewrite a single plan row',
  testPlan.n === baseline[TESTF].plan.n && testPlan.fp === baseline[TESTF].plan.fp,
  `${testPlan.n}/${testPlan.fp}`);

const audit = await q("SELECT event, authoritative_day, actor, detail FROM r5_plan_audit WHERE family_id=$1", [TESTF]);
check('F11', 'the audit records the corrected initialisation with its reason',
  audit.length === 1 && audit[0].event === 'initialize_authoritative_day_corrected'
  && audit[0].detail.corrections_applied.includes('PLAN_HISTORY_ROLLBACK')
  && String(audit[0].detail.correction_reason).length >= 8,
  JSON.stringify(audit[0] || null).slice(0, 160));

const conf = await q('SELECT confirmed_day, confirmed_by, corrections_applied, correction_reason FROM r5_day_confirmation WHERE family_id=$1', [TESTF]);
check('F12', 'r5_day_confirmation stores day, confirmer, codes and reason',
  conf.length === 1 && conf[0].confirmed_day === 3 && conf[0].confirmed_by === 'u-parent'
  && conf[0].corrections_applied.includes('PLAN_HISTORY_ROLLBACK'),
  JSON.stringify(conf));

const rAgain = await init(TESTF, 3, 'u-parent', s1.snapshot_fingerprint, CORR);
check('F13', 're-running the initialisation is a no-op (already_initialized)',
  rAgain.result === 'already_initialized' && rAgain.authoritative_day === 3, rAgain.result);

/* --- shape [1,1,1,2,2,1] — what production actually has */
const s2 = await snap(REALS);
check('F14', 'the real 6-row history is also classified as one explainable rollback',
  (s2.blocking || []).length === 0 && s2.corrections_required.includes('PLAN_HISTORY_ROLLBACK')
  && (s2.rollback_plan_rows || []).length === 1
  && String(s2.plan_high_water_date).slice(0, 10) === '2026-11-11',
  `hw=${String(s2.plan_high_water_date).slice(0, 10)} rows=${JSON.stringify(s2.rollback_plan_rows)}`);
const ok2 = await init(REALS, 3, 'u-parent', s2.snapshot_fingerprint, CORR);
check('F15', 'the real-shape family initialises at the confirmed day 3',
  ok2.result === 'initialized' && ok2.authoritative_day === 3, ok2.result);

/* --- control: an ordinary family must not need any correction */
const s3 = await snap(OTHER);
check('F16', 'a monotonic family needs no correction and is not blocked',
  (s3.blocking || []).length === 0 && (s3.corrections_required || []).length === 0,
  `blocking=${JSON.stringify(s3.blocking)} corrections=${JSON.stringify(s3.corrections_required)}`);
check('F17', 'the real family is still uninitialised — nothing was decided for it',
  (await q('SELECT count(*)::int AS n FROM r5_family_progress WHERE family_id=$1', [REAL]))[0].n === 0);

/* ============================================ 3. the learning day really works */
/* Evaluation runs on the implementation day, so the day-3 plan is published on
 * today's date — exactly what happens on the real switch-over day. */
const T3 = (await q("SELECT (timezone('Asia/Shanghai', clock_timestamp()))::date::text AS d"))[0].d;
await claims('u-parent');
await init(OTHER, 3, 'u-parent', s3.snapshot_fingerprint);   // control family, clean path

const publish = async (f, day) => { await claims('u-parent'); return (await q('SELECT public.r5_publish_today($1,$2,false) AS r', [f, day]))[0].r; };
const gate = async (f) => { await claims('u-parent'); return (await q('SELECT public.r5_status($1) AS s', [f]))[0].s; };
const addRec = async (id, f, type, subj, day, data) => q(
  `INSERT INTO growth_learning_records(record_id,family_id,record_type,subject,learning_day,record_data)
   VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [id, f, type, subj, day, JSON.stringify(data)]);
const answer = (correct, index) => ({ answer: { correct: correct ? 'true' : 'false', date: T3, track: '课程', index } });
const done = (hh) => ({ completed_at: `${T3}T${hh}:00.000Z` });

const pub = await publish(TESTF, 1);   // a stale device that still thinks it is day 1
check('G1', 'a stale client cannot publish day 1 once the authoritative day is 3',
  pub.stale_client === true && pub.study_day === 3, JSON.stringify({ d: pub.study_day, stale: pub.stale_client }));

const pub3 = await publish(TESTF, 3);
check('G2', 'day 3 publishes with its two subjects', pub3.study_day === 3 && pub3.published === true,
  JSON.stringify(pub3).slice(0, 140));

/* Work the subjects the platform actually published for day 3 — the app reads
 * the plan, it does not assume which two subjects a day carries. */
const daySubjects = (await q(`SELECT subjects FROM r5_daily_plan
  WHERE family_id=$1 AND study_date=$2 AND day_index=3`, [TESTF, T3]))[0].subjects;
const S1 = daySubjects[0];
const S2 = daySubjects[1];

/* one subject fully finished AND scored, the other only finished */
await addRec('iso-a1', TESTF, 'course-complete', S1, 3, done('02:00'));
for (let i = 0; i < 5; i++) await addRec(`iso-a-q-${i}`, TESTF, 'answer', S1, 3, answer(true, 100 + i));
await addRec('iso-b1', TESTF, 'course-complete', S2, 3, done('02:10'));
const g1 = await gate(TESTF);
check('G3', 'course finished but no answers yet -> the gate stays closed (score unverified)',
  g1.allowed === false, `${g1.allowed}/${g1.reason}`);

for (let i = 0; i < 5; i++) await addRec(`iso-b-q-${i}`, TESTF, 'answer', S2, 3, answer(true, 200 + i));
const g2 = await gate(TESTF);
check('G4', 'both subjects completed and scored -> the gate opens (racing unlock)',
  g2.allowed === true && g2.study_passed === true, `${g2.allowed}/${g2.study_passed}/${g2.reason}`);

const adv = await grab(() => q('SELECT public.r5_advance_day($1,$2) AS r', [TESTF, 3]).then((r) => r[0].r));
check('G5', 'a passing day advances the authoritative day exactly once',
  adv.ok && adv.value.result === 'advance_day' && adv.value.authoritative_day === 4,
  JSON.stringify(adv.value || adv.message).slice(0, 140));
const adv2 = await grab(() => q('SELECT public.r5_advance_day($1,$2) AS r', [TESTF, 4]).then((r) => r[0].r));
check('G6', 'a second advance on the same day is idempotent',
  adv2.ok && adv2.value.authoritative_day === 4 && adv2.value.result !== 'not_all_passed',
  JSON.stringify(adv2.value || adv2.message).slice(0, 140));

/* waiver: the control family completes one subject, the other is waived by the parent */
await claims('u-parent');
await publish(OTHER, 3);
const otherSubjects = (await q(`SELECT subjects FROM r5_daily_plan
  WHERE family_id=$1 AND study_date=$2 AND day_index=3`, [OTHER, T3]))[0].subjects;
const W1 = otherSubjects[0];
const W2 = otherSubjects[1];
for (let i = 0; i < 5; i++) await addRec(`iso-w-q-${i}`, OTHER, 'answer', W1, 3, answer(true, 300 + i));
await addRec('iso-w-c', OTHER, 'course-complete', W1, 3, done('03:00'));
await addRec('iso-w-m', OTHER, 'course-complete', W2, 3, done('03:05'));
const preWaive = await fpRecords(OTHER);
const waive = await grab(() => q("SELECT public.r5_parent_waive($1,$2,'家长确认已完成',false) AS r", [OTHER, W2]));
check('G7', 'the parent waiver entry still works (1800s / waiver path untouched)',
  waive.ok, waive.message || JSON.stringify(waive.value).slice(0, 120));

const gOther = await gate(OTHER);
const postWaive = await fpRecords(OTHER);
check('G8', 'a granted waiver counts as completion and opens the gate',
  gOther.allowed === true, `${gOther.allowed}/${gOther.reason}`);
check('G9', 'the waiver itself wrote no learning record',
  postWaive.n === preWaive.n && postWaive.fp === preWaive.fp,
  `${preWaive.n} -> ${postWaive.n}`);

/* ================================================= 4. rollback, and prove it */
await clearClaims();
const recBefore = {}; const planBefore = {};
for (const f of [REAL, TESTF, REALS, OTHER]) { recBefore[f] = await fpRecords(f); planBefore[f] = await fpPlans(f); }
const rb = await grab(async () => { await exec(M900); });
check('R1', '900_rollback.sql applies without error', rb.ok, rb.message || 'ok');

const gone = await q(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'
  AND tablename = ANY($1)`, [NEW_TABLES]);
check('R2', 'every table 010 created is gone, including the ACL capture', gone[0].n === 0, gone[0].n);

const fnsAfter = await q(`SELECT p.proname, md5(p.prosrc) AS md5,
    coalesce(array_to_string(p.proacl,' | '),'(default PUBLIC)') AS acl
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`);
const f2 = (name) => fnsAfter.filter((r) => r.proname === name);
check('R3', 'the production gate body is restored byte-for-byte',
  f2('r5_gate_status_core')[0].md5 === PROD_MD5.r5_gate_status_core, f2('r5_gate_status_core')[0].md5);
check('R4', 'the production publish body is restored byte-for-byte',
  f2('r5_publish_today')[0].md5 === PROD_MD5.r5_publish_today, f2('r5_publish_today')[0].md5);

/* R5 — the rollback must restore the ACL that existed BEFORE the migration,
 * function by function and signature by signature. Not "the default", not "a
 * grant to PUBLIC": exactly what was there, and nothing else. */
const aclAfter = await aclMap();
const ROLLBACK_FNS = ['r5_gate_status_core', 'r5_publish_today'];
const aclPreTwo = aclOnly(aclPreMigration, ROLLBACK_FNS);
const aclPostTwo = aclOnly(aclAfter, ROLLBACK_FNS);
check('R5', 'the rollback restores the pre-migration ACL of both replaced functions exactly',
  sameAcl(aclPostTwo, aclPreTwo),
  `want ${JSON.stringify(aclPreTwo)} got ${JSON.stringify(aclPostTwo)}`);

const gatesAfter = aclPostTwo['r5_gate_status_core(text, boolean, boolean)'] || [];
const pubAfter = aclPostTwo['r5_publish_today(text, integer, boolean)'] || [];check('R5b', 'the restored gate keeps no PUBLIC, anon or authenticated grant',
  !gatesAfter.some((g) => /^(PUBLIC|anon|authenticated):/.test(g))
  && gatesAfter.some((g) => g.startsWith('service_role:')),
  gatesAfter.join(','));
check('R5c', 'the restored publish function keeps authenticated + service_role and no PUBLIC/anon',
  pubAfter.some((g) => g.startsWith('authenticated:')) && pubAfter.some((g) => g.startsWith('service_role:'))
  && !pubAfter.some((g) => /^(PUBLIC|anon):/.test(g)),
  pubAfter.join(','));

const leftover = fnsAfter.filter((r) => candidateNames.includes(r.proname)
  && !['r5_gate_status_core', 'r5_publish_today'].includes(r.proname));
check('R6', 'every C0.1 helper function is gone', leftover.length === 0,
  leftover.map((r) => r.proname).join(','));

let lossless = true; const lossDetail = [];
for (const f of [REAL, TESTF, REALS, OTHER]) {
  const r = await fpRecords(f); const p = await fpPlans(f);
  const same = r.n === recBefore[f].n && r.fp === recBefore[f].fp
    && p.n === planBefore[f].n && p.fp === planBefore[f].fp;
  if (!same) { lossless = false; lossDetail.push(f); }
}
check('R7', 'rollback loses no learning record and rewrites no plan (all four families)',
  lossless, lossDetail.join(',') || 'byte-identical');
check('R8', 'the 73 historical records are still exactly 73, byte-identical',
  (await fpRecords(REAL)).fp === baseline[REAL].rec.fp);

/* Collateral-damage check. The previous version excluded every candidate name
 * from the comparison — which excluded the two functions the migration actually
 * replaces, i.e. the only ones whose ACL the rollback has to touch. The diff is
 * now over the *whole* pre-migration function set, replaced functions included,
 * plus a check that nothing extra is left behind. */
const drifted = Object.keys(aclPreMigration)
  .filter((sig) => JSON.stringify(aclAfter[sig] || null) !== JSON.stringify(aclPreMigration[sig]));
check('R10', 'every pre-existing function — replaced or untouched — carries the same grants after the rollback',
  drifted.length === 0,
  drifted.map((s) => `${s}: ${JSON.stringify(aclPreMigration[s])} -> ${JSON.stringify(aclAfter[s] || null)}`)
    .join(' | ') || `${Object.keys(aclPreMigration).length} signatures identical`);

const extraFns = Object.keys(aclAfter).filter((sig) => !(sig in aclPreMigration));
check('R10b', 'the rollback leaves no function behind that production does not have',
  extraFns.length === 0, extraFns.join(','));

/* after rollback the legacy gate must still evaluate, or the site is down */
await claims('u-parent');
const legacyStatus = await grab(() => q('SELECT public.r5_status($1) AS s', [REAL]));
check('R9', 'after the rollback the legacy gate still answers for the real family',
  legacyStatus.ok && legacyStatus.value[0].s && typeof legacyStatus.value[0].s.allowed === 'boolean',
  legacyStatus.message || JSON.stringify(legacyStatus.value[0].s).slice(0, 120));

/* ------------------------------------------- N. post-rollback privilege probes
 * The whole point of restoring the ACL is that `p_ignore_override` stays out of
 * reach of a browser session. These run as real roles, not as the owner, so the
 * ACL — not a superuser shortcut — decides. */
const callAs = async (role, sql) => {
  await resetRole();
  await exec(`SET ROLE ${role}`);
  try {
    const rows = await q(sql);
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, code: e.code, message: String(e.message).split('\n')[0] };
  } finally {
    await resetRole();
  }
};
const DENIED = '42501';
const GATE_CALL = "SELECT public.r5_gate_status_core('iso-no-such-family', true, true) AS r";

await clearClaims();
const n1 = await callAs('authenticated', GATE_CALL);
check('N1', 'after the rollback `authenticated` still cannot call the gate with p_ignore_override = true',
  !n1.ok && n1.code === DENIED, `${n1.code || 'ok'} ${n1.message || ''}`);

const n2 = await callAs('anon', GATE_CALL);
check('N2', 'after the rollback `anon` cannot call the gate either',
  !n2.ok && n2.code === DENIED, `${n2.code || 'ok'} ${n2.message || ''}`);

const n3 = await callAs('service_role', GATE_CALL);
check('N3', 'service_role still reaches the gate body — the refusal above is the ACL, not a broken function',
  n3.code !== DENIED, `${n3.code || 'ok'} ${n3.message || ''}`);

const PUB_CALL = "SELECT public.r5_publish_today('iso-no-such-family', 3, false) AS r";
const n4 = await callAs('authenticated', PUB_CALL);
check('N4', 'the rollback does not narrow the client path: `authenticated` still reaches r5_publish_today',
  n4.code !== DENIED, `${n4.code || 'ok'} ${n4.message || ''}`);

const n5 = await callAs('anon', PUB_CALL);
check('N5', '`anon` still cannot call r5_publish_today (it never could)',
  !n5.ok && n5.code === DENIED, `${n5.code || 'ok'} ${n5.message || ''}`);

/* the real client session, not the owner: this is what the PWA does after a rollback */
await claims('u-parent');
const n6 = await callAs('authenticated', `SELECT public.r5_status('${REAL}') AS s`);
check('N6', 'a logged-in client can still read r5_status after the rollback',
  n6.ok && n6.rows[0].s && typeof n6.rows[0].s.allowed === 'boolean',
  n6.message || JSON.stringify(n6.rows[0].s).slice(0, 120));

const n7 = await callAs('authenticated', "SELECT public.r5_gate_status_core('iso-no-such-family', false, false) AS r");
check('N7', '`authenticated` is denied the gate on the exact signature the app would use (false,false) too',
  !n7.ok && n7.code === DENIED, `${n7.code || 'ok'} ${n7.message || ''}`);

/* ============================================================= evidence file */
await clearClaims(); await resetRole();
await client.end();

const summary = {
  generated_at: new Date().toISOString(),
  commit: process.env.ISO_COMMIT || '(unset)',
  environment: {
    kind: 'separate PostgreSQL server, own data dir, own TCP port, separate process',
    engine: 'PostgreSQL 18.6 (WASM build, PGlite 0.5.16) behind a wire-protocol TCP endpoint',
    host: '127.0.0.1', port: PORT,
    cloudbase_untouched: true,
    limitations: [
      'no CloudBase gateway/PostgREST layer: the HTTP RPC surface is not exercised here',
      'all connections share one backend session, so per-connection SET ROLE does not isolate; role switching is done per statement batch instead',
    ],
  },
  /* Privilege before/after, per function and per signature. `production_readonly`
   * is what the live CloudBase instance grants today (SELECT-only query). */
  acl: {
    source: 'read-only pg_proc.proacl on CloudBase normal-goose-d5g4qyzr8bb389a4a, 2026-11-14',
    functions: Object.keys({ ...aclPreMigration, ...aclAfter }).sort().map((sig) => ({
      signature: sig,
      production_readonly: PROD_ACL_2026_11_14[sig] || null,
      pre_migration: aclPreMigration[sig] || null,
      after_deploy: aclAfterDeploy[sig] || null,
      after_rollback: aclAfter[sig] || null,
      rollback_restored_exactly: JSON.stringify(aclAfter[sig] || null) === JSON.stringify(aclPreMigration[sig] || null),
    })),
  },
  sql_sha256_16: { '010': bytes(M010), '020': bytes(M020), '900': bytes(M900) },
  totals: { pass: results.filter((r) => r.status === 'PASS').length, fail: results.filter((r) => r.status === 'FAIL').length, ms: Date.now() - t0 },
  results,
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'isolated-env-results.json'), JSON.stringify(summary, null, 2));
console.log(`\nisolated-env: ${summary.totals.pass} passed, ${summary.totals.fail} failed, ${summary.totals.ms} ms`);
process.exit(summary.totals.fail === 0 ? 0 : 1);
