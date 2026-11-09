/* ============================================================================
 * v6/r5-bridge.js — V6 学习平台 → 腾讯云 R5 赛车闸门 的桥接器（v2）
 *
 * v2 相对 v1 的关键变化（对应第四轮「成绩记录修复」）：
 *   1. **不再只看 state.records**：数学课件、科学课件、英语课件各自把逐题结果写在
 *      自己的 localStorage 键里，这里直接把真实结果读出来，不重复开发题库；
 *   2. **语文页面闯关**（只有得分、没有逐题明细的那种）按「题组」如实折算：
 *      score 题记正确、其余记错误，总数与得分都不变，并打上 derived 标记；
 *   3. **同题去重**：每道题一天只算一次（首次作答），重复点击 / 反复练习不会重复计数；
 *   4. **主观活动排除**：拼音跟读（语音识别）、描红（画布）没有客观正确率，
 *      一律不采集、不按 100% 计算；
 *   5. 记录 ID 与「第几题」解耦，重跑不会因为数组顺序变化而重复上传。
 *
 * 判定仍然完全在云端：r5_status 只认「course-complete + answer 条数>0 + 正确率≥80%」。
 * 这里不做阈值判断，不写孩子的历史成绩，不补题、不改课。
 *
 * 依赖：V6 页面里的全局 state / v6CourseDay() / V6_SUBJECT_DAYS（同页脚本可直接访问）。
 * ==========================================================================*/
