/**
 * DayPlan · 通知设置（D34）
 *
 * 契约：docs/spec/19-notifications.md §4 / §7。
 * 只做一件事：把「云端推送」开关变成 权限 → SW → 订阅 → 云端行 的完整链路。
 * 环境不支持时如实说明并保持关闭；本地兜底不受这里影响。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var M = root.DayPlan.modal;
  var el = M.el;

  var REASON_TEXT = {
    file: '单文件版不支持推送；应用打开期间仍会提醒。',
    electron: '桌面版不接推送；应用打开期间仍会提醒。',
    insecure: '当前页面不是 HTTPS，浏览器不允许推送。',
    'no-sw': '此浏览器不支持 Service Worker；应用打开期间仍会提醒。',
    'no-push': '此浏览器不支持推送；应用打开期间仍会提醒。',
    'no-notification': '此浏览器没有通知能力；应用打开期间仍会提醒。'
  };

  function permissionText(perm) {
    if (perm === 'granted') return '浏览器通知已允许';
    if (perm === 'denied') return '浏览器已禁止通知，请在站点设置里允许';
    return '尚未允许浏览器通知';
  }

  function cloudOf(opts) {
    return {
      session: typeof opts.getSession === 'function' ? opts.getSession() : null,
      config: typeof opts.getConfig === 'function' ? opts.getConfig() : null,
      fetchImpl: typeof opts.getFetch === 'function' ? opts.getFetch() : null
    };
  }

  /** 把一台设备的订阅写进云端（幂等）。 */
  function saveSubscription(opts, json) {
    var cloud = cloudOf(opts);
    var Supa = root.DayPlan.supabase;
    if (!cloud.session || !cloud.config || !cloud.fetchImpl || !Supa) {
      return Promise.resolve({ ok: false, message: '云端未启用' });
    }
    return cloud.session.withToken(function (token) {
      return Supa.rpcCall({
        config: cloud.config,
        fetchImpl: cloud.fetchImpl,
        fn: 'register_push_subscription',
        params: {
          p_endpoint: json.endpoint,
          p_p256dh: json.p256dh,
          p_auth: json.auth,
          p_user_agent: (root.navigator && root.navigator.userAgent) || ''
        },
        accessToken: token
      });
    });
  }

  /**
   * 启动 / 登录后把「已有订阅但云端可能没有」的情况补上。
   * 不请求权限、不新建订阅：只同步浏览器里真实存在的那一条。
   */
  function syncExistingSubscription(opts) {
    opts = opts || {};
    var P = root.DayPlan.push;
    var Cfg = root.DayPlan.pushConfig;
    if (!P || !Cfg || !Cfg.isConfigured || !Cfg.isConfigured()) {
      return Promise.resolve({ ok: false, code: 'E_CONFIG' });
    }
    if (!P.environment().supported || P.permission() !== 'granted') {
      return Promise.resolve({ ok: false, code: 'E_NO_PERMISSION' });
    }
    var uid = typeof opts.getUid === 'function' ? opts.getUid() : '';
    if (!uid) return Promise.resolve({ ok: false, code: 'E_NO_UID' });
    return P.getRegistration().then(function (reg) {
      if (!reg || !reg.pushManager) return { ok: false, code: 'E_NO_SW' };
      return reg.pushManager.getSubscription().then(function (sub) {
        if (!sub) return { ok: false, code: 'E_NO_SUBSCRIPTION' };
        var json = P.subscriptionJson(sub);
        if (!json) return { ok: false, code: 'E_BAD_SUBSCRIPTION' };
        return saveSubscription(opts, json).then(function (r) {
          return r && r.ok
            ? { ok: true, subscription: sub }
            : { ok: false, code: 'E_RPC', message: r && r.message };
        });
      });
    }).catch(function (e) {
      return { ok: false, code: 'E_NETWORK', message: e && e.message ? e.message : '订阅同步失败' };
    });
  }

  /**
   * @param {object} opts
   *   - getUid()        当前登录用户 id
   *   - getSession()    会话对象
   *   - getConfig()     Supabase 配置
   *   - getFetch()      注入的 fetch
   *   - onPushStateChange(active)  订阅状态变化时通知 app（用于关掉本地重复提醒）
   *   - getSyncState()  () => 最近一次提醒同步结果（排障文案）
   * @returns {{element:HTMLElement, render:Function, destroy:Function}}
   */
  function createNotificationSection(opts) {
    opts = opts || {};
    var P = root.DayPlan.push;
    var Cfg = root.DayPlan.pushConfig;
    var Supa = root.DayPlan.supabase;

    var wrap = el('div', {});
    var toggle = el('input', { type: 'checkbox', 'aria-label': '云端推送' });
    var status = el('div', { class: 'hint' });
    var busyText = el('div', { class: 'hint' });

    wrap.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'switch' }, [toggle, el('span', { text: '云端推送' })])
    ]));
    wrap.appendChild(status);
    wrap.appendChild(busyText);

    var busy = false;
    var alive = true;

    function setBusy(on, text) {
      busy = !!on;
      toggle.disabled = busy || toggle.disabled; /* render 会重新算真实状态 */
      busyText.textContent = busy ? (text || '处理中…') : '';
      if (!busy) render();
    }

    function setStatus(text) {
      if (status.textContent !== text) status.textContent = text;
    }

    function notSupported(env) {
      return REASON_TEXT[env.reason] || '此环境不支持推送；应用打开期间仍会提醒。';
    }

    function ready() {
      var uid = typeof opts.getUid === 'function' ? opts.getUid() : '';
      return !!(P && Cfg && Cfg.isConfigured && Cfg.isConfigured() && uid && P.environment().supported);
    }

    function render() {
      if (!alive) return;
      if (!P || !Cfg) {
        toggle.checked = false;
        toggle.disabled = true;
        setStatus('推送模块未加载，应用打开期间仍会提醒。');
        return;
      }
      var env = P.environment();
      var perm = P.permission();
      var uid = typeof opts.getUid === 'function' ? opts.getUid() : '';
      var can = ready();

      if (!env.supported) {
        toggle.checked = false;
        toggle.disabled = true;
        setStatus(notSupported(env));
        return;
      }
      if (!Cfg.isConfigured || !Cfg.isConfigured()) {
        toggle.checked = false;
        toggle.disabled = true;
        setStatus('推送尚未配置（缺少 VAPID 公钥）。');
        return;
      }
      if (!uid) {
        toggle.checked = false;
        toggle.disabled = true;
        setStatus('登录后可开启云端推送；未登录时只在应用打开期间提醒。');
        return;
      }
      toggle.disabled = busy;
      if (perm === 'denied') {
        toggle.checked = false;
        toggle.disabled = true;
        setStatus(permissionText(perm));
        return;
      }
      setStatus(busy ? '' : (toggle.checked
        ? '已开启：到点推送到这台设备。'
        : '开启后，应用关闭时也能收到提醒。'));

      /* 异步确认这台设备是否真的订阅过（权限允许但订阅可能被浏览器清掉）。 */
      P.getRegistration().then(function (reg) {
        if (!alive || busy || !can) return;
        return reg && reg.pushManager ? reg.pushManager.getSubscription() : null;
      }).then(function (sub) {
        if (!alive || busy || !can || perm === 'denied') return;
        toggle.checked = !!sub;
        setStatus(toggle.checked ? '已开启：到点推送到这台设备。' : '开启后，应用关闭时也能收到提醒。');
      }, function () { /* 查询失败保持当前显示 */ });
    }

    function removeSubscription(endpoint) {
      var session = typeof opts.getSession === 'function' ? opts.getSession() : null;
      var config = typeof opts.getConfig === 'function' ? opts.getConfig() : null;
      var fetchImpl = typeof opts.getFetch === 'function' ? opts.getFetch() : null;
      if (!session || !config || !fetchImpl || !Supa) return Promise.resolve({ ok: true });
      return session.withToken(function (token) {
        return Supa.rpcCall({
          config: config,
          fetchImpl: fetchImpl,
          fn: 'unregister_push_subscription',
          params: { p_endpoint: endpoint },
          accessToken: token
        });
      });
    }

    function notifyState(active) {
      if (typeof opts.onPushStateChange === 'function') {
        try { opts.onPushStateChange(!!active); } catch (e) { /* 不影响开关本身 */ }
      }
    }

    function enable() {
      return P.requestPermission().then(function (perm) {
        if (perm !== 'granted') return { ok: false, message: '通知权限未授予' };
        return P.register().then(function (reg) {
          if (!reg || !reg.ok) return { ok: false, message: (reg && reg.message) || 'Service Worker 注册失败' };
          return P.subscribe(reg.registration, Cfg.vapidPublicKey).then(function (sub) {
            if (!sub || !sub.ok) return { ok: false, message: (sub && sub.message) || '订阅失败' };
            var json = P.subscriptionJson(sub.subscription);
            if (!json) return { ok: false, message: '订阅信息不完整' };
            return saveSubscription(opts, json).then(function (r) {
              if (!r || !r.ok) {
                /* 云端行没写成 → 撤回本机订阅，避免「本地以为开了、云端没数据」 */
                return P.unsubscribe(sub.subscription).then(function () {
                  return { ok: false, message: (r && r.message) || '订阅未能同步到云端' };
                });
              }
              notifyState(true);
              return { ok: true };
            });
          });
        });
      });
    }

    function disable() {
      return P.getRegistration().then(function (reg) {
        var sub = reg && reg.pushManager ? reg.pushManager.getSubscription() : null;
        return Promise.resolve(sub).then(function (existing) {
          if (!existing) { notifyState(false); return { ok: true }; }
          var json = P.subscriptionJson(existing);
          return P.unsubscribe(existing).then(function (un) {
            var after = json ? removeSubscription(json.endpoint) : Promise.resolve({ ok: true });
            return after.then(function () {
              notifyState(false);
              return un && un.ok ? { ok: true } : { ok: false, message: (un && un.message) || '退订失败' };
            });
          });
        });
      });
    }

    toggle.addEventListener('change', function () {
      if (busy) return;
      var want = toggle.checked;
      setBusy(true, want ? '正在开启…' : '正在关闭…');
      (want ? enable() : disable()).then(function (r) {
        if (!r || !r.ok) {
          toggle.checked = !want;
          M.toast((r && r.message) || '操作失败');
        }
        setBusy(false);
      });
    });

    render();

    return {
      element: wrap,
      render: render,
      destroy: function () { alive = false; }
    };
  }

  /**
   * 浏览器换掉 endpoint（pushsubscriptionchange）后，已有授权下重新订阅并写回云端。
   * 失败不弹窗：本地兜底仍在，用户可在设置里手动重开。
   */
  function resubscribe(opts) {
    opts = opts || {};
    var P = root.DayPlan.push;
    var Cfg = root.DayPlan.pushConfig;
    if (!P || !Cfg || !Cfg.isConfigured || !Cfg.isConfigured()) {
      return Promise.resolve({ ok: false, code: 'E_CONFIG' });
    }
    if (!P.environment().supported || P.permission() !== 'granted') {
      return Promise.resolve({ ok: false, code: 'E_NO_PERMISSION' });
    }
    var uid = typeof opts.getUid === 'function' ? opts.getUid() : '';
    if (!uid) return Promise.resolve({ ok: false, code: 'E_NO_UID' });
    return P.register().then(function (reg) {
      if (!reg || !reg.ok) return { ok: false, code: 'E_SW' };
      return P.subscribe(reg.registration, Cfg.vapidPublicKey).then(function (sub) {
        if (!sub || !sub.ok) return { ok: false, code: 'E_SUBSCRIBE' };
        var json = P.subscriptionJson(sub.subscription);
        if (!json) return { ok: false, code: 'E_BAD_SUBSCRIPTION' };
        return saveSubscription(opts, json).then(function (r) {
          return r && r.ok
            ? { ok: true, subscription: sub.subscription }
            : { ok: false, code: 'E_RPC', message: r && r.message };
        });
      });
    }).catch(function (e) {
      return { ok: false, code: 'E_NETWORK', message: e && e.message ? e.message : '重新订阅失败' };
    });
  }

  root.DayPlan.notifications = {
    createNotificationSection: createNotificationSection,
    syncExistingSubscription: syncExistingSubscription,
    resubscribe: resubscribe
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
