/* ============================================================================
 * v6/r5-bridge.js — V6 学习平台 → 腾讯云 R5 赛车闸门 的桥接器（C0.1 候选）
 *
 * C0.1.6 自动跨日候选（当前仅在隔离 PR 开发）：
 *   1. 不修改已有学习记录和按日归属；云端 authoritative_day 为唯一权威。
 *   2. 学习日 D 的两科达标后，仍停在 D；跨到上海时间下一自然日，
 *      首个已授权设备联网触发 r5_auto_rollover_day。
 *   3. 云端在家庭行锁事务中用真实 r5_day_passed 证据决定只推进 D+1
 *      一次，并同步发布当天两科计划；未达标则延续 D。
 *   4. 老设备、本机超前、云端回退、学科表不一致时仍保留原上传守卫。
 *   5. 若数据库尚未部署完整 C0.1 030 + 040，不猜日、不发布、
 *      不上传或伪造任何成绩；旧 r5_advance_day 客户端路径仍禁用。
 *
 * 兼容性：保留 r5_status / r5_publish_today / r5_claim_answers 原参数签名；
 * 仅新增 r5_auto_rollover_day{p_family_id}（需已授权家庭成员）。
 *
 * 判定仍然完全在云端：本文件不做阈值判断、不写历史成绩、不补题、不改课。
 * ==========================================================================*/
