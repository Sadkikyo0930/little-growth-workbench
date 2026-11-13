/* C0.1 blocking-issue #2 — SECURITY DEFINER surface.
 *
 * Production shipped every r5_* function with the PostgreSQL default
 * (EXECUTE to PUBLIC, which includes `anon`). The candidate adds privileged
 * helpers that take a family_id straight from the caller, so the default is no
 * longer acceptable: a helper that trusts its argument is a cross-family read
 * (another child's records) or a cross-family write (someone else's
 * authoritative day).
 *
 * What is asserted here:
 *   S1–S10   the authenticated paths that must keep working (and the auth that
 *            must reject a foreign family / a grandparent advance)
 *   S11–S20  internal helpers are NOT executable by `authenticated`, and the
 *            client API is not executable by `anon`
 *   S21–S23  the new tables are unreadable/unwritable directly; RLS is on
 *   S24–S28  no candidate function carries a PUBLIC grant, every definer pins
 *            search_path, and the old client signatures are unchanged
 *   S29–S31  a legitimate advance still works, an illegal one does not
 *
 * Nothing here removes authentication, disables RLS or widens a grant.
 */
import path from 'node:path';
import { createSuite, writeJson } from '../lib/harness.mjs';
import {
  ROOT, newDb, today, seedFamily, putPlan, addAnswer, addCompletion,
  status, publish, fingerprint, grab, progressRow, asParent, asChild, clearClaims,
} from './lib/fixture.mjs';

const suite = createSuite('security');

const db = await newDb();
const T = await today(db);

/* two families, three identities: u-parent (parent of A), u-gp (grandparent of
 * A), u-other (parent of B only) */
await seedFamily(db, { id: 'fam-a', day: 2, grandparentOnly: true });
await seedFamily(db, { id: 'fam-b', day: 2 });
await db.query("INSERT INTO growth_family_members(family_id,user_id,member_role) VALUES ('fam-b','u-other','parent')");
/* u-parent must NOT be a member of fam-b, otherwise "cross-family" is not cross */
await db.query("DELETE FROM growth_family_members WHERE family_id='fam-b' AND user_id='u-parent'");

/* fam-a has a real, passing day 2 so that "advance" is legal for a parent */
await putPlan(db, 'fam-a', T, 2, ['语文', '数学']);
for (let i = 0; i < 5; i++) await addAnswer(db, 'fam-a', '语文', 2, true, T);
for (let i = 0; i < 5; i++) await addAnswer(db, 'fam-a', '数学', 2, true, T);
await addCompletion(db, 'fam-a', '语文', 2, `${T}T02:00:00.000Z`);
await addCompletion(db, 'fam-a', '数学', 2, `${T}T02:10:00.000Z`);
const before = await fingerprint(db, 'fam-a');

const asRole = async (role) => db.exec(`SET ROLE ${role}`);
const resetRole = async () => db.exec('RESET ROLE');
const call = (sql, params) => async () => (await db.query(sql, params)).rows;

/* ---------------------------------------------------------------- positives */
await asParent(db);
{
  const pub = (await db.query('SELECT public.r5_publish_today($1,$2,$3) AS r', ['fam-a', 2, false])).rows[0].r;
  suite.check('S1', 'parent still publishes with the unchanged 3-argument signature',
    pub.study_day === 2 && pub.published === true, JSON.stringify(pub));

  const creds = await call('SELECT * FROM public.r5_credential_derive($1)', ['fam-a'])();
  suite.check('S2', 'parent can derive its own credentials', creds.length >= 2
    && creds.every((c) => c.subject_canonical), creds.length);

  const st = await status(db, 'fam-a');
  suite.check('S3', 'a member still gets a full gate status (quota untouched)',
    st.daily_seconds === 1800 && st.study_passed === true, `${st.daily_seconds}/${st.reason}`);
}

