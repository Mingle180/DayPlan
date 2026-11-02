/**
 * DayPlan · 本地提醒兜底（D34）
 *
 * 契约：docs/spec/19-notifications.md §6。
 * 推送为主动达方式；未登录 / 未授权 / 浏览器不支持 / 单文件版 / Electron
 * 都落到这里：应用打开期间用 setTimeout 守最近一条到期提醒。
 *
 * 刻意保守：
 *   · 一次只武装一个 setTimeout，文档每次变化或页面回到前台才重算；
 *   · 只补发最近 10 分钟内错过的提醒，且同一行只提醒一次（按 key 记忆）；
 *   · 存在有效推送订阅时由调用方 setPushActive(true) 关闭本地补发，避免双响；
 *   · 首次 setPushActive() 之前不补发：启动时订阅查询是异步的，先补发会与刚点开的推送重复；
 *   · 不做后台 / 关页面的任何承诺——那正是推送要解决的问题。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var MISSED_WINDOW_MS = 10 * 60 * 1000;
  var MAX_MISSED_TOASTS = 3;
  var MAX_TIMEOUT_MS = 2147483647;

  function rowKey(r) {
    return r.sourceKind + '|' + r.sourceId + '|' + r.occurrenceKey + '|' + r.fireAt;
  }

  function create(opts) {
    opts = opts || {};
    var store = opts.store;
    var R = root.DayPlan.reminder;
    var M = root.DayPlan.modal;

    var timer = null;
    var fired = {};
    var unsubscribe = null;
    var pushActive = false;
    var pushDecided = false;
    var started = false;
    var onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : function () {};

    function notify(row) {
      var body = row.sourceKind === 'countdown' ? '倒计时提醒' : '事项即将开始';
      var title = row.title || '提醒';
      var open = function () { try { onOpen(row); } catch (e) { /* 导航失败不影响提醒 */ } };
      if (root.Notification && root.Notification.permission === 'granted') {
        try {
          var n = new root.Notification(title, { body: body, tag: rowKey(row) });
          n.onclick = function () {
            try { if (root.focus) root.focus(); } catch (e) { /* 部分环境不允许 */ }
            open();
            try { n.close(); } catch (e) { /* 忽略 */ }
          };
          return;
        } catch (e) { /* 通知构造失败 → 页内提示 */ }
      }
      if (M && typeof M.toast === 'function') {
        M.toast(title + ' · ' + body, { actionLabel: '查看', onAction: open });
      }
    }

    function clearTimer() {
      if (timer) clearTimeout(timer);
      timer = null;
    }

    function arm(rows, nowMs) {
      clearTimer();
      if (pushActive) return;
      var missed = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var r = rows[i];
        if (!r || !isFinite(r.fireAtMs)) continue;
        var key = rowKey(r);
        if (fired[key]) continue;
        if (r.fireAtMs <= nowMs) {
          if (nowMs - r.fireAtMs > MISSED_WINDOW_MS) continue;
          if (missed < MAX_MISSED_TOASTS) {
            fired[key] = true;
            missed += 1;
            notify(r);
          }
          continue;
        }
        var delay = r.fireAtMs - nowMs;
        timer = setTimeout(function () {
          timer = null;
          fired[key] = true;
          notify(r);
          refresh();
        }, Math.min(delay + 20, MAX_TIMEOUT_MS));
        if (timer && typeof timer.unref === 'function') timer.unref();
        return;
      }
    }

    function refresh() {
      /* 推送状态未判定前什么都不做：boot 时 start() 会先于异步订阅查询执行，
         此时若补发最近 10 分钟，会和「点开推送通知」本身叠成两次提醒。 */
      if (!started || !pushDecided || pushActive || !store || !R) return;
      var rows;
      try {
        rows = R.materialize(store.getState(), { nowMs: Date.now() });
      } catch (e) {
        return;
      }
      arm(rows, Date.now());
    }

    function start() {
      if (started) return;
      started = true;
      if (store && typeof store.subscribe === 'function') {
        unsubscribe = store.subscribe(function () { refresh(); });
      }
      if (typeof root.addEventListener === 'function') {
        root.addEventListener('visibilitychange', function () {
          if (root.document && root.document.visibilityState === 'visible') refresh();
        });
      }
      refresh();
    }

    function stop() {
      started = false;
      clearTimer();
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    }

    function setPushActive(on) {
      pushDecided = true;
      pushActive = !!on;
      if (pushActive) clearTimer();
      else refresh();
    }

    return {
      start: start,
      stop: stop,
      refresh: refresh,
      setPushActive: setPushActive,
      isPushActive: function () { return pushActive; },
      isPushDecided: function () { return pushDecided; }
    };
  }

  root.DayPlan.reminderLocal = { create: create, MISSED_WINDOW_MS: MISSED_WINDOW_MS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
