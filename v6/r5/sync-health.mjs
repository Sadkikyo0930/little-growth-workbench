/**
 * v6/r5/sync-health.mjs
 *
 * 同步健康（纯函数，无 DOM、无网络，可单独单测）。
 *
 * 目的：让妈妈在自己手机上直接看到「云端到底收到了谁、什么时候、哪一科」，
 * 而不是让外婆去手机上猜为什么赛车不放行。
 *
 * 三条硬原则：
 *   1. 只报服务端能确证的事实。V6 的 16 位同步设备号不是 r5_device.device_uid，
 *      必须与家长在 r5v2.device_binding 里确认过的哈希对上；对不上一律
 *      「设备待识别」，绝不因为「上传账号是外婆」就推断设备是外婆手机。
 *   2. 旧 answer / course-complete 记录不带设备号，只能归到账号来源。
 *   3. 浏览器本地的「自动同步已开启 / 同步基线 / 登录会话」服务器看不到。
 *      本模块永远返回 localFlagsKnown=false，并且措辞上绝不承诺
 *      「打开页面就会自动上传成功」。
 */

const CANON = {
  语文: '语文', chinese: '语文', yw: '语文', 国文: '语文',
  数学: '数学', math: '数学', sx: '数学',
  英语: '英语', english: '英语', en: '英语', yy: '英语',
  科学: '科学', science: '科学', kx: '科学',
};

export function canonSubject(s) {
  const raw = String(s == null ? '' : s).trim();
  return CANON[raw.toLowerCase()] || CANON[raw] || null;
}

/** ISO / 时间串 → 上海时区 YYYY-MM-DD；无法解析返回 '' */
export function shDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(t));
}

function dataOf(row) {
  let d = row && row.record_data;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return null; }
  }
  return d && typeof d === 'object' ? d : null;
}

/** 一条 course-attempt 是否是一次合法完整交卷（与服务端同一口径：total ≥ 5） */
export const MIN_ROUND_TOTAL = 5;

export function isScoredAttempt(row) {
  if (!row || row.record_type !== 'course-attempt') return false;
  const d = dataOf(row);
  if (!d) return false;
  const total = Number(d.total);
  const correct = Number(d.correct);
  if (!Number.isInteger(total) || !Number.isInteger(correct)) return false;
  if (total < MIN_ROUND_TOTAL || correct < 0 || correct > total) return false;
  return Number.isFinite(Date.parse(d.at));
}

/**
 * @param {object} input
 * @param {Array}  input.records  云端 learning_records（至少含 record_type/subject/learning_day/record_data/created_by/created_at）
 * @param {Array}  input.devices  家长确认过的 r5v2.device_binding 行（device_hash/label/bound_by）；
 *                                兼容旧字段 device_uid
 * @param {object} input.plan     今天的学习日计划 {day_index, subjects, published} 或 null
 * @param {string} input.today    今天的上海时区日期 YYYY-MM-DD
 * @param {Array}  input.unboundDevices 服务端返回的未确认哈希（可选，缺省时本地推导）
 * @param {Array}  input.dayCumulativeSubjects 服务端返回的学习日累计（可选）
 */