/* ------------------------------------------- authentication / authorisation */
{
  const cross = await grab(() => call('SELECT * FROM public.r5_credential_derive($1)', ['fam-b'])());
  suite.check('S4', 'cross-family credential derivation is denied (R5_MEMBER_DENIED)',
    !cross.ok && /R5_MEMBER_DENIED/.test(cross.message), cross.message);

  await clearClaims(db);
  const anonClaims = await grab(() => call('SELECT * FROM public.r5_credential_derive($1)', ['fam-a'])());
  suite.check('S5', 'a session without JWT claims cannot derive (R5_AUTH_REQUIRED)',
    !anonClaims.ok && /R5_AUTH_REQUIRED/.test(anonClaims.message), anonClaims.message);

  await asParent(db);
  const crossStatus = await grab(() => call('SELECT public.r5_status($1) AS s', ['fam-b'])());
  const crossGate = await grab(() => call('SELECT public.r5_gate_status_core($1,false,false) AS s', ['fam-b'])());
  suite.check('S6', 'r5_status / r5_gate_status_core refuse a foreign family',
    !crossStatus.ok && /R5_MEMBER_DENIED/.test(crossStatus.message)
    && !crossGate.ok && /R5_MEMBER_DENIED/.test(crossGate.message),
    `${crossStatus.message} | ${crossGate.message}`);

  const crossAdvance = await grab(() => call('SELECT public.r5_advance_day($1,$2) AS r', ['fam-b', 2])());
  suite.check('S7', 'advancing a foreign family is denied',
    !crossAdvance.ok && /R5_MEMBER_DENIED/.test(crossAdvance.message), crossAdvance.message);
  suite.check('S8', 'the foreign family is untouched by the attempt',
    (await progressRow(db, 'fam-b')).authoritative_day === 2);

  await asChild(db);   // u-child is a grandparent of fam-a
  const gpAdvance = await grab(() => call('SELECT public.r5_advance_day($1,$2) AS r', ['fam-a', 2])());
  suite.check('S9', 'a grandparent session cannot move the authoritative day',
    !gpAdvance.ok && /R5_MEMBER_DENIED/.test(gpAdvance.message)
    && (await progressRow(db, 'fam-a')).authoritative_day === 2, gpAdvance.message);

  const gpPublish = await grab(() => call('SELECT public.r5_publish_today($1,$2,$3) AS r', ['fam-a', 2, false])());
  const gpSync = await grab(call('SELECT public.r5_claim_answers($1,$2::jsonb) AS r',
    ['fam-a', JSON.stringify([{ subject: '语文', day: 2, date: T, track: '课程', index: 901, correct: true }])]));
  suite.check('S10', 'a grandparent can still publish a normal plan and sync answers',
    gpPublish.ok && gpSync.ok, `${gpPublish.message || 'ok'} | ${gpSync.message || 'ok'}`);
}

/* ------------------------------------- internal helpers are not reachable */
await asParent(db);
await asRole('authenticated');
{
  const denied = async (label, sql, params) => {
    const r = await grab(() => call(sql, params)());
    return { label, ok: !r.ok && /permission denied/i.test(r.message), msg: r.message };
  };
  const internal = [
    await denied('derive_impl', 'SELECT * FROM public.r5_credential_derive_impl($1)', ['fam-a']),
    await denied('snapshot_impl', 'SELECT public.r5_initialization_snapshot_impl($1) AS s', ['fam-a']),
    await denied('initialize', 'SELECT public.r5_initialize_authoritative_day($1,3,$2,$3) AS r', ['fam-a', 'u-parent', 'x']),
    await denied('day_passed', 'SELECT public.r5_day_passed($1,$2) AS r', ['fam-a', T]),
    await denied('progress_ensure', 'SELECT public.r5_progress_ensure($1)', ['fam-a']),
    await denied('maybe_advance', 'SELECT public.r5_progress_maybe_advance($1) AS r', ['fam-a']),
    await denied('refresh_snapshot', 'SELECT public.r5_refresh_credential_snapshot($1) AS r', ['fam-a']),
    await denied('gate_legacy', 'SELECT public.r5_gate_status_core_legacy($1,false,false) AS r', ['fam-a']),
    await denied('publish_legacy', 'SELECT public.r5_publish_today_legacy($1,2,false) AS r', ['fam-a']),
    await denied('guard_trigger', 'SELECT public.r5_guard_plan_day() AS r', []),
  ];
  const bad = internal.filter((x) => !x.ok);
  suite.check('S11', 'all ten internal helpers reject a direct call from `authenticated`',
    bad.length === 0, bad.map((x) => `${x.label}: ${x.msg}`).join(' | '));
}

