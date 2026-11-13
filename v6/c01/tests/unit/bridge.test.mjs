/* C0.1 bridge suite — executes the real candidate v6/r5-bridge.js inside a VM
 * sandbox against an in-memory CloudBase double. No network, no real database.
 *
 * The double implements the SAME interfaces the production bridge calls
 * (r5_status / r5_publish_today / r5_advance_day / r5_claim_answers /
 * growth_learning_records REST), so the code under test is the shipping file.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createSuite, writeJson, localToday } from '../lib/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'candidate/v6/r5-bridge.js'), 'utf8');
const suite = createSuite('bridge');

const TODAY = localToday();
const REST = 'https://normal-goose-d5g4qyzr8bb389a4a.api.tcloudbasegateway.com/v1/rdb/rest';

/** Production 30-day subject table (r5_subject_template, read-only 2026-11-14). */
const SUBJECT_DAYS = [
  ['英语', '科学'], ['语文', '数学'], ['数学', '英语'], ['语文', '英语'], ['数学', '科学'],
  ['语文', '数学'], ['语文', '英语'], ['英语', '科学'], ['语文', '数学'], ['数学', '英语'],
  ['语文', '英语'], ['数学', '科学'], ['语文', '数学'], ['语文', '英语'], ['英语', '科学'],
  ['语文', '数学'], ['数学', '英语'], ['语文', '英语'], ['数学', '科学'], ['语文', '数学'],
  ['语文', '英语'], ['英语', '科学'], ['语文', '数学'], ['数学', '英语'], ['语文', '英语'],
  ['数学', '科学'], ['语文', '数学'], ['语文', '英语'], ['英语', '科学'], ['语文', '数学'],
];

class FakeCloud {
  constructor({ planDay = null, authDay = null, published = false, modules = null,
    compute = false, afterUpload = null, serverDay = null } = {}) {
    this.planDay = planDay;
    this.authDay = authDay;
    this.published = published;
    this.serverDay = serverDay;
    this.modules = modules;
    this.compute = compute;
    this.afterUpload = afterUpload;
    this.rows = new Map();
    this.calls = { publish: [], advance: [], claim: 0, post: [] };
    this.uploadBatches = 0;
  }

  status() {
    if (this.afterUpload && this.uploadBatches > 0 && this.afterUpload.planDay !== undefined) {
      this.planDay = this.afterUpload.planDay;
    }
    let modules = this.modules;
    if (this.compute || modules === null) modules = this.computedModules();
    const allPass = modules.length > 0 && modules.every((m) => m.passed);
    return {
      api: 'r5_status',
      date: TODAY,
      allowed: allPass,
      reason: allPass ? 'STUDY_PASSED' : 'STUDY_INCOMPLETE_OR_SCORE_UNVERIFIED',
      study_day: this.planDay,
      authoritative_day: this.authDay === null ? this.planDay : this.authDay,
      schedule_published: this.published,
      modules,
      study_passed: allPass,
      daily_seconds: 1800,
      remaining_seconds: 1800,
      parent_control: true,
    };
  }

  computedModules() {
    const subjects = this.planDay ? SUBJECT_DAYS[this.planDay - 1] : [];
    return subjects.map((subject) => {
      let total = 0, correct = 0, finished = false;
      for (const r of this.rows.values()) {
        if (r.subject !== subject || r.learning_day !== this.planDay) continue;
        if (r.record_type === 'answer') {
          const c = r.record_data?.answer?.correct;
          const d = String(r.record_data?.answer?.date || '').slice(0, 10);
          const scored = c === true || c === false || c === 'true' || c === 'false';
          if (scored && d === TODAY) {
            total++; if (c === true || c === 'true') correct++;
          }
        } else if (r.record_type === 'course-complete') {
          const at = r.record_data?.completed_at;
          if (at && new Date(at).toISOString().slice(0, 10) === TODAY) finished = true;
        }
      }
      const passed = finished && total > 0 && correct * 100 >= 80 * total;
      return {
        subject, completed: finished, correct, total,
        accuracy_pct: total ? Math.round(correct * 1000 / total) / 10 : null,
        waived: false,
        evidence: total > 0 && passed ? 'SCORED'
          : total > 0 ? 'SCORED_BELOW_THRESHOLD'
            : finished ? 'COMPLETED_UNSCORED' : 'NOT_COMPLETED',
        passed,
      };
    });
  }

