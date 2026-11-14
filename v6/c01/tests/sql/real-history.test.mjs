/* C0.1.2 — the real family's actual plan history.
 *
 * Production is not "history max day 2, parent moved to day 3". It is:
 *
 *     2026-11-11  day 2
 *     2026-11-12  day 2
 *     2026-11-13  day 1      <- an older day was published AFTER a newer one
 *
 * The C0.1.1 snapshot classified that tail regression as PLAN_NOT_MONOTONIC and
 * blocked initialisation outright, so the real family could never be
 * initialised at all. The fix splits the classification in two:
 *
 *   HARD blockers   still block unconditionally (device disagreement, a record
 *                   ahead of the plan, records without any plan, day out of
 *                   range). No confirmation can acknowledge them away.
 *
 *   CORRECTION      PLAN_HISTORY_ROLLBACK — an explainable historical rollback.
 *                   It requires an explicit acknowledgement of every required
 *                   code plus a written reason, is recorded in the audit trail,
 *                   and leaves the plan rows and the learning records exactly as
 *                   they are.
 *
 * Nothing here writes a day by itself: the authoritative day always comes from
 * the operator's confirmed value inside the snapshot window.
 */
import { createSuite, writeJson } from '../lib/harness.mjs';
import {
  newDb, seedFamily, putPlan, addAnswer, addCompletion, publish, fingerprint,
  snapshot, initialize, grab, progressRow, plans, asParent, clearClaims,
} from './lib/fixture.mjs';

const suite = createSuite('real-history');

const D1 = '2026-11-11';
const D2 = '2026-11-12';
const D3 = '2026-11-13';
const REASON = '11-13 的设备用了旧缓存把 day1 计划写回，家长确认当前应继续 day3';

/* The operator path in full, including the correction argument. Runs as the
 * database owner (no jwt claims), exactly like a maintenance-window session. */
async function confirm(db, id, day, by, fp, correction) {
  await clearClaims(db);
  try {
    const r = (await db.query(
      'SELECT public.r5_initialize_authoritative_day($1,$2,$3,$4,$5::jsonb) AS r',
      [id, day, by, fp, correction ? JSON.stringify(correction) : null])).rows[0].r;
    return { ok: true, value: r };
  } catch (e) {
    return { ok: false, message: (e.message || '').split('\n')[0], code: e.code };
  } finally {
    await asParent(db);
  }
}

async function seedRealHistory(db, id, { disagree = false, ahead = false } = {}) {
  await seedFamily(db, { id, progress: false });
  await putPlan(db, id, D1, 2, ['语文', '数学']);
  await putPlan(db, id, D2, 2, ['语文', '英语']);
  await putPlan(db, id, D3, 1, ['数学', '英语']);

  await addAnswer(db, id, '语文', 2, true, D1);
  await addAnswer(db, id, '数学', 2, true, D1);
  await addAnswer(db, id, '语文', 2, true, D2);
  await addAnswer(db, id, '英语', 2, true, D2);
  await addCompletion(db, id, '语文', 2, `${D2}T02:00:00.000Z`);
  await addCompletion(db, id, '英语', 2, `${D2}T02:05:00.000Z`);

  if (disagree) {
    /* two devices wrote the same date with different learning days */
    await addAnswer(db, id, '数学', 1, false, D3);
    await addAnswer(db, id, '数学', 2, false, D3);
  } else if (ahead) {
    /* a device ran to day 3 although the plan never published day 3 */
    await addAnswer(db, id, '数学', 3, false, D3);
  } else {
    await addAnswer(db, id, '数学', 1, false, D3);
    await addAnswer(db, id, '英语', 1, false, D3);
  }
}

