/**
 * v6/r5/attempt-recovery.mjs
 *
 * 本机「完整交卷」补救：当 attempt-history 里缺少某次整轮成绩时，
 * 从课程页面自己的进度存档里把同一轮的真实分数补成一条 course-attempt。
 *
 * 为什么需要：成绩曾经只写进课程进度（v6_math_*_progress_v1 / v6_science_*_progress_v1），
 * 而上传走的是 v6-attempt-history-v1。两者只要有一次没同步，
 * 就会出现「孩子本机明明 15/15，云端一条完整交卷都没有」。
 *
 * 安全边界（很重要）：
 *   - 只搬运本机已经记录过的真实分数，绝不推算、不四舍五入、不补题；
 *   - 只接受 correct / total 都是整数、total 达到整轮下限、at 可解析的记录；
 *   - 产出行的 record_data 带 recovered:true 与 source:'v6-progress-recovery'，
 *     妈妈端可以一眼看出这条是补同步来的，而不是原始交卷；
 *   - 纯函数：不读写 localStorage，由调用方传入 getItem，便于单测。
 */

import { MIN_ROUND_TOTAL } from './attempt-upload-policy.mjs';

/** 数学第 n 课 → 学习日 */
export const MATH_LEARNING_DAY = {
  1: 2, 2: 3, 3: 5, 4: 6, 5: 9, 6: 10, 7: 12, 8: 13, 9: 16,
  10: 17, 11: 19, 12: 20, 13: 23, 14: 24, 15: 26, 16: 27, 17: 30,
};

/** 科学第 n 课 → 学习日 */
export const SCIENCE_LESSONS = [1, 5, 8, 12, 15, 19, 22, 26, 29];

const SOURCES = [
  {
    subject: '数学',
    code: 'ma',
    keys: ['v6_math_course_20261109_progress_v1', 'v6_math_month_progress_v1'],
    dayOf: (key) => MATH_LEARNING_DAY[Number(key)],
    // 数学页面存的是「首次答对题数」，这才是这一轮的成绩
    scoreOf: (v) => ({ correct: Number(v.first), total: Number(v.total) }),
    accept: () => true,
  },
  {
    subject: '科学',
    code: 'sc',
    keys: ['v6_science_course_20261109_progress_v1', 'v6_science_preview_progress_v1'],
    dayOf: (key) => SCIENCE_LESSONS[Number(key) - 1],
    scoreOf: (v) => ({ correct: Number(v.correct), total: Number(v.total) }),
    // 只认真正答完的那一轮（实验页写的存档没有 quizComplete，不能被当成成绩）
    accept: (v) => v.quizComplete === true,
  },
];

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const isInt = (n) => Number.isInteger(n);
const parse = (raw) => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * @param {object}   options
 * @param {object}   options.history  v6-attempt-history-v1 的内容
 * @param {Function} options.getItem  (key) => string|null
 * @param {string}   options.deviceId 本机同步设备号
 * @param {string}   [options.since]  同步起点（ISO），早于它的不补
 * @returns {Array} 可直接上传的 course-attempt 行
 */
export function recoverAttempts({ history, getItem, deviceId, since } = {}) {
  if (typeof getItem !== 'function' || !deviceId) return [];
  const sinceMs = Date.parse(since || '') || 0;

  // 已有交卷指纹：学科 + 学习日 + 时刻
  const known = new Set();
  if (history && typeof history === 'object') {
    for (const list of Object.values(history)) {
      if (!Array.isArray(list)) continue;
      for (const a of list) {
        if (!a) continue;
        known.add(`${a.subject}|${a.learningDay}|${a.at}`);
      }
    }
  }

  const out = [];
  const emitted = new Set();

  for (const source of SOURCES) {
    for (const key of source.keys) {
      const table = parse(getItem(key));
      if (!table) continue;

      for (const [rawKey, entry] of Object.entries(table)) {
        if (!entry || typeof entry !== 'object') continue;
        if (!source.accept(entry)) continue;

        const learningDay = source.dayOf(rawKey);
        if (!isInt(learningDay) || learningDay < 1 || learningDay > 30) continue;

        const score = source.scoreOf(entry);
        if (!isInt(score.correct) || !isInt(score.total)) continue;
        if (score.total < MIN_ROUND_TOTAL) continue;
        if (score.correct < 0 || score.correct > score.total) continue;

        const at = entry.at;
        if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) continue;
        if (Date.parse(at) < sinceMs) continue;

        // attempt-history 里已经有这一轮 → 不用补
        if (known.has(`${source.subject}|${learningDay}|${at}`)) continue;

        const rawId = `${source.code}-${learningDay}-${at}-${score.correct}-${score.total}`;
        const attemptId = `rcv-${source.code}-d${learningDay}-${fnv1a(rawId)}`;
        const recordId = `v6-${deviceId}-attempt-${attemptId}`;
        if (emitted.has(recordId)) continue;
        emitted.add(recordId);

        out.push({
          record_id: recordId,
          record_type: 'course-attempt',
          subject: source.subject,
          learning_day: learningDay,
          record_data: {
            version: 1,
            source: 'v6-progress-recovery',
            recovered: true,
            recovered_from: key,
            device_id: deviceId,
            attempt_id: attemptId,
            correct: score.correct,
            total: score.total,
            wrong: score.total - score.correct,
            accuracy_pct: Math.round((score.correct / score.total) * 1000) / 10,
            passed: score.correct * 5 >= score.total * 4,
            at,
          },
        });
      }
    }
  }

  return out;
}
