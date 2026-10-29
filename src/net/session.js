/**
 * DayPlan · 会话与令牌（dayplan.auth.v1 的唯一所有者）
 *
 * 契约：docs/spec/18-manual-cloud-save.md
 *   §2  存储键（`dayplan.auth.v1` 只属于本模块）
 *   §4  登录 / 退出：会话四态、单飞刷新、401 处理、刷新失败分流、会话恢复
 *
 * 四态与单飞刷新等实现细节沿用原实时同步契约的 S-04…S-34，行为未变：
 * 单个 401 重试一次、并发 401 只刷新一次、刷新令牌失效转 signed-out、
 * 恢复失败不动任何数据键。
 *
 * 边界：
 *   · 本模块是 `dayplan.auth.v1` 的**唯一**读写者；其他模块只能 getToken / subscribe。
 *   · 令牌**不写文档、不进入导出、不写日志、不写 Toast**（§6「泄露面」）。
 *   · 只碰 `dayplan.auth.v1`。退出登录**不碰任何数据键**（§6 末行）。
 *   · 网络细节全部由注入的 `refresh` 承担；本模块不引入 fetch，也不猜 HTTP。
 *
 * 关键约定：
 *   · `expiresAt` 一律是**毫秒时间戳**（不是 ISO 串、不是秒）。
 *   · 刷新失败分两类，绝不混同：
 *       E_INVALID_GRANT            → `expired`，不可重试，需重新登录
 *       网络 / 超时 / 5xx / 429     → 状态不变，`retryable: true`，由引擎转 `paused-error`
 *     这里不做 `paused-error` 判定——那是同步状态，不属于会话状态。
 *   · `restore()` 失败一律回到 `signed-out`（S-34），**数据键一个不写**。
 *     与「运行中刷新失败」的区别是刻意的：启动时拿不到令牌就当没登录，不需要区分原因。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.session = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var AUTH_KEY = 'dayplan.auth.v1';
  var STATES = {
    signedOut: 'signed-out',
    refreshing: 'refreshing',
    signedIn: 'signed-in',
    expired: 'expired'
  };
  var UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  var DEFAULT_SKEW_MS = 60000;

  function isNonEmptyString(v) {
    return typeof v === 'string' && v !== '';
  }

  /** 形状校验。任何一项不合格都视为不可用凭据，不做"能读多少算多少"的宽容。 */
  function isValidAuth(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (!isNonEmptyString(v.accessToken)) return false;
    if (!isNonEmptyString(v.refreshToken)) return false;
    if (typeof v.expiresAt !== 'number' || !isFinite(v.expiresAt) || v.expiresAt <= 0) return false;
    if (typeof v.userId !== 'string' || !UID_RE.test(v.userId)) return false;
    return true;
  }

  /**
   * 只读窥探：磁盘上是否有一份**可恢复**的会话，是的话 uid 是多少。
   *
   * 为什么单独开这个口子：Store 在同步装配层之前创建，而它解析活动指针
   * （`dayplan.active.v1`）时必须知道「当前会话 uid」。没有这个窥探，Store 只能
   * 认为自己未登录，于是每次刷新都把 `user:<uid>` 指针按 §2.2 回落成 guest——
   * 用户看到的现象是「刷新一下同步就断了」（Q-28 / Q-29 实测）。
   *
   * 边界（别把它当 restore 用）：
   *   · 不刷新令牌、不发请求、不写盘、不改任何状态；
   *   · 「可恢复」= 形状合法（含非空 refreshToken）——access 过期仍算可恢复，
   *     真恢复由 restore() 做；restore 失败时由装配层回落 guest；
   *   · 任何异常一律返回 null，绝不让启动被它拦住。
   *
   * @param {{get:function(string):(string|undefined)}} kv
   * @returns {string|null}
   */
  function peekPersistedUserId(kv) {
    if (!kv || typeof kv.get !== 'function') return null;
    var raw;
    try {
      raw = kv.get(AUTH_KEY);
    } catch (e) {
      return null;
    }
    if (typeof raw !== 'string' || raw === '') return null;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!isValidAuth(parsed)) return null;
    return parsed.userId;
  }

  /**
   * @param {object} cfg
   *   kv       { get, set, remove }            —— 与项目其它 KV 同构
   *   refresh  function(refreshToken) -> Promise<{ok:true,accessToken,refreshToken,expiresAt,userId}
   *                                              |{ok:false,code,message}>
   *            src/net/supabase.js 的 refreshSession 可直接注入
   *   now      () => number（毫秒），默认 Date.now
   *   skewMs   提前多久算"该刷新了"，默认 60s
   */
  function createSession(cfg) {
    if (!cfg || !cfg.kv || typeof cfg.kv.get !== 'function' ||
        typeof cfg.kv.set !== 'function' || typeof cfg.kv.remove !== 'function') {
      throw new TypeError('createSession 需要 kv（get/set/remove）');
    }
    if (typeof cfg.refresh !== 'function') {
      throw new TypeError('createSession 需要 refresh 函数');
    }
    var kv = cfg.kv;
    var refreshFn = cfg.refresh;
    var nowFn = typeof cfg.now === 'function' ? cfg.now : function () { return Date.now(); };
    var skewMs = typeof cfg.skewMs === 'number' && isFinite(cfg.skewMs) && cfg.skewMs >= 0
      ? cfg.skewMs
      : DEFAULT_SKEW_MS;

    var state = STATES.signedOut;
    var auth = null;
    var inflight = null;
    var listeners = [];

    function setState(next) {
      if (state === next) return;
      state = next;
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i](state);
        } catch (e) {
          // 订阅者异常不得影响状态机本身
        }
      }
    }

    function readAuth() {
      var raw = kv.get(AUTH_KEY);
      if (raw === undefined || raw === null || raw === '') {
        return { ok: false, reason: 'missing' };
      }
      if (typeof raw !== 'string') {
        return { ok: false, reason: 'corrupt' };
      }
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return { ok: false, reason: 'corrupt' };
      }
      if (!isValidAuth(parsed)) return { ok: false, reason: 'corrupt' };
      return {
        ok: true,
        auth: {
          accessToken: parsed.accessToken,
          refreshToken: parsed.refreshToken,
          expiresAt: parsed.expiresAt,
          userId: parsed.userId
        }
      };
    }

    /** 写入并读回校验：存储满了 / 只读时 set 可能静默失败，不能当成功。 */
    function writeAuth(value) {
      var json;
      try {
        json = JSON.stringify(value);
      } catch (e) {
        return { ok: false, code: 'E_PERSIST' };
      }
      try {
        kv.set(AUTH_KEY, json);
      } catch (e) {
        return { ok: false, code: 'E_PERSIST' };
      }
      return { ok: kv.get(AUTH_KEY) === json, code: 'E_PERSIST' };
    }

    function needsRefresh() {
      if (!auth) return false;
      return auth.expiresAt - skewMs <= nowFn();
    }

    function getState() {
      return state;
    }

    function getUserId() {
      return auth ? auth.userId : null;
    }

    function subscribe(fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }

    /**
     * 刷新一次。并发调用共用同一个 Promise（§6「单飞」）。
     * 返回的 code 已经归一：E_EXPIRED（不可重试）或其余（可重试）。
     */
    function refreshOnce() {
      if (inflight) return inflight;
      if (!auth || !isNonEmptyString(auth.refreshToken)) {
        setState(STATES.signedOut);
        return Promise.resolve({ ok: false, code: 'E_NO_SESSION', retryable: false });
      }
      var previous = state;
      setState(STATES.refreshing);

      var p = Promise.resolve()
        .then(function () { return refreshFn(auth.refreshToken); })
        .then(
          function (res) { return settleRefresh(res, previous); },
          function () { return settleRefresh({ ok: false, code: 'E_NETWORK' }, previous); }
        );

      inflight = p;
      p.then(
        function () { if (inflight === p) inflight = null; },
        function () { if (inflight === p) inflight = null; }
      );
      return p;
    }

    function settleRefresh(res, previous) {
      if (res && res.ok) {
        var next = {
          accessToken: res.accessToken,
          refreshToken: isNonEmptyString(res.refreshToken) ? res.refreshToken : auth.refreshToken,
          expiresAt: res.expiresAt,
          userId: isNonEmptyString(res.userId) ? res.userId : auth.userId
        };
        if (!isValidAuth(next)) {
          setState(previous);
          return { ok: false, code: 'E_BAD_RESPONSE', retryable: true, message: '刷新结果不完整' };
        }
        var w = writeAuth(next);
        if (!w.ok) {
          // 内存不得比磁盘更新，否则刷新后崩溃会拿到旧令牌
          setState(previous);
          return { ok: false, code: 'E_PERSIST', retryable: true, message: '令牌写入失败' };
        }
        auth = next;
        setState(STATES.signedIn);
        return { ok: true, accessToken: auth.accessToken };
      }

      var code = (res && res.code) || 'E_NETWORK';
      if (code === 'E_INVALID_GRANT') {
        setState(STATES.expired);
        return { ok: false, code: 'E_EXPIRED', retryable: false, message: '登录已过期，需重新登录' };
      }
      // 网络 / 超时 / 5xx / 429：令牌本身可能仍有效，不判过期，保持原状态等重试
      setState(auth ? previous : STATES.signedOut);
      return { ok: false, code: code, retryable: true, message: '刷新失败，可重试' };
    }

    /** 取一个可用于请求的 token；必要时先刷新。 */
    function getToken() {
      if (!auth) {
        return Promise.resolve({ ok: false, code: 'E_NO_SESSION', retryable: false });
      }
      if (state === STATES.expired) {
        return Promise.resolve({ ok: false, code: 'E_EXPIRED', retryable: false });
      }
      if (!needsRefresh()) {
        return Promise.resolve({ ok: true, accessToken: auth.accessToken });
      }
      return refreshOnce().then(function (r) {
        if (!r.ok) return r;
        return { ok: true, accessToken: auth.accessToken };
      });
    }

    /**
     * 用一个 token 执行请求，并处理 401：刷新一次 → 重试一次 → 再 401 转 expired。
     * 只重试一次是刻意的（§6）：无限重试会把"令牌彻底失效"伪装成"网络抖动"。
     */
    function withToken(fn) {
      if (typeof fn !== 'function') {
        return Promise.resolve({ ok: false, code: 'E_BAD_ARGUMENT', retryable: false });
      }
      return getToken().then(function (t) {
        if (!t.ok) return t;
        return Promise.resolve(fn(t.accessToken)).then(function (res) {
          if (!res || res.ok || res.code !== 'E_UNAUTHORIZED') return res;
          return refreshOnce().then(function (r) {
            if (!r.ok) return r;
            return Promise.resolve(fn(r.accessToken)).then(function (res2) {
              if (res2 && !res2.ok && res2.code === 'E_UNAUTHORIZED') {
                setState(STATES.expired);
                return { ok: false, code: 'E_EXPIRED', status: 401, retryable: false, message: '登录已过期，需重新登录' };
              }
              return res2;
            });
          });
        });
      });
    }

    /** 接受一组已有凭据（登录 UI 拿到之后调用）。登录 ≠ 开启同步。 */
    function signIn(creds) {
      var next = creds && typeof creds === 'object'
        ? {
            accessToken: creds.accessToken,
            refreshToken: creds.refreshToken,
            expiresAt: creds.expiresAt,
            userId: creds.userId
          }
        : null;
      if (!isValidAuth(next)) {
        return Promise.resolve({ ok: false, code: 'E_INVALID_CREDENTIALS', retryable: false });
      }
      var w = writeAuth(next);
      if (!w.ok) {
        return Promise.resolve({ ok: false, code: 'E_PERSIST', retryable: true, message: '令牌写入失败' });
      }
      auth = next;
      setState(STATES.signedIn);
      return Promise.resolve({ ok: true, userId: next.userId });
    }

    /** 退出登录：只删 dayplan.auth.v1，不碰任何数据键（§6 末行）。 */
    function signOut() {
      var from = state;
      auth = null;
      inflight = null;
      try {
        kv.remove(AUTH_KEY);
      } catch (e) {
        // 删除失败仍视为已登出：内存里已无凭据，不会再用它发请求
      }
      setState(STATES.signedOut);
      return Promise.resolve({ ok: true, from: from });
    }

    /**
     * 启动恢复（S-34）：能恢复则 signed-in，否则 signed-out。
     * 恢复失败**不写任何数据键**，也不在存储里留下半截状态。
     */
    function restore() {
      var parsed = readAuth();
      if (!parsed.ok) {
        if (parsed.reason === 'corrupt') {
          // 损坏的凭据不是用户数据，留着只会让每次启动都失败一次
          try {
            kv.remove(AUTH_KEY);
          } catch (e) {
            // 忽略：即便删不掉，本次也不会使用它
          }
        }
        auth = null;
        setState(STATES.signedOut);
        return Promise.resolve({
          ok: false,
          code: parsed.reason === 'missing' ? 'E_NO_SESSION' : 'E_AUTH_CORRUPT',
          state: state
        });
      }

      auth = parsed.auth;
      if (!needsRefresh()) {
        setState(STATES.signedIn);
        return Promise.resolve({ ok: true, state: state, refreshed: false });
      }
      return refreshOnce().then(function (r) {
        if (r.ok) return { ok: true, state: state, refreshed: true };
        /* 网络 / 超时 / 5xx 这类可重试失败：凭据本身没坏，人也还是「已登录」。
           旧实现这里一律判 signed-out——离线状态下刷新一次，应用就把用户切去
           游客作用域，账号副本从界面上消失，用户以为数据丢了。
           保持登录、标记 deferred，联网后第一次请求会自动续期。 */
        if (r && r.retryable) {
          setState(STATES.signedIn);
          return {
            ok: true, state: state, refreshed: false, deferred: true,
            code: r.code, retryable: true
          };
        }
        setState(STATES.signedOut);
        return { ok: false, code: r.code, state: state };
      });
    }

    /** 只读快照，供 UI 显示与诊断；调用方不得依赖其中的令牌做长期存储。 */
    function snapshot() {
      return {
        state: state,
        userId: auth ? auth.userId : null,
        expiresAt: auth ? auth.expiresAt : null,
        hasRefreshToken: !!(auth && auth.refreshToken)
      };
    }

    return {
      getState: getState,
      getUserId: getUserId,
      getToken: getToken,
      withToken: withToken,
      signIn: signIn,
      signOut: signOut,
      restore: restore,
      subscribe: subscribe,
      snapshot: snapshot
    };
  }

  return {
    AUTH_KEY: AUTH_KEY,
    STATES: STATES,
    DEFAULT_SKEW_MS: DEFAULT_SKEW_MS,
    isValidAuth: isValidAuth,
    createSession: createSession,
    peekPersistedUserId: peekPersistedUserId
  };
});
