/* C0.1 blocking-issue #1 — authoritative day initialisation.
 *
 * The real family (the only production family) has plan history that tops out at
 * day 2, while the parent has already moved the child to day 3. The first C0.1
 * draft initialised authoritative_day = MAX(plan.day_index) = 2, which would
 * reopen day 2 and make the day-3 plan illegal. These checks lock the corrected
 * behaviour:
 *
 *   * the migration itself initialises nobody;
 *   * an existing family starts only through r5_initialize_authoritative_day()
 *     with a live read-only snapshot + a verified parent confirmation;
 *   * missing confirmation / device disagreement / thin evidence block it;
 *   * day 1 and day 2 are never written back, day 4 is never reached by itself.
 */
import path from 'node:path';
import { createSuite, writeJson } from '../lib/harness.mjs';
import {
  ROOT, newDb, today, addDays, seedFamily, putPlan, addAnswer, addCompletion,
  publish, fingerprint, snapshot, initialize, grab, progressRow, plans, asParent,
} from './lib/fixture.mjs';

const suite = createSuite('init-day');

/* ---------------------------------------------------------------------------
 * The real family: day 1 and day 2 were played, history max is day 2.
 * ------------------------------------------------------------------------- */
{
  const db = await newDb();
  const id = 'fam-formal';
  const T = await today(db);
  const D1 = await addDays(db, T, -2);
  const D2 = await addDays(db, T, -1);

  await seedFamily(db, { id, progress: false });     // migration state: no progress row
  await putPlan(db, id, D1, 1, ['语文', '数学']);
  await putPlan(db, id, D2, 2, ['数学', '英语']);
  for (let i = 0; i < 5; i++) await addAnswer(db, id, '语文', 1, true, D1);
  for (let i = 0; i < 5; i++) await addAnswer(db, id, '数学', 1, true, D1);
  await addCompletion(db, id, '语文', 1, `${D1}T02:00:00.000Z`);
  await addCompletion(db, id, '数学', 1, `${D1}T02:10:00.000Z`);
  for (let i = 0; i < 5; i++) await addAnswer(db, id, '数学', 2, true, D2);
  for (let i = 0; i < 5; i++) await addAnswer(db, id, '英语', 2, true, D2);
  await addCompletion(db, id, '数学', 2, `${D2}T02:00:00.000Z`);
  await addCompletion(db, id, '英语', 2, `${D2}T02:10:00.000Z`);
  const before = await fingerprint(db, id);

  /* I1 — the migration did not initialise anybody. */
  suite.check('I1', 'migration alone creates no progress row (no MAX(day_index) guess)',
    (await progressRow(db, id)) === null);

  /* I2 — the snapshot says exactly what a reviewer must see. */
  const snap = await snapshot(db, id);
  suite.check('I2', 'snapshot reports history max day 2 and a [2,3] confirmation window',
    snap.plan_max_day === 2 && snap.allowed_min_day === 2 && snap.allowed_max_day === 3
    && snap.evidence_ok === true && snap.blocking.length === 0, JSON.stringify(snap));

  /* I3 — an uninitialised family fails closed instead of publishing day 2. */
  const prePublish = await grab(() => publish(db, id, 2));
  const todayPlans = (await plans(db, id)).filter((p) => p.d === T);
  suite.check('I3', 'publish before initialisation raises R5_DAY_NOT_INITIALIZED and writes no plan',
    !prePublish.ok && /R5_DAY_NOT_INITIALIZED/.test(prePublish.message) && todayPlans.length === 0,
    prePublish.message);

  /* I4 — verified parent confirmation of day 3 is accepted. */
  const init = await initialize(db, id, 3, 'u-parent');
  const prog = await progressRow(db, id);
  suite.check('I4', 'parent confirms day 3: authoritative_day = 3, provenance parent_confirmed',
    init.result === 'initialized' && prog.authoritative_day === 3
    && prog.initialized_from === 'parent_confirmed',
    `${init.result}/${prog && prog.authoritative_day}/${prog && prog.initialized_from}`);

  /* I5 — re-running with day 4 never overwrites and never jumps. */
  const again = await initialize(db, id, 4, 'u-parent');
  const prog2 = await progressRow(db, id);
  suite.check('I5', 're-initialisation is a no-op (stays 3, never auto-reaches day 4)',
    again.result === 'already_initialized' && prog2.authoritative_day === 3,
    `${again.result}/${prog2.authoritative_day}`);

  /* I6 / I7 — a stale client cannot write day 1 or day 2 back. */
  const pub1 = await publish(db, id, 1);
  const pub2 = await publish(db, id, 2);
  const todayRow = (await plans(db, id)).filter((p) => p.d === T);
  suite.check('I6', 'stale client day 1 publishes day 3 and is told it is stale',
    pub1.study_day === 3 && pub1.stale_client === true, JSON.stringify(pub1));
  suite.check('I7', 'no day-1 / day-2 plan was written for today (only day 3 exists)',
    todayRow.length === 1 && todayRow[0].day_index === 3
    && pub2.study_day === 3 && pub2.stale_client === true,
    JSON.stringify(todayRow.map((r) => r.day_index)));

  /* I8 — the automatic advance cannot skip to day 4: the previous plan is day 2
   * while the authoritative day is 3, so the server refuses to guess. */
  const maybe = (await db.query('SELECT public.r5_progress_maybe_advance($1) AS r', [id])).rows[0].r;
  const prog3 = await progressRow(db, id);
  suite.check('I8', 'auto-advance refuses on day mismatch (stays 3, no silent day 4)',
    maybe.result === 'previous_plan_day_mismatch' && prog3.authoritative_day === 3,
    `${maybe.result}/${prog3.authoritative_day}`);

  /* I9 — the child's records are untouched by init + publish. */
  const after = await fingerprint(db, id);
  suite.check('I9', 'init + publish + advance attempt leave every learning record byte-identical',
    after.n === before.n && after.fp === before.fp, `${after.n}/${before.n}`);
  await db.close();
}