/* --------------------------------------------------- table-level exposure */
{
  const t = async (label, sql) => {
    const r = await grab(() => call(sql)());
    return { label, ok: !r.ok && /permission denied/i.test(r.message), msg: r.message };
  };
  const tables = [
    await t('progress', 'SELECT * FROM public.r5_family_progress'),
    await t('audit', 'SELECT * FROM public.r5_plan_audit'),
    await t('snapshot', 'SELECT * FROM public.r5_credential_snapshot'),
    await t('confirmation', 'SELECT * FROM public.r5_day_confirmation'),
    await t('progress_write', "INSERT INTO public.r5_family_progress(family_id) VALUES ('x')"),
    await t('confirmation_write', "INSERT INTO public.r5_day_confirmation(family_id,confirmed_day,confirmed_by,snapshot,snapshot_fingerprint) VALUES ('x',1,'y','{}','z')"),
  ];
  const bad = tables.filter((x) => !x.ok);
  suite.check('S12', 'all four new tables deny direct read and write to `authenticated`',
    bad.length === 0, bad.map((x) => `${x.label}: ${x.msg}`).join(' | '));
  await resetRole();
}

/* RLS is enabled (not disabled) on every table the candidate adds */
{
  const rows = (await db.query(`SELECT tablename, rowsecurity FROM pg_tables
    WHERE schemaname='public' AND tablename IN
    ('r5_family_progress','r5_plan_audit','r5_credential_snapshot','r5_day_confirmation')`)).rows;
  suite.check('S13', 'RLS is enabled on all four new tables',
    rows.length === 4 && rows.every((r) => r.rowsecurity === true),
    JSON.stringify(rows));
}

/* ------------------------------------------------------------- anon denied */
await asRole('anon');
{
  const a1 = await grab(() => call('SELECT public.r5_publish_today($1,2,false) AS r', ['fam-a'])());
  const a2 = await grab(() => call('SELECT public.r5_gate_status_core($1,false,false) AS r', ['fam-a'])());
  const a3 = await grab(() => call('SELECT public.r5_advance_day($1,2) AS r', ['fam-a'])());
  const a4 = await grab(() => call('SELECT * FROM public.r5_credential_derive($1)', ['fam-a'])());
  suite.check('S14', '`anon` cannot execute the client API at all',
    [a1, a2, a3, a4].every((x) => !x.ok && /permission denied/i.test(x.message)),
    [a1, a2, a3, a4].map((x) => x.message.split('\n')[0]).join(' | '));
  await resetRole();
}

