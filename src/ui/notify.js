/**
 * DayPlan · 应用内通知出口（F-106）
 *
 * 统一的「系统通知优先、无权限时页内提示」通道，供本地提醒兜底与完成台共用：
 *   · Notification.permission === 'granted' → 新系统通知，点击聚焦窗口 + onOpen + 关闭；
 *   · 否则（拒绝 / 不支持 / 构造失败）→ modal.toast 带「查看」动作；
 *   · 返回实际走的通道：'notification' | 'toast' | 'none'（两者都不可用）。
 * 只在应用打开期间生效，不做关页面 / 后台承诺（那是 Web Push 的职责）。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  function show(opts) {
    opts = opts || {};
    var title = opts.title || '提醒';
    var body = opts.body || '';
    var tag = opts.tag;
    var onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : function () {};
    var open = function () { try { onOpen(); } catch (e) { /* 导航失败不影响提醒 */ } };

    var N = root.Notification;
    if (N && N.permission === 'granted') {
      try {
        var n = new N(title, { body: body, tag: tag });
        n.onclick = function () {
          try { if (root.focus) root.focus(); } catch (e) { /* 部分环境不允许 */ }
          open();
          try { n.close(); } catch (e) { /* 忽略 */ }
        };
        return 'notification';
      } catch (e) { /* 通知构造失败 → 页内提示 */ }
    }
    var M = root.DayPlan.modal;
    if (M && typeof M.toast === 'function') {
      M.toast(body ? title + ' · ' + body : title, { actionLabel: '查看', onAction: open });
      return 'toast';
    }
    return 'none';
  }

  root.DayPlan.notify = { show: show };
})(typeof globalThis !== 'undefined' ? globalThis : this);