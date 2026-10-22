/**
 * DayPlan · id 生成（纯函数，无 DOM 依赖）
 *
 * 契约见 docs/spec/03-data-model.md DM-3 / DM-4.1。
 * 前缀用于让 id 自带类型信息，便于排查与数据迁移。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.id = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var counter = 0;

  /** 取随机源：优先 crypto.randomUUID，其次 crypto.getRandomValues，最后时间戳+随机数 */
  function randomToken() {
    var g = typeof globalThis !== 'undefined' ? globalThis : {};
    var c = g.crypto;
    if (c && typeof c.randomUUID === 'function') {
      return c.randomUUID().replace(/-/g, '').slice(0, 12);
    }
    if (c && typeof c.getRandomValues === 'function') {
      var buf = new Uint32Array(2);
      c.getRandomValues(buf);
      return buf[0].toString(36) + buf[1].toString(36);
    }
    return Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  }

  function next(opts) {
    counter = (counter + 1) % 100000;
    var time = Date.now().toString(36);
    var seq = counter.toString(36);
    return time + '-' + seq + '-' + randomToken();
  }

  /** 事项 id：itm_ 前缀 */
  function itemId() {
    return 'itm_' + next();
  }

  /** 类别 id：cat_ 前缀 */
  function categoryId() {
    return 'cat_' + next();
  }

  /** 通用 id（无前缀约定时使用） */
  function genericId(prefix) {
    return (prefix ? String(prefix) + '_' : '') + next();
  }

  return {
    randomToken: randomToken,
    next: next,
    itemId: itemId,
    categoryId: categoryId,
    genericId: genericId
  };
});