(function () {
  'use strict';

  var R5_FRAGMENT_QUEUE_KEY = 'v6-fragment-pending-v2';
  var r5RewardMod = null;
  var r5WeeklyMod = null;
  var r5FragmentsPromise = null;
  var R5_FRAGMENT_RECORD = /^(?:v6c-[A-Za-z0-9_-]{3,80}-complete-(?:语文|数学|英语|科学|cn|ma|en|sc)-d(?:[1-9]|[1-5][0-9]|60)(?:-[0-9]{6,20})?|v6-[a-f0-9]{16}-course-(?:[1-9]|[12][0-9]|30)-(?:cn|ma|en|sc))$/;
  function r5LoadFragmentModules() {
    if (!r5FragmentsPromise) {
      r5FragmentsPromise = Promise.all([
        import('./r5/reward-hook.mjs').catch(function () { return null; }),
        import('./r5/weekly-goal.mjs').catch(function () { return null; }),
      ]).then(function (mods) {
        r5RewardMod = mods[0] || null;
        r5WeeklyMod = mods[1] || null;
        if (r5RewardMod && r5RewardMod.bootstrap) r5RewardMod.bootstrap();
        if (r5WeeklyMod && r5WeeklyMod.bootstrap) r5WeeklyMod.bootstrap();
        return r5RewardMod;
      });
    }
    return r5FragmentsPromise;
  }
  function r5SpoolFragmentRecord(recordId) {
    var id = String(recordId || '');
    if (!R5_FRAGMENT_RECORD.test(id)) return false;
    try {
      var seen = JSON.parse(localStorage.getItem('v6-fragment-claim-seen-v2') || '[]');
      if (!Array.isArray(seen) || seen.indexOf(id) >= 0) return false;
      var q = JSON.parse(localStorage.getItem(R5_FRAGMENT_QUEUE_KEY) || '[]');
      if (!Array.isArray(q)) q = [];
      if (q.indexOf(id) >= 0) return false;
      q.push(id);
      localStorage.setItem(R5_FRAGMENT_QUEUE_KEY, JSON.stringify(q.slice(-160)));
      return true;
    } catch (e) { return false; }
  }
  function r5KickFragmentRewards() {
    return r5LoadFragmentModules().then(function (m) {
      return m && m.resumeRewardQueue ? m.resumeRewardQueue() : { status: 'MODULE_UNAVAILABLE' };
    }).catch(function () { return { status: 'MODULE_UNAVAILABLE' }; });
  }

  var diagnostic = document.currentScript && document.currentScript.hasAttribute('data-parent-check');
  var BRIDGE_BUILD = '2026-11-27.rc8-cross-midnight-backfill-v1';

  var CFG = {
    familyId: 'little-growth-family-001',
    env: 'normal-goose-d5g4qyzr8bb389a4a',
    region: 'ap-shanghai',
    restBase: 'https://normal-goose-d5g4qyzr8bb389a4a.api.tcloudbasegateway.com/v1/rdb/rest',
    /* 已上线的 R5 网关：按 x-r5-device 设备令牌鉴权，只读入口 /v1/child/entry。
     * 与赛车页共用同一套设备绑定，不新增任何服务端接口。 */
    gatewayBase: 'https://normal-goose-d5g4qyzr8bb389a4a.service.tcloudbase.com/r5',
    deviceTokenKey: 'r5_device',
    devicePendingKey: 'r5_device_pending',
    cloudCacheKey: 'v6-r5-cloud-day-cache',
    stateKey: 'growth-workbench-v6-adaptive-2',
    deviceKey: 'v6-family-sync-device-id',
    statusKey: 'v6-r5-bridge-status',
    offKey: 'v6-r5-bridge-off',
    courseKey: {
      ma: 'v6_math_course_20261109_progress_v1',
      sc: 'v6_science_course_20261109_progress_v1',
      en: 'v6_english_course_20261109_progress_v1',
    },
    sdk: [
      'https://static.cloudbase.net/cloudbase-js-sdk/latest/cloudbase.full.js',
      'https://static.cloudbase.net/cloudbase-js-sdk/3.0.1/cloudbase.full.js',
      'https://imgcache.qq.com/qcloud/cloudbase-js-sdk/latest/cloudbase.full.js',
    ],
    subjectName: { cn: '语文', ma: '数学', en: '英语', sc: '科学' },
    subjectKey: { 语文: 'cn', 数学: 'ma', 英语: 'en', 科学: 'sc' },
    maxDay: 30,
  };

  var running = false;
  var lastRun = 0;

  /* ---------------------------------------------------------------- 基础工具 */

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[r5-v6]');
      console.info.apply(console, args);
    } catch (e) { /* ignore */ }
  }

  function saveStatus(patch) {
    try {
      var prev = {};
      try { prev = JSON.parse(localStorage.getItem(CFG.statusKey) || '{}') || {}; } catch (e) { prev = {}; }
      var next = Object.assign({}, prev, patch || {}, { at: new Date().toISOString() });
      localStorage.setItem(CFG.statusKey, JSON.stringify(next));
      return next;
    } catch (e) { return null; }
  }

  function readStatus() {
    try { return JSON.parse(localStorage.getItem(CFG.statusKey) || 'null'); } catch (e) { return null; }
  }

  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function today() { return ymd(new Date()); }

  /* 课件进度里的 at 是 UTC ISO 串；东八区 00:00-08:00 直接 slice(0,10) 会取到昨天。
   * 这里统一按本地时区取日期，纯 YYYY-MM-DD 原样返回。 */
  function ymdOf(v) {
    if (v == null || v === '') return '';
    var s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var d = new Date(s);
    if (isNaN(d.getTime())) return s.slice(0, 10);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }

  function readJson(key) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || 'null');
      return v && typeof v === 'object' ? v : null;
    } catch (e) { return null; }
  }

  function sha16() {
    var bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }

  function deviceId() {
    try {
      var v = localStorage.getItem(CFG.deviceKey);
      if (v && /^[a-f0-9]{16}$/.test(v)) return v;
      var fresh = sha16();
      localStorage.setItem(CFG.deviceKey, fresh);
      return fresh;
    } catch (e) {
      return 'anon000000000000';
    }
  }

  function readState() {
    try {
      var s = JSON.parse(localStorage.getItem(CFG.stateKey) || 'null');
      return s && Array.isArray(s.records) ? s : null;
    } catch (e) { return null; }
  }

  function readLiveState() {
    try {
      if (typeof state === 'object' && state && Array.isArray(state.records)) return state;
    } catch (e) { /* fall through */ }
    return readState();
  }

  /** 稳定短哈希：同一道题每天得到同一个 id，与数组顺序无关 */
  function hash8(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /* ------------------------------------------------------------ 课程日与学科 */

  /* 家长/桥接确认过的「云端对齐日」。与 index.html 的 v6AlignedDay() 同一条规则：
   * 只存在 state.v6Course.cloudAlignedDay，只抬高本机课次，不改任何历史记录。 */
  function alignedDayOf(s) {
    var a = Number(s && s.v6Course && s.v6Course.cloudAlignedDay);
    return Number.isInteger(a) && a >= 1 && a <= CFG.maxDay ? a : 0;
  }

  /* 本机课次。必须与首页 v6CourseDay() 完全同口径，否则会出现
   * 「首页第 6 日、同步诊断第 3 日」这种自相矛盾的读数：
   *   自然课次 = 第一个还没标记完成的学习日
   *   对齐课次 = cloudAlignedDay
   *   取两者较大者。 */
  function naturalCourseDay(s) {
    var done = (s && s.v6Course && s.v6Course.completedDays) || {};
    for (var d = 1; d <= CFG.maxDay; d++) if (!done[d]) return d;
    return CFG.maxDay;
  }

  function courseDay() {
    try {
      if (typeof v6CourseDay === 'function') return Number(v6CourseDay()) || 1;
    } catch (e) { /* fall through */ }
    var s = readState();
    var natural = naturalCourseDay(s);
    var aligned = alignedDayOf(s);
    return aligned > natural ? aligned : natural;
  }

  /* 云端刚跨日时让本机跟上。
   * 只写对齐标记：不清空记录、不改历史学习日、不动云端。
   *   opts.allowGap=true（设备身份只读核对时）：只要云端更靠前就跟上。
   *   否则维持旧规则——只在「恰好落后一天」时自动跟随（家长会话路径），
   *   落后更多留给家长一键对齐，避免孩子跳过课程。
   * 任何情况下都只抬高、不降低，也绝不修改 completedDays / records。 */
  function followCloudDay(cloudDay, localDay, opts) {
    if (!Number.isInteger(cloudDay) || !Number.isInteger(localDay)) return null;
    if (cloudDay < 1 || cloudDay > CFG.maxDay) return null;
    var allowGap = !!(opts && opts.allowGap);
    if (allowGap) {
      if (cloudDay <= localDay) return null;
    } else if (cloudDay !== localDay + 1) {
      return null;
    }
    var live = readLiveState();
    if (!live || typeof live !== 'object') return null;
    if (!live.v6Course || typeof live.v6Course !== 'object') live.v6Course = {};
    var prev = Number(live.v6Course.cloudAlignedDay) || 0;
    if (prev >= cloudDay) return null;
    live.v6Course.cloudAlignedDay = cloudDay;
    live.v6Course.cloudAlignedAt = new Date().toISOString();
    live.v6Course.cloudAlignedSource = (opts && opts.source) || 'cloud_authoritative';
    if (typeof save === 'function') { try { save(); } catch (e) { /* ignore */ } }
    try { localStorage.setItem(CFG.stateKey, JSON.stringify(live)); } catch (e) { /* ignore */ }
    log('本机课次跟随云端跨日', localDay, '→', cloudDay, allowGap ? '(设备身份)' : '(家长会话)');
    /* 首页与课程页需要立刻按新学习日重绘；历史记录原样保留。 */
    try {
      if (typeof window.v6OnCloudDayChanged === 'function') window.v6OnCloudDayChanged(cloudDay);
    } catch (e) { /* 页面没有钩子时忽略 */ }
    return { from: localDay, to: cloudDay };
  }

  function subjectDays() {
    try {
      if (typeof V6_SUBJECT_DAYS !== 'undefined' && Array.isArray(V6_SUBJECT_DAYS)) return V6_SUBJECT_DAYS;
    } catch (e) { /* ignore */ }
    return null;
  }

  function subjectsFor(day) {
    var table = subjectDays();
    if (table && table[day - 1]) return table[day - 1].slice();
    try {
      var nov = window.V6_NOV_SCHEDULE && window.V6_NOV_SCHEDULE.days;
      if (Array.isArray(nov)) {
        var hit = nov.filter(function (x) { return x.day === day; })[0];
        if (hit && Array.isArray(hit.subjects)) return hit.subjects.slice();
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  /**
   * 课次 → 学习日。
   * V6 规则：某科目的第 N 课，排在该科目出现的第 N 个学习日。
   * 用 V6_SUBJECT_DAYS 推导，不另存一份日期表（避免两边不同步）。
   */
  function dayForLesson(subjectName, lesson) {
    var table = subjectDays();
    if (!table) return 0;
    var n = 0;
    for (var d = 1; d <= table.length; d++) {
      if ((table[d - 1] || []).indexOf(subjectName) >= 0) {
        n++;
        if (n === lesson) return d;
      }
    }
    return 0;
  }

  /* ------------------------------------------------------- 权威学习日读取 */

  /**
   * 从 r5_status 读出「今天用哪一天」。
   *   plan_day          今天已发布计划的课次（云端今天真正在上的那一天）
   *   authoritative_day 下一次允许发布的课次（完成当天后 +1，可能比 plan_day 大 1）
   *   today             本机今天应该对齐的课次 = plan_day ?? authoritative_day
   * 老云端两个字段都可能缺失，此时 today 为 null，调用方退回旧逻辑。
   */
  function readDayState(st) {
    var planDay = null, authDay = null;
    if (st && typeof st === 'object') {
      if (st.study_day !== null && st.study_day !== undefined && st.study_day !== ''
          && isFinite(Number(st.study_day))) planDay = Number(st.study_day);
      if (st.authoritative_day !== null && st.authoritative_day !== undefined
          && st.authoritative_day !== '' && isFinite(Number(st.authoritative_day))) {
        authDay = Number(st.authoritative_day);
      } else if (planDay !== null) {
        authDay = planDay; // 老云端：没有独立进度，studying_day 就是权威日
      }
    }
    var todayDay = planDay !== null ? planDay : authDay;
    return {
      plan_day: planDay,
      authoritative_day: authDay,
      today: todayDay,
      published: !!(st && st.schedule_published === true),
      advanced: (planDay !== null && authDay !== null && authDay > planDay),
      source: (st && st.authoritative_day !== undefined) ? 'cloud_authoritative' : 'cloud_study_day',
    };
  }

  /** 今日「完成了但成绩还没同步」的科目；用于家长可见状态，不影响放行。 */
  function pendingScoreSyncOf(st) {
    var mods = (st && Array.isArray(st.modules)) ? st.modules : [];
    return mods.filter(function (m) {
      return m && (m.pending_score_sync === true
        || m.evidence === 'COMPLETED_UNSCORED'
        || m.credential_status === 'PENDING_SCORE_SYNC');
    }).map(function (m) {
      return { subject: m.subject, completed: m.completed === true, total: Number(m.total) || 0 };
    });
  }

  /** 今日「历史归属待核实」的科目；只上报，不放行。 */
  function pendingVerifyOf(st) {
    var mods = (st && Array.isArray(st.modules)) ? st.modules : [];
    return mods.filter(function (m) {
      return m && (m.pending_verification === true || m.credential_status === 'PENDING_VERIFICATION');
    }).map(function (m) {
      return { subject: m.subject, reasons: m.pending_reasons || [] };
    });
  }

  /* ------------------------------------------------------------------ 身份 */

  function loadSdk(i) {
    return new Promise(function (resolve, reject) {
      if (window.cloudbase && typeof window.cloudbase.init === 'function') return resolve();
      if (i >= CFG.sdk.length) return reject(new Error('CloudBase SDK 加载失败'));
      var s = document.createElement('script');
      s.src = CFG.sdk[i];
      s.async = true;
      s.onload = function () {
        if (window.cloudbase && typeof window.cloudbase.init === 'function') resolve();
        else loadSdk(i + 1).then(resolve, reject);
      };
      s.onerror = function () { loadSdk(i + 1).then(resolve, reject); };
      document.head.appendChild(s);
    });
  }

  var app = null;
  async function connect() {
    if (app) return app;
    await loadSdk(0);
    app = window.cloudbase.init({ env: CFG.env, region: CFG.region });
    return app;
  }

  async function identity() {
    await connect();
    var auth = app.auth;
    if (!auth) throw new Error('SDK 没有 auth');
    var res;
    try { res = await auth.getSession(); } catch (e) { throw new Error('NO_SESSION'); }
    if (res && res.error) throw new Error('NO_SESSION');
    var session = res && res.data && res.data.session;
    if (!session || !session.user || !session.user.id) throw new Error('NO_SESSION');
    var tok = await auth.getAccessToken();
    var token = (tok && (tok.accessToken || tok.access_token)) || (session.access_token || '');
    if (!token) throw new Error('NO_TOKEN');
    return { uid: String(session.user.id), token: token };
  }

  /* ------------------------------------------------ 设备身份只读学习日 */

  /* 本机一次性授权：家长输入口令后，生成设备令牌并绑定到本家庭。
   * 复用赛车页同一个网关接口 /v1/parent/bind，不新增服务端能力。
   * 口令只在本次请求头里出现，绝不写入 localStorage / 状态 / 日志。 */
  /**
   * 一次性授权这台设备。
   * 凭据是「家长自己的账号 + 自己的密码」（妈妈 / 爸爸 / 外婆），
   * 由网关转发给 CloudBase Auth 校验；本机不保存、不缓存、不写日志。
   * 不再有任何共享「家长口令」。
   */
  async function bindThisDevice(account, password, label) {
    var acc = String(account || '').trim().toLowerCase();
    var pw = String(password || '');
    if (!acc) throw gatewayError('R5_PARENT_CREDENTIALS_REQUIRED', 0);
    if (!pw) throw gatewayError('R5_PARENT_CREDENTIALS_REQUIRED', 0);
    /* 复用上次未确认的候选令牌：网络中断后重试不会在云端留下孤儿设备。
     * 与赛车绑定页共用同一个 pending 键。 */
    var token = '';
    try { token = localStorage.getItem(CFG.devicePendingKey) || ''; } catch (e) { token = ''; }
    if (!/^r5dev_[a-f0-9]{32}$/.test(token)) {
      var bytes = new Uint8Array(16);
      if (!window.crypto || !window.crypto.getRandomValues) throw gatewayError('R5_NO_CRYPTO', 0);
      window.crypto.getRandomValues(bytes);
      token = 'r5dev_' + Array.prototype.map.call(bytes, function (x) {
        return ('0' + x.toString(16)).slice(-2);
      }).join('');
      try { localStorage.setItem(CFG.devicePendingKey, token); } catch (e) { /* ignore */ }
    }

    var res, text;
    try {
      res = await fetch(CFG.gatewayBase + '/v1/parent/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-r5-device': token },
        body: JSON.stringify({
          family_id: CFG.familyId, device: token,
          account: acc, password: pw,
          label: String(label || '孩子的学习设备'),
        }),
      });
      text = await res.text();
    } catch (e) {
      /* 结果未知：保留 pending 令牌，下次重试沿用同一个设备，避免孤儿记录。 */
      throw gatewayError('R5_NETWORK', 0);
    }
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        try { localStorage.removeItem(CFG.devicePendingKey); } catch (e2) { /* ignore */ }
      }
      throw gatewayError((json && (json.error || json.code)) || ('HTTP_' + res.status), res.status);
    }
    if (!json || (json.ok !== true && !json.device_uid)) {
      throw gatewayError((json && (json.error || json.code)) || 'R5_BIND_REJECTED', res.status);
    }
    try {
      localStorage.setItem(CFG.deviceTokenKey, token);
      localStorage.removeItem(CFG.devicePendingKey);
    } catch (e) { throw gatewayError('R5_STORAGE_DENIED', 0); }
    /* 立刻用同一令牌读一次，确认真的可用（读不到就回滚本地令牌，避免假授权）。 */
    try {
      var read = await gatewayReadDay();
      return { bound: true, token_tail: token.slice(-6), day: read.today, subjects: read.subjects };
    } catch (e2) {
      try {
        localStorage.removeItem(CFG.deviceTokenKey);
        localStorage.setItem(CFG.devicePendingKey, token);   // 保留候选，重试不产生新设备
      } catch (e3) { /* ignore */ }
      throw gatewayError(e2 && (e2.code || e2.message) || 'R5_BIND_UNVERIFIED', 0);
    }
  }

  /* 与赛车页共用同一份设备令牌（同源 localStorage）。只读，不新建绑定。 */
  function deviceToken() {
    try {
      var t = localStorage.getItem(CFG.deviceTokenKey);
      return t && /^[A-Za-z0-9_-]{8,80}$/.test(t) ? t : '';
    } catch (e) { return ''; }
  }

  function gatewayError(code, status) {
    var e = new Error(code || 'R5_GATEWAY_ERROR');
    e.code = code || 'R5_GATEWAY_ERROR';
    e.status = status || 0;
    return e;
  }

  /**
   * 用设备身份向 R5 网关只读查询当前学习日。
   * 不需要家长会话；未绑定 / 已撤销 / 跨家庭由网关侧的设备校验直接拒绝。
   * 只读取学习日与课程，不写任何学习记录、不改云端学习日。
   */
  async function gatewayReadDay() {
    var token = deviceToken();
    if (!token) throw gatewayError('R5_DEVICE_REQUIRED', 0);
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, 12000) : null;
    var res, text;
    try {
      res = await fetch(CFG.gatewayBase + '/v1/child/entry', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-r5-device': token },
        body: JSON.stringify({ family_id: CFG.familyId }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      text = await res.text();
    } catch (e) {
      var aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
      throw gatewayError(aborted ? 'R5_TIMEOUT' : 'R5_NETWORK', 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!json) throw gatewayError('R5_BAD_RESPONSE', res.status);
    /* 网关在部分拒绝场景下仍返回 HTTP 200 + error 字段，必须先看 error。 */
    if (json.error) throw gatewayError(String(json.error), res.status);
    if (!res.ok) throw gatewayError('HTTP_' + res.status, res.status);
    if (json.allowed === undefined && json.authoritative_day === undefined) {
      throw gatewayError('R5_BAD_RESPONSE', res.status);
    }
    var ds = readDayState(json);
    return {
      ok: true,
      source: 'device',
      authoritative_day: ds.authoritative_day,
      plan_day: ds.plan_day,
      today: ds.today,
      published: ds.published,
      advanced: ds.advanced,
      study_passed: typeof json.study_passed === 'boolean' ? json.study_passed : null,
      allowed: typeof json.allowed === 'boolean' ? json.allowed : null,
      reason: json.reason || null,
      subjects: (json.modules || []).map(function (m) { return m.subject; }),
      modules: json.modules || [],
      remaining_seconds: json.remaining_seconds == null ? null : Number(json.remaining_seconds),
      fetched_at: new Date().toISOString(),
      raw: json,
    };
  }

  /* 通用网关调用：只带设备令牌，不携带任何家长凭据。 */
  async function gatewayCall(pathname, payload) {
    var token = deviceToken();
    if (!token) throw gatewayError('R5_DEVICE_REQUIRED', 0);
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, 15000) : null;
    var res, text;
    try {
      res = await fetch(CFG.gatewayBase + pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-r5-device': token },
        body: JSON.stringify(Object.assign({ family_id: CFG.familyId }, payload || {})),
        signal: ctrl ? ctrl.signal : undefined,
      });
      text = await res.text();
    } catch (e) {
      var aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
      throw gatewayError(aborted ? 'R5_TIMEOUT' : 'R5_NETWORK', 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!json) throw gatewayError('R5_BAD_RESPONSE', res.status);
    if (json.error) throw gatewayError(String(json.error), res.status);
    if (!res.ok) throw gatewayError('HTTP_' + res.status, res.status);
    return json;
  }

  /* 答题时刻 -> 上海日期。服务端校验 (at AT TIME ZONE 'Asia/Shanghai')::date = date，
     浏览器在别的时区时也不能用本机时区去切片，否则会被 R5_ATTEMPT_DATE_MISMATCH 拒绝。 */
  function ymdSH(v) {
    var d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return ymdOf(v);
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
    } catch (e) {
      return ymdOf(v);
    }
  }

  /* 本机整轮 -> 网关 /v1/child/round-upload 的 rounds[]。
     只带 attempt_id、科目、学习日、答题时刻与逐题对错；
     correct / total / 是否学完一律由服务端按这轮逐题证据自己算，本机不交任何结论。 */
  function roundPayload(rounds) {
    var token = deviceToken();
    if (!token) return [];
    var out = [];
    (rounds || []).forEach(function (rd) {
      if (!rd || !rd.attempt_id || !rd.answers || !rd.answers.length) return;
      var at = (rd.attempt && rd.attempt.record_data && rd.attempt.record_data.at) || new Date().toISOString();
      var answers = rd.answers.map(function (a, i) {
        var d = (a && a.record_data && a.record_data.answer) || {};
        return { index: i, correct: d.correct === true };
      });
      /* rd.subject 在桥接器里可能是「语文」也可能已经是代码「cn」（两处历史来源不同），
         网关要的是中文名；这里统一归一化，否则服务端 r5_round_subject_code() 认不出，
         会以 R5_INVALID_SUBJECT 整批拒绝。 */
      var code = rd.code || (CFG.subjectKey[rd.subject] ? rd.subject : '');
      var name = CFG.subjectName[code] || CFG.subjectName[rd.subject]
        || (CFG.subjectKey[rd.subject] ? rd.subject : '');
      if (!name) { out.__badSubject = (out.__badSubject || []).concat([String(rd.subject) + '/' + String(rd.code)]); return; }
      out.push({
        attempt_id: String(rd.attempt_id),
        subject: String(name),
        day: Number(rd.day),
        date: ymdSH(at),
        at: String(at),
        device_id: token,
        answers: answers,
      });
    });
    return out;
  }

  /* 只有网关明确回 ok 的轮次才能把本机状态改成「云端已确认」。
     回填失败不能影响上传本身；宁可继续显示「等待确认」，也不误报。 */
  function apiForSubject(subject) {
    return String(subject) === '语文' ? window.V6ChineseAttempt : window.V6CourseAttempt;
  }

  function markAttemptCloud(attemptId, state, detail) {
    var api = apiForSubject(detail && detail.subject);
    if (!api || typeof api.markCloud !== 'function') return false;
    try { return api.markCloud(attemptId, state, detail); } catch (e) { return false; }
  }

  /**
   * 只有「服务端整轮核验明确 ok」的轮次才能把本机状态改成「云端已确认」。
   * 三重条件缺一不可：
   *   1) 整批响应顶层 ok === true（网关只有在数据库 r5_round_verify_v5 全部通过时才会这样返回）；
   *   2) 返回项带 attempt_id，且必须是本次上传的某个 attempt_id（不按数组序号猜）；
   *   3) 服务端重算的 correct / total 与本机这一轮的逐题证据完全一致。
   * 任何一项不满足都保持「等待云端确认」，绝不用本机保存或模拟响应冒充成功。
   */
  function markCourseAttemptsCloud(payload, verified, rounds) {
    if (!Array.isArray(payload) || !Array.isArray(verified)) return 0;
    var sent = {};
    payload.forEach(function (p) {
      if (p && p.attempt_id) sent[String(p.attempt_id)] = true;
    });
    var roundByAid = {};
    (rounds || []).forEach(function (rd) {
      if (rd && rd.attempt_id) roundByAid[String(rd.attempt_id)] = rd;
    });
    var marked = 0;
    verified.forEach(function (v) {
      if (!v || v.ok !== true) return;
      var aid = String(v.attempt_id || v.attemptId || '');
      if (!aid || !sent[aid]) return;
      var rd = roundByAid[aid];
      if (!rd) return;
      if (Number(v.correct) !== Number(rd.correct) || Number(v.total) !== Number(rd.total)) return;
      var subject = String(rd.subject || v.subject || '');
      if (!subject) return;
      if (markAttemptCloud(aid, 'cloud_confirmed', {
        subject: subject, source: 'device-round-upload', day: Number(rd.day) || Number(v.day) || null,
        correct: Number(v.correct), total: Number(v.total)
      })) marked++;
    });
    return marked;
  }

  /* 同一台设备已经确认过的「学习日|学科」成绩，只接受严格提高的后续轮次。
     这是设备侧去重；跨设备仍由服务端 R5_SAFE_ROUND_V4 与家长会话策略把关。 */
  function confirmedBestFromLedger() {
    var best = {};
    var keys = ['v6-chinese-attempt-status-v1', 'v6-course-attempt-status-v1'];
    keys.forEach(function (key) {
      try {
        var data = JSON.parse(localStorage.getItem(key) || '{}') || {};
        Object.keys(data).forEach(function (id) {
          var s = data[id];
          if (!s || s.state !== 'cloud_confirmed' || !s.detail) return;
          var day = Number(s.detail.day);
          var subject = String(s.detail.subject || (key.indexOf('chinese') >= 0 ? '语文' : ''));
          if (!CFG.subjectName[subject] && subject !== '语文' && subject !== '数学' && subject !== '英语' && subject !== '科学') return;
          var c = Number(s.detail.correct), t = Number(s.detail.total);
          if (!Number.isInteger(day) || !Number.isInteger(c) || !Number.isInteger(t) || t < 5) return;
          var k = day + '|' + subject;
          var prev = best[k];
          if (!prev || c * prev.total > prev.correct * t) best[k] = { correct: c, total: t };
        });
      } catch (e) { /* 读不到确认台账就只依赖服务端规则，不臆造成绩 */ }
    });
    return best;
  }

  function filterImprovedRounds(rounds) {
    if (!Array.isArray(rounds) || !rounds.length) return { send: rounds, skipped: [] };
    var best = confirmedBestFromLedger();
    var send = [], skipped = [];
    rounds.forEach(function (rd) {
      if (!rd || !rd.subject) { send.push(rd); return; }
      var key = Number(rd.day) + '|' + String(rd.subject);
      var prev = best[key];
      if (prev && Number(rd.correct) * prev.total <= prev.correct * Number(rd.total)) {
        skipped.push(rd);
        return;
      }
      send.push(rd);
      best[key] = { correct: Number(rd.correct), total: Number(rd.total) };
    });
    return { send: send, skipped: skipped };
  }

  function markSkippedRounds(rounds) {
    (rounds || []).forEach(function (rd) {
      if (!rd || !rd.attempt_id) return;
      markAttemptCloud(rd.attempt_id, 'skipped_not_higher', {
        subject: String(rd.subject || '语文'), source: 'device-local-best', day: Number(rd.day) || null,
        correct: Number(rd.correct), total: Number(rd.total)
      });
    });
  }

  /**
   * 设备身份上传：家长会话过期也能把成绩送到云端。
   * 只传答题记录；「学完」由服务端按真实答题派生，客户端不能直接断言。
   *
   * rc8：除了「今天」的一轮，还会把本机已完整保存、尚未确认的往日轮次
   * 按原日期 / 原学习日补传。补传单独成批，任何一轮失败都不影响今天。
   */
  async function deviceUpload(day) {
    var state = readState();
    if (!state) return null;
    var todayStr = today();
    var todaySh = ymdSH(new Date());
    var rounds = collectRounds(state, day, todayStr);
    var improved = filterImprovedRounds(rounds);
    var uploadRounds = improved.send;

    /* 往日待补传：只取未确认的完整轮次，去掉与今天通道重复的 attempt_id。 */
    var backfillAll = pendingHistoryRounds(todayStr, todaySh);
    var seenAid = {};
    uploadRounds.forEach(function (rd) { if (rd && rd.attempt_id) seenAid[String(rd.attempt_id)] = true; });
    var backfillOnly = backfillAll.filter(function (rd) {
      return rd && rd.attempt_id && !seenAid[String(rd.attempt_id)];
    });
    var backfillImproved = filterImprovedRounds(backfillOnly);
    var backfillRounds = backfillImproved.send;

    var out = {
      day: day, channel: 'round-v2',
      rounds: uploadRounds.length, skipped_not_higher: improved.skipped.length,
      backfill_candidates: backfillOnly.length,
      backfill_rounds: backfillRounds.length,
      backfill_skipped_not_higher: backfillImproved.skipped.length,
      backfill_uploaded: 0,
      uploaded: 0,
      verified: [], rejected: [], errors: [], after: null, after_error: null,
    };
    markSkippedRounds(improved.skipped);
    markSkippedRounds(backfillImproved.skipped);

    /* 诊断：把这一轮到底准备交什么留下来（只读，不上传任何额外内容） */
    try {
      window.__r5LastUpload = {
        at: new Date().toISOString(), day: day, todayStr: todayStr, todaySh: todaySh,
        rounds: uploadRounds.map(function (r) { return { subject: r.subject, code: r.code, total: r.total, answers: (r.answers || []).length }; }),
        backfill: backfillRounds.map(function (r) { return { subject: r.subject, code: r.code, day: r.day, total: r.total, answers: (r.answers || []).length, attempt_id: r.attempt_id }; }),
      };
    } catch (e) { /* ignore */ }

    /* ---- 1) 今天：沿用原有单批上传；失败不阻断补传 ---- */
    if (uploadRounds.length) {
      var payload = roundPayload(uploadRounds);
      if (payload.length) {
        try {
          var r = await gatewayCall('/v1/child/round-upload', { rounds: payload });
          var rows = (r && r.ok === true && Array.isArray(r.rounds)) ? r.rounds : [];
          if (!rows.length) {
            out.errors.push('rounds:R5_UNVERIFIED_RESPONSE');
          } else {
            rows.forEach(function (v) {
              if (v && v.ok === true) out.verified.push(v);
              else out.rejected.push(v);
            });
            out.uploaded += rows.filter(function (v) { return v && v.ok === true; }).length;
            markCourseAttemptsCloud(payload, rows, uploadRounds);
          }
        } catch (e) {
          out.errors.push('rounds:' + (e.code || e.message));
        }
      }
    }

    /* ---- 2) 往日补传：独立批次，原日期原学习日；不触发完成态/奖励 ---- */
    if (backfillRounds.length) {
      var bpayload = roundPayload(backfillRounds);
      if (bpayload.length) {
        var batchOk = false;
        try {
          var br = await gatewayCall('/v1/child/round-upload', { rounds: bpayload });
          var brows = (br && br.ok === true && Array.isArray(br.rounds)) ? br.rounds : [];
          if (brows.length) {
            batchOk = true;
            applyBackfillResult(out, bpayload, brows, backfillRounds);
          } else {
            out.errors.push('backfill:R5_UNVERIFIED_RESPONSE');
          }
        } catch (batchErr) {
          /* 服务端整批回滚时（例如某天计划已变），逐轮重试，坏轮不拖累好轮。 */
          log('往日补传整批失败，改为逐轮重试',
            String(batchErr && (batchErr.code || batchErr.message) || 'UNKNOWN'));
        }
        if (!batchOk) {
          for (var bi = 0; bi < backfillRounds.length; bi++) {
            var one = [backfillRounds[bi]];
            var p1 = roundPayload(one);
            if (!p1.length) continue;
            try {
              var r1 = await gatewayCall('/v1/child/round-upload', { rounds: p1 });
              var rows1 = (r1 && r1.ok === true && Array.isArray(r1.rounds)) ? r1.rounds : [];
              if (rows1.length) applyBackfillResult(out, p1, rows1, one);
              else out.errors.push('backfill:' + one[0].attempt_id + ':R5_UNVERIFIED_RESPONSE');
            } catch (oneErr) {
              out.errors.push('backfill:' + one[0].attempt_id + ':'
                + String(oneErr && (oneErr.code || oneErr.message) || 'UNKNOWN'));
            }
          }
        }
      }
    }

    if (!out.uploaded && !out.backfill_uploaded && !out.errors.length && !out.rejected.length) return out;

    /* 上传后立刻用同一台设备回读闸门：只读，不推送学习日，也不改写任何成绩。
       读到的 study_passed / allowed 就是赛车页看到的那一份（同一个 r5_child_entry）。 */
    try { out.after = await gatewayReadDay(); }
    catch (e2) { out.after_error = String(e2 && (e2.code || e2.message) || 'UNKNOWN'); }
    return out;
  }

  /** 往日补传的结果只按服务端逐轮核验回写状态；不写完成态、不发奖励。 */
  function applyBackfillResult(out, payload, rows, rounds) {
    rows.forEach(function (v) {
      if (v && v.ok === true) out.verified.push(v);
      else out.rejected.push(v);
    });
    var okCount = rows.filter(function (v) { return v && v.ok === true; }).length;
    out.backfill_uploaded += okCount;
    out.uploaded += okCount;
    markCourseAttemptsCloud(payload, rows, rounds);
  }


  /* 最近一次云端读取结果（带核对时间），用于「实时失败时不冒充当前状态」。 */
  function saveCloudCache(data) {
    try {
      localStorage.setItem(CFG.cloudCacheKey, JSON.stringify({
        authoritative_day: data.authoritative_day,
        plan_day: data.plan_day,
        today: data.today,
        published: data.published === true,
        subjects: data.subjects || [],
        study_passed: typeof data.study_passed === 'boolean' ? data.study_passed : null,
        allowed: typeof data.allowed === 'boolean' ? data.allowed : null,
        reason: data.reason || null,
        source: data.source || 'unknown',
        fetched_at: data.fetched_at || new Date().toISOString(),
      }));
    } catch (e) { /* 缓存失败不影响主流程 */ }
  }

  function readCloudCache() {
    var c = readJson(CFG.cloudCacheKey);
    if (!c || !Number.isInteger(Number(c.authoritative_day))) return null;
    c.authoritative_day = Number(c.authoritative_day);
    c.plan_day = c.plan_day == null ? null : Number(c.plan_day);
    c.today = c.today == null ? null : Number(c.today);
    c.age_ms = Date.now() - new Date(c.fetched_at).getTime();
    c.stale = !(c.age_ms >= 0 && c.age_ms < 12 * 3600 * 1000);
    return c;
  }


  /* -------------------------------------------------------------- 云端调用 */

  async function rpc(name, params, who) {
    var res = await fetch(CFG.restBase + '/rpc/' + encodeURIComponent(name), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + who.token,
        prefer: 'return=representation',
      },
      body: JSON.stringify(params || {}),
    });
    var text = await res.text();
    var json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!res.ok) {
      var code = (json && (json.message || json.code)) || ('HTTP_' + res.status);
      var err = new Error(code);
      err.code = String(code).replace(/^DATABASE_/, '');
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /* The last authenticated, published course day is a display checkpoint, not
   * a course-completion record or permission to upload. It must survive bridge
   * status changes such as "running" and short-lived RPC failures. */
  function rememberPublishedDay(st) {
    try {
      var ds = readDayState(st);
      var day = ds.plan_day;
      if (!ds.published || !Number.isInteger(day) || day < 1 || day > CFG.maxDay
          || (ds.authoritative_day !== null && ds.authoritative_day < day)) return;
      var key = 'v6-r5-confirmed-course-day';
      var old = readJson(key);
      if (old && old.family_id === CFG.familyId
          && Number.isInteger(old.day) && old.day > day) {
        // A lower server day requires investigation, not a silent UI regression.
        return;
      }
      localStorage.setItem(key, JSON.stringify({
        family_id: CFG.familyId, day: day, confirmed_at: new Date().toISOString(),
        source: 'authenticated_r5_status'
      }));
    } catch (e) { /* Never turn an authenticated read into a write failure. */ }
  }

  async function cloudStatus(who) {
    var status = await rpc('r5_status', { p_family_id: CFG.familyId }, who);
    rememberPublishedDay(status);
    return status;
  }

  /* 旧签名：p_family_id / p_day_index / p_no_tasks 三个参数一个都不改。
   * p_day_index 是「本机认为的课次」，由云端判定是否采纳。 */
  function publishPlan(who, day, noTasks) {
    return rpc('r5_publish_today', {
      p_family_id: CFG.familyId,
      p_day_index: day,
      p_no_tasks: !!noTasks,
    }, who);
  }

  /* C0.1.6 次日自动结算：
   * 由已经过授权的家庭成员触发 r5_auto_rollover_day。
   * 云端根据上海日期、上一日真实题目/完成标记判断是否达标，
   * 同一家庭事务锁防止多设备重复 +1，并原子发布新计划。
   * 同一日双科刚达标时不能提前跳日；本机不能通过
   * r5_advance_day 或 local completedDays 推进。
   * 仅在完整 C0.1 030+040 数据库迁移完成后启用此桥接版本。 */

  /* 云端还没为这个家庭确定权威学习日（C0.1 起不再按历史计划自动猜）。
   * 这是「必须家长确认」的状态，不是网络错误：一次都不上传，也不落任何成绩。 */
  function isDayNotInitialised(e) {
    var code = String((e && (e.code || e.message)) || '');
    return /R5_DAY_NOT_INITIALIZED/.test(code);
  }

  function dayNotInitialisedStatus(extra) {
    var s = {
      state: 'day_not_initialized',
      message: '云端还没有为这个家庭设定权威学习日（需要家长确认一次当前进度），本次不上传任何成绩，本机记录原样保留。',
      pending: null, pending_known: false,
      cloud_verified: false, cloud_verified_reason: 'DAY_NOT_INITIALIZED',
    };
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) s[k] = extra[k]; } }
    return saveStatus(s);
  }

  /* ------------------------------------------------------- 采集「今天的真实记录」 */

  /**
   * 采集结果统一成内部结构：
   *   { subj, day, track, index, correct, date, source, perQuestion, raw }
   * 只有 perQuestion=true 的才是逐题真实对错；聚合题组用 perQuestion=false 标记。
   */
  function makeSink(out) {
    var seen = {};
    return function add(item) {
      if (!item) return;
      if (!CFG.subjectName[item.subj]) return;
      if (typeof item.correct !== 'boolean') return;
      var d = Number(item.day);
      if (!Number.isInteger(d) || d < 1 || d > CFG.maxDay) return;
      if (String(item.date || '') !== item.today) return;
      var key = [item.subj, d, item.track || '', Number(item.index) || 0].join('|');
      if (seen[key]) return;          // 同题一天只算一次（首次作答）
      seen[key] = 1;
      out.push(item);
    };
  }

  /** 1) state.records：英语课程 / 科学探索 / 岛内练习，本身就是逐题结果 */
  function fromRecords(state, day, todayStr, add) {
    (state.records || []).forEach(function (r, i) {
      if (!r || typeof r !== 'object') return;
      var ld = Number(r.learningDay);
      if (!Number.isInteger(ld) || ld < 1 || ld > CFG.maxDay) return;   // 摸底/周测不进课程成绩
      if (String(r.date || '') !== todayStr) return;
      if (typeof r.correct !== 'boolean') return;
      add({
        subj: String(r.subject || '').toLowerCase(),
        day: ld,
        track: r.track || '练习',
        /* 题号必须取「这道题自己的 index」。旧写法 `Number(r.index) || i` 在
         * index=0 时会退化成数组下标，导致英语第 1 题被记成 10，整轮题号不连续、
         * 云端无法核验。0 是合法题号，不能被 || 吃掉。 */
        index: (r.index === undefined || r.index === null) ? i : Number(r.index),
        correct: r.correct,
        date: r.date,
        today: todayStr,
        source: 'v6',
        perQuestion: true,
        originIndex: i,
        raw: r,
      });
    });
  }

  /** 2) 语文 story 日的阅读理解：走 state.dailyChinese[day].answers（逐题） */
  function fromChineseStory(state, day, todayStr, add) {
    var daily = state.dailyChinese || {};
    Object.keys(daily).forEach(function (k) {
      var dayNo = Number(k);
      if (!Number.isInteger(dayNo) || dayNo < 1 || dayNo > CFG.maxDay) return;
      var pack = daily[k];
      if (!pack || !Array.isArray(pack.answers)) return;
      var quizDate = ymdOf(pack.quizAt);
      if (quizDate !== todayStr) return;
      pack.answers.forEach(function (a, i) {
        if (!a || typeof a.correct !== 'boolean') return;
        add({
          subj: 'cn', day: dayNo, track: '语文闯关·故事', index: i,
          correct: a.correct, date: quizDate, today: todayStr,
          source: 'v6-chinese', perQuestion: true, raw: a,
        });
      });
    });
  }

  /**
   * 3) 课件自己的进度键：数学 / 科学 / 英语。
   *    - 数学：results[].firstTry（课件定义就是「首次答对」）
   *    - 科学：answers[].correct
   *    - 英语：answers[].correct
   */
  function fromCourseProgress(state, day, todayStr, add) {
    var specs = [
      { subj: 'ma', name: '数学', track: '数学课件', pick: function (v) {
          if (Array.isArray(v.results)) {
            return v.results.map(function (r, i) {
              return { index: i, correct: r && typeof r.firstTry === 'boolean' ? r.firstTry : null, raw: r };
            });
          }
          return null;
        } },
      { subj: 'sc', name: '科学', track: '科学探索', pick: function (v) {
          if (Array.isArray(v.answers)) {
            return v.answers.map(function (a, i) {
              return { index: i, correct: a && typeof a.correct === 'boolean' ? a.correct : null, raw: a };
            });
          }
          return null;
        } },
      { subj: 'en', name: '英语', track: '英语课程', pick: function (v) {
          if (Array.isArray(v.answers)) {
            return v.answers.map(function (a, i) {
              return { index: i, correct: a && typeof a.correct === 'boolean' ? a.correct : null, raw: a };
            });
          }
          return null;
        } },
    ];

    specs.forEach(function (spec) {
      var store = readJson(CFG.courseKey[spec.subj]);
      if (!store) return;
      Object.keys(store).forEach(function (lessonKey) {
        var lesson = Number(lessonKey);
        if (!Number.isInteger(lesson) || lesson < 1) return;
        var learningDay = dayForLesson(spec.name, lesson);
        if (!learningDay) return;
        var rec = store[lessonKey];
        if (!rec || typeof rec !== 'object') return;
        var at = String(rec.at || '');
        if (ymdOf(at) !== todayStr) return;     // 只采今天的（按本地时区）
        var list = spec.pick(rec);
        if (!list) return;
        list.forEach(function (item) {
          if (typeof item.correct !== 'boolean') return;
          add({
            subj: spec.subj, day: learningDay, track: spec.track, index: item.index,
            correct: item.correct, date: todayStr, today: todayStr,
            source: 'v6-' + spec.subj + '-course', perQuestion: true, raw: item.raw,
          });
        });
      });
    });
  }

  /**
   * 4) 语文页面闯关：官方只上报 score/total（没有逐题明细）。
   *    按「题组」如实折算：得分几题就记几题正确，总数不变，并打 derived 标记。
   */
  function fromChineseQuiz(state, day, todayStr, add) {
    var daily = state.dailyChinese || {};
    Object.keys(daily).forEach(function (k) {
      var dayNo = Number(k);
      if (!Number.isInteger(dayNo) || dayNo < 1 || dayNo > CFG.maxDay) return;
      var pack = daily[k];
      if (!pack || typeof pack !== 'object') return;

      var quizzes = [];
      Object.keys(pack).forEach(function (name) {
        if (!/Quiz$/.test(name) || name === 'cnPageQuiz') return;
        var q = pack[name];
        if (!q || typeof q !== 'object') return;
        if (!Number.isInteger(q.score) || !Number.isInteger(q.total) || q.total <= 0) return;
        if (q.score < 0 || q.score > q.total) return;
        var at = ymdOf(q.at);
        if (at !== todayStr) return;
        quizzes.push({ name: name, score: q.score, total: q.total });
      });

      /* Older three-question poetry lessons were recorded as cnPageQuiz 3/3.
       * The expanded ten-question lesson is a NEW evidence set. Do not silently
       * replace the original cloud answer IDs or add fake correct answers.
       * A distinct track makes the actually completed ten-question attempt
       * uploadable alongside existing historical three-question records.
       * Where a lesson already reports a genuine ten-question quiz, prefer
       * that evidence instead of double-counting the DOM observer. */
      if (pack.cnPageQuiz) {
        var c = pack.cnPageQuiz;
        if (Number.isInteger(c.score) && Number.isInteger(c.total) && c.total > 0
            && c.score >= 0 && c.score <= c.total && ymdOf(c.at) === todayStr) {
          if (c.total >= 10) {
            if (!quizzes.some(function(q) { return q.total >= c.total; })) {
              quizzes = [{ name: 'cnPageQuiz-expanded-' + c.total,
                score: c.score, total: c.total }];
            }
          } else if (!quizzes.length) {
            quizzes.push({ name: 'cnPageQuiz', score: c.score, total: c.total });
          }
        }
      }

      quizzes.forEach(function (q) {
        for (var i = 0; i < q.total; i++) {
          add({
            subj: 'cn', day: dayNo, track: '语文闯关·' + q.name, index: i,
            correct: i < q.score, date: todayStr, today: todayStr,
            source: 'v6-chinese-quiz', perQuestion: false,
            derived: 'quiz-aggregate', raw: { quiz: q.name, score: q.score, total: q.total },
          });
        }
      });
    });
  }

  function collectItems(state, day, todayStr) {
    var out = [];
    var add = makeSink(out);
    fromRecords(state, day, todayStr, add);
    fromChineseStory(state, day, todayStr, add);
    fromCourseProgress(state, day, todayStr, add);
    fromChineseQuiz(state, day, todayStr, add);
    return out;
  }

  function toRow(item, device) {
    var id;
    if (item.source === 'v6' && Number.isInteger(item.originIndex)) {
      // 与 family-auto-sync.js 完全一致的命名：两个同步器同时开也不会重复计分
      id = 'v6-' + device + '-answer-' + String(item.originIndex).padStart(9, '0');
    } else {
      id = 'v6-' + device + '-g-' + item.subj + '-' + item.day + '-'
        + hash8(item.track + '#' + item.index) + '-' + String(item.index).padStart(3, '0');
    }
    var answer = {
      correct: item.correct,
      date: item.date,
      index: item.index,
      track: item.track,
      subject: item.subj,
      source: item.source,
    };
    if (item.perQuestion) {
      answer.skill = (item.raw && item.raw.skill) || item.track;
      answer.level = (item.raw && item.raw.level) || 1;
      answer.choice = item.raw && item.raw.choice != null ? item.raw.choice : null;
      answer.learningDay = item.day;
    } else {
      answer.skill = item.track;
      answer.level = 1;
      answer.derived = item.derived;
      answer.raw = item.raw;
      answer.learningDay = item.day;
    }
    return {
      record_id: id,
      family_id: CFG.familyId,
      record_type: 'answer',
      subject: CFG.subjectName[item.subj],
      learning_day: item.day,     // 恒等于该题自己的学习日，绝不改写
      record_data: { version: 1, source: item.source, index: item.index, answer: answer },
    };
  }

  /**
   * 只采「本学习日」的记录。item.day 与 day 不等的一律丢弃，
   * 不会因为云端今天到了第 3 天，就把第 1 天的英语重新标成第 3 天。
   */
  function collectAnswers(state, day, todayStr) {
    var device = deviceId();
    return collectItems(state, day, todayStr)
      .filter(function (it) { return it.day === day; })
      .map(function (it) { return toRow(it, device); });
  }

  /* ==================================================================
   * 整轮（round）：v6.1.0 起上传的唯一单位
   *
   * 云端判定要求「一次完整交卷 = 摘要 + 同一 attempt_id 的逐题答案」，
   * 因此本机必须先把今天的逐题记录拼成一整轮再发，不能只发摘要。
   *
   * 拼轮规则（与云端 R5_SAFE_ROUND_V4 口径一致）：
   *   · 同一学科可能来自多个来源（学习记录 / 课件进度 / 语文故事 / 语文闯关），
   *     逐个来源检查「题号是否恰好是 0..n-1」，只有完全连续的才算一轮；
   *   · 取题量最多的那一组，n < 5 不构成一轮（零散练习不算）；
   *   · attempt_id 由「学科+学习日+日期+逐题对错序列」决定 →
   *     同一天同一结果重复同步得到同一个 id（PWA 重启、断网重试都幂等），
   *     结果改变才会得到新 id。
   *
   * ---- rc3 修复：同一天重新答题（第二次）传不上去 ----
   * 旧实现对着「同一 source|track 只允许一组 0..n-1」这条规则，
   * 同一天再答一轮时这组会变成 0..9,0..9，连续性检查直接 return，
   * 于是整科被丢弃 → 「第一次 4/10、第二次 10/10」的第二轮永远到不了云端，
   * 孩子当天被判未完成、赛车继续锁死。这是 rc2 之前就存在的前端缺陷。
   *
   * rc3 两条最小修复（不改变云端评分口径，也不拼接不同轮次）：
   *   1) 优先取 v6-attempt-history-v1 里「带完整逐题答案」的轮次：
   *      每轮自带 answers 与 at，天然不覆盖旧轮（语文、数学会带）；
   *   2) 退回逐题记录时，把重复题号拆成多轮再取最好的一轮，
   *      不再因为一段不连续就丢掉整科（英语、科学走这条）。
   * 每科每天仍然只上传「最好的一轮」：半轮不上传，跨轮不合并分子分母。
   * ================================================================== */
  /* 本机 attempt 历史（append-only，四科共用同一个 key） */
  var HISTORY_KEY = 'v6-attempt-history-v1';

  function readAttemptHistory() {
    try {
      var v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) { return {}; }
  }

  /**
   * 今天这个学习日、带完整逐题证据的轮次。
   * 只收「题号 0..n-1 连续、逐题正确数与摘要一致、at 落在今天」的轮次；
   * 任何一项不符就整轮丢掉，绝不臆造顺序、绝不补题。
   */
  function historyRounds(day, todayStr) {
    var data = readAttemptHistory();
    var out = [];
    Object.keys(data).forEach(function (group) {
      var list = Array.isArray(data[group]) ? data[group] : [];
      list.forEach(function (it) {
        if (!it || typeof it !== 'object') return;
        if (!CFG.subjectKey[it.subject]) return;
        if (Number(it.learningDay) !== day) return;
        var total = Number(it.total), correct = Number(it.correct);
        if (!Number.isInteger(total) || total < 5) return;
        if (!Number.isInteger(correct) || correct < 0 || correct > total) return;
        if (!Array.isArray(it.answers) || it.answers.length !== total) return;
        if (ymdOf(it.at) !== todayStr) return;      // 只认「今天答的」，不改挂旧日成绩
        var marks = [], strict = true;
        it.answers.forEach(function (a, i) {
          if (!a || Number(a.index) !== i) strict = false;
          marks.push(!!(a && a.correct === true));
        });
        if (!strict) return;
        if (marks.filter(Boolean).length !== correct) return;   // 摘要与逐题不一致，不收
        /* 保留本机交卷自己的唯一 attempt_id：网关靠它做整轮校验与幂等重试。
           旧的「按对错序列推算 id」只用于没有 id 的历史记录，不能覆盖新轮次。 */
        var aid = typeof it.id === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(it.id) ? it.id : '';
        out.push({ subject: it.subject, marks: marks, at: String(it.at || ''), attemptId: aid });
      });
    });
    return out;
  }

  /* ==================================================================
   * 跨零点补传（rc8）
   *
   * 现象：孩子 23:59 答完、断网，次日 00:10 恢复网络。旧实现所有采集器都按
   * `ymdOf(at) === todayStr` 过滤，昨天的真实交卷在午夜后一概采不到，
   * 于是「本机已完整保存、云端永远没有」。
   *
   * 修复边界（与服务端 r5_child_upload_rounds_v2 的实际规则对齐）：
   *   · 只补「昨天及更早、最近 7 天」的轮次（服务端拒绝 7 天以前与未来日期）；
   *   · 用轮次自己的 at 推出原始日期、用轮次自己的 learningDay 作学习日，
   *     绝不改挂到今天，也绝不改写已有成绩；
   *   · 只补本机尚未 cloud_confirmed / skipped_not_higher 的轮次；
   *   · 每个「学习日 + 学科」只补一轮（正确率最高的那一轮），半轮不上传。
   *   · 补传不调用 r5_child_complete_course，因此不会给往日补发碎片奖励，
   *     也不会占用今天的每日奖励次数。
   * ================================================================== */
  var BACKFILL_MAX_DAYS = 7;
  var ATTEMPT_STATUS_KEYS = ['v6-chinese-attempt-status-v1', 'v6-course-attempt-status-v1'];

  function attemptStateOf(attemptId) {
    if (!attemptId) return '';
    for (var i = 0; i < ATTEMPT_STATUS_KEYS.length; i++) {
      var data = readJson(ATTEMPT_STATUS_KEYS[i]);
      var s = data && data[attemptId];
      if (s && s.state) return String(s.state);
    }
    return '';
  }

  /** 'YYYY-MM-DD' 减 n 天（纯日期计算，不经过本地时区）。 */
  function shiftYmd(dateStr, days) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return '';
    var t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Number(days) * 86400000;
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
      + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  /**
   * 本机「已完整保存、尚未云端确认」的往日轮次。
   * 数据源是本机 attempt 历史（四科统一），只接受逐题题号 0..n-1 连续、
   * 逐题正确数与摘要一致、at 可解析的完整轮次；任何一项不符整轮丢弃。
   */
  function pendingHistoryRounds(todayStr, todaySh) {
    var data = readAttemptHistory();
    var floor = shiftYmd(todaySh || todayStr, BACKFILL_MAX_DAYS);
    var picked = {};
    Object.keys(data).forEach(function (group) {
      var list = Array.isArray(data[group]) ? data[group] : [];
      list.forEach(function (it) {
        if (!it || typeof it !== 'object') return;
        if (!CFG.subjectKey[it.subject]) return;
        var day = Number(it.learningDay);
        if (!Number.isInteger(day) || day < 1 || day > CFG.maxDay) return;
        var total = Number(it.total), correct = Number(it.correct);
        if (!Number.isInteger(total) || total < 5) return;
        if (!Number.isInteger(correct) || correct < 0 || correct > total) return;
        if (!Array.isArray(it.answers) || it.answers.length !== total) return;
        var at = String(it.at || '');
        var date = ymdSH(at);
        if (!date) return;
        if (date >= todayStr) return;        // 今天 / 未来交给今日通道，避免重复
        if (date < floor) return;            // 服务端只接收最近 7 天
        var id = typeof it.id === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(it.id) ? it.id : '';
        if (!id) return;
        var st = attemptStateOf(id);
        if (st === 'cloud_confirmed' || st === 'skipped_not_higher') return;
        var marks = [], strict = true;
        it.answers.forEach(function (a, i) {
          if (!a || Number(a.index) !== i) strict = false;
          marks.push(!!(a && a.correct === true));
        });
        if (!strict) return;
        if (marks.filter(Boolean).length !== correct) return;
        var key = day + '|' + it.subject;
        var prev = picked[key];
        if (!prev || correct * prev.marks.length > prev.correct * marks.length) {
          picked[key] = { subject: it.subject, day: day, marks: marks, at: at, attemptId: id, correct: correct };
        }
      });
    });
    var out = [];
    Object.keys(picked).forEach(function (k) {
      var h = picked[k];
      /* 关键：日期与学习日都取轮次自己的，不取今天。 */
      out.push(buildRound(h.subject, h.day, ymdSH(h.at), h.marks, h.at,
        'attempt-history-backfill', 'attempt-history', h.attemptId));
    });
    return out;
  }

  /**
   * 把同一来源的逐题记录拆成多次完整作答。
   * 反复「从题号 0 起按 0,1,2… 贪心取一条」，取到不能再取为止 ——
   * 这样 0..9,0..9 会拆成两轮，而不是像旧实现那样因为不连续丢掉整科。
   */
  function extractRuns(list) {
    var pool = list.slice().sort(function (a, b) { return a.index - b.index; });
    var runs = [];
    while (pool.length) {
      var start = -1, i;
      for (i = 0; i < pool.length; i++) if (pool[i].index === 0) { start = i; break; }
      if (start < 0) break;                       // 剩余题目都没有题号 0，不成轮
      var run = [pool.splice(start, 1)[0]];
      var next = 1, guard = 0;
      while (guard++ < 500) {
        var found = -1;
        for (i = 0; i < pool.length; i++) if (pool[i].index === next) { found = i; break; }
        if (found < 0) break;
        run.push(pool.splice(found, 1)[0]);
        next++;
      }
      runs.push(run);
    }
    return runs;
  }

  /** 用「逐题对错序列」造一整轮（摘要 + 同一 attempt_id 的逐题答案） */
  function buildRound(subj, day, todayStr, marks, at, sourceTag, track, storedAttemptId) {
    var total = marks.length;
    var correct = marks.filter(Boolean).length;
    var vector = marks.map(function (b) { return b ? '1' : '0'; }).join('');
    var code = CFG.subjectKey[subj] || subj;
    var token = deviceToken() || deviceId();
    /* attempt_id 公式与 v6.1.0 完全一致：同一天同一结果重复同步得到同一个 id
       （PWA 重开、断网重试都幂等）；结果不同才得到新 id，由 rc3 云端规则接受。 */
    var aid = storedAttemptId || ('r5r-' + hash8('v1|' + code + '|' + day + '|' + todayStr + '|' + vector));

    var answers = marks.map(function (ok, i) {
      return {
        record_id: 'v6-' + token + '-a-' + code + '-' + day + '-' + aid + '-' + ('00' + i).slice(-2),
        record_type: 'answer',
        subject: CFG.subjectName[code] || CFG.subjectName[subj] || subj,
        learning_day: day,
        record_data: {
          version: 1,
          attempt_id: aid,
          device_id: token,
          index: i,
          source: sourceTag,
          answer: {
            index: i,
            correct: ok === true,
            date: todayStr,
            learningDay: day,
            subject: code,
            track: track || sourceTag,
            source: sourceTag,
          },
        },
      };
    });

    return {
      subject: CFG.subjectName[code] || CFG.subjectName[subj] || subj,
      code: code,
      day: day,
      attempt_id: aid,
      correct: correct,
      total: total,
      attempt: {
        record_id: 'v6-' + token + '-attempt-' + code + '-' + day + '-' + aid,
        record_type: 'course-attempt',
        subject: CFG.subjectName[subj],
        learning_day: day,
        record_data: {
          attempt_id: aid,
          device_id: token,
          correct: correct,
          total: total,
          wrong: total - correct,
          at: at || new Date().toISOString(),
          source: 'device-upload',
        },
      },
      answers: answers,
    };
  }

  function collectRounds(state, day, todayStr) {
    /* 只把真实逐题结果拼成上传轮次。「答对 X/Y」折算出来的题号是展示摘要，
       不是孩子实际作答证据，绝不进入 course-attempt + answer 整轮。 */
    var items = collectItems(state, day, todayStr)
      .filter(function (it) { return it.day === day && it.derived !== 'quiz-aggregate'; });
    var rounds = [];
    var covered = {};      // 已有整轮证据的学科，逐题记录不再重复计分

    /* 1) attempt 历史里带逐题答案的轮次优先（语文、数学会带）。
          同科多轮 → 只留单轮最好的一轮，用整数交叉相乘比较，避免浮点误差。 */
    var picked = {};
    historyRounds(day, todayStr).forEach(function (rd) {
      var c = rd.marks.filter(Boolean).length, t = rd.marks.length;
      var prev = picked[rd.subject];
      if (!prev || c * prev.marks.length > prev.marks.filter(Boolean).length * t) {
        picked[rd.subject] = rd;
      }
    });
    Object.keys(picked).forEach(function (subj) {
      var hit = picked[subj];
      if (hit.marks.length < 5) return;
      covered[subj] = true;
      rounds.push(buildRound(subj, day, todayStr, hit.marks, hit.at, 'attempt-history', 'attempt-history', hit.attemptId));
    });

    /* 2) 历史里没有可核验轮次的学科，退回逐题记录。
          先按「来源|赛道」分组，再拆成多轮 ——
          题量最多优先（完整交卷才算一轮），同题量下取正确率最高的一轮。 */
    var bySubject = {};
    items.forEach(function (it) {
      if (!CFG.subjectName[it.subj]) return;
      if (covered[CFG.subjectName[it.subj]]) return;
      (bySubject[it.subj] = bySubject[it.subj] || []).push(it);
    });

    Object.keys(bySubject).forEach(function (subj) {
      var groups = {};
      bySubject[subj].forEach(function (it) {
        var k = String(it.source) + '|' + String(it.track);
        (groups[k] = groups[k] || []).push(it);
      });

      var best = null, bestCorrect = -1, bestAt = '', bestSrc = '', bestTrack = '';
      Object.keys(groups).forEach(function (k) {
        extractRuns(groups[k]).forEach(function (run) {
          if (run.length < 5) return;
          var correct = run.filter(function (it) { return it.correct === true; }).length;
          var longer = !best || run.length > best.length;
          var sameLenBetter = best && run.length === best.length && correct * best.length > bestCorrect * run.length;
          if (longer || sameLenBetter) {
            best = run; bestCorrect = correct;
            bestAt = run[0].at || '';
            bestSrc = run[0].source || 'device-upload';
            bestTrack = run[0].track || '练习';
          }
        });
      });
      if (!best) return;

      rounds.push(buildRound(subj, day, todayStr,
        best.map(function (it) { return it.correct === true; }),
        bestAt, bestSrc, bestTrack));
    });

    return rounds.sort(function (a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; });
  }

  /** 把整轮摊平成行数组（网关 / REST 都收同一形状） */
  function roundRows(rounds) {
    var rows = [];
    rounds.forEach(function (rd) {
      rows.push(rd.attempt);
      rows = rows.concat(rd.answers);
    });
    return rows;
  }

  /**
   * @deprecated v6.1.0 起客户端不再上传 course-complete。
   * 完成态一律由服务端按整轮证据派生（r5_child_complete_course），
   * 这里保留函数只为诊断页/旧状态读取，任何上传路径都不再调用。
   */
  function collectCompletions(state, day, todayStr) {
    var device = deviceId();
    var subs = (state.v6Course && state.v6Course.subjects) || {};
    var alreadyCloud = (state.v6Course && state.v6Course.remoteRestored) || {};
    var pack = subs[day] || {};
    var out = [];
    Object.keys(pack).forEach(function (name) {
      if (alreadyCloud[day] && alreadyCloud[day][name]) return;
      var iso = pack[name];
      if (!iso || !Number.isFinite(Date.parse(iso))) return;
      var localDate = ymd(new Date(iso));
      if (localDate !== todayStr) return;
      out.push({
        record_id: 'v6-' + device + '-course-' + day + '-' + (CFG.subjectKey[name] || encodeURIComponent(name)),
        family_id: CFG.familyId,
        record_type: 'course-complete',
        subject: name,
        learning_day: day,
        record_data: { version: 1, source: 'v6', day: day, completed_at: iso },
      });
    });
    return out;
  }

  /* ------------------------------------------------------------------ 上传 */

  /* 云端这个家庭真实保存了多少条记录（不含 sync-test 自检行）。
   * 只取 1 行 + count=exact，读的是 Content-Range 的总数，不拉数据。
   * 「本批确认条数」和「云端总数」是两件事，页面上必须分开显示，
   * 否则「云端只存了 27 条」这种误读会让人以为成绩丢了。 */
  async function cloudTotal(who) {
    try {
      var url = CFG.restBase + '/growth_learning_records?select=record_id'
        + '&family_id=eq.' + encodeURIComponent(CFG.familyId)
        + '&record_type=neq.sync-test&limit=1';
      var res = await fetch(url, {
        headers: {
          authorization: 'Bearer ' + who.token,
          accept: 'application/json',
          prefer: 'count=exact',
        },
      });
      if (!res.ok) return null;
      var cr = res.headers.get('content-range') || '';
      var m = /\/(\d+)\s*$/.exec(cr);
      return m ? Number(m[1]) : null;
    } catch (e) { return null; }
  }

  async function existingIds(who) {
    var url = CFG.restBase + '/growth_learning_records?select=record_id'
      + '&family_id=eq.' + encodeURIComponent(CFG.familyId)
      + '&limit=5000';
    var res = await fetch(url, {
      headers: { authorization: 'Bearer ' + who.token, accept: 'application/json' },
    });
    if (!res.ok) throw new Error('READ_RECORDS_' + res.status);
    var rows = await res.json();
    var set = new Set();
    (rows || []).forEach(function (r) { if (r && r.record_id) set.add(String(r.record_id)); });
    return set;
  }

  /**
   * 服务端原子抢占（依赖 007_answer_dedupe.sql）。两台设备同时上传同一道题时，
   * 只有一台能 RETURNING 到行；另一台拿到 duplicates。返回 null 表示 RPC 不可用，
   * 调用方降级为「读云端当天记录再过滤」，同步永不中断。
   */
  async function claimOnServer(items, who) {
    var payload = items.map(function (r) {
      var a = r.record_data && r.record_data.answer;
      var c = r.record_data && r.record_data.completed_at;
      return {
        record_id: r.record_id,
        subject: r.subject,
        date: a ? ymdOf(a.date) : (c ? ymdOf(c) : ymdOf(new Date())),
        track: a ? String(a.track || '') : '__course__',
        index: a ? (Number(a.index) || 0) : 0,
      };
    });
    try {
      var out = await rpc('r5_claim_answers', { p_family_id: CFG.familyId, p_items: payload }, who);
      var row = Array.isArray(out) ? out[0] : out;
      if (!row || !Array.isArray(row.claimed)) return null;
      return {
        claimed: new Set(row.claimed.map(String)),
        reclaimed: new Set((row.reclaimed || []).map(String)),
        duplicates: new Set((row.duplicates || []).map(String)),
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * 降级路径：云端已有的「答题/完成指纹」集合。
   * 指纹 = 学科|日期|关卡|题号；课程完成记录用 track='__course__', index=0。
   * 并发下两台设备可能同时读到空集合，这条路只做兜底。
   */
  async function cloudQuestionKeys(who, day) {
    try {
      var url = CFG.restBase + '/growth_learning_records'
        + '?select=subject,learning_day,record_type,record_data'
        + '&family_id=eq.' + encodeURIComponent(CFG.familyId)
        + '&record_type=in.(answer,course-complete)'
        + '&learning_day=eq.' + encodeURIComponent(String(day))
        + '&limit=3000';
      var res = await fetch(url, {
        headers: { authorization: 'Bearer ' + who.token, accept: 'application/json' },
      });
      if (!res.ok) return null;
      var rows = await res.json();
      var set = {};
      (rows || []).forEach(function (r) {
        if (!r) return;
        var a = r.record_data && r.record_data.answer;
        if (a) {
          set[r.subject + '|' + ymdOf(a.date) + '|' + String(a.track || '') + '|' + String(a.index)] = 1;
          return;
        }
        var c = r.record_data && r.record_data.completed_at;
        if (c) set[r.subject + '|' + ymdOf(c) + '|__course__|0'] = 1;
      });
      return set;
    } catch (e) { return null; }
  }

  function fingerprint(r) {
    var a = r.record_data && r.record_data.answer;
    if (a) return r.subject + '|' + ymdOf(a.date) + '|' + String(a.track || '') + '|' + String(a.index);
    var c = r.record_data && r.record_data.completed_at;
    return r.subject + '|' + (c ? ymdOf(c) : ymdOf(new Date())) + '|__course__|0';
  }

  /** 按 record_id 精确回查：只查本机这批 id，不会被历史记录条数截断。 */
  async function persistedIds(who, ids) {
    if (!ids.length) return { ok: true, ids: {}, scanned: 0 };
    try {
      var list = ids.map(function (s) { return '"' + String(s).replace(/["\\]/g, '') + '"'; }).join(',');
      var url = CFG.restBase + '/growth_learning_records'
        + '?select=record_id'
        + '&family_id=eq.' + encodeURIComponent(CFG.familyId)
        + '&record_id=in.(' + list + ')'
        + '&limit=' + (ids.length + 5);
      var res = await fetch(url, {
        headers: { authorization: 'Bearer ' + who.token, accept: 'application/json' },
      });
      if (!res.ok) return { ok: false, ids: {}, scanned: 0 };
      var rows = await res.json();
      var set = {};
      (rows || []).forEach(function (r) { if (r && r.record_id) set[String(r.record_id)] = 1; });
      return { ok: true, ids: set, scanned: (rows || []).length };
    } catch (e) { return { ok: false, ids: {}, scanned: 0 }; }
  }

  /** 当天题目指纹（判断「别的设备已经传过这道题」），带截断标记。 */
  async function dayFingerprints(who, day) {
    var limit = 3000;
    try {
      var url = CFG.restBase + '/growth_learning_records'
        + '?select=subject,learning_day,record_type,record_data'
        + '&family_id=eq.' + encodeURIComponent(CFG.familyId)
        + '&record_type=in.(answer,course-complete)'
        + '&learning_day=eq.' + encodeURIComponent(String(day))
        + '&limit=' + limit;
      var res = await fetch(url, {
        headers: { authorization: 'Bearer ' + who.token, accept: 'application/json' },
      });
      if (!res.ok) return null;
      var rows = await res.json();
      var fps = {};
      (rows || []).forEach(function (r) {
        if (!r) return;
        var a = r.record_data && r.record_data.answer;
        if (a) { fps[r.subject + '|' + ymdOf(a.date) + '|' + String(a.track || '') + '|' + String(a.index)] = 1; return; }
        var c = r.record_data && r.record_data.completed_at;
        if (c) fps[r.subject + '|' + ymdOf(c) + '|__course__|0'] = 1;
      });
      return { fps: fps, truncated: (rows || []).length >= limit };
    } catch (e) { return null; }
  }

  /**
   * 回读云端，逐条确认「本机认为应有成绩」的每一条是否真的落库。
   * 不能看 r5_status：它的 modules 可能全部来自另一台设备。
   * known=false 表示这次没能力判断（读不到/超上限），此时 pending 必须是 null。
   */
  async function verifyPersisted(rows, who, day) {
    if (!rows.length) return { known: true, missing: [], confirmed: 0, scanned: 0 };
    var ids = rows.map(function (r) { return r.record_id; });
    var exact = await persistedIds(who, ids);
    if (!exact.ok) return { known: false, missing: ids.slice(), confirmed: 0, scanned: 0 };

    var needFp = [];
    rows.forEach(function (r) { if (!exact.ids[r.record_id]) needFp.push(r); });
    if (!needFp.length) return { known: true, missing: [], confirmed: rows.length, scanned: exact.scanned };

    var dayIdx = await dayFingerprints(who, day);
    if (!dayIdx) {
      return { known: false, missing: needFp.map(function (r) { return r.record_id; }),
        confirmed: rows.length - needFp.length, scanned: exact.scanned };
    }
    var missing = [];
    needFp.forEach(function (r) {
      if (!dayIdx.fps[fingerprint(r)]) missing.push(r.record_id);
    });
    if (missing.length && dayIdx.truncated) {
      return { known: false, missing: missing, confirmed: rows.length - missing.length,
        scanned: exact.scanned, truncated: true };
    }
    return { known: true, missing: missing, confirmed: rows.length - missing.length, scanned: exact.scanned };
  }

  function sleepMs(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /** 给 0.6 秒再确认一次，避免把「正在上传」误报成「没落库」；绝不把「确认不到」当已确认。 */
  async function verifyWithRetry(rows, who, day) {
    var vf = await verifyPersisted(rows, who, day);
    if (!rows.length || (vf.known && !vf.missing.length)) return vf;
    await sleepMs(600);
    var again = await verifyPersisted(rows, who, day);
    return again.known ? again : vf;
  }

  /**
   * 上传。返回值是统计对象：
   *   uploaded / already / duplicates / reclaimed
   */
  async function upload(rows, who) {
    var out = { uploaded: 0, already: 0, duplicates: 0, reclaimed: 0 };
    if (!rows.length) return out;
    var have = await existingIds(who);
    var fresh = rows.filter(function (r) { return !have.has(r.record_id); });
    out.already = rows.length - fresh.length;
    if (!fresh.length) return out;

    /* 整轮行（带 attempt_id）不参与「逐题指纹抢占」：
     * 抢占键是 学科|日期|关卡|题号，会把同一学科第二轮的逐题挡掉，
     * 导致这一轮摘要与逐题配不齐、整轮核验必然失败。
     * 整轮行靠 record_id（含 attempt 哈希）天然幂等，重复 POST 不会多写。 */
    var withAid = fresh.filter(function (r) { return r.record_data && r.record_data.attempt_id; });
    var legacy = fresh.filter(function (r) { return !(r.record_data && r.record_data.attempt_id); });

    if (legacy.length) {
      var claim = await claimOnServer(legacy, who);
      if (claim) {
        out.reclaimed = claim.reclaimed.size;
        legacy = legacy.filter(function (r) { return claim.claimed.has(r.record_id); });
        out.duplicates += claim.duplicates.size;
      } else {
        var day = legacy[0].learning_day;
        var seenQ = await cloudQuestionKeys(who, day);
        if (seenQ) {
          var before = legacy.length;
          legacy = legacy.filter(function (r) { return !seenQ[fingerprint(r)]; });
          out.duplicates += before - legacy.length;
        }
      }
    }

    fresh = withAid.concat(legacy);
    if (!fresh.length) return out;

    var payload = fresh.map(function (r) {
      return Object.assign({}, r, { created_by: who.uid });
    });
    var res = await fetch(CFG.restBase + '/growth_learning_records', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + who.token,
        prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      var body = '';
      try { body = await res.text(); } catch (e) { body = ''; }
      throw new Error('WRITE_RECORDS_' + res.status + ':' + body.slice(0, 160));
    }
    out.uploaded = fresh.length;
    return out;
  }

  /* ------------------------------------------------------------- 主流程 */

  async function runOnce() {
    if (running) return readStatus();
    try { if (localStorage.getItem(CFG.offKey) === 'yes') { return saveStatus({ state: 'off' }); } } catch (e) { /* ignore */ }

    var state = readState();
    if (!state) return saveStatus({ state: 'no_local_state', message: '本机还没有 V6 学习记录' });
    if (typeof v6CourseStarted === 'function' && !v6CourseStarted()) {
      return saveStatus({ state: 'not_started', message: '正式课程尚未开始，未发布计划或上传成绩。' });
    }

    running = true;
    saveStatus({ state: 'running', build: BRIDGE_BUILD });
    var rows;
    try {
      /* ================= 阶段 A：设备身份只读跟随学习日 =================
       * 孩子设备已由家长绑定，凭 x-r5-device 就能向 R5 网关只读查询云端
       * 当前学习日，不需要家长会话。未绑定 / 已撤销 / 跨家庭由网关拒绝。
       * 本阶段只写本机 cloudAlignedDay，不碰任何历史答题与课次。 */
      var deviceRead = null, deviceError = null, dayFollowedByDevice = null;
      try {
        deviceRead = await gatewayReadDay();
        saveCloudCache(deviceRead);
        /* 比较基准必须是「档案里已保存的对齐日」，不能用 courseDay()：
           pwa.js 把 v6CourseDay 改写成了「云端确认日优先」，诊断页读到的 7 就来自它，
           followCloudDay(7, 7) 会认为不必跟随，cloudAlignedDay 便永远停在 6。 */
        dayFollowedByDevice = followCloudDay(deviceRead.today,
          alignedDayOf(readLiveState()) || 1,
          { allowGap: true, source: 'device_entry_readonly' });
        /* 数据与渲染解耦：读到的云端学习日无论如何都通知页面重绘一次。 */
        try {
          if (typeof window.v6OnCloudDayChanged === 'function') {
            window.v6OnCloudDayChanged(Number(deviceRead.today));
          }
        } catch (notifyError) { /* 页面没有钩子时忽略 */ }
      } catch (deviceFail) {
        deviceError = String(deviceFail && (deviceFail.code || deviceFail.message) || 'UNKNOWN');
        log('设备身份只读查询失败', deviceError);
      }

      /* ================= 阶段 B：上传（设备身份优先） =================
       * 没有家长会话时，已授权设备凭 x-r5-device 直接上传今天的整轮成绩，
       * 走 /v1/child/round-upload（V5 统一评分）。家长会话只用来做跨日结算。 */
      var who = null, authError = null;
      try { who = await identity(); } catch (authFail) {
        authError = String(authFail && (authFail.code || authFail.message) || 'NO_SESSION');
      }
      if (!who) {
        var cache = readCloudCache();
        /* 家长会话过期不再等于「什么都不能做」：
         * 已授权设备直接用设备身份上传今天的答题记录，完成态由服务端派生。
         * 拉不到学习日或没有设备令牌时，自动跳过，绝不影响首页显示。 */
        var devUp = null, devUpErr = null;
        if (deviceRead && deviceRead.today) {
          try { devUp = await deviceUpload(deviceRead.today); }
          catch (upFail) { devUpErr = String(upFail && (upFail.code || upFail.message) || 'UNKNOWN'); }
        /* 上传成功就用手上的回读结果替换掉上传前的状态，页面上「是否达标 / 能否进赛车」
           才不会停在上传前的那一秒。回读失败时保留旧值，不猜测。 */
        if (devUp && devUp.after) { deviceRead = devUp.after; saveCloudCache(deviceRead); }
        }
        /* 实时失败时，缓存只能作为「上次核对到第几日」的提示，
         * 不能写进 cloud_day 冒充当前学习日。 */
        var devDay = deviceRead ? deviceRead.today : null;
        return saveStatus({
          state: deviceRead ? 'device_day_synced' : 'device_day_unavailable',
          auth_required: true,
          upload_blocked_by_auth: !devUp,
          upload_via_device: devUp || null,
          upload_via_device_error: devUpErr,
          cloud_settled_by_server: true,
          local_day: courseDay(),
          cloud_day: devDay,
          authoritative_day: deviceRead ? deviceRead.authoritative_day : null,
          cloud_subjects: deviceRead ? deviceRead.subjects : null,
          schedule_published: deviceRead ? deviceRead.published : null,
          cached_authoritative_day: (!deviceRead && cache) ? cache.authoritative_day : null,
          cached_cloud_day: (!deviceRead && cache) ? cache.today : null,
          cached_study_passed: (!deviceRead && cache) ? cache.study_passed : null,
          study_passed: deviceRead ? deviceRead.study_passed : null,
          racing_allowed: deviceRead ? deviceRead.allowed : null,
          subjects: deviceRead
            ? (deviceRead.modules || []).map(function (m) {
                return m.subject + (m.accuracy_pct == null ? '（无成绩）' : ' ' + m.accuracy_pct + '%')
                  + (m.passed ? ' ✓' : ' ✗');
              })
            : null,
          reason: deviceRead ? deviceRead.reason : null,
          remaining_seconds: deviceRead ? deviceRead.remaining_seconds : null,
          followed_cloud_day: dayFollowedByDevice,
          day_source: deviceRead ? 'device' : 'none',
          day_fetched_at: deviceRead ? deviceRead.fetched_at : null,
          cache_checked_at: (!deviceRead && cache) ? cache.fetched_at : null,
          device_day_error: deviceError,
          cache_stale: cache ? cache.stale : null,
          cloud_verified: false,
          cloud_verified_reason: deviceRead ? 'DEVICE_READ_ONLY' : 'DEVICE_READ_FAILED',
          message: deviceRead
            ? '已按本机设备身份核对：云端现在是第 ' + deviceRead.today + ' 日'
              + (deviceRead.subjects && deviceRead.subjects.length ? '（' + deviceRead.subjects.join('＋') + '）' : '')
              + '，首页与课程已对齐。'
              + (devUp
                ? (function () {
                  var todayUp = Math.max(0, Number(devUp.uploaded || 0) - Number(devUp.backfill_uploaded || 0));
                  var bits = [];
                  if (todayUp > 0) {
                    bits.push('今天有 ' + todayUp + ' 轮成绩已由这台设备直接送到云端'
                      + (devUp.after && devUp.after.study_passed ? '，两科已达标，赛车闸门已解锁' : ''));
                  }
                  if (Number(devUp.backfill_uploaded || 0) > 0) {
                    bits.push('另有 ' + devUp.backfill_uploaded + ' 轮往日成绩已按原日期、原学习日补传'
                      + '（不补发往日碎片，不占今天次数）');
                  }
                  if (!bits.length) {
                    bits.push(devUp.errors.length
                      ? '云端暂未接收今天的成绩：' + devUp.errors.join('；')
                      : '今天的成绩云端已有，没有重复上传。');
                  } else if (devUp.errors.length) {
                    bits.push('另有 ' + devUp.errors.length + ' 项待重试');
                  }
                  return bits.join('；') + '。';
                })()
                : '本机成绩仍安全保存在本机，稍后会自动重试；')
              + '云端每日结算由服务器独立完成。'
            : (deviceError === 'R5_DEVICE_REQUIRED'
              ? '这台设备还没有授权，所以暂时读不到云端学习日。'
                + '请家长用这个账号（妈妈/爸爸）和自己的密码在下方完成一次授权；授权后孩子每天打开学习页会自动跟到云端学习日，不需要家长每天登录。'
                + '本机成绩与学习日都未被改动，云端结算不受影响。'
              : /R5_MEMBER_DENIED|R5_AUTH_REQUIRED/.test(deviceError || '')
                ? '这台设备的授权已被撤销或不属于这个家庭，所以读不到云端学习日。'
                  + '请家长重新授权这台设备；本机成绩与学习日都未被改动。'
                : '这台设备没有家长登录凭证，设备身份查询也没成功（' + deviceError + '）。'
                  + '本机成绩与学习日均未被改动，云端结算不受影响。'),
          pending: null, pending_known: false,
          build: BRIDGE_BUILD,
          checked_at: new Date().toISOString(),
        });
      }
      var todayStr = today();

      // On the first authorized check after Shanghai midnight, ask the server
      // to atomically verify yesterday's two-subject result, advance at most
      // once, and publish the new plan. Never use the local completedDays to
      // choose the next day, and never guess success on old servers.
      var rollover = null;
      try {
        rollover = await rpc('r5_auto_rollover_day',
          { p_family_id: CFG.familyId }, who);
      } catch (rolloverError) {
        // Do not infer that SQL is missing from a failed HTTP request.
        // Keep uploads blocked, but independently ask for today's plan using
        // the existing authenticated read-only r5_status RPC.
        var readOnlyStatus = null, readOnlyError = null, readOnlyDay = null;
        try {
          readOnlyStatus = await cloudStatus(who);
          readOnlyDay = readDayState(readOnlyStatus);
        } catch (statusError) {
          readOnlyError = String(statusError && (statusError.code || statusError.message) || 'UNKNOWN');
        }
        var verifiedToday = !!(readOnlyDay && readOnlyDay.published
          && Number.isInteger(readOnlyDay.plan_day)
          && readOnlyDay.plan_day >= 1 && readOnlyDay.plan_day <= CFG.maxDay
          && readOnlyDay.authoritative_day === readOnlyDay.plan_day);
        var localDayAtFailure = courseDay();
        var serverDayAtFailure = verifiedToday ? readOnlyDay.plan_day : null;
        var safeDayAlignment = verifiedToday && serverDayAtFailure > localDayAtFailure;
        return saveStatus({
          state: safeDayAlignment ? 'stale_device_day' : 'auto_day_backend_not_ready',
          message: readOnlyError
            ? '自动跨日及云端只读查询均失败。请在原桌面应用中检查家长登录及云端接口权限，本机学习记录未改动。'
            : verifiedToday
              ? '已只读核实云端今日第 ' + serverDayAtFailure + ' 日，但自动跨日接口仍调用失败。暂不上传成绩或改写云端，请核实登录及接口权限。'
              : '自动跨日接口调用失败，云端今日计划未能核实。本机学习记录保持不变，不自动推进学习日。',
          local_day: localDayAtFailure,
          cloud_day: serverDayAtFailure,
          authoritative_day: verifiedToday ? readOnlyDay.authoritative_day : null,
          cloud_subjects: verifiedToday ? (readOnlyStatus.modules || []).map(function(m){ return m.subject; }) : null,
          read_only_cloud_verified: verifiedToday,
          cloud_verified: false,
          cloud_verified_reason: 'AUTO_DAY_RPC_FAILED',
          error: String(rolloverError && (rolloverError.code || rolloverError.message) || 'UNKNOWN'),
          read_only_error: readOnlyError,
          pending: null, pending_known: false,
          build: BRIDGE_BUILD
        });
      }
      if (!rollover || rollover.published !== true
          || rollover.result === 'day_not_initialized'
          || rollover.result === 'plan_progress_mismatch') {
        return saveStatus({
          state: 'auto_day_requires_review',
          message: '云端学习日尚不能安全自动结算，请在家庭管理页核实，未改变任何本地学习成绩。',
          cloud_verified: false,
          cloud_verified_reason: 'AUTO_DAY_NOT_READY',
          rollover: rollover && rollover.result || null,
          build: BRIDGE_BUILD
        });
      }
      var st = await cloudStatus(who);
      var ds = readDayState(st);
      var parentFetchedAt = new Date().toISOString();
      saveCloudCache({
        authoritative_day: ds.authoritative_day,
        plan_day: ds.plan_day,
        today: ds.today,
        published: ds.published,
        subjects: (st && st.modules || []).map(function (m) { return m.subject; }),
        study_passed: st && st.study_passed,
        allowed: st && st.allowed,
        reason: st && st.reason,
        source: 'parent',
        fetched_at: parentFetchedAt,
      });
      var localDay = courseDay();
      /* 云端已经跨日、本机恰好落后一天：跟上，避免孩子每天都在旧课次上打转。 */
      var followed = null;
      if (ds.today !== null && ds.today > localDay) {
        followed = followCloudDay(ds.today, localDay);
        if (followed) localDay = followed.to;
      }
      /* 本机恰好超前一天（当天两科已学完并点了「进入下一学习日」）时，
       * 仍然要把「当天」的真实记录传上去，否则孩子做完的数学英语永远进不了
       * 云端。只放宽上传：不发布、不推进、不改写 learning_day。 */
      var aheadSync = false;

      /* 老云端 + 今天还没计划：按旧行为用本机 day 发布一次。
       * 新云端会忽略这个 day（以权威日为准），并在返回里给出真实课次。 */
      if (ds.today === null) {
        if (diagnostic) {
          return saveStatus({ state: 'plan_unpublished', local_day: localDay,
            local_subjects: subjectsFor(localDay),
            message: '云端当天计划尚未发布，本次诊断未上传。' });
        }
        try {
          await publishPlan(who, localDay, subjectsFor(localDay).length === 0);
        } catch (e) {
          if (isDayNotInitialised(e)) return dayNotInitialisedStatus({ local_day: localDay });
          throw e;
        }
        st = await cloudStatus(who);
        ds = readDayState(st);
      }
      if (ds.today === null) {
        return saveStatus({ state: 'cloud_unavailable',
          local_day: localDay,
          message: '云端没有返回学习日（计划未发布且无权威日），本次不上传。',
          pending: null, pending_known: false,
          cloud_verified: false, cloud_verified_reason: 'CLOUD_DAY_UNKNOWN' });
      }

      /* ---- 关键闸门 1：本机落后于云端 ---- */
      if (ds.today > localDay) {
        return saveStatus({
          state: 'stale_device_day',
          message: '云端已到第 ' + ds.today + ' 天，本机还是第 ' + localDay
            + ' 天；本机这次不上传，避免把旧课次的成绩记到新学习日。请家长在家长入口把本机课次对齐到第 '
            + ds.today + ' 天后再试。',
          cloud_day: ds.today, local_day: localDay,
          authoritative_day: ds.authoritative_day,
          /* 只给出对齐建议，绝不自动改动本机课次；必须家长在家长入口确认。 */
          needs_day_alignment: true,
          align_target_day: ds.today,
          align_action: 'parent_align_to_cloud_day',
          align_note: '对齐只在本设备抬高课次：不改云端学习日、不清空本机记录、不删除历史成绩。',
          pending: null, pending_known: false,
          cloud_verified: false, cloud_verified_reason: 'STALE_DEVICE_DAY',
        });
      }

      /* ---- 关键闸门 2：本机超前于云端 ---- */
      if (ds.today < localDay) {
        /* 唯一放宽项：超前正好 1 天，且云端当天计划已发布。
         * 这时本机代表「今天已经学完了」，当天记录必须能上传；本机多出来的
         * 那一天（ds.today+1）的任何作答都不会被 collected（collectAnswers
         * 按 cloudDay 过滤）。超前 1 天以上，或计划还没发布，一律不提。 */
        if (ds.today + 1 === localDay && ds.published === true) {
          aheadSync = true;
        } else {
          return saveStatus({
            state: 'device_ahead',
            message: '本机是第 ' + localDay + ' 天，云端权威学习日还是第 ' + ds.today
              + ' 天；不会用本机进度自动推进，请家长在家长入口确认。',
            cloud_day: ds.today, local_day: localDay,
            authoritative_day: ds.authoritative_day,
            pending: null, pending_known: false,
            cloud_verified: false, cloud_verified_reason: 'DEVICE_AHEAD',
          });
        }
      }

      /* ---- 今天计划未发布：发布权威日 ---- */
      if (!ds.published) {
        if (diagnostic) {
          return saveStatus({ state: 'plan_unpublished', cloud_day: ds.today, local_day: localDay,
            local_subjects: subjectsFor(ds.today), cloud_subjects: [],
            message: '云端当天计划尚未发布，本次诊断未上传。' });
        }
        var conflict = null;
        try {
          await publishPlan(who, ds.today, subjectsFor(ds.today).length === 0);
        } catch (e) {
          if (isDayNotInitialised(e)) return dayNotInitialisedStatus({ local_day: localDay, cloud_day: ds.today });
          if (e.code === 'R5_TODAY_PLAN_ALREADY_PUBLISHED') conflict = e;
          else throw e;
        }
        st = await cloudStatus(who);
        ds = readDayState(st);
        if (conflict && ds.today !== localDay) {
          return saveStatus({
            state: ds.today !== null && ds.today > localDay ? 'stale_device_day' : 'cloud_day_regression',
            message: '云端今天已发布第 ' + ds.today + ' 天的计划，本机是第 ' + localDay
              + ' 天；已停止上传，以免错记。',
            cloud_day: ds.today, local_day: localDay,
            authoritative_day: ds.authoritative_day,
            pending: null, pending_known: false,
            cloud_verified: false, cloud_verified_reason: 'PLAN_LOCKED_OTHER_DAY',
          });
        }
      }

      var cloudDay = ds.today;
      if (cloudDay !== localDay && !(aheadSync === true && cloudDay + 1 === localDay)) {
        return saveStatus({
          state: cloudDay > localDay ? 'stale_device_day' : 'device_ahead',
          message: '云端第 ' + cloudDay + ' 天，本机第 ' + localDay + ' 天；已停止上传，请家长确认。',
          cloud_day: cloudDay, local_day: localDay,
          authoritative_day: ds.authoritative_day,
          pending: null, pending_known: false,
          cloud_verified: false, cloud_verified_reason: 'DAY_MISMATCH',
        });
      }

      var cloudSubjects = Array.isArray(st && st.modules)
        ? st.modules.map(function (m) { return m.subject; }).sort() : null;
      var localSubjects = subjectsFor(cloudDay).slice().sort();
      if (!cloudSubjects || JSON.stringify(cloudSubjects) !== JSON.stringify(localSubjects)) {
        return saveStatus({ state: 'subject_mismatch',
          message: '本机与云端当天课程不一致，已停止上传，请家长确认。',
          cloud_day: cloudDay, local_day: localDay,
          cloud_subjects: cloudSubjects, local_subjects: localSubjects,
          authoritative_day: ds.authoritative_day,
          pending: null, pending_known: false,
          cloud_verified: false, cloud_verified_reason: 'SUBJECT_MISMATCH' });
      }

      /* learning_day 恒为 cloudDay（= 本机 day），item 自己的学习日不会被改写。
       * v6.1.0：只上传「整轮」（摘要 + 逐题），不再由客户端写 course-complete。
       * rc8：另外把本机未确认的往日轮次按原日期/原学习日补传；补传轮次
       * 不参与今天的完成态派生，也不触发碎片奖励。 */
      var todaySh = ymdSH(new Date());
      var roundsForSession = collectRounds(state, cloudDay, todayStr);
      var todayRows = roundRows(roundsForSession);
      var seenSessionAid = {};
      roundsForSession.forEach(function (rd) { if (rd && rd.attempt_id) seenSessionAid[String(rd.attempt_id)] = true; });
      var backfillForSession = filterImprovedRounds(pendingHistoryRounds(todayStr, todaySh)).send
        .filter(function (rd) { return rd && rd.attempt_id && !seenSessionAid[String(rd.attempt_id)]; });
      var backfillRows = roundRows(backfillForSession);
      rows = todayRows.concat(backfillRows);

      if (diagnostic && !rows.length) {
        return saveStatus({ state: 'no_local_records', cloud_day: cloudDay,
          cloud_subjects: cloudSubjects, local_day: localDay,
          local_subjects: localSubjects,
          message: '当前窗口没有匹配当天的真实成绩，没有上传。' });
      }

      var up = await upload(rows, who);

      /* 完成态仍由服务端派生（家长会话也是家庭成员，可直接调用同一函数）。
       * 只对「今天」的轮次派生；往日补传不补发完成态 / 碎片奖励。 */
      for (var ri = 0; ri < roundsForSession.length; ri++) {
        try {
          var comp = await rpc('r5_child_complete_course', {
            p_family_id: CFG.familyId,
            p_subject: roundsForSession[ri].subject,
            p_day: cloudDay,
            p_attempt_id: roundsForSession[ri].attempt_id,
          }, who);
          if (comp && comp.ok && comp.completed && comp.record_id &&
              r5SpoolFragmentRecord(comp.record_id)) {
            r5KickFragmentRewards();
          }
        } catch (compErr) {
          log('派生完成态未成立', roundsForSession[ri].subject,
            String(compErr && (compErr.code || compErr.message) || 'UNKNOWN'));
        }
      }

      st = await cloudStatus(who);

      /* ---- 关键闸门 3：云端课次不允许回退 ---- */
      var after = readDayState(st);
      if (after.today !== null && after.today < cloudDay) {
        return saveStatus({
          state: 'cloud_day_regression',
          message: '云端学习日从第 ' + cloudDay + ' 天回退到第 ' + after.today
            + ' 天，已立即停止后续写入，请家长检查。',
          cloud_day: after.today, previous_cloud_day: cloudDay,
          authoritative_day: after.authoritative_day,
          uploaded: up.uploaded,
          pending: null, pending_known: false,
          cloud_verified: false, cloud_verified_reason: 'CLOUD_DAY_REGRESSION',
        });
      }

      var vf = await verifyWithRetry(todayRows, who, cloudDay);
      var pending = vf.known ? vf.missing.length : null;
      var noRows = todayRows.length === 0;
      var allThere = vf.known && vf.missing.length === 0 && !noRows;
      /* 往日补传：用精确 record_id 回读确认，只有确实落库的才标记「云端已确认」。
         读不到就保持等待，绝不用上传返回值直接冒充。 */
      var backfillConfirmed = 0;
      if (backfillForSession.length) {
        try {
          var bvf = await verifyWithRetry(backfillRows, who, cloudDay);
          if (bvf.known) {
            var missingIds = {};
            bvf.missing.forEach(function (id) { missingIds[id] = true; });
            backfillForSession.forEach(function (rd) {
              if (!rd || !rd.attempt || !rd.attempt.record_id) return;
              if (missingIds[rd.attempt.record_id]) return;
              var marked = markAttemptCloud(rd.attempt_id, 'cloud_confirmed', {
                source: 'parent-session-exact-readback', subject: rd.subject,
                day: Number(rd.day) || null, correct: Number(rd.correct), total: Number(rd.total)
              });
              if (marked) backfillConfirmed++;
            });
          }
        } catch (bvfErr) {
          log('往日补传回读确认失败，保持等待', String(bvfErr && (bvfErr.code || bvfErr.message) || 'UNKNOWN'));
        }
      }
      if (allThere && up.uploaded > 0) {
        r5LoadFragmentModules().then(function (m) {
          if (!m) return null;
          return m.reconcileToday().then(function (r) {
            return m.resumeRewardQueue().then(function (s) { return { reconcile: r, resume: s }; });
          });
        }).catch(function () {});
        r5LoadFragmentModules().then(function () {
          return r5WeeklyMod && r5WeeklyMod.resumeWeeklyGoal
            ? r5WeeklyMod.resumeWeeklyGoal() : { status: 'MODULE_UNAVAILABLE' };
        }).catch(function () {});
      }
      var stateName = !vf.known ? 'unverified' : (vf.missing.length ? 'partial' : 'ok');
      var pendingSync = pendingScoreSyncOf(st);
      var pendingVerify = pendingVerifyOf(st);
      var msg;
      var backfillNote = backfillForSession.length
        ? '；另补传往日成绩 ' + backfillForSession.length + ' 轮（按原日期原学习日，已确认 '
          + backfillConfirmed + ' 轮，不补发往日碎片）'
        : '';
      if (noRows && !backfillForSession.length) {
        msg = '第 ' + cloudDay + ' 天 · 本机还没有需要上传的成绩';
      } else if (noRows) {
        msg = '第 ' + cloudDay + ' 天 · 本机没有今天的新成绩' + backfillNote;
      } else if (stateName === 'ok') {
        msg = '第 ' + cloudDay + ' 天 · 云端已确认落库 ' + todayRows.length + ' 条'
          + '（本次新增 ' + up.uploaded + ' 条，云端已有 ' + up.already + ' 条）' + backfillNote;
      } else if (stateName === 'partial') {
        msg = '第 ' + cloudDay + ' 天 · 还有 ' + vf.missing.length + ' 条没确认落库'
          + '（已确认 ' + vf.confirmed + ' 条），本机成绩已保留，下次同步会自动重试';
      } else {
        msg = '第 ' + cloudDay + ' 天 · 成绩已提交，但没能回读确认'
          + '（网络或当天记录超过查询上限），下次同步再核对';
      }
      if (pendingSync.length) {
        msg += '；' + pendingSync.map(function (x) { return x.subject; }).join('、')
          + ' 已完成课程但成绩还没同步，赛车暂不解锁，等成绩上来会自动重算。';
      }

      /* 当天两科都通过后「不解锁下一天」，只解锁赛车。
       * 权威学习日的推进只发生在家长发布下一学习日的计划那一刻（见文件头注释）。 */
      var adv = null;
      var cloudTotalRows = await cloudTotal(who);
      var batchConfirmed = vf.known ? todayRows.length - vf.missing.length : null;

      saveStatus({
        state: stateName,
        message: msg,
        cloud_day: cloudDay,
        authoritative_day: ds.authoritative_day,
        next_day: (adv && adv.authoritative_day) || ds.authoritative_day,
        local_day: localDay,
        followed_cloud_day: followed || dayFollowedByDevice || null,
        day_source: ds.source,
        day_fetched_at: parentFetchedAt,
        device_day_error: deviceError,
        subjects: (st && st.modules || []).map(function (m) {
          return m.subject + (m.accuracy_pct == null ? '（无成绩）' : ' ' + m.accuracy_pct + '%')
            + (m.passed ? ' ✓' : ' ✗');
        }),
        grading: gradingOf(state, cloudDay, todayStr),
        allowed: !!(st && st.allowed),
        reason: st && st.reason,
        pending: pending,
        pending_known: vf.known,
        device_ahead_by_one: aheadSync === true,
        pending_score_sync: pendingSync,
        pending_verification: pendingVerify,
        uploaded: up.uploaded,
        skipped_duplicates: up.already + up.duplicates,
        reclaimed: up.reclaimed,
        synced_total: batchConfirmed,
        batch_total: todayRows.length,
        batch_confirmed: batchConfirmed,
        backfill_total: backfillForSession.length,
        backfill_confirmed: backfillConfirmed,
        cloud_total: cloudTotalRows,
        cloud_verified: allThere,
        cloud_verified_reason: noRows ? 'NO_LOCAL_ROWS'
          : (!vf.known ? 'VERIFY_UNAVAILABLE' : (vf.missing.length ? 'MISSING_RECORDS' : 'ALL_RECORDS_PRESENT')),
        cloud_checked: {
          expected: todayRows.length,
          confirmed: vf.confirmed,
          missing_sample: vf.missing.slice(0, 5),
          scanned: vf.scanned,
          truncated: !!vf.truncated,
        },
        advance: adv,
        build: BRIDGE_BUILD,
        verified_at: new Date().toISOString(),
      });
      log('同步完成', cloudDay, '新增', up.uploaded, '条', '待确认', pending,
        '待同步科目', pendingSync.length, st && st.reason);
      return readStatus();
    } catch (e) {
      var code = (e && (e.code || e.message)) || 'UNKNOWN';
      var noSession = code === 'NO_SESSION' || code === 'NO_TOKEN';
      /* 本机没有家长登录凭证，只影响「本机成绩上传」这一件事。
       * 每日结算由服务端定时任务独立完成，不依赖任何浏览器登录；
       * 文案必须说清这一点，否则家长会以为整个学习链条断了。 */
      var hint = noSession
        ? '这台设备还没有家长登录云端的凭证，所以本机成绩暂时无法上传（成绩仍安全保存在本机）。'
          + '云端学习日的每日结算由服务器独立完成，不受本机是否登录影响；'
          + '在「家庭同步」页登录一次即可恢复上传，并自动对齐到云端学习日。'
        : String(code);
      saveStatus({
        state: 'error', error: code,
        auth_required: noSession,
        cloud_settled_by_server: true,
        message: hint + ' 本机成绩已保留，下次同步会自动重试。',
        pending: (typeof rows !== 'undefined' && rows) ? rows.length : null,
        pending_known: false,
        cloud_verified: false,
        cloud_verified_reason: 'UPLOAD_FAILED',
        build: BRIDGE_BUILD,
      });
      log('同步失败', code);
      return readStatus();
    } finally {
      running = false;
    }
  }

  function run(force) {
    var now = Date.now();
    if (!force && now - lastRun < 15000) return Promise.resolve(readStatus());
    lastRun = now;
    return runOnce().catch(function (e) {
      log('run 异常', e);
      return readStatus();
    });
  }

  /** 按科目汇总今天能拿到的题量与正确数（给家长自检页看，不改任何数据） */
  function gradingOf(state, day, todayStr) {
    var items = collectItems(state, day, todayStr).filter(function (it) { return it.day === day; });
    var out = {};
    items.forEach(function (it) {
      var s = CFG.subjectName[it.subj];
      if (!out[s]) out[s] = { subject: s, total: 0, correct: 0, perQuestion: 0, aggregate: 0, sources: {} };
      out[s].total++;
      if (it.correct) out[s].correct++;
      if (it.perQuestion) out[s].perQuestion++; else out[s].aggregate++;
      out[s].sources[it.track] = (out[s].sources[it.track] || 0) + 1;
    });
    return Object.keys(out).map(function (k) {
      var g = out[k];
      g.accuracy_pct = g.total ? Math.round(g.correct * 100 / g.total) : null;
      g.passed = g.total > 0 && g.correct * 100 >= 80 * g.total;
      return g;
    });
  }

  /* -------------------------------------------------- 语文页面得分抓取（只读） */

  /**
   * V6 有 5 个语文页面会算出成绩但不向父页面汇报。
   * 这里在父页面侧注入一段**只读**观察脚本：只监听页面上出现的「答对 X / Y 题」，
   * 不碰课程任何逻辑、不改题目、不改答案。抓不到就等于没抓，不会影响孩子上课。
   */
  var CN_CAPTURE = function () {
    var sent = '';
    var re = /答对\s*(\d+)\s*\/\s*(\d+)\s*题/;
    function tick() {
      var text = '';
      try { text = document.body ? document.body.textContent || '' : ''; } catch (e) { return; }
      var m = text.match(re);
      if (!m) return;
      var sig = m[1] + '/' + m[2];
      if (sig === sent) return;
      sent = sig;
      try {
        window.parent.postMessage({
          type: 'v6-cn-quiz-score',
          score: Number(m[1]),
          total: Number(m[2]),
          at: new Date().toISOString(),
        }, window.location.origin);
      } catch (e) { /* ignore */ }
    }
    try {
      new MutationObserver(tick).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    } catch (e) { /* ignore */ }
    setInterval(tick, 2000);
    tick();
  };

  function attachChineseCapture() {
    var frame = document.getElementById('lionLessonFrame');
    if (!frame) return;
    function attach() {
      try {
        var doc = frame.contentDocument;
        if (!doc || doc.__r5CnCapture) return;
        doc.__r5CnCapture = true;
        var s = doc.createElement('script');
        s.textContent = '(' + CN_CAPTURE.toString() + ')();';
        (doc.body || doc.documentElement).appendChild(s);
      } catch (e) { /* 跨域或还没加载好：忽略 */ }
    }
    frame.addEventListener('load', attach);
    attach();
  }

  window.addEventListener('message', function (e) {
    if (!e.data || e.data.type !== 'v6-cn-quiz-score') return;
    /* 带逐题证据的完整交卷由 chinese-classroom.js 的专用入口保存；
       DOM 文本观察器不得把这份证据再折算成一条只有分数的摘要。 */
    if (Array.isArray(e.data.answers) || e.data.attemptId || e.data.source) return;
    try { if (e.origin !== location.origin) return; } catch (x) { return; }
    var frame = document.getElementById('lionLessonFrame');
    if (!frame || e.source !== frame.contentWindow) return;
    var score = Number(e.data.score);
    var total = Number(e.data.total);
    if (!Number.isInteger(score) || !Number.isInteger(total) || total <= 0 || score < 0 || score > total) return;
    try { if (window.__cnPreviewMode) return; } catch (x) { /* ignore */ }
    if (typeof v6CourseStarted === 'function' && !v6CourseStarted()) return;
    var day = 0;
    try { if (typeof novSelected === 'number') day = novSelected; } catch (x) { day = 0; }
    if (!Number.isInteger(day) || day < 1 || day > CFG.maxDay) day = courseDay();
    // The embedded lesson reports its planned learning day. An old iframe, a
    // different lesson or a cross-day tab must never create a score for today.
    if (e.data.lessonDay != null && Number(e.data.lessonDay) !== day) return;

    if (day !== courseDay() || subjectsFor(day).indexOf('语文') < 0) return;
    var current = readLiveState();
    if (!current || typeof current !== 'object') return;
    if (!current.dailyChinese || typeof current.dailyChinese !== 'object') current.dailyChinese = {};
    var pack = current.dailyChinese[day] || {};
    var previous = pack.cnPageQuiz;
    if (previous && Number.isInteger(previous.total) && previous.total >= total) return;
    // The child has completed a longer, revised question set. Preserve the
    // original 3-question attempt as history and independently store the
    // genuine full-length result. Never fabricate ten results from 3/3.
    if (previous) {
      if (!Array.isArray(pack.cnPageQuizHistory)) pack.cnPageQuizHistory = [];
      pack.cnPageQuizHistory.push(previous);
    }
    pack.cnPageQuiz = { score: score, total: total, at: new Date().toISOString(),
      source: total >= 10 ? 'dom-capture-expanded' : 'dom-capture' };
    current.dailyChinese[day] = pack;
    if (typeof save === 'function') { try { save(); } catch (x) { /* ignore */ } }
    try { localStorage.setItem(CFG.stateKey, JSON.stringify(current)); } catch (x) { /* ignore */ }
  });

  /* 完整交卷落盘后立即走既有设备身份上传流程；断网时 run() 会安全返回，
     本机记录保持原样，联网/回到前台会由既有定时器继续补传。 */
  window.addEventListener('message', function (e) {
    if (!e.data || (e.data.type !== 'v6-cn-attempt-saved' && e.data.type !== 'v6-course-attempt-saved')) return;
    try { if (e.origin !== location.origin) return; } catch (x) { return; }
    setTimeout(function () { try { run(true); } catch (x) { /* 本机记录不受影响 */ } }, 600);
  });

  /* ------------------------------------------------------ 对外接口 & 触发器 */

  window.R5Bridge = {
    roundsFor: function (day) {
      try {
        var rd = collectRounds(readState(), day || courseDay(), today());
        return rd.map(function (r) {
          return { subject: r.subject, code: r.code, day: r.day, attempt_id: r.attempt_id,
                   correct: r.correct, total: r.total, answers: (r.answers || []).length };
        });
      } catch (e) { return { error: String(e && e.message || e) }; }
    },
    version: BRIDGE_BUILD,
    build: BRIDGE_BUILD,
    run: run,
    inspectCloud: async function () {
      var st = await cloudStatus(await identity());
      var ds = readDayState(st);
      return {
        cloud_day: ds.plan_day,
        authoritative_day: ds.authoritative_day,
        today_day: ds.today,
        cloud_subjects: (st && st.modules || []).map(function (m) { return m.subject; }),
        // Read-only, authenticated per-subject server verdict. Do not infer a
        // learning result from the unrelated remaining racing time/quota.
        modules: (st && Array.isArray(st.modules) ? st.modules : []).map(function(m) {
          return {
            subject: m.subject, completed: m.completed === true,
            total: Number.isFinite(Number(m.total)) ? Number(m.total) : null,
            correct: Number.isFinite(Number(m.correct)) ? Number(m.correct) : null,
            accuracy_pct: Number.isFinite(Number(m.accuracy_pct)) ? Number(m.accuracy_pct) : null,
            passed: m.passed === true ? true : m.passed === false ? false : null,
            evidence: m.evidence || null,
            credential_status: m.credential_status || null,
            pending_score_sync: m.pending_score_sync === true,
            pending_reasons: m.pending_reasons || null,
            graded_day: m.graded_day == null ? null : m.graded_day
          };
        }),
        study_passed: st && typeof st.study_passed === 'boolean' ? st.study_passed : null,
        racing_allowed: st && typeof st.allowed === 'boolean' ? st.allowed : null,
        schedule_published: !!(st && st.schedule_published),
        pending_score_sync: pendingScoreSyncOf(st),
        pending_verification: pendingVerifyOf(st),
        reason: st && st.reason,
      };
    },
    /**
     * 设备身份只读学习日：不需要家长会话，凭已绑定设备令牌向 R5 网关查询。
     * 只读，不写学习记录，不改云端学习日。
     */
    inspectCloudDevice: async function () {
      var d = await gatewayReadDay();
      d.local_day = courseDay();
      return d;
    },
    /** 本机一次性授权（家长口令只用于这一次请求，不保存） */
    bindThisDevice: bindThisDevice,
    /** 上次成功读取的云端学习日缓存（含核对时间），只用于展示，不等于当前状态 */
    cachedCloud: readCloudCache,
    /**
     * 统一云端视图：家长实时 → 设备实时 → 上次缓存（标记 stale）。
     * 缓存只用于告知「上次核对到第几日」，绝不把旧达标结论当作当前结论。
     */
    cloudView: async function () {
      var attempts = [];
      var norm = function (mods) {
        return (Array.isArray(mods) ? mods : []).map(function (m) {
          return {
            subject: m.subject, completed: m.completed === true,
            total: Number.isFinite(Number(m.total)) ? Number(m.total) : null,
            correct: Number.isFinite(Number(m.correct)) ? Number(m.correct) : null,
            accuracy_pct: Number.isFinite(Number(m.accuracy_pct)) ? Number(m.accuracy_pct) : null,
            passed: m.passed === true ? true : m.passed === false ? false : null,
            evidence: m.evidence || null,
            credential_status: m.credential_status || null,
            pending_score_sync: m.pending_score_sync === true,
            pending_reasons: m.pending_reasons || null,
            graded_day: m.graded_day == null ? null : m.graded_day,
          };
        });
      };
      try {
        var st = await cloudStatus(await identity());
        var ds = readDayState(st);
        var at = new Date().toISOString();
        var view = {
          ok: true, source: 'parent', source_label: '家长会话实时',
          fetched_at: at, stale: false,
          authoritative_day: ds.authoritative_day,
          today_day: ds.today, cloud_day: ds.plan_day,
          cloud_subjects: (st && st.modules || []).map(function (m) { return m.subject; }),
          modules: norm(st && st.modules),
          study_passed: st && typeof st.study_passed === 'boolean' ? st.study_passed : null,
          racing_allowed: st && typeof st.allowed === 'boolean' ? st.allowed : null,
          schedule_published: !!(st && st.schedule_published),
          reason: st && st.reason,
          local_day: courseDay(),
          attempts: attempts,
        };
        saveCloudCache({
          authoritative_day: ds.authoritative_day, plan_day: ds.plan_day, today: ds.today,
          published: ds.published, subjects: view.cloud_subjects,
          study_passed: view.study_passed, allowed: view.racing_allowed,
          reason: view.reason, source: 'parent', fetched_at: at,
        });
        return view;
      } catch (e) {
        attempts.push({ source: 'parent', error: String(e && (e.code || e.message) || 'UNKNOWN') });
      }
      try {
        var dev = await gatewayReadDay();
        saveCloudCache(dev);
        attempts.push({ source: 'device', error: null });
        return {
          ok: true, source: 'device', source_label: '设备身份实时（无需家长登录）',
          fetched_at: dev.fetched_at, stale: false,
          authoritative_day: dev.authoritative_day,
          today_day: dev.today, cloud_day: dev.plan_day,
          cloud_subjects: dev.subjects,
          modules: norm(dev.modules),
          study_passed: dev.study_passed,
          racing_allowed: dev.allowed,
          schedule_published: dev.published,
          reason: dev.reason,
          remaining_seconds: dev.remaining_seconds,
          local_day: courseDay(),
          attempts: attempts,
        };
      } catch (e2) {
        attempts.push({ source: 'device', error: String(e2 && (e2.code || e2.message) || 'UNKNOWN') });
      }
      var c = readCloudCache();
      return {
        ok: false, source: c ? 'cache' : 'none',
        source_label: c ? '上次核对结果（缓存）' : '没有可用数据',
        fetched_at: c ? c.fetched_at : null,
        stale: true,
        authoritative_day: c ? c.authoritative_day : null,
        today_day: c ? c.today : null,
        cloud_day: c ? c.plan_day : null,
        cloud_subjects: c ? (c.subjects || []) : [],
        modules: [],
        /* 缓存里的达标结论只能作为历史参考，绝不冒充当前状态 */
        study_passed: null,
        cached_study_passed: c ? c.study_passed : null,
        racing_allowed: null,
        cached_racing_allowed: c ? c.allowed : null,
        schedule_published: c ? c.published : null,
        reason: null,
        local_day: courseDay(),
        attempts: attempts,
      };
    },
    /**
     * 权威学习日对照：本机 vs 云端。
     * 家长会话优先；会话过期时退回设备身份只读，仍然给出权威学习日。
     */
    dayInfo: async function () {
      var localDay = courseDay();
      var ds, source;
      try {
        var st = await cloudStatus(await identity());
        ds = readDayState(st);
        source = 'parent';
      } catch (e) {
        var dev = await gatewayReadDay();
        ds = readDayState(dev.raw);
        source = 'device';
      }
      return {
        local_day: localDay,
        cloud_day: ds.plan_day,
        authoritative_day: ds.authoritative_day,
        today_day: ds.today,
        aligned: ds.today === localDay,
        stale_device_day: ds.today !== null && ds.today > localDay,
        device_ahead: ds.today !== null && ds.today < localDay,
        day_source: source,
        build: BRIDGE_BUILD,
      };
    },
    runNow: function () { return run(true); },
    status: readStatus,
    installChineseCapture: attachChineseCapture,
    /** 今天各科能拿到的真实题量与正确数（不写云端，纯本地计算） */
    grading: function () {
      var s = readState();
      return s ? gradingOf(s, courseDay(), today()) : [];
    },
    diagnose: function () {
      var s = readState();
      var day = courseDay();
      var mathStore = readJson(CFG.courseKey.ma);
      return {
        today: today(),
        localDay: day,
        subjects: subjectsFor(day),
        hasState: !!s,
        records: s ? s.records.length : 0,
        chineseDays: s && s.dailyChinese ? Object.keys(s.dailyChinese) : [],
        courseKeys: {
          math: mathStore ? Object.keys(mathStore) : [],
          science: readJson(CFG.courseKey.sc) ? Object.keys(readJson(CFG.courseKey.sc)) : [],
          english: readJson(CFG.courseKey.en) ? Object.keys(readJson(CFG.courseKey.en)) : [],
        },
        grading: s ? gradingOf(s, day, today()) : [],
        cloud: readStatus(),
        build: BRIDGE_BUILD,
      };
    },
    collectAnswers: function () {
      var s = readState();
      return s ? collectAnswers(s, courseDay(), today()) : [];
    },

    /* 诊断/测试用：本机某一天会拼成哪几整轮（不写任何东西） */
    collectRounds: function () {
      var s = readState();
      return s ? collectRounds(s, courseDay(), today()) : [];
    },

    /**
     * 兜底入口：给将来新增的、还没落盘的客观题用。
     * 只写本机 state.records，不直接写云端，也不做任何凑数。
     *   R5Bridge.recordAnswer('数学', 学习日, 题号, 是否正确)
     */
    recordAnswer: function (subjectKey, day, index, correct) {
      var key = CFG.subjectKey[subjectKey] || subjectKey;
      if (!CFG.subjectName[key]) return false;
      if (typeof correct !== 'boolean') return false;
      var d = Number(day);
      if (!Number.isInteger(d) || d < 1 || d > CFG.maxDay) return false;
      if (d !== courseDay() || subjectsFor(d).indexOf(CFG.subjectName[key]) < 0) return false;
      if (typeof v6CourseStarted === 'function' && !v6CourseStarted()) return false;
      var live = readLiveState();
      if (!live || !Array.isArray(live.records)) return false;
      live.records.push({
        subject: key,
        track: '课程小测',
        index: Number(index) || 0,
        learningDay: d,
        skill: '课程小测·' + d,
        level: 1,
        correct: correct,
        choice: null,
        date: today(),
      });
      if (typeof save === 'function') { try { save(); } catch (e) { /* ignore */ } }
      try { localStorage.setItem(CFG.stateKey, JSON.stringify(live)); } catch (e) { /* ignore */ }
      return true;
    },
  };

  if (diagnostic) return;
  // 打开页面 3 秒后跑一次，之后每 60 秒、回到前台、联网都再试
  r5LoadFragmentModules().then(function (m) {
    if (m && m.resumeRewardQueue) m.resumeRewardQueue().catch(function () {});
  }).catch(function () {});
  setTimeout(function () { run(false); attachChineseCapture(); }, 3000);
  setInterval(function () { run(false); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { run(false); attachChineseCapture(); } });
  window.addEventListener('online', function () { run(false); });
  window.addEventListener('pageshow', function () { run(false); attachChineseCapture(); });
})();
