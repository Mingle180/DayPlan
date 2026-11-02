/**
 * DayPlan · 浏览器推送能力封装（D34）
 *
 * 契约：docs/spec/19-notifications.md §4 / §7。
 * 只做「能不能推 / 注册 SW / 订阅与退订 / 把订阅交给云端」，不弹任何 UI。
 * 所有函数都返回 Promise 或普通对象，失败不抛（页面要如实显示原因）。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.push = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var SW_PATH = 'sw.js';

  function hasPushManager() {
    return typeof root !== 'undefined' && typeof root.PushManager === 'function';
  }

  /**
   * @returns {{supported:boolean, reason:string}}
   *   reason: '' | 'file' | 'insecure' | 'electron' | 'no-sw' | 'no-push' | 'no-notification'
   */
  function environment() {
    var nav = root.navigator || {};
    var ua = typeof nav.userAgent === 'string' ? nav.userAgent : '';
    if (root.location && root.location.protocol === 'file:') return { supported: false, reason: 'file' };
    if (/Electron/i.test(ua) || (root.process && root.process.versions && root.process.versions.electron)) {
      return { supported: false, reason: 'electron' };
    }
    if (root.isSecureContext === false) return { supported: false, reason: 'insecure' };
    if (!nav.serviceWorker) return { supported: false, reason: 'no-sw' };
    if (!hasPushManager()) return { supported: false, reason: 'no-push' };
    if (!root.Notification) return { supported: false, reason: 'no-notification' };
    return { supported: true, reason: '' };
  }

  function permission() {
    return root.Notification && typeof root.Notification.permission === 'string'
      ? root.Notification.permission
      : 'denied';
  }

  function requestPermission() {
    if (!root.Notification || typeof root.Notification.requestPermission !== 'function') {
      return Promise.resolve('denied');
    }
    try {
      var p = root.Notification.requestPermission();
      if (p && typeof p.then === 'function') return p;
      return new Promise(function (resolve) { root.Notification.requestPermission(resolve); });
    } catch (e) {
      return Promise.resolve('denied');
    }
  }

  /** sw.js 放在站点根；更新绕过 HTTP 缓存，避免旧 SW 卡住。 */
  function register() {
    var env = environment();
    if (!env.supported) return Promise.resolve({ ok: false, code: env.reason });
    return root.navigator.serviceWorker.register(SW_PATH, { updateViaCache: 'none' })
      .then(function (registration) {
        var update = registration.update ? registration.update() : Promise.resolve();
        return Promise.resolve(update).catch(function () {}).then(function () {
          return { ok: true, registration: registration };
        });
      }, function (e) {
        return { ok: false, code: 'E_SW_REGISTER', message: e && e.message ? e.message : 'Service Worker 注册失败' };
      });
  }

  function getRegistration() {
    if (!root.navigator || !root.navigator.serviceWorker) return Promise.resolve(null);
    return root.navigator.serviceWorker.getRegistration().catch(function () { return null; });
  }

  /** base64url → Uint8Array（PushManager 只接受字节数组）。 */
  function urlBase64ToUint8Array(base64) {
    var text = String(base64 || '').replace(/-/g, '+').replace(/_/g, '/');
    while (text.length % 4) text += '=';
    var bin = (typeof root.atob === 'function' ? root.atob(text) : atob(text));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function subscribe(registration, vapidPublicKey) {
    if (!registration || !registration.pushManager) {
      return Promise.resolve({ ok: false, code: 'no-push' });
    }
    return registration.pushManager.getSubscription().then(function (existing) {
      if (existing) return { ok: true, subscription: existing, existing: true };
      return registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      }).then(function (subscription) {
        return { ok: true, subscription: subscription, existing: false };
      });
    }).catch(function (e) {
      return { ok: false, code: 'E_SUBSCRIBE', message: e && e.name ? e.name : '订阅失败' };
    });
  }

  function subscriptionJson(subscription) {
    if (!subscription || typeof subscription.toJSON !== 'function') return null;
    var json = subscription.toJSON();
    if (!json || !json.endpoint || !json.keys || !json.keys.p256dh || !json.keys.auth) return null;
    return { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth };
  }

  function unsubscribe(subscription) {
    if (!subscription || typeof subscription.unsubscribe !== 'function') return Promise.resolve({ ok: true });
    return subscription.unsubscribe().then(function (ok) { return { ok: !!ok }; }, function (e) {
      return { ok: false, message: e && e.message ? e.message : '退订失败' };
    });
  }

  return {
    SW_PATH: SW_PATH,
    environment: environment,
    permission: permission,
    requestPermission: requestPermission,
    register: register,
    getRegistration: getRegistration,
    urlBase64ToUint8Array: urlBase64ToUint8Array,
    subscribe: subscribe,
    subscriptionJson: subscriptionJson,
    unsubscribe: unsubscribe
  };
});
