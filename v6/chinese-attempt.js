/* V6 语文完整交卷本机保存桥接。
   2026-11-27 成绩修复版。

   原则：
   1. 只有「同一轮摘要 + 条数/题号/对错都与答题过程一致的逐题答案」才算完整记录；
   2. 先写本机两份独立存档并回读校验，再通知父页面进入既有设备上传流程；
   3. attemptId 每轮唯一，重复上报同一 id 不会新增第二份成绩；
   4. 云端确认状态只能由上传链路回写，页面自身绝不擅自显示「云端已确认」；
   5. 不触碰题目、答案判分、学习日推进、家长授权和碎片奖励逻辑。 */
(function () {
  'use strict';

  var BUILD = '20261127-cn-score-v1';
  var ATTEMPT_KEY = 'v6-attempt-history-v1';
  var LOCAL_KEY = 'v6-chinese-attempt-history-v1';
  var STATUS_KEY = 'v6-chinese-attempt-status-v1';
  var BADGE_ID = 'v6-cn-save-status';
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
    return 'cn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
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

  function latestSaved(learningDay) {
    var data = read(LOCAL_KEY), group = data['语文|day' + Number(learningDay)];
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

  function renderFromStorage() {
    var params = new URLSearchParams(location.search);
    var day = Number(params.get('learningDay') || params.get('lessonDay') || 0);
    if (!Number.isInteger(day) || day < 1 || day > 30) return;
    var saved = latestSaved(day);
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
      if (Number(s.detail.day) !== saved.learningDay) return;
      var c = Number(s.detail.correct), t = Number(s.detail.total);
      if (!Number.isInteger(c) || !Number.isInteger(t) || t < 5) return;
      if (!confirmedBest || c * confirmedBest.total > confirmedBest.correct * t) confirmedBest = { correct: c, total: t };
    });
    var notHigher = confirmedBest && saved.correct * confirmedBest.total <= confirmedBest.correct * saved.total;
    if (state === 'cloud_confirmed') {
      show('云端已确认成绩：' + saved.correct + '/' + saved.total + '（本机完整记录保留）', 'cloud');
    } else if (state === 'skipped_not_higher' || notHigher) {
      show('本机已保存 ' + saved.correct + '/' + saved.total + '，未超过已确认最高成绩，云端保持原成绩', 'local');
    } else if (!navigator.onLine) {
      show('离线：本机已完整保存 ' + saved.correct + '/' + saved.total + '，联网后安全补传', 'offline');
    } else {
      show('本机已完整保存 ' + saved.correct + '/' + saved.total + '，等待云端确认', 'local');
    }
  }

  function appendAttempt(record) {
    var local = read(LOCAL_KEY);
    var groupKey = '语文|day' + record.learningDay;
    var localList = Array.isArray(local[groupKey]) ? local[groupKey] : [];
    if (localList.some(function (x) { return x && x.id === record.id; })) return true;
    localList.push(record);
    local[groupKey] = localList;
    if (!writeJson(LOCAL_KEY, local)) return false;
    var verifyLocal = read(LOCAL_KEY)[groupKey] || [];
    if (!verifyLocal.some(function (x) { return x && x.id === record.id; })) return false;

    var history = read(ATTEMPT_KEY);
    var historyList = Array.isArray(history[groupKey]) ? history[groupKey] : [];
    if (!historyList.some(function (x) { return x && x.id === record.id; })) {
      historyList.push({
        id: record.id,
        subject: '语文',
        lesson: record.lesson,
        learningDay: record.learningDay,
        correct: record.correct,
        total: record.total,
        rate: record.rate,
        passed: record.passed,
        answers: record.answers,
        at: record.at,
        source: record.source || 'lesson-finish'
      });
      history[groupKey] = historyList;
      if (!writeJson(ATTEMPT_KEY, history)) return false;
      var verifyHistory = read(ATTEMPT_KEY)[groupKey] || [];
      if (!verifyHistory.some(function (x) { return x && x.id === record.id; })) return false;
    }
    return true;
  }

  function notifyParent(record) {
    if (!window.parent || window.parent === window) return;
    var message = {
      type: 'v6-cn-quiz-score',
      lessonDay: record.learningDay,
      lesson: record.lesson,
      score: record.correct,
      total: record.total,
      attemptId: record.id,
      answers: record.answers,
      at: record.at,
      source: record.source || 'lesson-finish'
    };
    try { window.parent.postMessage(message, location.origin); } catch (e) { /* local save stays intact */ }
    try { window.parent.postMessage({ type: 'v6-cn-attempt-saved', attemptId: record.id, learningDay: record.learningDay }, location.origin); } catch (e) { /* ignore */ }
  }

  function begin(opts) {
    var o = opts || {};
    current = {
      id: uuid(),
      learningDay: Number(o.learningDay),
      lesson: Number(o.lesson) || Number(o.learningDay),
      source: o.source || 'lesson-finish',
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
    var day = Number(o.learningDay || (current && current.learningDay));
    var total = Number(o.total);
    var answers = normalizeAnswers(o.answers || (current && current.answers), total);
    if (!Number.isInteger(day) || day < 1 || day > 30) return fail('INVALID_LEARNING_DAY');
    if (!Number.isInteger(total) || total < 5) return fail('TOTAL_TOO_SMALL');
    if (!answers) return fail('INCOMPLETE_ANSWERS');
    var correct = answers.filter(function (a) { return a.correct === true; }).length;
    if (o.score !== undefined && Number(o.score) !== correct) return fail('SCORE_EVIDENCE_MISMATCH');
    var id = typeof o.attemptId === 'string' && o.attemptId ? o.attemptId
      : (current && current.id ? current.id : uuid());
    var record = {
      id: id,
      subject: '语文',
      lesson: Number(o.lesson || (current && current.lesson)) || day,
      learningDay: day,
      correct: correct,
      total: total,
      rate: Math.round(correct / total * 1000) / 10,
      passed: correct * 5 >= total * 4,
      answers: answers,
      at: o.at || new Date().toISOString(),
      durationMs: Number(o.durationMs) || durationMs(),
      source: o.source || (current && current.source) || 'lesson-finish',
      localSavedAt: new Date().toISOString()
    };
    if (!appendAttempt(record)) {
      show('保存失败：本机完整记录未能落盘，本次不上传', 'error');
      current = null;
      return { ok: false, reason: 'LOCAL_SAVE_FAILED', saved: false, id: id };
    }
    show('本机已完整保存 ' + correct + '/' + total + '，等待云端确认', 'local');
    markCloud(id, 'local_saved', { subject: '语文', learningDay: day, day: day, source: record.source });
    notifyParent(record);
    current = null;
    return { ok: true, saved: true, id: id, correct: correct, total: total, answers: answers.length };
  }

  function fail(reason) {
    show('本机没有可保存的完整答题记录（' + reason + '），未提示安全保存', 'error');
    return { ok: false, reason: reason, saved: false };
  }

  window.addEventListener('message', function (e) {
    if (!e.data || typeof e.data !== 'object') return;
    /* rc8：云端确认只能由 r5-bridge 在服务端整轮核验通过后写入；
       不再接受页面消息把状态改成 cloud_confirmed。 */
    if (e.data.type === 'v6-cn-cloud-status-request') {
      var saved = latestSaved(e.data.learningDay);
      if (saved) {
        var st = read(STATUS_KEY)[saved.id];
        try {
          window.parent.postMessage({
            type: 'v6-cn-cloud-status-reply',
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

  window.V6ChineseAttempt = {
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