/* ===========================================================================
 * A. the snapshot classifies the real history correctly
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-real';
  await seedRealHistory(db, id);

  const s = await snapshot(db, id);

  suite.equals('R1', 'real history is read as plan days [2,2,1] with max 2', s.plan_days, [2, 2, 1]);
  suite.check('R2', 'the newest plan row (2026-11-13, day 1) is reported, not hidden',
    s.latest_plan_date === D3 && s.latest_plan_day === 1,
    `${s.latest_plan_date}/${s.latest_plan_day}`);

  suite.equals('R3', 'a tail regression is no longer a hard blocker', s.blocking, []);
  suite.equals('R4', 'it is classified as an explainable correction instead',
    s.corrections_required, ['PLAN_HISTORY_ROLLBACK']);

  suite.check('R5', 'the snapshot is not "evidence_ok" while a correction is pending',
    s.evidence_ok === false, JSON.stringify(s.evidence_ok));
  suite.check('R6', 'the high-water date is the first day the family reached day 2',
    s.plan_high_water_date === D1, String(s.plan_high_water_date));
  suite.check('R7', 'the rollback rows pin exactly the offending plan row',
    Array.isArray(s.rollback_plan_rows) && s.rollback_plan_rows.length === 1
    && s.rollback_plan_rows[0].date === D3 && s.rollback_plan_rows[0].day === 1,
    JSON.stringify(s.rollback_plan_rows));
  suite.check('R8', 'the correction window collapses to [3,3] — day 2 can never be reopened, day 4 never skipped',
    s.allowed_min_day === 3 && s.allowed_max_day === 3,
    `${s.allowed_min_day}..${s.allowed_max_day}`);
  suite.check('R9', 'the full plan history is in the fingerprinted evidence',
    Array.isArray(s.plan_history) && s.plan_history.length === 3
    && s.plan_history.map((p) => `${p.date}:${p.day}`).join(',') === `${D1}:2,${D2}:2,${D3}:1`,
    JSON.stringify(s.plan_history));

  /* ---------- refusals: nothing is written until the correction is explicit */
  const fingerprintBefore = await fingerprint(db, id);
  const plansBefore = JSON.stringify(await plans(db, id));
  const fp = s.snapshot_fingerprint;

  const plain = await confirm(db, id, 3, 'u-parent', fp, null);
  suite.check('R10', 'without a correction the operator is told exactly that',
    !plain.ok && /R5_INIT_CORRECTION_REQUIRED/.test(plain.message), plain.message);

  const unknown = await confirm(db, id, 3, 'u-parent', fp,
    { acknowledged: ['SOMETHING_ELSE'], reason: REASON });
  suite.check('R11', 'acknowledging a code that is not required is refused',
    !unknown.ok && /R5_INIT_CORRECTION_UNKNOWN/.test(unknown.message), unknown.message);

  const incomplete = await confirm(db, id, 3, 'u-parent', fp,
    { acknowledged: [], reason: REASON });
  suite.check('R12', 'an empty acknowledgement list is refused',
    !incomplete.ok && /R5_INIT_CORRECTION_INCOMPLETE/.test(incomplete.message), incomplete.message);

  const reasonless = await confirm(db, id, 3, 'u-parent', fp,
    { acknowledged: ['PLAN_HISTORY_ROLLBACK'], reason: '   ' });
  suite.check('R13', 'a correction without a written reason is refused',
    !reasonless.ok && /R5_INIT_CORRECTION_REASON_REQUIRED/.test(reasonless.message), reasonless.message);

  const shortReason = await confirm(db, id, 3, 'u-parent', fp,
    { acknowledged: ['PLAN_HISTORY_ROLLBACK'], reason: 'fix' });
  suite.check('R14', 'a two-word "reason" is refused too',
    !shortReason.ok && /R5_INIT_CORRECTION_REASON_REQUIRED/.test(shortReason.message), shortReason.message);

  const stillNull = await progressRow(db, id);
  const auditRows = (await db.query(
    'SELECT count(*)::int AS n FROM public.r5_day_confirmation WHERE family_id=$1', [id])).rows[0].n;
  suite.check('R15', 'five refusals left the family untouched: no progress row, no confirmation row',
    stillNull === null && auditRows === 0, `progress=${JSON.stringify(stillNull)} audit=${auditRows}`);

  /* ---------- the allowed correction path */
  const ok = await confirm(db, id, 3, 'u-parent', fp,
    { acknowledged: ['PLAN_HISTORY_ROLLBACK'], reason: REASON });
  suite.check('R16', 'an acknowledged correction with a reason initialises the family at day 3',
    ok.ok && ok.value.result === 'initialized' && ok.value.authoritative_day === 3,
    JSON.stringify(ok.value || ok.message));

  const prog = await progressRow(db, id);
  suite.check('R17', 'authoritative_day is 3 and the provenance says parent-confirmed',
    prog.authoritative_day === 3 && prog.initialized_from === 'parent_confirmed',
    JSON.stringify(prog && { d: prog.authoritative_day, f: prog.initialized_from }));
  suite.check('R18', 'it was NOT silently pushed to day 3 by default — the value came from the call',
    ok.value.corrections_applied.length === 1
    && ok.value.corrections_applied[0] === 'PLAN_HISTORY_ROLLBACK'
    && ok.value.correction_reason === REASON,
    JSON.stringify({ c: ok.value.corrections_applied, r: ok.value.correction_reason }));

  /* ---------- nothing historical was rewritten */
  suite.check('R19', 'all three original plan rows are byte-identical after the correction',
    JSON.stringify(await plans(db, id)) === plansBefore,
    `${JSON.stringify(await plans(db, id))}\n!= ${plansBefore}`);
  const fingerprintAfter = await fingerprint(db, id);
  suite.check('R20', 'every learning record is byte-identical after the correction',
    fingerprintAfter.n === fingerprintBefore.n && fingerprintAfter.fp === fingerprintBefore.fp,
    `${fingerprintAfter.n}/${fingerprintBefore.n}`);

  /* ---------- audit completeness */
  const conf = (await db.query(
    `SELECT confirmed_day, confirmed_by, snapshot_fingerprint, corrections_applied,
            correction_reason, snapshot
       FROM public.r5_day_confirmation WHERE family_id=$1`, [id])).rows[0];
  suite.check('R21', 'the confirmation row stores the corrected day, who confirmed and the reviewed fingerprint',
    conf.confirmed_day === 3 && conf.confirmed_by === 'u-parent'
    && conf.snapshot_fingerprint === fp,
    JSON.stringify({ d: conf.confirmed_day, by: conf.confirmed_by, fp: conf.snapshot_fingerprint === fp }));
  suite.equals('R22', 'the confirmation row stores which correction was acknowledged',
    conf.corrections_applied, ['PLAN_HISTORY_ROLLBACK']);
  suite.check('R23', 'the confirmation row stores the written reason verbatim',
    conf.correction_reason === REASON, String(conf.correction_reason));
  suite.check('R24', 'the stored snapshot keeps the rollback evidence for later review',
    conf.snapshot.rollback_plan_rows.length === 1
    && conf.snapshot.rollback_plan_rows[0].date === D3,
    JSON.stringify(conf.snapshot.rollback_plan_rows));

  const audit = (await db.query(
    `SELECT event, detail FROM public.r5_plan_audit
       WHERE family_id=$1 ORDER BY audit_id DESC LIMIT 1`, [id])).rows[0];
  suite.check('R25', 'the audit event is marked as a correction, not a plain initialisation',
    audit.event === 'initialize_authoritative_day_corrected', String(audit.event));
  suite.check('R26', 'the audit detail repeats the codes, the reason and the offending plan rows',
    JSON.stringify(audit.detail.corrections_applied) === JSON.stringify(['PLAN_HISTORY_ROLLBACK'])
    && audit.detail.correction_reason === REASON
    && audit.detail.rollback_plan_rows.length === 1,
    JSON.stringify(audit.detail));

  /* ---------- still no auto-advance */
  const again = await confirm(db, id, 3, 'u-parent', fp,
    { acknowledged: ['PLAN_HISTORY_ROLLBACK'], reason: REASON });
  const prog2 = await progressRow(db, id);
  suite.check('R27', 'a second initialisation is a no-op (never drifts to day 4)',
    again.ok && again.value.result === 'already_initialized' && prog2.authoritative_day === 3,
    JSON.stringify(again.value || again.message));

  await db.close();
}

