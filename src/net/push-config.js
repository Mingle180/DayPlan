/**
 * DayPlan · Web Push 公开配置（D34）
 *
 * 契约：docs/spec/19-notifications.md §4。
 * vapidPublicKey 是公开信息，可以入库；私钥只放 Supabase Secrets。
 * 生成方式：node tools/generate_vapid_keys.js（把打印出的公钥粘到下面）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.pushConfig = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var vapidPublicKey = 'BEAwZIo0aIvUUQ-rSUadk79WePRrFvkRCaIPpzkiv7eI_9HQZ3UmhrNIX9gLX2M8IZRDVkiiIMlWgTns6B1ZW5s';

  function isConfigured() {
    return typeof vapidPublicKey === 'string' && /^[A-Za-z0-9_-]{80,120}$/.test(vapidPublicKey);
  }

  return {
    vapidPublicKey: vapidPublicKey,
    isConfigured: isConfigured
  };
});
