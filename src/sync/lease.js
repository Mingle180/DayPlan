/**
 * DayPlan · 同步租约（契约 §5.4，仅协调）
 *
 * 一句话：**这不是锁**（§5.1 末句）。它只降低「两个标签页同时往云端写」的概率，
 * 任何失败都不得把用户挡在门外，更不得取代 §5.2（本地旧快照）与 §5.5（revision）。
 *
 * 键：`dayplan.sync.lease.<uid> = { token, tabId, expiresAt }`
 *   获取：读 → 不存在或已过期则写入自己的 token → 等 50–200ms → 回读，token 匹配才算持有
 *   续期：持有期间每 10s（由**调用方**驱动，见下）
 *   释放：退出登录 / 关闭同步 / 页面卸载
 *   未持有：暂停云端写入，本地照常
 *   写入失败：不阻断，仅依赖 §5.2 与 §5.5
 *
 * 关于「等 50–200ms 后回读」：读—写—回读不是原子的，两个人可能同时写、都回读到自己。
 * 这次等待把窗口压到毫秒级，但没有消除它——真正的兜底始终是 §5.5 的条件更新。
 *
 * 关于续期定时器：本模块**自己不开定时器**。原因有两个：
 *   1. 引擎与装配层要在 Node 里跑用例，一个 setInterval 会让进程永不退出；
 *   2. 续期的真正需求是「写云端前租约还有效」，因此引擎在每次云端写之前懒续期即可。
 * 页面可见时的 10s 续期由 app 层驱动（它本来就管页面生命周期）。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(isNode ? require('../core/sync-keys.js') : root.DayPlan.syncKeys);
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.syncLease = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (K) {
  'use strict';

  var TTL_MS = 30000;
  /* §5.4 括号里写的是 50–200ms。取中间值：太短压不住窗口，太长让每次推送都卡一下。 */
  var ACQUIRE_WAIT_MS = 120;

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /**
   * 解析租约原文。
   * 「不存在」「损坏」「合法」必须分开：不存在是正常情况，损坏要能报出来（否则排障时
   * 只看到「抢不到租约」），而两者都可以直接接管——因为租约不是锁。
   */
  function parse(raw) {
    if (raw === undefined || raw === null || raw === '') {
      return { present: false, ok: false, corrupt: false, code: 'E_LEASE_ABSENT' };
    }
    var obj = raw;
    if (typeof raw === 'string') {
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        return { present: true, ok: false, corrupt: true, code: 'E_LEASE_CORRUPT' };
      }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { present: true, ok: false, corrupt: true, code: 'E_LEASE_CORRUPT' };
    }
    if (typeof obj.token !== 'string' || obj.token === '' ||
        typeof obj.tabId !== 'string' || obj.tabId === '' ||
        !isFiniteNumber(obj.expiresAt)) {
      return { present: true, ok: false, corrupt: true, code: 'E_LEASE_CORRUPT' };
    }
    return {
      present: true,
      ok: true,
      corrupt: false,
      lease: { token: obj.token, tabId: obj.tabId, expiresAt: obj.expiresAt }
    };
  }

  function defaultWait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function randomToken() {
    var rnd = Math.random().toString(36).slice(2);
    return 'lk-' + Date.now().toString(36) + '-' + rnd;
  }

  function randomTabId() {
    return 'tab-' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * @param {{
   *   kv: {get:function(string):*, set:function(string,*):void, remove:function(string):void},
   *   tabId?: string,
   *   ttlMs?: number, acquireWaitMs?: number,
   *   nowMs?: function():number,
   *   wait?: function(number):Promise<any>,
   *   newToken?: function():string
   * }} cfg
   */
  function createLease(cfg) {
    if (!cfg || !cfg.kv || typeof cfg.kv.get !== 'function' || typeof cfg.kv.set !== 'function') {
      throw new TypeError('createLease 需要 kv（get/set）');
    }
    var kv = cfg.kv;
    var tabId = typeof cfg.tabId === 'string' && cfg.tabId ? cfg.tabId : randomTabId();
    var ttlMs = isFiniteNumber(cfg.ttlMs) && cfg.ttlMs > 0 ? cfg.ttlMs : TTL_MS;
    var acquireWaitMs = isFiniteNumber(cfg.acquireWaitMs) && cfg.acquireWaitMs >= 0
      ? cfg.acquireWaitMs : ACQUIRE_WAIT_MS;
    var nowMs = typeof cfg.nowMs === 'function' ? cfg.nowMs : function () { return Date.now(); };
    var wait = typeof cfg.wait === 'function' ? cfg.wait : defaultWait;
    var newToken = typeof cfg.newToken === 'function' ? cfg.newToken : randomToken;

    var held = false;
    var token = null;
    var uid = null;
    var expiresAt = 0;
    var lastProblem = null;
    var sawCorrupt = false;

    function keyFor(id) {
      return K.syncLeaseKey(id);
    }

    function safeGet(key) {
      try {
        return { ok: true, raw: kv.get(key) };
      } catch (e) {
        return { ok: false, raw: null, error: e };
      }
    }

    function safeSet(key, value) {
      try {
        kv.set(key, value);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e };
      }
    }

    function safeRemove(key) {
      try {
        kv.remove(key);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e };
      }
    }

    /** 读一次账面上的租约（不改任何东西）。 */
    function peek(id) {
      var target = typeof id === 'string' ? id : uid;
      if (!target) return { present: false, ok: false, corrupt: false, held: false, holder: null, expired: false };
      var got = safeGet(keyFor(target));
      if (!got.ok) {
        return { present: false, ok: false, corrupt: false, held: false, holder: null, expired: false, error: true };
      }
      var p = parse(got.raw);
      var live = !!(p.ok && p.lease.expiresAt > nowMs());
      return {
        present: p.present,
        ok: p.ok,
        corrupt: !!p.corrupt,
        expired: !!(p.ok && p.lease.expiresAt <= nowMs()),
        held: !!(p.ok && p.token === token && target === uid),
        holder: p.ok ? { tabId: p.lease.tabId, expiresAt: p.lease.expiresAt } : null
      };
    }

    /** 丢掉本地「自以为持有」的身份。不动键——键可能已经是别人的。 */
    function dropLocal() {
      held = false;
      token = null;
      expiresAt = 0;
    }

    /**
     * 获取（或确认自己已经持有）。
     * @returns {Promise<{ok:boolean, held:boolean, code?:string, token?:string,
     *                    holder?:object, retryable?:boolean}>}
     */
    async function acquire(nextUid) {
      if (typeof nextUid !== 'string' || nextUid === '') {
        return { ok: false, held: false, code: 'E_LEASE_NO_UID', message: '没有账号就没有租约' };
      }

      /* 换账号：旧账号的租约必须先释放。留着它既没人续期（到点自然过期），
         又会在过期前挡住别的标签页——那是最难排查的一类「同步突然不推了」。 */
      if (held && uid && uid !== nextUid) release();
      if (!held) dropLocal();
      uid = nextUid;

      var key = keyFor(nextUid);
      var now = nowMs();

      /* 已经持有且未过期：直接续期即可，不重写 token（重写会扩大竞态窗口）。 */
      if (held && token && expiresAt > now) {
        renewIfNeeded();
        return { ok: true, held: true, token: token };
      }

      var got = safeGet(key);
      if (!got.ok) {
        /* 读都读不了：不知道有没有人持有。按「不可用」处理，由上层降级为不阻断。 */
        lastProblem = 'E_LEASE_UNAVAILABLE';
        return { ok: false, held: false, code: 'E_LEASE_UNAVAILABLE', message: '租约不可读写' };
      }

      var p = parse(got.raw);
      if (p.corrupt) sawCorrupt = true;

      if (p.ok && p.lease.expiresAt > now && p.lease.tabId !== tabId) {
        lastProblem = null;
        return {
          ok: false,
          held: false,
          code: 'E_LEASE_BUSY',
          holder: { tabId: p.lease.tabId, expiresAt: p.lease.expiresAt },
          message: '另一个标签页正在同步'
        };
      }

      var mine = newToken();
      var expires = now + ttlMs;
      var w = safeSet(key, JSON.stringify({ token: mine, tabId: tabId, expiresAt: expires }));
      if (!w.ok) {
        /* §5.4「写入失败：不阻断」。这里只如实报告，由上层决定继续。 */
        lastProblem = 'E_LEASE_UNAVAILABLE';
        return { ok: false, held: false, code: 'E_LEASE_UNAVAILABLE', message: '租约写不进去（配额或隐私模式）' };
      }

      if (acquireWaitMs > 0) {
        try {
          await wait(acquireWaitMs);
        } catch (e) {
          /* 等待本身失败不该判失败：回读才是判据。 */
        }
      }

      var back = safeGet(key);
      var pb = back.ok ? parse(back.raw) : { ok: false };
      if (!pb.ok || pb.lease.token !== mine) {
        lastProblem = 'E_LEASE_LOST';
        dropLocal();
        return {
          ok: false,
          held: false,
          code: 'E_LEASE_LOST',
          holder: pb.ok ? { tabId: pb.lease.tabId, expiresAt: pb.lease.expiresAt } : null,
          message: '另一个标签页抢先开始了同步'
        };
      }

      held = true;
      token = mine;
      expiresAt = expires;
      lastProblem = null;
      return { ok: true, held: true, token: mine };
    }

    /**
     * 续期。**回读比对 token**：别人可能已经接管（我们过期了而他写了进来），
     * 此时继续以持有者自居，就会出现两个标签页同时写云端。
     */
    function renew() {
      if (!held || !token || !uid) {
        return { ok: false, code: 'E_LEASE_NOT_HELD', renewed: false };
      }
      var key = keyFor(uid);
      var got = safeGet(key);
      if (!got.ok) {
        lastProblem = 'E_LEASE_UNAVAILABLE';
        return { ok: false, code: 'E_LEASE_UNAVAILABLE', renewed: false };
      }
      var p = parse(got.raw);
      if (!p.ok || p.lease.token !== token) {
        lastProblem = 'E_LEASE_LOST';
        dropLocal();
        return {
          ok: false,
          code: 'E_LEASE_LOST',
          renewed: false,
          holder: p.ok ? { tabId: p.lease.tabId, expiresAt: p.lease.expiresAt } : null
        };
      }
      var expires = nowMs() + ttlMs;
      /* 续期写入失败不改变持有状态：此刻 token 仍是自己的，只是有效期没延长，
         到点自然失效，下一次 acquire 会重新走一遍。 */
      var w = safeSet(key, JSON.stringify({ token: token, tabId: tabId, expiresAt: expires }));
      if (!w.ok) {
        lastProblem = 'E_LEASE_RENEW_FAILED';
        return { ok: false, code: 'E_LEASE_RENEW_FAILED', renewed: false };
      }
      expiresAt = expires;
      lastProblem = null;
      return { ok: true, renewed: true, expiresAt: expires };
    }

    /** 剩余时间不足一半才续期：每次云端写都重写一遍纯属自己放大竞态。 */
    function renewIfNeeded() {
      if (!held || !token || !uid) {
        return { ok: false, code: 'E_LEASE_NOT_HELD', renewed: false };
      }
      if (expiresAt - nowMs() > ttlMs / 2) {
        return { ok: true, renewed: false, expiresAt: expiresAt };
      }
      return renew();
    }

    /** 释放：只删自己的。键已属于别人时，删掉等于让对方「以为自己还持有」。 */
    function release() {
      var released = false;
      if (held && token && uid) {
        var key = keyFor(uid);
        var got = safeGet(key);
        var p = got.ok ? parse(got.raw) : { ok: false };
        if (p.ok && p.lease.token === token) {
          released = safeRemove(key).ok;
        }
      }
      dropLocal();
      return { ok: true, released: released };
    }

    function isHeld() {
      return !!(held && token && expiresAt > nowMs());
    }

    return {
      tabId: tabId,
      ttlMs: ttlMs,
      acquireWaitMs: acquireWaitMs,
      acquire: acquire,
      renew: renew,
      renewIfNeeded: renewIfNeeded,
      release: release,
      isHeld: isHeld,
      peek: peek,
      getUid: function () { return uid; },
      getToken: function () { return token; },
      getExpiresAt: function () { return expiresAt; },
      getProblem: function () { return lastProblem; },
      describe: function () {
        return {
          tabId: tabId,
          held: isHeld(),
          uid: uid,
          expiresAt: expiresAt || null,
          problem: lastProblem,
          corruptSeen: sawCorrupt
        };
      }
    };
  }

  return {
    TTL_MS: TTL_MS,
    ACQUIRE_WAIT_MS: ACQUIRE_WAIT_MS,
    parse: parse,
    createLease: createLease
  };
});
