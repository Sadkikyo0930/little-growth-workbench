/**
 * v6/r5/attempt-upload-policy.mjs
 *
 * 四科成绩上传策略 + 云端有效成绩归一（纯函数，无 DOM / 无网络，可单独单测）。
 *
 * 规则（与云端 r5v2 / R5_SAFE_ROUND_V4 判定保持同一套语义）：
 *   1. 某个「家庭 + 学习日 + 学科」在云端还没有**可核验**成绩时，
 *      本机最早的那次完整交卷必须上传 —— 即使低于 80%，也要留下真实的第一次成绩。
 *   2. 云端已有可核验成绩时，只有「严格大于」云端历史最高正确率才上传。相等不上传，更低不上传。
 *   3. 比较一律用 correct / total 的整数交叉相乘，绝不使用显示用的四舍五入百分比，
 *      因此 11/15(73.3%) 与 12/15(80%) 不会因为显示成 73.3 / 80.0 而被判成相等。
 *   4. 「可核验」的唯一口径 = **同一轮真实完整逐题答案**（与数据库判定完全一致）：
 *        a) 摘要必须带 attempt_id、设备标识、答题时刻；
 *        b) correct / total / wrong 三个字段必须自洽（wrong = total − correct）；
 *        c) 同 attempt_id 的逐题 answer 行条数必须等于 total，且 index 恰好覆盖 0..total−1；
 *        d) 逐题行必须同设备、同答题日、同学习日，且逐题正确数必须等于摘要里的 correct。
 *      不满足任何一条的摘要（历史 100% 占位、老客户端无 attempt_id 的摘要、
 *      1/1 之类零散练习、缺题/重题/串轮次的摘要）一律**不参与比较**，
 *      因此**不会**把后续真实交卷挡在门外。
 *   5. 旧客户端的「逐题记录 + course-complete 整轮完成证据」仍然算有效来源，
 *      但只覆盖**没有** attempt_id 的旧行，避免与新的整轮核验重复计数。
 *
 * 该模块只决定「哪些行值得上传」，不删除本机任何记录，也从不改写已上传过的历史。
 */

/** 一整轮的最少题量，必须与服务端 r5v2.round_min_total() 保持一致。 */
export const MIN_ROUND_TOTAL = 5;

/** 把一次交卷的分数取出来；不是合法完整交卷则返回 null。 */
export function scoreOf(data) {
  if (!data || typeof data !== 'object') return null;
  const correct = Number(data.correct);
  const total = Number(data.total);
  if (!Number.isInteger(correct) || !Number.isInteger(total)) return null;
  if (total < 1 || correct < 0 || correct > total) return null;
  return { correct, total };
}

/** a 的比例是否严格大于 b（交叉相乘，整数比较，无浮点误差）。 */
export function strictlyHigher(a, b) {
  return a.correct * b.total > b.correct * a.total;
}

function higher(a, b) {
  if (!a) return b;
  if (!b) return a;
  return strictlyHigher(b, a) ? b : a;
}

/** record_data 可能是 JSON 字符串，统一成对象。 */
export function dataOf(row) {
  if (!row || typeof row !== 'object') return null;
  let d = row.record_data;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return null; }
  }
  return d && typeof d === 'object' ? d : null;
}

/** 'YYYY-MM-DD'（上海时区）；无法解析返回 ''。 */
export function dayOf(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(t));
}

const keyOf = (learningDay, subject) => `${learningDay}|${subject}`;
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

/** 摘要行的设备标识：优先 record_data.device_id，其次从 record_id 里取。 */
export function attemptDeviceOf(row, data) {
  if (nonEmpty(data.device_id)) return data.device_id;
  const m = /^v6-([^-]+)-attempt-/.exec(String(row.record_id || ''));
  return m ? m[1] : '';
}

/** 逐题行的设备标识：优先 record_data.device_id，其次从两种 record_id 形态里取。 */
export function answerDeviceOf(row, data) {
  if (nonEmpty(data.device_id)) return data.device_id;
  const rid = String(row.record_id || '');
  const a = /^v6-([^-]+)-a-/.exec(rid) || /^v6-([^-]+)-answer-/.exec(rid);
  return a ? a[1] : '';
}

/**
 * 把云端行按 attempt_id 分组。
 * @returns {{attempts:Array, answers:Map<string,Array>}}
 */
