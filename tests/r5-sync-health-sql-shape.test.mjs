import assert from 'node:assert/strict';
import { normalizeSyncHealth, describeSync } from '../v6/r5/sync-health.mjs';

// 线上 SQL r5v2.sync_health 返回 today_subjects 而不是 subject_status。
// 防止因字段不一致导致妈妈端「读取失败」，或错误宣称所有科目都已上传。
const fromSql = {
  today: '2026-11-18',
  overall: 'PARTIAL_TODAY',
  today_subjects: [
    { subject: '数学', today_scores: 0, status: 'MISSING_TODAY' },
    { subject: '科学', today_scores: 1, status: 'RECEIVED_TODAY' },
  ],
  day_cumulative_subjects: [
    { subject: '数学', learning_day: 5, cumulative_scores: 1, status: 'HAS_SCORES' },
    { subject: '科学', learning_day: 5, cumulative_scores: 1, status: 'HAS_SCORES' },
  ],
  can_confirm_local_flags: false,
  devices: [], accounts: [], unbound_devices: [],
};
const normalized = normalizeSyncHealth(fromSql);
assert.equal(normalized.subject_status.length, 2);
assert.equal(normalized.local_flags_known, false);
assert.equal(fromSql.subject_status, undefined, 'normalization must not mutate cloud data');

const visible = describeSync(fromSql);
assert.equal(visible.level, 'warn');
assert(visible.lines.some(x => x.includes('未收到：数学')));
assert(visible.lines.some(x => x.includes('今日逐科：数学 今日未收到 · 科学 已收到')));
assert(visible.lines.some(x => x.includes('当前学习日累计有效成绩：数学 1 条')));
assert(!visible.lines.some(x => x.includes('今天计划内的科目都已从云端收到')));

const missing = describeSync({ overall: 'PARTIAL_TODAY' });
assert.equal(missing.level, 'warn');
assert(missing.lines.some(x => x.includes('暂未提供逐科详情')));
assert.equal(normalizeSyncHealth({}).subject_status.length, 0);

const unknown = describeSync({ overall: 'UNRECOGNIZED_VALUE' });
assert.equal(unknown.level, 'warn');
assert(!unknown.lines.some(x => x.includes('都已从云端收到')));

const empty = describeSync(null);
assert.equal(empty.level, 'warn');

const legacy = describeSync({ overall: 'RECEIVING_TODAY', subject_status: [
  { subject: '数学', status: 'RECEIVED_TODAY' },
  { subject: '科学', status: 'RECEIVED_TODAY' },
], devices: [], accounts: [], unbound_devices: [] });
assert.equal(legacy.level, 'ok');
assert(legacy.lines.some(x => x.includes('今日逐科：数学 已收到 · 科学 已收到')));

console.log('PASS: SQL response, missing arrays, safe unknown states, legacy JS shape');