export function buildSyncHealth({
  records = [], devices = [], plan = null, planKnown = true, today,
  unboundDevices, dayCumulativeSubjects,
} = {}) {
  const rows = Array.isArray(records) ? records : [];
  const binds = Array.isArray(devices) ? devices : [];
  const deviceHash = (d) => String(d && (d.device_hash || d.device_uid) || '');
  const boundIds = new Set(binds.map(deviceHash).filter(Boolean));
  const published = !!(plan && plan.published);
  const subjects = published && Array.isArray(plan.subjects) ? plan.subjects : [];

  const tagged = rows.filter(isScoredAttempt);
  const untagged = tagged.filter((r) => !dataOf(r).device_id);
  const unverified = tagged.filter((r) => {
    const id = dataOf(r).device_id;
    return !!id && !boundIds.has(id);
  });

  /* ---------------- 设备级（只认已验证绑定 + 带设备号的完整交卷） -------- */
  const deviceList = binds.map((d) => {
    const hash = deviceHash(d);
    const mine = tagged.filter((r) => dataOf(r).device_id === hash);
    const todays = mine.filter((r) => shDate(r.created_at) === today);
    const last = mine.reduce((acc, r) => {
      const t = Date.parse(r.created_at);
      return Number.isFinite(t) && (!acc || t > acc) ? t : acc;
    }, 0);
    const revoked = !!(d.revoked_at || d.revoked);
    let status = 'NEVER_TAGGED_UPLOAD';
    if (revoked) status = 'REVOKED';
    else if (todays.length > 0) status = 'UPLOADED_TODAY';
    else if (last > 0) status = 'STALE';
    return {
      device_uid: hash,
      device_hash: hash,
      label: d.label || null,
      bound_by: d.bound_by || null,
      bound_at: d.bound_at || null,
      verified: true,
      revoked,
      last_upload_at: last > 0 ? new Date(last).toISOString() : null,
      today_uploads: todays.length,
      tagged_uploads: mine.length,
      status,
    };
  });

  /* ------ 待家长确认的设备哈希：服务端有就直接用，否则从记录里推导 ------ */
  let unboundList;
  if (Array.isArray(unboundDevices)) {
    unboundList = unboundDevices.map((u) => ({
      device_hash: u.device_hash || u.device_uid || '',
      uploads: Number(u.uploads || 0),
      last_upload_at: u.last_upload_at || null,
      status: u.status || 'DEVICE_PENDING',
    }));
  } else {
    const grouped = new Map();
    for (const r of unverified) {
      const hash = dataOf(r).device_id;
      const g = grouped.get(hash) || { device_hash: hash, uploads: 0, last_upload_at: null };
      g.uploads += 1;
      const t = Date.parse(r.created_at);
      if (Number.isFinite(t) && (!g.last_upload_at || t > Date.parse(g.last_upload_at))) {
        g.last_upload_at = r.created_at;
      }
      grouped.set(hash, g);
    }
    unboundList = [...grouped.values()].map((u) => ({ ...u, status: 'DEVICE_PENDING' }));
  }

  /* ---------------- 账号级：谁在往云端写 ------------------------------- */
  const byAccount = new Map();
  for (const r of rows) {
    const uid = r.created_by || '';
    if (!byAccount.has(uid)) byAccount.set(uid, []);
    byAccount.get(uid).push(r);
  }
  const accountList = [...byAccount.entries()].map(([uid, list]) => {
    const todays = list.filter((r) => shDate(r.created_at) === today);
    const last = list.reduce((acc, r) => {
      const t = Date.parse(r.created_at);
      return Number.isFinite(t) && (!acc || t > acc) ? t : acc;
    }, 0);
    return {
      user_id: uid,
      last_upload_at: last > 0 ? new Date(last).toISOString() : null,
      today_uploads: todays.length,
      status: todays.length > 0 ? 'UPLOADED_TODAY' : (last > 0 ? 'STALE' : 'NEVER_UPLOADED'),
    };
  }).sort((a, b) => b.today_uploads - a.today_uploads || String(a.user_id).localeCompare(String(b.user_id)));

  /* ----------- 今日计划逐科：today 看 created_at，累计看 learning_day ------- */
  const attributedToPlan = (r, subject) => (
    canonSubject(r.subject) === subject
    && (!plan || !Number.isInteger(Number(plan.day_index))
        || Number(r.learning_day) === Number(plan.day_index))
  );
  const subjectStatus = subjects.map((raw) => {
    const subject = canonSubject(raw) || String(raw);
    const todays = tagged.filter((r) => attributedToPlan(r, subject) && shDate(r.created_at) === today);
    const cumulative = tagged.filter((r) => attributedToPlan(r, subject));
    return {
      subject,
      today_scores: todays.length,
      cumulative_scores: cumulative.length,
      status: todays.length > 0 ? 'RECEIVED_TODAY' : 'MISSING_TODAY',
    };
  });

  const dayCumulative = Array.isArray(dayCumulativeSubjects)
    ? dayCumulativeSubjects.map((s) => ({
        subject: s.subject,
        learning_day: s.learning_day,
        cumulative_scores: Number(s.cumulative_scores || 0),
        status: s.status || (Number(s.cumulative_scores || 0) > 0 ? 'HAS_SCORES' : 'NO_SCORES'),
      }))
    : subjectStatus.map((s) => ({
        subject: s.subject,
        learning_day: plan ? Number(plan.day_index) : null,
        cumulative_scores: s.cumulative_scores,
        status: s.cumulative_scores > 0 ? 'HAS_SCORES' : 'NO_SCORES',
      }));

  const received = subjectStatus.filter((s) => s.status === 'RECEIVED_TODAY').length;
  let overall;
  if (!planKnown) overall = 'UNKNOWN_PLAN';
  else if (!published) overall = 'NO_PUBLISHED_PLAN_TODAY';
  else if (received === 0) overall = 'NOTHING_RECEIVED_TODAY';
  else if (received < subjectStatus.length) overall = 'PARTIAL_TODAY';
  else overall = 'RECEIVING_TODAY';

  return {
    today,
    plan: published ? { day_index: plan.day_index, subjects, published: true } : null,
    plan_known: !!planKnown,
    overall,
    subject_status: subjectStatus,
    day_cumulative_subjects: dayCumulative,
    devices: deviceList,
    unbound_devices: unboundList,
    accounts: accountList,
    untagged_attempts: untagged.length,
    unverified_device_attempts: unverified.length,
    local_flags_known: false,
    local_flags_note:
      '浏览器本地的「自动同步已开启」「同步基线」「登录会话」服务器读不到；'
      + '这里只反映云端实际收到的记录，没有记录即视为同步异常。',
  };
}