/* ===========================================================================
 * B. hard anomalies still block, even with a valid correction
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-disagree';
  await seedRealHistory(db, id, { disagree: true });
  const s = await snapshot(db, id);

  suite.check('B1', 'device disagreement is reported as a hard blocker next to the correction',
    s.blocking.includes('DEVICE_DAY_DISAGREEMENT')
    && s.corrections_required.includes('PLAN_HISTORY_ROLLBACK'),
    JSON.stringify({ b: s.blocking, c: s.corrections_required }));

  const r = await confirm(db, id, 3, 'u-parent', s.snapshot_fingerprint,
    { acknowledged: ['PLAN_HISTORY_ROLLBACK', 'DEVICE_DAY_DISAGREEMENT'], reason: REASON });
  suite.check('B2', 'acknowledging the hard blocker does NOT let the correction through',
    !r.ok && /R5_INIT_BLOCKED/.test(r.message), r.message);
  suite.check('B3', 'the blocked attempt still wrote nothing',
    (await progressRow(db, id)) === null,
    JSON.stringify(await progressRow(db, id)));
  await db.close();
}

{
  const db = await newDb();
  const id = 'fam-ahead';
  await seedRealHistory(db, id, { ahead: true });
  const s = await snapshot(db, id);

  suite.check('C1', 'a record that ran ahead of the plan is a hard blocker',
    s.blocking.includes('RECORD_DAY_AHEAD_OF_PLAN'), JSON.stringify(s.blocking));

  const r = await confirm(db, id, 3, 'u-parent', s.snapshot_fingerprint,
    { acknowledged: ['PLAN_HISTORY_ROLLBACK', 'RECORD_DAY_AHEAD_OF_PLAN'], reason: REASON });
  suite.check('C2', 'the correction cannot absorb it either',
    !r.ok && /R5_INIT_BLOCKED/.test(r.message), r.message);
  await db.close();
}

/* ===========================================================================
 * C. a correction is not a licence to move the day
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-window';
  await seedRealHistory(db, id);
  const s = await snapshot(db, id);
  const correction = { acknowledged: ['PLAN_HISTORY_ROLLBACK'], reason: REASON };

  const jump = await confirm(db, id, 4, 'u-parent', s.snapshot_fingerprint, correction);
  suite.check('D1', 'confirming day 4 is still rejected — no skipped day',
    !jump.ok && /R5_INIT_JUMP_REJECTED/.test(jump.message), jump.message);

  const back = await confirm(db, id, 1, 'u-parent', s.snapshot_fingerprint, correction);
  suite.check('D2', 'confirming day 1 is still rejected — no writeback of a played day',
    !back.ok && /R5_INIT_REGRESSION_REJECTED/.test(back.message), back.message);

  /* The high-water day itself is equally forbidden: the child already lived
   * through day 2, so re-publishing it would silently replay a day. */
  const highWater = await confirm(db, id, 2, 'u-parent', s.snapshot_fingerprint, correction);
  suite.check('D2b', 'confirming the high-water day 2 is rejected for the same reason',
    !highWater.ok && /R5_INIT_REGRESSION_REJECTED/.test(highWater.message), highWater.message);

  const noBy = await confirm(db, id, 3, '  ', s.snapshot_fingerprint, correction);
  suite.check('D3', 'a correction without a named confirmer is rejected',
    !noBy.ok && /R5_INIT_CONFIRMATION_REQUIRED/.test(noBy.message), noBy.message);

  suite.check('D4', 'none of those attempts created a progress row',
    (await progressRow(db, id)) === null, JSON.stringify(await progressRow(db, id)));
  await db.close();
}

