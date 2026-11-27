/* V6 四科完整交卷本机保存桥接（数学 / 英语 / 科学；语文沿用 chinese-attempt.js）。
   2026-11-27 四科成绩修复版。

   原则：
   1. 只有「同一轮摘要 + 条数/题号/对错都与答题过程一致的逐题答案」才算完整记录；
   2. 先写本机两份独立存档并回读校验，再通知父页面进入既有设备身份上传流程；
   3. attempt_id 每轮唯一，重复上报同一 id 不会新增第二份成绩；
   4. 云端确认状态只能由上传链路回写，页面自身绝不擅自显示「云端已确认」；
   5. 不触碰题目、答案判分、学习日推进、家长授权、语音、周测和碎片奖励逻辑。 */
(function () {
  'use strict';

  var BUILD = '20261127-four-score-v1';
  var ATTEMPT_KEY = 'v6-attempt-history-v1';
  var LOCAL_KEY = 'v6-course-attempt-history-v1';
  var STATUS_KEY = 'v6-course-attempt-status-v1';
  var BADGE_ID = 'v6-course-save-status';
  var SUBJECTS = ['语文', '数学', '英语', '科学'];
  var LESSON_DAYS = {
    '数学': [2, 3, 5, 6, 9, 10, 12, 13, 16, 17, 19, 20, 23, 24, 26, 27, 30],
    '英语': [1, 3, 4, 7, 8, 10, 11, 14, 15, 17, 18, 21, 22, 24, 25, 28, 29],
    '科学': [1, 5, 8, 12, 15, 19, 22, 26, 29]
  };
  var current = null;

  function read(key) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || 'null');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (e) { return {}; }
  }

  function writeJson(key, value) {
    try {
      var text = JSON.stringify(value);
      localStorage.setItem(key, text);
      return localStorage.getItem(key) === text;
    } catch (e) { return false; }
  }

  function uuid() {
    try {
      if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return 'ca-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function normalizeAnswers(input, total) {
    if (!Array.isArray(input) || input.length !== total) return null;
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < total; i += 1) {
      var a = input[i];
      if (!a || typeof a !== 'object') return null;
      var index = Number(a.index);
      if (!Number.isInteger(index) || index !== i || seen[index]) return null;
      seen[index] = true;
      if (typeof a.correct !== 'boolean') return null;
      out.push({
        index: index,
        choice: a.choice === undefined || a.choice === null ? null : a.choice,
        correct: a.correct
      });
    }
    return out;
  }

  function pageContext() {
    var params = new URLSearchParams(location.search);
    var subject = params.get('subject') || document.body.dataset.v6Subject || '';
    var lesson = Number(params.get('lesson'));
    var day = Number(params.get('learningDay') || params.get('lessonDay'));
    if ((!Number.isInteger(day) || day < 1 || day > 30) && Number.isInteger(lesson) && LESSON_DAYS[subject]) {
      day = LESSON_DAYS[subject][lesson - 1] || 0;
    }
    return { subject: SUBJECTS.indexOf(subject) >= 0 ? subject : '', day: day, lesson: lesson };
  }

  function badge() {
    var node = document.getElementById(BADGE_ID);
    if (node) return node;
    node = document.createElement('div');
    node.id = BADGE_ID;
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.style.cssText = 'position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:2147483647;'
      + 'max-width:min(92vw,420px);padding:10px 12px;border-radius:12px;background:#f4f8ff;color:#1b4f72;'
      + 'border:1px solid #9dc9e6;box-shadow:0 4px 16px #0002;font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif';
    node.dataset.state = 'none';
    (document.body || document.documentElement).appendChild(node);
    return node;
  }

  function show(text, state) {
    var node = badge();
    node.textContent = text;
    node.dataset.state = String(state || 'none');
    return node;
  }

  function groupKey(subject, day) { return subject + '|day' + Number(day); }

  function latestSaved(subject, learningDay) {
    var data = read(LOCAL_KEY), group = data[groupKey(subject, learningDay)];
    if (!Array.isArray(group) || !group.length) return null;
    var best = null;
    group.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      if (!Number.isInteger(Number(item.total)) || !Array.isArray(item.answers)) return;
      if (item.answers.length !== item.total) return;
      if (!best || Date.parse(item.at || '') > Date.parse(best.at || '')) best = item;
    });
    return best;
  }

  function markCloud(attemptId, state, detail) {
    if (!attemptId || !state) return false;
    var data = read(STATUS_KEY);
    var old = data[attemptId] || {};
    if (old.state === 'cloud_confirmed' && String(state) !== 'cloud_confirmed') return true;
    data[attemptId] = {
      attemptId: String(attemptId),
      state: String(state),
      detail: detail || null,
      at: new Date().toISOString(),
      previous: old.state || null
    };
    var ok = writeJson(STATUS_KEY, data);
    if (ok) renderFromStorage();
    return ok;
  }

  function confirmedBest(subject, day) {
    var data = read(STATUS_KEY), best = null;
    Object.keys(data).forEach(function (id) {
      var s = data[id];
      if (!s || s.state !== 'cloud_confirmed' || !s.detail) return;
      if ((s.detail.subject || subject) !== subject) return;
      if (Number(s.detail.day) !== Number(day)) return;
      var c = Number(s.detail.correct), t = Number(s.detail.total);
      if (!Number.isInteger(c) || !Number.isInteger(t) || t < 5) return;
      if (!best || c * best.total > best.correct * t) best = { correct: c, total: t };
    });
    return best;
  }

  function renderAllSubjects(day) {
    var lines = [];
    SUBJECTS.forEach(function (subject) {
      var saved = latestSaved(subject, day);
      if (!saved) return;
      var st = read(STATUS_KEY)[saved.id];
      var state = st && st.state;
      var best = confirmedBest(subject, day);
      var notHigher = best && saved.correct * best.total <= best.correct * saved.total;
      var label;
      if (state === 'cloud_confirmed') label = '云端已确认';
      else if (state === 'skipped_not_higher' || notHigher) label = '本机已保存，未超过已确认最高成绩';
      else if (!navigator.onLine) label = '离线：本机已完整保存，待补传';
      else label = '本机已保存，等待云端';
      lines.push(subject + ' ' + saved.correct + '/' + saved.total + '（' + label + '）');
    });
    if (!lines.length) {
      show('本机没有这一日可恢复的完整答题记录', 'none');
      return;
    }
    show(lines.join('；'), lines.some(function (line) { return /云端已确认/.test(line); }) ? 'cloud' : 'local');
  }

  function renderFromStorage() {
    var ctx = pageContext();
    if (!Number.isInteger(ctx.day) || ctx.day < 0 || ctx.day > 30) return;
    if (ctx.day === 0) return; // 月测等测评记录只保留本机，不冒充学习日成绩
    if (!ctx.subject) { renderAllSubjects(ctx.day); return; } // 主页面汇总四科状态
    var saved = latestSaved(ctx.subject, ctx.day);
    if (!saved) {
      show('本机没有这一日可恢复的完整答题记录', 'none');
      return;
    }
    var allStatus = read(STATUS_KEY);
    var status = allStatus[saved.id];
    var state = status && status.state;
    var confirmedBest = null;
    Object.keys(allStatus).forEach(function (id) {
      var s = allStatus[id];
      if (!s || s.state !== 'cloud_confirmed' || !s.detail) return;
      if ((s.detail.subject || ctx.subject) !== ctx.subject) return;
      if (Number(s.detail.day) !== saved.learningDay) return;
      var c = Number(s.detail.correct), t = Number(s.detail.total);
      if (!Number.isInteger(c) || !Number.isInteger(t) || t < 5) return;
      if (!confirmedBest || c * confirmedBest.total > confirmedBest.correct * t) confirmedBest = { correct: c, total: t };
    });
    var notHigher = confirmedBest && saved.correct * confirmedBest.total <= confirmedBest.correct * saved.total;
    var label = ctx.subject + ' ' + saved.correct + '/' + saved.total;
    if (state === 'cloud_confirmed') {
      show('云端已确认成绩：' + label + '（本机完整记录保留）', 'cloud');
    } else if (state === 'skipped_not_higher' || notHigher) {
      show('本机已保存 ' + label + '，未超过已确认最高成绩，云端保持原成绩', 'local');
    } else if (!navigator.onLine) {
      show('离线：本机已完整保存 ' + label + '，联网后安全补传', 'offline');
    } else {
      show('本机已完整保存 ' + label + '，等待云端确认', 'local');
    }
  }

  function appendAttempt(record, assessmentOnly) {
    var local = read(LOCAL_KEY);
    var key = groupKey(record.subject, assessmentOnly ? 0 : record.learningDay);
    var localList = Array.isArray(local[key]) ? local[key] : [];
    if (localList.some(function (x) { return x && x.id === record.id; })) return true;
    localList.push(record);
    local[key] = localList;
    if (!writeJson(LOCAL_KEY, local)) return false;
    var verifyLocal = read(LOCAL_KEY)[key] || [];
    if (!verifyLocal.some(function (x) { return x && x.id === record.id; })) return false;

    if (assessmentOnly) return true; // 测评只留本机，不进入每日成绩/上传闸门

    var history = read(ATTEMPT_KEY);
    var historyList = Array.isArray(history[key]) ? history[key] : [];
    if (!historyList.some(function (x) { return x && x.id === record.id; })) {
      historyList.push({
        id: record.id,
        subject: record.subject,
        lesson: record.lesson,
        learningDay: record.learningDay,
        correct: record.correct,
        total: record.total,
        rate: record.rate,
        passed: record.passed,
        answers: record.answers,
        at: record.at,
        source: record.source || 'course-finish'
      });
      history[key] = historyList;
      if (!writeJson(ATTEMPT_KEY, history)) return false;
      var verifyHistory = read(ATTEMPT_KEY)[key] || [];
      if (!verifyHistory.some(function (x) { return x && x.id === record.id; })) return false;
    }
    return true;
  }

  function notifyParent(record) {
    if (!window.parent || window.parent === window) return;
    var message = {
      type: 'v6-course-attempt-saved',
      subject: record.subject,
      learningDay: record.learningDay,
      lesson: record.lesson,
      score: record.correct,
      total: record.total,
      attemptId: record.id,
      answers: record.answers,
      at: record.at,
      source: record.source || 'course-finish'
    };
    try { window.parent.postMessage(message, location.origin); } catch (e) { /* local save stays intact */ }
  }

  function begin(opts) {
    var o = opts || {};
    current = {
      id: uuid(),
      subject: SUBJECTS.indexOf(o.subject) >= 0 ? o.subject : (pageContext().subject || '数学'),
      learningDay: Number(o.learningDay),
      lesson: Number(o.lesson) || Number(o.learningDay),
      source: o.source || 'course-finish',
      answers: [],
      startedAt: new Date().toISOString()
    };
    return current.id;
  }

  function answer(index, choice, correct) {
    if (!current) return false;
    var i = Number(index);
    if (!Number.isInteger(i) || i < 0 || typeof correct !== 'boolean') return false;
    if (current.answers.some(function (a) { return a.index === i; })) return false;
    current.answers.push({ index: i, choice: choice === undefined ? null : choice, correct: correct });
    return true;
  }

  function durationMs() {
    if (!current || !current.startedAt) return 0;
    var t = Date.parse(current.startedAt);
    return Number.isFinite(t) ? Math.max(0, Date.now() - t) : 0;
  }

  function finish(input) {
    var o = input || {};
    var ctx = pageContext();
    var subject = SUBJECTS.indexOf(o.subject) >= 0 ? o.subject : (current && current.subject) || ctx.subject;
    var assessmentOnly = o.assessmentOnly === true || o.learningDay === 0;
    var day = assessmentOnly ? 0 : Number(o.learningDay || (current && current.learningDay) || ctx.day);
    var total = Number(o.total);
    var answers = normalizeAnswers(o.answers || (current && current.answers), total);
    if (SUBJECTS.indexOf(subject) < 0) return fail('INVALID_SUBJECT');
    if (!assessmentOnly && (!Number.isInteger(day) || day < 1 || day > 30)) return fail('INVALID_LEARNING_DAY');
    if (!Number.isInteger(total) || total < 5) return fail('TOTAL_TOO_SMALL');
    if (!answers) return fail('INCOMPLETE_ANSWERS');
    var correct = answers.filter(function (a) { return a.correct === true; }).length;
    if (o.score !== undefined && Number(o.score) !== correct) return fail('SCORE_EVIDENCE_MISMATCH');
    var id = typeof o.attemptId === 'string' && o.attemptId ? o.attemptId
      : (current && current.id ? current.id : uuid());
    var record = {
      id: id,
      subject: subject,
      lesson: Number(o.lesson || (current && current.lesson)) || Number(ctx.lesson) || 0,
      learningDay: day,
      correct: correct,
      total: total,
      rate: Math.round(correct / total * 1000) / 10,
      passed: correct * 5 >= total * 4,
      answers: answers,
      at: o.at || new Date().toISOString(),
      durationMs: Number(o.durationMs) || durationMs(),
      source: o.source || (current && current.source) || 'course-finish',
      assessmentOnly: assessmentOnly,
      localSavedAt: new Date().toISOString()
    };
    if (!appendAttempt(record, assessmentOnly)) {
      show('保存失败：本机完整记录未能落盘，本次不上传', 'error');
      current = null;
      return { ok: false, saved: false, reason: 'LOCAL_SAVE_FAILED', id: id, entry: record };
    }
    show(assessmentOnly
      ? '本机已完整保存测评 ' + correct + '/' + total + '（不计入每日成绩）'
      : '本机已完整保存 ' + subject + ' ' + correct + '/' + total + '，等待云端确认', 'local');
    markCloud(id, 'local_saved', { subject: subject, learningDay: day, day: day, source: record.source });
    if (!assessmentOnly) notifyParent(record);
    current = null;

    var history = read(LOCAL_KEY);
    var list = Array.isArray(history[groupKey(subject, assessmentOnly ? 0 : day)]) ? history[groupKey(subject, assessmentOnly ? 0 : day)] : [];
    var attemptNo = list.length;
    var first = list.length ? list[0] : record;
    var best = list.reduce(function (a, b) { return b.rate > a.rate ? b : a; }, record);
    return {
      ok: true, saved: true, id: id, entry: record,
      attemptNo: attemptNo, first: first, best: best,
      correct: correct, total: total, answers: answers.length
    };
  }

  function fail(reason) {
    show('本机没有可保存的完整答题记录（' + reason + '），未提示安全保存', 'error');
    return { ok: false, reason: reason, saved: false };
  }

  window.addEventListener('message', function (e) {
    if (!e.data || typeof e.data !== 'object') return;
    /* 2026-11-27 rc8：删除「收到 postMessage 就直接写云端状态」的旧分支。
       云端确认只能由 r5-bridge 在拿到服务端整轮核验 ok 后调用 markCloud 写入；
       任何页面消息、本机保存或模拟响应都不再能把状态改成 cloud_confirmed。 */
    if (e.data.type === 'v6-course-cloud-status-request') {
      var ctx = pageContext();
      var saved = ctx.subject && ctx.day ? latestSaved(ctx.subject, ctx.day) : null;
      if (saved) {
        var st = read(STATUS_KEY)[saved.id];
        try {
          window.parent.postMessage({
            type: 'v6-course-cloud-status-reply',
            subject: ctx.subject,
            attemptId: saved.id,
            learningDay: saved.learningDay,
            state: st ? st.state : 'local_saved'
          }, location.origin);
        } catch (x) { /* ignore */ }
      }
    }
  });

  window.addEventListener('storage', function (e) {
    if (e.key === STATUS_KEY || e.key === LOCAL_KEY) renderFromStorage();
  });
  window.addEventListener('online', renderFromStorage);
  window.addEventListener('offline', renderFromStorage);

  window.V6CourseAttempt = {
    build: BUILD,
    begin: begin,
    answer: answer,
    finish: finish,
    current: function () { return current; },
    latestSaved: latestSaved,
    markCloud: markCloud,
    render: renderFromStorage,
    keys: { local: LOCAL_KEY, status: STATUS_KEY, history: ATTEMPT_KEY }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderFromStorage);
  else renderFromStorage();
})();