const SUBJECT_TAG = { RECEIVED_TODAY: '已收到', MISSING_TODAY: '今日未收到' };

/**
 * 给妈妈端直接显示的文字与级别。level: ok / warn / bad
 */
export function describeSync(health) {
  if (!health) return { level: 'warn', lines: ['同步状态未知。'] };

  const lines = [];
  let level = 'ok';

  if (health.overall === 'UNKNOWN_PLAN') {
    level = 'warn';
    lines.push('读不到今天的学习计划，暂时无法判断同步是否正常（不是孩子没学）。');
  } else if (health.overall === 'NO_PUBLISHED_PLAN_TODAY') {
    level = 'warn';
    lines.push('今天还没有已发布的学习计划，暂时无法判断同步是否正常。');
  } else if (health.overall === 'NOTHING_RECEIVED_TODAY') {
    level = 'bad';
    lines.push('今天一科成绩都没有收到 —— 同步异常，需要核实（不要让孩子重做）。');
  } else if (health.overall === 'PARTIAL_TODAY') {
    level = 'warn';
    const missing = health.subject_status.filter((s) => s.status === 'MISSING_TODAY')
      .map((s) => s.subject).join('、');
    lines.push(`今天只收到部分科目，未收到：${missing} —— 成绩待同步或需核实。`);
  } else {
    lines.push('今天计划内的科目都已从云端收到成绩。');
  }

  if (health.subject_status.length) {
    lines.push('今日逐科：' + health.subject_status
      .map((s) => `${s.subject} ${SUBJECT_TAG[s.status] || s.status}`).join(' · '));
  }

  const cumulative = Array.isArray(health.day_cumulative_subjects) ? health.day_cumulative_subjects : [];
  if (cumulative.length) {
    lines.push('当前学习日累计有效成绩：' + cumulative
      .map((s) => `${s.subject} ${s.cumulative_scores} 条${s.status === 'NO_SCORES' ? '（暂无）' : ''}`)
      .join(' · ') + '（含跨晚完成，不代表今天新收到）');
  }

  const verified = health.devices.filter((d) => d.verified && !d.revoked);
  if (!verified.length) {
    lines.push('没有可用的已验证设备绑定，设备归属一律显示「设备待识别」。');
  } else {
    const parts = verified.map((d) => {
      if (d.status === 'UPLOADED_TODAY') return `${d.label || '设备待识别'} 今天已上传 ${d.today_uploads} 次`;
      if (d.status === 'NEVER_TAGGED_UPLOAD') return `${d.label || '设备待识别'} 还没有带设备号的完整交卷`;
      return `${d.label || '设备待识别'} 最近上传 ${d.last_upload_at ? shDate(d.last_upload_at) : '未知'}`;
    });
    lines.push('设备：' + parts.join('；'));
  }

  if (health.untagged_attempts > 0) {
    lines.push(`另有 ${health.untagged_attempts} 条完整交卷没有携带设备号，只能归到上传账号，不能算到某台设备。`);
  }
  const unbound = Array.isArray(health.unbound_devices) ? health.unbound_devices : [];
  if (unbound.length > 0) {
    lines.push(`设备待识别：${unbound.map((u) => `${u.device_hash}（${u.uploads} 条成绩）`).join('、')} —— 请在下方输入设备名称完成家长确认。`);
  } else if (health.unverified_device_attempts > 0) {
    lines.push(`另有 ${health.unverified_device_attempts} 条完整交卷带的是未确认设备号，只能归到上传账号；设备待识别。`);
  }

  if (health.accounts.length) {
    lines.push('上传账号：' + health.accounts
      .map((a) => `${a.user_id || '未知账号'} 今天 ${a.today_uploads} 条`).join('；'));
  }

  lines.push(health.local_flags_note || '服务器无法确认设备本地同步开关。');
  return { level, lines };
}