/* ===========================================================================
 * D. a stale snapshot cannot be corrected retroactively
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-stale';
  await seedRealHistory(db, id);
  const s = await snapshot(db, id);

  /* evidence drifts between review and write: a fourth plan appears */
  await putPlan(db, id, '2026-11-14', 1, ['语文', '数学']);

  const r = await confirm(db, id, 3, 'u-parent', s.snapshot_fingerprint,
    { acknowledged: ['PLAN_HISTORY_ROLLBACK'], reason: REASON });
  suite.check('E1', 'a correction against a reviewed-but-stale snapshot is refused',
    !r.ok && /R5_INIT_SNAPSHOT_STALE/.test(r.message), r.message);
  suite.check('E2', 'the refused correction wrote nothing',
    (await progressRow(db, id)) === null, JSON.stringify(await progressRow(db, id)));
  await db.close();
}

/* ===========================================================================
 * E. a clean family must not be able to use the correction flag
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-clean';
  await seedFamily(db, { id, progress: false });
  await putPlan(db, id, D1, 1, ['语文', '数学']);
  await putPlan(db, id, D2, 2, ['数学', '英语']);
  await addAnswer(db, id, '语文', 1, true, D1);
  await addAnswer(db, id, '数学', 2, true, D2);

  const s = await snapshot(db, id);
  suite.check('F1', 'a monotonic history needs no correction',
    s.corrections_required.length === 0 && s.blocking.length === 0
    && s.evidence_ok === true, JSON.stringify({ c: s.corrections_required, b: s.blocking }));

  const bogus = await confirm(db, id, 3, 'u-parent', s.snapshot_fingerprint,
    { acknowledged: ['PLAN_HISTORY_ROLLBACK'], reason: REASON });
  suite.check('F2', 'passing a correction when none is required is refused (no blanket bypass)',
    !bogus.ok && /R5_INIT_CORRECTION_NOT_NEEDED/.test(bogus.message), bogus.message);

  const plain = await confirm(db, id, 3, 'u-parent', s.snapshot_fingerprint, null);
  const prog = await progressRow(db, id);
  suite.check('F3', 'the plain path still works for a clean family',
    plain.ok && prog.authoritative_day === 3, JSON.stringify(plain.value || plain.message));

  const conf = (await db.query(
    `SELECT corrections_applied, correction_reason FROM public.r5_day_confirmation
       WHERE family_id=$1`, [id])).rows[0];
  suite.check('F4', 'a clean confirmation records no correction and no reason',
    (conf.corrections_applied || []).length === 0 && conf.correction_reason === null,
    JSON.stringify(conf));
  await db.close();
}

/* ===========================================================================
 * F. the real family can actually publish after the correction
 * ========================================================================= */
{
  const db = await newDb();
  const id = 'fam-publish';
  await seedRealHistory(db, id);
  const s = await snapshot(db, id);
  await confirm(db, id, 3, 'u-parent', s.snapshot_fingerprint,
    { acknowledged: ['PLAN_HISTORY_ROLLBACK'], reason: REASON });

  const pub = await grab(() => publish(db, id, 1, false));
  suite.check('G1', 'after the correction the bridge can publish the authoritative day (client says 1)',
    pub.ok && pub.value.study_day === 3, JSON.stringify(pub.value || pub.message));
  suite.check('G2', 'the stale client is told it is stale, not silently obeyed',
    pub.ok && pub.value.stale_client === true, JSON.stringify(pub.value && pub.value.stale_client));

  const after = await plans(db, id);
  suite.check('G3', 'the historical rows are still the ones from production (no rewrite)',
    after.filter((p) => p.d === D1 || p.d === D2 || p.d === D3)
      .map((p) => `${p.d}:${p.day_index}`).join(',') === `${D1}:2,${D2}:2,${D3}:1`,
    JSON.stringify(after.map((p) => [p.d, p.day_index])));
  await db.close();
}

const summary = suite.print();
writeJson('evidence/real-history-results.json', summary);
process.exit(summary.failed === 0 ? 0 : 1);