(function () {
  'use strict';

  var BRIDGE_BUILD = '2026-11-09.multidevice-4';

  var CFG = {
    familyId: 'little-growth-family-001',
    env: 'normal-goose-d5g4qyzr8bb389a4a',
    region: 'ap-shanghai',
    restBase: 'https://normal-goose-d5g4qyzr8bb389a4a.api.tcloudbasegateway.com/v1/rdb/rest',
    stateKey: 'growth-workbench-v6-adaptive-2',
    deviceKey: 'v6-family-sync-device-id',
    statusKey: 'v6-r5-bridge-status',
    offKey: 'v6-r5-bridge-off',
    // 各课件自己的进度键（真实成绩来源，见 docs/GRADING_AUDIT.md）
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
      var next = Object.assign({ at: new Date().toISOString() }, prev, patch || {});
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

  /* v1.8.0-rc2 / r5-prodlink-date-fix
   * 课件进度里的 at 是 new Date().toISOString()（UTC）。东八区 00:00-08:00 之间
   * 用 at.slice(0,10) 取到的是「昨天」，会把当天成绩整批判成过期丢弃。
   * 这里统一按本地时区解析；纯 YYYY-MM-DD 字符串原样返回。 */
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

  function courseDay() {
    try {
      if (typeof v6CourseDay === 'function') return Number(v6CourseDay()) || 1;
    } catch (e) { /* fall through */ }
    var s = readState();
    var done = (s && s.v6Course && s.v6Course.completedDays) || {};
    for (var d = 1; d <= CFG.maxDay; d++) if (!done[d]) return d;
    return CFG.maxDay;
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
   * V6 的规则：某科目的第 N 课，排在该科目出现的第 N 个学习日。
   * 直接用 V6_SUBJECT_DAYS 推导，不另存一份日期表（避免两边不同步）。
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

  function cloudStatus(who) {
    return rpc('r5_status', { p_family_id: CFG.familyId }, who);
  }

  function publishPlan(who, day, noTasks) {
    return rpc('r5_publish_today', {
      p_family_id: CFG.familyId,
      p_day_index: day,
      p_no_tasks: !!noTasks,
    }, who);
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
        index: Number(r.index) || i,
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
   *    - 数学：results[].firstTry（课件定义就是「首次答对」，不是我们改的口径）
   *    - 科学：answers[].correct + correctIndex
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
   *    按「题组」如实折算：得分几题就记几题正确，总数不变。
   *    这类记录带 derived:'quiz-aggregate'，方便日后核对，不代表具体哪一题对错。
   *    如果同一页面被 DOM 抓取过（cnPageQuiz），只在没有官方数据时才用，避免重复。
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

      if (!quizzes.length && pack.cnPageQuiz) {
        var c = pack.cnPageQuiz;
        if (Number.isInteger(c.score) && Number.isInteger(c.total) && c.total > 0
            && c.score >= 0 && c.score <= c.total && ymdOf(c.at) === todayStr) {
          quizzes.push({ name: 'cnPageQuiz', score: c.score, total: c.total });
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
      learning_day: item.day,
      record_data: { version: 1, source: item.source, index: item.index, answer: answer },
    };
  }

  function collectAnswers(state, day, todayStr) {
    var device = deviceId();
    return collectItems(state, day, todayStr)
      .filter(function (it) { return it.day === day; })
      .map(function (it) { return toRow(it, device); });
  }

  function collectCompletions(state, day, todayStr) {
    var device = deviceId();
    var subs = (state.v6Course && state.v6Course.subjects) || {};
    var pack = subs[day] || {};
    var out = [];
    Object.keys(pack).forEach(function (name) {
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
   * 服务端原子抢占（首选路径，依赖 007_answer_dedupe.sql）。
   *
   * r5_answer_dedupe 的主键 (family_id, subject, answer_date, track, q_index) 就是
   * 唯一约束，服务端用 INSERT ... ON CONFLICT DO NOTHING 完成抢占 —— 两台设备
   * 同时上传同一道题时，只有一台能 RETURNING 到行，另一台拿到 duplicates。
   * 这是数据库层的原子保证，不是「先查再判断」的时序假设。
   *
   * 服务端对「同一台设备 + 同一个 record_id」的重试会返回 reclaimed：
   * 本机上次抢到了但 POST 失败时，10 分钟内重试不会被自己判成已同步。
   *
   * 返回 null 表示 RPC 不可用（未部署 / 网络失败 / 权限不足），
   * 调用方降级到「读云端当天记录再过滤」，同步本身永不中断。
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
   * 降级路径：云端当天已有的「答题/完成指纹」集合。
   * 指纹 = 学科|日期|关卡|题号；课程完成记录用 track='__course__', index=0。
   * 读不到就返回 null，保持原有的按 record_id 去重。
   * 注意：并发下两台设备可能同时读到空集合，这条路只做兜底，不作为并发保证。
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

  /** 按 record_id 精确回查：只查本机这批 id，不会因为历史记录多而被 limit 截断。 */
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

  /** 当天题目指纹（用于判断「别的设备已经传过这道题」），带截断标记。 */
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
   *
   * 为什么不能看 r5_status：r5_status 的 modules 只说明云端有这个科目的记录，
   * 可能全部来自另一台设备；本机 POST 静默失败时它照样返回 modules。
   * 所以 cloud_verified 只能建立在「按 record_id 或题目指纹能在正表里找到」之上。
   *
   * known=false 表示这次没能力判断（读不到 / 当天记录超过上限），
   * 此时 pending 必须是 null，绝不能报 0。
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

  /**
   * 另一台设备可能正在写同一天的记录。给 0.6 秒再确认一次，
   * 避免把「正在上传」误报成「没落库」——但绝不把「确认不到」当成已确认。
   */
  async function verifyWithRetry(rows, who, day) {
    var vf = await verifyPersisted(rows, who, day);
    if (!rows.length || (vf.known && !vf.missing.length)) return vf;
    await sleepMs(600);
    var again = await verifyPersisted(rows, who, day);
    return again.known ? again : vf;
  }

  /**
   * 上传。返回值是统计对象，不再是条数：
   *   uploaded   本次真正写入的条数
   *   already    云端本来就有（按 record_id）
   *   duplicates 别的设备抢占在先（按题目指纹）
   *   reclaimed  本机重试自己上次没落库的占位
   */
  async function upload(rows, who) {
    var out = { uploaded: 0, already: 0, duplicates: 0, reclaimed: 0 };
    if (!rows.length) return out;
    var have = await existingIds(who);
    var fresh = rows.filter(function (r) { return !have.has(r.record_id); });
    out.already = rows.length - fresh.length;
    if (!fresh.length) return out;

    var claim = await claimOnServer(fresh, who);
    if (claim) {
      // ① 原子抢占：只上传本机抢到的，其余是别的设备已经传过的
      out.reclaimed = claim.reclaimed.size;
      fresh = fresh.filter(function (r) { return claim.claimed.has(r.record_id); });
      out.duplicates += claim.duplicates.size;
    } else {
      // ② RPC 不可用：降级为读后过滤（不保证并发安全，但不阻塞同步）
      var day = fresh[0].learning_day;
      var seenQ = await cloudQuestionKeys(who, day);
      if (seenQ) {
        var before = fresh.length;
        fresh = fresh.filter(function (r) { return !seenQ[fingerprint(r)]; });
        out.duplicates += before - fresh.length;
      }
    }
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
    saveStatus({ state: 'running' });
    try {
      var who = await identity();
      var day = courseDay();
      var subs = subjectsFor(day);
      var rest = subs.length === 0;

      var st = await cloudStatus(who);
      if (!st || st.schedule_published !== true) {
        try {
          await publishPlan(who, day, rest);
        } catch (e) {
          if (e.code === 'R5_TODAY_PLAN_ALREADY_PUBLISHED') {
            st = await cloudStatus(who);
            saveStatus({
              state: 'plan_conflict',
              message: '今天云端已发布别的学习计划（第 ' + (st && st.study_day) + ' 天），本机是第 ' + day + ' 天，已停止上传以免错记。',
              cloud_day: st && st.study_day, local_day: day,
            });
            return readStatus();
          }
          throw e;
        }
        st = await cloudStatus(who);
      }

      var cloudDay = Number(st && st.study_day) || day;
      var todayStr = today();

      if (cloudDay !== day) {
        saveStatus({
          state: 'day_mismatch',
          message: '云端今天是第 ' + cloudDay + ' 天，V6 本机是第 ' + day + ' 天；已停止上传，请家长确认。',
          cloud_day: cloudDay, local_day: day,
        });
        return readStatus();
      }

      var cloudSubjects = Array.isArray(st && st.modules)
        ? st.modules.map(function (m) { return m.subject; }).sort() : null;
      var localSubjects = subs.slice().sort();
      if (!cloudSubjects || JSON.stringify(cloudSubjects) !== JSON.stringify(localSubjects)) {
        return saveStatus({ state: 'subject_mismatch',
          message: '本机与云端当天课程不一致，已停止上传，请家长确认。',
          cloud_day: cloudDay, local_day: day,
          cloud_subjects: cloudSubjects, local_subjects: localSubjects });
      }
      var rows = collectAnswers(state, cloudDay, todayStr).concat(collectCompletions(state, cloudDay, todayStr));
      var up = await upload(rows, who);
      st = await cloudStatus(who);

      /* 关键修正（r5-birthday-multidevice v4）：
       * 不能再用「r5_status 有没有 modules」当 cloud_verified —— modules 可能全部
       * 来自另一台设备，本机这条 POST 失败它照样有值。这里回读正表逐条确认：
       *   先按 record_id 精确查本机这批（不会被历史条数截断），
       *   查不到的再按「学科|日期|关卡|题号」指纹判断是否已被别的设备传过。
       * 任何一步读不到 → pending 记 null（未知），绝不报 0。 */
      var vf = await verifyWithRetry(rows, who, cloudDay);
      var pending = vf.known ? vf.missing.length : null;
      var noRows = rows.length === 0;
      var allThere = vf.known && vf.missing.length === 0 && !noRows;
      var stateName = !vf.known ? 'unverified' : (vf.missing.length ? 'partial' : 'ok');
      var msg;
      if (noRows) {
        msg = '第 ' + cloudDay + ' 天 · 本机还没有需要上传的成绩';
      } else if (stateName === 'ok') {
        msg = '第 ' + cloudDay + ' 天 · 云端已确认落库 ' + rows.length + ' 条'
          + '（本次新增 ' + up.uploaded + ' 条，云端已有 ' + up.already + ' 条）';
      } else if (stateName === 'partial') {
        msg = '第 ' + cloudDay + ' 天 · 还有 ' + vf.missing.length + ' 条没确认落库'
          + '（已确认 ' + vf.confirmed + ' 条），本机成绩已保留，下次同步会自动重试';
      } else {
        msg = '第 ' + cloudDay + ' 天 · 成绩已提交，但没能回读确认'
          + '（网络或当天记录超过查询上限），下次同步再核对';
      }
      saveStatus({
        state: stateName,
        message: msg,
        cloud_day: cloudDay,
        subjects: (st && st.modules || []).map(function (m) {
          return m.subject + (m.accuracy_pct == null ? '（无成绩）' : ' ' + m.accuracy_pct + '%') + (m.passed ? ' ✓' : ' ✗');
        }),
        grading: gradingOf(state, cloudDay, todayStr),
        allowed: !!(st && st.allowed),
        reason: st && st.reason,
        // pending：确认未落库的条数；null = 这次无法判断（不是 0）
        pending: pending,
        pending_known: vf.known,
        uploaded: up.uploaded,
        skipped_duplicates: up.already + up.duplicates,
        reclaimed: up.reclaimed,
        synced_total: vf.known ? rows.length - vf.missing.length : null,
        cloud_verified: allThere,
        cloud_verified_reason: noRows ? 'NO_LOCAL_ROWS'
          : (!vf.known ? 'VERIFY_UNAVAILABLE' : (vf.missing.length ? 'MISSING_RECORDS' : 'ALL_RECORDS_PRESENT')),
        cloud_checked: {
          expected: rows.length,
          confirmed: vf.confirmed,
          missing_sample: vf.missing.slice(0, 5),
          scanned: vf.scanned,
          truncated: !!vf.truncated,
        },
        verified_at: new Date().toISOString(),
      });
      log('同步完成', cloudDay, '新增', up.uploaded, '条', '待确认', pending, st && st.reason);
      return readStatus();
    } catch (e) {
      var code = (e && (e.code || e.message)) || 'UNKNOWN';
      var hint = code === 'NO_SESSION' || code === 'NO_TOKEN'
        ? '这台设备还没有家长登录云端的凭证：请在「家庭同步」页登录一次（成绩仍安全保存在本机）。'
        : String(code);
      // 上传失败：本机这批一律算「待上传」，让家长看到真实的 pending
      saveStatus({
        state: 'error', error: code,
        message: hint + ' 本机成绩已保留，下次同步会自动重试。',
        pending: (typeof rows !== 'undefined' && rows) ? rows.length : null,
        pending_known: false,
        cloud_verified: false,
        cloud_verified_reason: 'UPLOAD_FAILED',
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
   * V6 有 5 个语文页面（第 4/6/7/9/11/13 天）会算出成绩但不向父页面汇报。
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

    if (day !== courseDay() || subjectsFor(day).indexOf('语文') < 0) return;
    var current = readLiveState();
    if (!current || typeof current !== 'object') return;
    if (!current.dailyChinese || typeof current.dailyChinese !== 'object') current.dailyChinese = {};
    var pack = current.dailyChinese[day] || {};
    if (pack.cnPageQuiz) return;                       // 只留第一次
    pack.cnPageQuiz = { score: score, total: total, at: new Date().toISOString(), source: 'dom-capture' };
    current.dailyChinese[day] = pack;
    if (typeof save === 'function') { try { save(); } catch (x) { /* ignore */ } }
    try { localStorage.setItem(CFG.stateKey, JSON.stringify(current)); } catch (x) { /* ignore */ }
  });

  /* ------------------------------------------------------ 对外接口 & 触发器 */

  window.R5Bridge = {
    version: '2026-11-09.prodlink-rc2',
    run: run,
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
      };
    },
    collectAnswers: function () {
      var s = readState();
      return s ? collectAnswers(s, courseDay(), today()) : [];
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

  // 打开页面 3 秒后跑一次，之后每 60 秒、回到前台、联网都再试
  setTimeout(function () { run(false); attachChineseCapture(); }, 3000);
  setInterval(function () { run(false); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { run(false); attachChineseCapture(); } });
  window.addEventListener('online', function () { run(false); });
  window.addEventListener('pageshow', function () { run(false); attachChineseCapture(); });
})();