/* ---------------------------------------------------------------------------
 * Rejected initialisations — each one must leave the family uninitialised.
 * ------------------------------------------------------------------------- */
{
  const db = await newDb();
  const T = await today(db);
  const mk = async (id, planMax) => {
    await seedFamily(db, { id, progress: false });
    for (let d = 1; d <= planMax; d++) {
      await putPlan(db, id, await addDays(db, T, -planMax + d - 1), d, ['语文', '数学']);
    }
    return snapshot(db, id);
  };

  const sJ = await mk('fam-jump', 2);
  const jump = await grab(() => initialize(db, 'fam-jump', 4, 'u-parent', sJ.snapshot_fingerprint));
  suite.check('I10', 'confirming day 4 over a day-2 history is rejected (no skipped day)',
    !jump.ok && /R5_INIT_JUMP_REJECTED/.test(jump.message)
    && (await progressRow(db, 'fam-jump')) === null, jump.message);

  const sR = await mk('fam-regress', 3);
  const regress = await grab(() => initialize(db, 'fam-regress', 2, 'u-parent', sR.snapshot_fingerprint));
  suite.check('I11', 'confirming day 2 over a day-3 history is rejected (would reopen a published day)',
    !regress.ok && /R5_INIT_REGRESSION_REJECTED/.test(regress.message)
    && (await progressRow(db, 'fam-regress')) === null, regress.message);

  const sF = await mk('fam-stale', 2);
  const staleFp = await grab(() => initialize(db, 'fam-stale', 3, 'u-parent', 'deadbeefdeadbeefdeadbeefdeadbeef'));
  const freshFp = await initialize(db, 'fam-stale', 3, 'u-parent', sF.snapshot_fingerprint);
  suite.check('I12', 'a stale snapshot fingerprint is rejected, the current one is accepted',
    !staleFp.ok && /R5_INIT_SNAPSHOT_STALE/.test(staleFp.message)
    && freshFp.result === 'initialized', staleFp.message);

  const blank = await grab(() => initialize(db, 'fam-stale', 3, '   ', sF.snapshot_fingerprint));
  suite.check('I13', 'a blank confirmer identity is rejected',
    !blank.ok && /R5_INIT_CONFIRMATION_REQUIRED/.test(blank.message), blank.message);

  /* device disagreement: two devices dated the same plan day report day 2 and 3 */
  await seedFamily(db, { id: 'fam-split', progress: false });
  const D2 = await addDays(db, T, -1);
  await putPlan(db, 'fam-split', D2, 2, ['数学', '英语']);
  await addAnswer(db, 'fam-split', '数学', 2, true, D2);
  await addAnswer(db, 'fam-split', '数学', 3, true, D2);
  const sSplit = await snapshot(db, 'fam-split');
  const split = await grab(() => initialize(db, 'fam-split', 3, 'u-parent', sSplit.snapshot_fingerprint));
  suite.check('I14', 'device disagreement blocks initialisation (DEVICE_DAY_DISAGREEMENT)',
    sSplit.evidence_ok === false && sSplit.blocking.includes('DEVICE_DAY_DISAGREEMENT')
    && !split.ok && /R5_INIT_BLOCKED/.test(split.message)
    && (await progressRow(db, 'fam-split')) === null,
    JSON.stringify(sSplit.blocking));

  /* no plan at all, but records exist -> not enough evidence */
  await seedFamily(db, { id: 'fam-noplan', progress: false });
  await addAnswer(db, 'fam-noplan', '语文', 2, true, D2);
  const sNoPlan = await snapshot(db, 'fam-noplan');
  const noPlan = await grab(() => initialize(db, 'fam-noplan', 2, 'u-parent', sNoPlan.snapshot_fingerprint));
  suite.check('I15', 'records without any published plan block initialisation',
    sNoPlan.blocking.includes('NO_PUBLISHED_PLAN_BUT_RECORDS')
    && !noPlan.ok && /R5_INIT_BLOCKED/.test(noPlan.message),
    JSON.stringify(sNoPlan.blocking));

  /* accepted confirmations are the only thing persisted; a refusal raises and
   * therefore leaves no row (documented, and checked here so it cannot regress
   * into "we quietly wrote a row for a blocked family"). */
  const confirmations = (await db.query(
    'SELECT family_id, confirmed_day, snapshot_fingerprint FROM public.r5_day_confirmation')).rows;
  suite.check('I16', 'only the accepted confirmation is persisted (refusals roll back cleanly)',
    confirmations.length === 1 && confirmations[0].family_id === 'fam-stale'
    && confirmations[0].confirmed_day === 3
    && confirmations[0].snapshot_fingerprint === sF.snapshot_fingerprint,
    JSON.stringify(confirmations));
  await db.close();
}

/* ---------------------------------------------------------------------------
 * Brand-new family must still work without any human step.
 * ------------------------------------------------------------------------- */
{
  const db = await newDb();
  const id = 'fam-new';
  await seedFamily(db, { id, progress: false });
  const T = await today(db);
  const pub = await publish(db, id, 1);
  const prog = await progressRow(db, id);
  suite.check('I17', 'a family with no history is created at day 1 and publishes normally',
    pub.study_day === 1 && prog.authoritative_day === 1
    && prog.initialized_from === 'new_family_day_1',
    `${pub.study_day}/${prog.initialized_from}`);
  const row = (await plans(db, id)).find((p) => p.d === T);
  suite.check('I18', 'the new family really has a day-1 plan for today',
    !!row && row.day_index === 1 && row.published === true, JSON.stringify(row));
  await db.close();
}

const summary = suite.print();
writeJson(path.join(ROOT, 'evidence/init-day-results.json'), { ...summary, results: suite.results });
if (summary.failed > 0) process.exitCode = 1;