export function groupByAttempt(cloudRows) {
  const attempts = [];
  const answers = new Map();
  for (const row of cloudRows || []) {
    if (!row || typeof row !== 'object') continue;
    const data = dataOf(row);
    if (!data) continue;
    const aid = nonEmpty(data.attempt_id) ? data.attempt_id : '';
    if (!aid) continue;
    if (row.record_type === 'course-attempt') attempts.push(row);
    else if (row.record_type === 'answer') {
      const arr = answers.get(aid) || [];
      arr.push(row);
      answers.set(aid, arr);
    }
  }
  return { attempts, answers };
}

/**
 * 单轮核验：镜像数据库的 R5_SAFE_ROUND_V4 整轮校验。
 * @returns {{ok:boolean, reason:string|null, correct:number, total:number, attemptId:string, day:number, subject:string}}
 */
export function verifyRound(attemptRow, answerRows) {
  const data = dataOf(attemptRow) || {};
  const attemptId = nonEmpty(data.attempt_id) ? data.attempt_id : '';
  const day = Number(attemptRow.learning_day);
  const subject = String(attemptRow.subject || '');
  const base = { ok: false, reason: null, correct: 0, total: 0, attemptId, day, subject };

  if (!attemptId) return { ...base, reason: 'NO_ATTEMPT_ID' };
  const device = attemptDeviceOf(attemptRow, data);
  if (!device) return { ...base, reason: 'NO_DEVICE' };
  const attemptDay = dayOf(data.at);
  if (!attemptDay) return { ...base, reason: 'NO_ATTEMPT_DATE' };

  const correct = Number(data.correct);
  const total = Number(data.total);
  const wrong = Number(data.wrong);
  if (!Number.isInteger(correct) || !Number.isInteger(total) || !Number.isInteger(wrong)
    || total < 1 || correct < 0 || correct > total || wrong !== total - correct) {
    return { ...base, reason: 'INVALID_SCORE_FIELDS' };
  }
  if (total < MIN_ROUND_TOTAL) return { ...base, reason: 'TOTAL_TOO_SMALL' };

  const rows = answerRows || [];
  if (rows.length !== total) return { ...base, reason: 'ANSWER_ROUND_MISMATCH' };

  const seen = new Set();
  let okCount = 0;
  for (const row of rows) {
    const d = dataOf(row) || {};
    const ans = d.answer;
    if (!ans || typeof ans !== 'object') return { ...base, reason: 'ANSWER_ROUND_MISMATCH' };
    const idx = Number(ans.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= total) return { ...base, reason: 'ANSWER_INDEX_GAP' };
    if (seen.has(idx)) return { ...base, reason: 'ANSWER_INDEX_GAP' };
    seen.add(idx);
    if (answerDeviceOf(row, d) !== device) return { ...base, reason: 'ANSWER_DEVICE_MISMATCH' };
    if (dayOf(ans.date) !== attemptDay) return { ...base, reason: 'ANSWER_DATE_MISMATCH' };
    const answerLearningDay = Number(ans.learningDay);
    if (Number(row.learning_day) !== day
      || (ans.learningDay !== undefined && answerLearningDay !== day)) {
      return { ...base, reason: 'WRONG_LEARNING_DAY' };
    }
    const c = ans.correct;
    if (c === true || c === 'true') okCount++;
    else if (!(c === false || c === 'false')) return { ...base, reason: 'ANSWER_ROUND_MISMATCH' };
  }
  if (okCount !== correct) return { ...base, reason: 'ANSWER_ROUND_MISMATCH' };

  return { ok: true, reason: null, correct, total, attemptId, day, subject };
}

/**
 * 扫描云端所有带 attempt_id 的交卷，返回逐轮核验结果。
 * @returns {{verified:Array, ignored:Array}}
 */
export function scanCloudRounds(cloudRows) {
  const { attempts, answers } = groupByAttempt(cloudRows);
  const verified = [];
  const ignored = [];
  for (const row of attempts) {
    const data = dataOf(row) || {};
    const aid = String(data.attempt_id || '');
    const r = verifyRound(row, answers.get(aid));
    const item = {
      record_id: row.record_id, attempt_id: aid, day: r.day, subject: r.subject,
      correct: r.correct, total: r.total, reason: r.reason,
    };
    if (r.ok) verified.push(item); else ignored.push(item);
  }
  return { verified, ignored };
}

/**
 * 旧客户端的「整轮完成」成绩：answer 逐题聚合 + 同科目同学习日同日期的 course-complete。
 * 只统计**没有** attempt_id 的旧行，避免与整轮核验重复计数。
 * @returns {Map<string,{correct:number,total:number}>} key = `learningDay|subject`
 */
