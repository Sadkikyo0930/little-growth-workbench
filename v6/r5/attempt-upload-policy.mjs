/**
 * v6/r5/attempt-upload-policy.mjs
 *
 * 四科成绩上传策略 + 云端有效成绩归一（纯函数，无 DOM / 无网络，可单独单测）。
 *
 * 规则（与云端 r5v2 判定保持同一套语义）：
 *   1. 某个「家庭 + 学习日 + 学科」在云端还没有任何有效成绩时，
 *      本机最早的那次完整交卷必须上传 —— 即使低于 80%，也要留下真实的第一次成绩。
 *   2. 云端已有成绩时，只有「严格大于」云端历史最高正确率才上传。相等不上传，更低不上传。
 *   3. 比较一律用 correct / total 的整数交叉相乘，绝不使用显示用的四舍五入百分比，
 *      因此 11/15(73.3%) 与 12/15(80%) 不会因为显示成 73.3 / 80.0 而被判成相等。
 *   4. 云端的「有效成绩」同时包含两类来源，统一按原始比例比较：
 *        a) 新的 course-attempt 完整交卷
 *        b) 旧的逐题记录 —— 但必须带整轮完成证据：
 *           同一学科 + 同一学习日 + 同一答题日期上存在 course-complete，
 *           并且题量达到 MIN_ROUND_TOTAL。1/1、2/2 这类零散练习不算。
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

/**
 * 旧记录的「整轮完成」成绩：answer 逐题聚合 + 同科目同学习日同日期的 course-complete。
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
 * 云端每个「学习日|学科」的历史最高有效成绩（新交卷 + 已验证旧成绩 取最高）。
 * @returns {Map<string,{correct:number,total:number,kind:string}>}
 */
export function cloudBest(cloudRows) {
  const best = new Map();

  for (const row of cloudRows || []) {
    if (!row || row.record_type !== 'course-attempt') continue;
    const score = scoreOf(dataOf(row));
    if (!score || score.total < MIN_ROUND_TOTAL) continue;
    const k = keyOf(Number(row.learning_day), row.subject);
    const prev = best.get(k);
    if (!prev || strictlyHigher(score, prev)) {
      best.set(k, { correct: score.correct, total: score.total, kind: 'course-attempt' });
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
 * @returns {{selected:Array, skipped:Array, reason:Object}}
 */
export function selectUploads(rows, cloudRows) {
  const best = cloudBest(cloudRows);
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
      // 第一次完整交卷：无论是否达标都上传
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

  return { selected, skipped, reason };
}

/** 保留所有非交卷行，交卷行只保留被策略选中的。 */
export function rowsToInsert(rows, uploadResult) {
  const keep = new Set(uploadResult.selected.map((r) => r.record_id));
  return (rows || []).filter((r) => r.record_type !== 'course-attempt' || keep.has(r.record_id));
}