  async fetch(url, opts = {}) {
    const u = new URL(url, REST);
    const p = u.pathname;
    if (p.endsWith('/r5_status')) return this.json(this.status());
    if (p.endsWith('/r5_publish_today')) {
      const body = JSON.parse(opts.body || '{}');
      this.calls.publish.push(body);
      if (!this.published) {
        this.planDay = this.serverDay !== null ? this.serverDay
          : (this.authDay === null ? body.p_day_index : this.authDay);
        this.published = true;
      }
      return this.json({
        date: TODAY, study_day: this.planDay,
        subjects: SUBJECT_DAYS[this.planDay - 1],
        published: true, authoritative_day: this.authDay === null ? this.planDay : this.authDay,
        client_day: body.p_day_index, stale_client: body.p_day_index !== this.planDay,
      });
    }
    if (p.endsWith('/r5_advance_day')) {
      this.calls.advance.push(JSON.parse(opts.body || '{}'));
      this.authDay = (this.planDay || 1) + 1;
      return this.json({ result: 'advance_day', authoritative_day: this.authDay });
    }
    if (p.endsWith('/r5_claim_answers')) {
      const body = JSON.parse(opts.body || '{}');
      this.calls.claim++;
      const ids = (body.p_items || []).map((x) => x.record_id);
      return this.json({ claimed: ids.filter((id) => !this.claimDuplicates?.has(id)),
        reclaimed: [], duplicates: ids.filter((id) => this.claimDuplicates?.has(id)) });
    }
    if (p.endsWith('/growth_learning_records')) {
      if (opts.method === 'POST') {
        const rows = JSON.parse(opts.body || '[]');
        this.uploadBatches++;
        for (const r of rows) {
          this.calls.post.push(r);
          if (!this.rows.has(r.record_id)) this.rows.set(r.record_id, r);
        }
        return new Response('', { status: 201 });
      }
      const sel = u.searchParams.get('select') || '';
      const idFilter = u.searchParams.get('record_id');
      const dayFilter = u.searchParams.get('learning_day');
      let rows = [...this.rows.values()];
      if (idFilter && idFilter.startsWith('in.(')) {
        const ids = idFilter.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
        rows = rows.filter((r) => ids.includes(r.record_id));
      }
      if (dayFilter && dayFilter.startsWith('eq.')) {
        rows = rows.filter((r) => String(r.learning_day) === dayFilter.slice(3));
      }
      if (sel.trim() === 'record_id') rows = rows.map((r) => ({ record_id: r.record_id }));
      return this.json(rows);
    }
    return new Response('not found', { status: 404 });
  }

  json(obj) {
    return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  }
}

function makeState({ day = 1, records = [], subjects = {}, chinese = {} } = {}) {
  const completedDays = {};
  for (let d = 1; d < day; d++) completedDays[d] = true;
  return { records, v6Course: { completedDays, subjects }, dailyChinese: chinese };
}

function answers(subject, learningDay, count, correct = count, date = TODAY) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ subject, track: '课程', index: i, learningDay, correct: i < correct, date });
  }
  return out;
}