export function legacyVerifiedBest(cloudRows) {
  const complete = new Set();
  const groups = new Map();

  for (const row of cloudRows || []) {
    if (!row || typeof row !== 'object') continue;
    const data = dataOf(row);
    if (!data) continue;

    if (row.record_type === 'course-complete') {
      const d = dayOf(data.completed_at);
      if (d) complete.add(`${row.subject}|${row.learning_day}|${d}`);
      continue;
    }

    if (row.record_type === 'answer') {
      if (nonEmpty(data.attempt_id)) continue;
      const answer = data.answer;
      if (!answer) continue;
      if (!(answer.correct === true || answer.correct === false
        || answer.correct === 'true' || answer.correct === 'false')) continue;
      const d = dayOf(answer.date);
      if (!d) continue;
      const k = `${row.subject}|${row.learning_day}|${d}`;
      const g = groups.get(k) || { correct: 0, total: 0 };
      g.total += 1;
      if (answer.correct === true || answer.correct === 'true') g.correct += 1;
      groups.set(k, g);
    }
  }

  const best = new Map();
  for (const [k, g] of groups) {
    // 必须有整轮完成证据，且达到整轮题量下限，否则只是零散练习
    if (!complete.has(k)) continue;
    if (g.total < MIN_ROUND_TOTAL) continue;
    const parts = k.split('|');
    const mapKey = keyOf(Number(parts[1]), parts[0]);
    best.set(mapKey, higher(best.get(mapKey), { correct: g.correct, total: g.total }));
  }
  return best;
}

/**
 * 云端每个「学习日|学科」的历史最高**可核验**成绩。
 * 无效摘要（无 attempt_id / 缺逐题 / 题量不符 / 串轮次）一律忽略。
 * @returns {Map<string,{correct:number,total:number,kind:string}>}
 */
export function cloudBest(cloudRows) {
  const best = new Map();

  const { verified } = scanCloudRounds(cloudRows);
  for (const r of verified) {
    const k = keyOf(r.day, r.subject);
    const prev = best.get(k);
    if (!prev || strictlyHigher(r, prev)) {
      best.set(k, { correct: r.correct, total: r.total, kind: 'course-attempt' });
    }
  }

  for (const [k, score] of legacyVerifiedBest(cloudRows)) {
    const prev = best.get(k);
    if (!prev || strictlyHigher(score, prev)) {
      best.set(k, { correct: score.correct, total: score.total, kind: 'answer-verified' });
    }
  }

  return best;
}

function timeOf(row) {
  const d = dataOf(row);
  const t = Date.parse(d && d.at);
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/**
 * @param {Array} rows 本机待上传行（含 record_type）
 * @param {Array} cloudRows 云端已存在的记录（含 record_data）
 * @returns {{selected:Array, skipped:Array, reason:Object, cloudIgnored:Array, cloudVerified:Array}}
 */
export function selectUploads(rows, cloudRows) {
  const best = cloudBest(cloudRows);
  const scan = scanCloudRounds(cloudRows);
  const candidates = (rows || [])
    .filter((r) => r && r.record_type === 'course-attempt')
    .slice()
    .sort((a, b) => timeOf(a) - timeOf(b) || String(a.record_id).localeCompare(String(b.record_id)));

  const selected = [];
  const skipped = [];
  const reason = {};

  for (const row of candidates) {
    const score = scoreOf(dataOf(row));
    if (!score || score.total < MIN_ROUND_TOTAL) {
      skipped.push(row);
      reason[row.record_id] = 'NOT_A_COMPLETE_ATTEMPT';
      continue;
    }
    const k = keyOf(Number(row.learning_day), row.subject);
    const prev = best.get(k);
    if (!prev) {
      // 云端的都不可核验：本机最早一次完整交卷必须上传
      selected.push(row);
      best.set(k, { correct: score.correct, total: score.total, kind: 'local' });
      reason[row.record_id] = 'FIRST_ATTEMPT';
      continue;
    }
    if (strictlyHigher(score, prev)) {
      selected.push(row);
      best.set(k, { correct: score.correct, total: score.total, kind: 'local' });
      reason[row.record_id] = 'STRICT_IMPROVEMENT';
      continue;
    }
    skipped.push(row);
    reason[row.record_id] = 'NOT_HIGHER_THAN_CLOUD_BEST';
  }

  return {
    selected, skipped, reason,
    cloudVerified: scan.verified,
    cloudIgnored: scan.ignored,
  };
}

/** 保留所有非交卷行，交卷行只保留被策略选中的。 */
export function rowsToInsert(rows, uploadResult) {
  const keep = new Set(uploadResult.selected.map((r) => r.record_id));
  return (rows || []).filter((r) => r.record_type !== 'course-attempt' || keep.has(r.record_id));
}