/* ------------------------------------------------------- privilege catalog */
{
  await asParent(db);
  const names = ['r5_publish_today', 'r5_gate_status_core', 'r5_advance_day', 'r5_credential_derive',
    'r5_credential_derive_impl', 'r5_initialization_snapshot', 'r5_initialization_snapshot_impl',
    'r5_initialize_authoritative_day', 'r5_day_passed', 'r5_progress_ensure',
    'r5_progress_maybe_advance', 'r5_refresh_credential_snapshot', 'r5_guard_plan_day',
    'r5_gate_status_core_legacy', 'r5_publish_today_legacy'];
  const rows = (await db.query(`SELECT p.proname, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname = ANY($1)`, [names])).rows;

  const publicGrant = rows.filter((r) => r.acl === null || /(^|,)=[A-Z]*\//.test(r.acl));
  suite.check('S15', 'no candidate function carries a PUBLIC EXECUTE grant',
    publicGrant.length === 0, publicGrant.map((r) => `${r.proname}: ${r.acl}`).join(' | '));

  const unpinned = rows.filter((r) => r.prosecdef && !/search_path/.test(r.cfg || ''));
  suite.check('S16', 'every SECURITY DEFINER function pins search_path',
    unpinned.length === 0, unpinned.map((r) => r.proname).join(', '));

  const authAcl = (await db.query(`SELECT p.proname, p.proacl::text AS acl FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname = ANY($1)`, [['r5_publish_today', 'r5_gate_status_core',
    'r5_advance_day', 'r5_credential_derive', 'r5_initialization_snapshot']])).rows;
  suite.check('S17', 'the five client-facing functions are granted to `authenticated`',
    authAcl.length === 5 && authAcl.every((r) => /authenticated=[A-Za-z]/.test(r.acl || '')),
    JSON.stringify(authAcl));

  const sig = async (name) => (await db.query(
    `SELECT pg_get_function_identity_arguments(p.oid) AS a FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`,
    [name])).rows.map((r) => r.a);
  suite.equals('S18', 'old client signatures are byte-for-byte unchanged',
    [await sig('r5_publish_today'), await sig('r5_gate_status_core'), await sig('r5_advance_day')],
    [['p_family_id text, p_day_index integer, p_no_tasks boolean'],
      ['p_family_id text, p_entry boolean, p_ignore_override boolean'],
      ['p_family_id text, p_expected_day integer']]);

  const untouched = await Promise.all(['r5_status', 'r5_gate_status', 'r5_child_entry',
    'r5_claim_answers', 'r5_parent_waive'].map(async (n) => (await sig(n)).length === 1));
  suite.check('S19', 'the untouched production functions keep their signatures',
    untouched.every(Boolean), JSON.stringify(untouched));
}

/* ------------------------------------------- a real advance still works */
{
  await asParent(db);
  const adv = (await db.query('SELECT public.r5_advance_day($1,$2) AS r', ['fam-a', 2])).rows[0].r;
  suite.check('S20', 'parent advance after a passing day moves exactly one day',
    adv.result === 'advance_day' && adv.from === 2 && adv.to === 3,
    JSON.stringify(adv));

  const twice = (await db.query('SELECT public.r5_advance_day($1,$2) AS r', ['fam-a', 3])).rows[0].r;
  suite.check('S21', 'a second advance on the same day is idempotent (stays 3)',
    twice.result === 'already_advanced' && twice.authoritative_day === 3,
    JSON.stringify(twice));

  await seedFamily(db, { id: 'fam-c', day: 2 });
  await putPlan(db, 'fam-c', T, 2, ['语文', '数学']);
  await addAnswer(db, 'fam-c', '语文', 2, false, T);       // 0% — day not passed
  await addCompletion(db, 'fam-c', '语文', 2, `${T}T02:00:00.000Z`);
  await addCompletion(db, 'fam-c', '数学', 2, `${T}T02:10:00.000Z`);
  const blocked = (await db.query('SELECT public.r5_advance_day($1,$2) AS r', ['fam-c', 2])).rows[0].r;
  suite.check('S22', 'a failed day cannot be advanced even by a parent',
    blocked.result === 'not_all_passed' && (await progressRow(db, 'fam-c')).authoritative_day === 2,
    JSON.stringify(blocked));

  const after = await fingerprint(db, 'fam-a');
  suite.check('S23', 'the whole security sweep leaves every learning record byte-identical',
    after.n === before.n && after.fp === before.fp, `${after.n}/${before.n}`);
}

/* ------------------------------- the real client role, end to end --------- */
/* Everything above ran as a superuser or as a deliberately blocked role. This
 * block is the counter-check: logging in as `authenticated` (what PostgREST
 * does) must still give a normal family member the whole old API. */
{
  await asChild(db);
  await asRole('authenticated');
  const st = await grab(() => call('SELECT public.r5_status($1) AS s', ['fam-a'])());
  const ce = await grab(() => call('SELECT public.r5_child_entry($1) AS s', ['fam-a'])());
  const cl = await grab(() => call('SELECT public.r5_claim_answers($1,$2::jsonb) AS r',
    ['fam-a', JSON.stringify([{ record_id: 'sec-claim-1', subject: '数学', day: 3, date: T, track: '课程', index: 777, correct: true }])])());
  await resetRole();
  suite.check('S24', 'a logged-in member still gets status, child entry and answer claiming',
    st.ok && ce.ok && cl.ok, [st, ce, cl].map((x) => x.message || 'ok').join(' | '));

  await asParent(db);
  const dedupe = (await db.query(
    "SELECT count(*)::int AS n FROM r5_answer_dedupe WHERE family_id='fam-a' AND record_id='sec-claim-1'")).rows[0].n;
  const rows = (await db.query("SELECT record_id FROM growth_learning_records WHERE family_id='fam-a'")).rows;
  suite.check('S25', 'the claim registered exactly one dedupe row and wrote no learning record',
    dedupe === 1 && rows.length === before.n, `dedupe=${dedupe} records=${rows.length}/${before.n}`);
}

/* ------------------------------------ the operator door refuses app sessions */
{
  await asParent(db);
  const adminOnly = await grab(() => call('SELECT public.r5_initialize_authoritative_day($1,3,$2,$3) AS r',
    ['fam-c', 'u-parent', 'x'])());
  suite.check('S26', 'the initialiser refuses an app session even when EXECUTE would be granted',
    !adminOnly.ok && /R5_ADMIN_ONLY/.test(adminOnly.message)
    && (await progressRow(db, 'fam-c')).authoritative_day === 2,
    adminOnly.message);
  const stillUnset = await progressRow(db, 'fam-still-unset');
  suite.check('S27', 'the refusal did not create a progress row anywhere',
    stillUnset === null, JSON.stringify(stillUnset));
}

await db.close();
const summary = suite.print();
writeJson(path.join(ROOT, 'evidence/security-results.json'), { ...summary, results: suite.results });
if (summary.failed > 0) process.exitCode = 1;