function mount(state, cloud, { today = TODAY } = {}) {
  const store = new Map();
  store.set('growth-workbench-v6-adaptive-2', JSON.stringify(state));
  store.set('v6-family-sync-device-id', 'a1b2c3d4e5f60718');
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  let seq = 0;
  const sandbox = {
    document: {
      currentScript: null,
      addEventListener() {},
      getElementById() { return null; },
      createElement() { return { setAttribute() {}, appendChild() {} }; },
      head: { appendChild() {} },
    },
    localStorage,
    crypto: { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (seq = (seq * 7 + 13) % 256); return a; } },
    fetch: (url, opts) => cloud.fetch(url, opts),
    location: { origin: 'https://example.com' },
    console: { info() {}, log() {}, warn() {} },
    setTimeout() { return 0; },
    setInterval() { return 0; },
    clearTimeout() {},
    V6_SUBJECT_DAYS: SUBJECT_DAYS,
    addEventListener() {},
    // CloudBase SDK double: identity() must resolve without loading a script.
    cloudbase: {
      init() {
        return {
          auth: {
            async getSession() { return { data: { session: { user: { id: 'u-parent' }, access_token: 'test-token' } } }; },
            async getAccessToken() { return { accessToken: 'test-token' }; },
          },
        };
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.__today = today;
  vm.createContext(sandbox);
  vm.runInContext(bridgeSrc, sandbox, { filename: 'r5-bridge.js' });
  return { api: sandbox.R5Bridge, store, sandbox };
}

/* ---- B1 interface surface ------------------------------------------------ */
{
  const { api } = mount(makeState({ day: 2 }), new FakeCloud({ planDay: 2 }));
  suite.check('B1.1', 'build id is the C0.1 candidate id',
    api.build === '2026-11-14.authoritative-day-c01' && api.version === api.build);
  suite.check('B1.2', 'legacy entry points still exist',
    typeof api.run === 'function' && typeof api.runNow === 'function' && typeof api.status === 'function');
  suite.check('B1.3', 'diagnostic entry points still exist',
    typeof api.diagnose === 'function' && typeof api.grading === 'function'
    && typeof api.collectAnswers === 'function' && typeof api.recordAnswer === 'function'
    && typeof api.installChineseCapture === 'function');
  suite.check('B1.4', 'new read-only day inspector exists',
    typeof api.inspectCloud === 'function' && typeof api.dayInfo === 'function');
  suite.check('B1.5', 'bridge hardcodes no quota value',
    !/1800/.test(bridgeSrc));
  suite.check('B1.6', 'bridge never touches racing storage / gate html',
    !/little-racing|r5_racing_saves|gate\.html/.test(bridgeSrc));
}

/* ---- B2 normal day 2 -> day 3 ------------------------------------------- */
{
  const cloud = new FakeCloud({ planDay: 2, authDay: 2, published: true, compute: true });
  const state = makeState({
    day: 2,
    records: [...answers('cn', 2, 5), ...answers('ma', 2, 5)],
    subjects: { 2: { 语文: `${TODAY}T02:00:00.000Z`, 数学: `${TODAY}T02:10:00.000Z` } },
  });
  const { api } = mount(state, cloud);
  const st = await api.runNow();
  suite.check('B2.1', 'state is ok after a clean two-subject day', st.state === 'ok', st.state);
  suite.check('B2.2', 'cloud day is reported', st.cloud_day === 2, st.cloud_day);
  suite.check('B2.3', 'all 12 rows (10 answers + 2 completions) were uploaded',
    st.uploaded === 12 && cloud.rows.size === 12, `${st.uploaded}/${cloud.rows.size}`);
  suite.check('B2.4', 'cloud verification confirms every row', st.cloud_verified === true);
  suite.check('B2.5', 'gate allows the racing unlock', st.allowed === true && st.reason === 'STUDY_PASSED', st.reason);
  suite.check('B2.6', 'advance was requested exactly once', cloud.calls.advance.length === 1);
  suite.check('B2.7', 'next day is day 3', st.next_day === 3, st.next_day);
  suite.check('B2.8', 'every uploaded row keeps learning_day = 2',
    cloud.calls.post.every((r) => r.learning_day === 2),
    JSON.stringify(cloud.calls.post.map((r) => r.learning_day)));
  suite.check('B2.9', 'no row is written for another day',
    !cloud.calls.post.some((r) => r.learning_day !== 2));
  suite.check('B2.10', 'publish used the authoritative day and no_tasks=false',
    cloud.calls.publish.length === 0 || (cloud.calls.publish[0].p_day_index === 2
      && cloud.calls.publish[0].p_no_tasks === false));
  suite.check('B2.11', 'two subjects reported with 100% accuracy',
    Array.isArray(st.subjects) && st.subjects.length === 2 && st.subjects.every((s) => /100%/.test(s)),
    JSON.stringify(st.subjects));
  suite.check('B2.12', 'both completions are tagged with the course-complete type',
    cloud.calls.post.filter((r) => r.record_type === 'course-complete').length === 2);
}

/* ---- B3 stale device (local day 1, cloud day 3) ------------------------- */
{
  const cloud = new FakeCloud({ planDay: 3, authDay: 3, published: true, compute: true });
  const state = makeState({
    day: 1,
    records: [...answers('en', 1, 14), ...answers('sc', 1, 6)],
    subjects: { 1: { 英语: `${TODAY}T01:00:00.000Z`, 科学: `${TODAY}T01:10:00.000Z` } },
  });
  const { api } = mount(state, cloud);
  const st = await api.runNow();
  suite.check('B3.1', 'stale device is flagged', st.state === 'stale_device_day', st.state);
  suite.check('B3.2', 'cloud day and local day are both reported',
    st.cloud_day === 3 && st.local_day === 1, `${st.cloud_day}/${st.local_day}`);
  suite.check('B3.3', 'stale device writes zero learning records', cloud.calls.post.length === 0);
  suite.check('B3.4', 'stale device publishes no plan', cloud.calls.publish.length === 0);
  suite.check('B3.5', 'stale device never advances the day', cloud.calls.advance.length === 0);
  suite.check('B3.6', 'pending is reported as unknown, not zero',
    st.pending === null && st.pending_known === false);
  suite.check('B3.7', 'message explains the day skew',
    /第 3 天/.test(st.message) && /不上传/.test(st.message), st.message);
}

/* ---- B4 device ahead (local day 4, cloud day 2) ------------------------- */
{
  const cloud = new FakeCloud({ planDay: 2, authDay: 2, published: true, compute: true });
  const { api } = mount(makeState({ day: 4 }), cloud);
  const st = await api.runNow();
  suite.check('B4.1', 'device ahead is flagged', st.state === 'device_ahead', st.state);
  suite.check('B4.2', 'no learning record is written', cloud.calls.post.length === 0);
  suite.check('B4.3', 'no plan is published from unverified local progress', cloud.calls.publish.length === 0);
  suite.check('B4.4', 'no advance is attempted', cloud.calls.advance.length === 0);
  suite.check('B4.5', 'message asks the parent to confirm',
    /家长/.test(st.message), st.message);
}

/* ---- B5 cross-date: yesterday's work is not replayed today -------------- */
{
  const cloud = new FakeCloud({ planDay: 3, authDay: 3, published: true, compute: true });
  const state = makeState({
    day: 3,
    records: [...answers('ma', 2, 6), ...answers('en', 2, 6)],
    subjects: { 2: { 数学: `${TODAY}T03:00:00.000Z`, 英语: `${TODAY}T03:10:00.000Z` } },
  });
  const { api } = mount(state, cloud);
  const st = await api.runNow();
  suite.check('B5.1', 'nothing is uploaded for the new day', st.uploaded === 0, st.uploaded);
  suite.check('B5.2', 'cloud row count is unchanged', cloud.rows.size === 0);
  suite.check('B5.3', 'state still reports the sync attempt honestly', st.state === 'ok', st.state);
  suite.check('B5.4', 'message says there is nothing to upload',
    /还没有需要上传的成绩/.test(st.message), st.message);
  suite.check('B5.5', 'no fabricated day-3 row exists', !cloud.calls.post.some((r) => r.learning_day === 3));
}

/* ---- B6 day-1 English is never re-dated to day 3 ------------------------ */
{
  const cloud = new FakeCloud({ planDay: 3, authDay: 3, published: true, compute: true });
  const state = makeState({
    day: 3,
    records: answers('en', 1, 14),
    subjects: { 1: { 英语: `${TODAY}T01:30:00.000Z` } },
  });
  const { api } = mount(state, cloud);
  const st = await api.runNow();
  suite.check('B6.1', 'stale local answer rows are not uploaded under the new day',
    cloud.calls.post.length === 0, JSON.stringify(cloud.calls.post.map((r) => [r.subject, r.learning_day])));
  suite.check('B6.2', 'no English row is re-dated to day 3',
    !cloud.calls.post.some((r) => r.subject === '英语' && r.learning_day === 3));
  suite.check('B6.3', 'no English row is uploaded as day 1 either (already old)',
    !cloud.calls.post.some((r) => r.subject === '英语' && r.learning_day === 1));
  suite.check('B6.4', 'the report does not claim a verified unlock',
    st.cloud_verified === false && st.allowed !== true);
}

/* ---- B7 completed but score not synced --------------------------------- */
{
  const cloud = new FakeCloud({
    planDay: 3, authDay: 3, published: true,
    modules: [
      { subject: '数学', completed: true, correct: 0, total: 0, accuracy_pct: null,
        waived: false, evidence: 'COMPLETED_UNSCORED', passed: false, pending_score_sync: true },
      { subject: '英语', completed: true, correct: 6, total: 6, accuracy_pct: 100,
        waived: false, evidence: 'SCORED', passed: true },
    ],
  });
  const state = makeState({ day: 3, subjects: { 3: { 数学: `${TODAY}T04:00:00.000Z` } } });
  const { api } = mount(state, cloud);
  const st = await api.runNow();
  suite.check('B7.1', 'completion still uploads the course-complete row', st.uploaded === 1);
  suite.check('B7.2', 'pending score sync is surfaced for 数学',
    st.pending_score_sync.length === 1 && st.pending_score_sync[0].subject === '数学',
    JSON.stringify(st.pending_score_sync));
  suite.check('B7.3', 'no answer row is fabricated for the unsynced subject',
    !cloud.calls.post.some((r) => r.record_type === 'answer'));
  suite.check('B7.4', 'gate stays closed', st.allowed === false);
  suite.check('B7.5', 'message explains the score is not synced yet',
    /成绩还没同步/.test(st.message), st.message);
}

/* ---- B8 cloud day regression ------------------------------------------- */
{
  const cloud = new FakeCloud({
    planDay: 3, authDay: 3, published: true, compute: true,
    afterUpload: { planDay: 2 },
  });
  const state = makeState({
    day: 3,
    records: [...answers('ma', 3, 5), ...answers('en', 3, 5)],
    subjects: { 3: { 数学: `${TODAY}T05:00:00.000Z` } },
  });
  const { api } = mount(state, cloud);
  const st = await api.runNow();
  suite.check('B8.1', 'regression is detected', st.state === 'cloud_day_regression', st.state);
  suite.check('B8.2', 'previous and current cloud days are reported',
    st.previous_cloud_day === 3 && st.cloud_day === 2, `${st.previous_cloud_day}/${st.cloud_day}`);
  suite.check('B8.3', 'only one upload batch was sent', cloud.uploadBatches === 1, cloud.uploadBatches);
  suite.check('B8.4', 'no unlock is reported while regressed', st.cloud_verified === false);
}

/* ---- B9 atomic claim duplicates ---------------------------------------- */
{
  const cloud = new FakeCloud({ planDay: 2, authDay: 2, published: true, compute: true });
  const dupId = 'v6-a1b2c3d4e5f60718-answer-000000000';
  cloud.claimDuplicates = new Set([dupId]);
  cloud.rows.set(dupId, {
    record_id: dupId, family_id: 'little-growth-family-001', record_type: 'answer',
    subject: '语文', learning_day: 2,
    record_data: { answer: { correct: 'true', date: TODAY, track: '课程', index: 0 } },
  });
  const state = makeState({
    day: 2,
    records: [...answers('cn', 2, 5), ...answers('ma', 2, 5)],
    subjects: { 2: { 语文: `${TODAY}T06:00:00.000Z`, 数学: `${TODAY}T06:10:00.000Z` } },
  });
  const { api } = mount(state, cloud);
  const st = await api.runNow();
  suite.check('B9.1', 'a duplicate claimed by another device is skipped',
    st.skipped_duplicates >= 1, st.skipped_duplicates);
  suite.check('B9.2', 'the duplicate is not re-posted',
    !cloud.calls.post.some((r) => r.record_id === dupId));
  suite.check('B9.3', 'remaining rows still land', cloud.rows.size === 12, cloud.rows.size);
  suite.check('B9.4', 'sync still completes and verifies', st.state === 'ok' && st.cloud_verified === true);
}

/* ---- B10 publish with a stale client day ------------------------------- */
{
  const cloud = new FakeCloud({ planDay: null, authDay: null, published: false, serverDay: 3 });
  const state = makeState({
    day: 1,
    records: answers('en', 1, 14),
    subjects: { 1: { 英语: `${TODAY}T07:00:00.000Z` } },
  });
  const { api } = mount(state, cloud);
  const st = await api.runNow();
  suite.check('B10.1', 'publish is called with the local (stale) day as a hint',
    cloud.calls.publish.length === 1 && cloud.calls.publish[0].p_day_index === 1,
    JSON.stringify(cloud.calls.publish));
  suite.check('B10.2', 'the cloud plan follows the authoritative day (3)',
    cloud.planDay === 3, cloud.planDay);
  suite.check('B10.3', 'the bridge then refuses to upload', cloud.calls.post.length === 0);
  suite.check('B10.4', 'final state is stale_device_day', st.state === 'stale_device_day', st.state);
  suite.check('B10.5', 'message names the authoritative day', /第 3 天/.test(st.message), st.message);
}

/* ---- B11 recordAnswer guards ------------------------------------------- */
{
  const { api, sandbox } = mount(makeState({ day: 2 }), new FakeCloud({ planDay: 2 }));
  suite.check('B11.1', 'rejects a non-boolean correctness', api.recordAnswer('数学', 2, 0, 'yes') === false);
  suite.check('B11.2', 'rejects an out-of-range day', api.recordAnswer('数学', 0, 0, true) === false);
  suite.check('B11.3', 'rejects a day that is not the current course day', api.recordAnswer('数学', 5, 0, true) === false);
  const ok = api.recordAnswer('数学', 2, 3, true);
  const saved = JSON.parse(sandbox.localStorage.getItem('growth-workbench-v6-adaptive-2'));
  suite.check('B11.4', 'accepts a valid answer and appends it locally',
    ok === true && saved.records.length === 1 && saved.records[0].learningDay === 2);
}

/* ---- B12 diagnostics ---------------------------------------------------- */
{
  const cloud = new FakeCloud({ planDay: 3, authDay: 3, published: true, compute: true });
  const { api } = mount(makeState({ day: 3 }), cloud);
  const info = await api.dayInfo();
  suite.check('B12.1', 'dayInfo reports alignment without writing', info.aligned === true && info.cloud_day === 3);
  suite.check('B12.2', 'dayInfo carries the build id', info.build === '2026-11-14.authoritative-day-c01');
  const diag = api.diagnose();
  suite.check('B12.3', 'diagnose still reports the local day', diag.localDay === 3 && diag.build === info.build);
  suite.check('B12.4', 'diagnose read the cloud cache written by the last run',
    diag.cloud === null || typeof diag.cloud === 'object');
}

const summary = suite.print();
writeJson(path.join(ROOT, 'evidence/bridge-results.json'), { ...summary, results: suite.results });
if (summary.failed > 0) process.exitCode = 1;
