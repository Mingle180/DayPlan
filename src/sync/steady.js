/**
 * DayPlan · 稳态同步（steady）
 *
 * 首次同步（check → confirm）只解决"第一次对齐"。此后的持续同步是另一件事：
 * 本机数据一变就要在有限延迟内推一次，切回页面时要拉一次。
 *
 * 这一层刻意不碰网络细节，只做调度：
 *   1. 防抖合并——连续录入不能打成一串请求；
 *   2. 尾随补推——推送期间到达的变更不得被吞（否则最后一次改动永远上不了云）；
 *   3. 状态守卫——非 syncing 一律不发请求（首次同步未确认时推送等于绕过唯一写入门槛）；
 *   4. 失败不打扰——任何异常只转成状态上报，绝不抛回 store 的订阅链。
 *
 * 依赖注入：timer / now 都可替换，测试用受控时钟。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.syncSteady = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 推送防抖（D14 从 800ms 压到 400ms）：本机一有变更 0.4s 内起飞。
     每次推送是一个单行 PATCH，免费额度下压力可忽略；
     连续录入由防抖自然合并，不会一行一个请求。 */
  var DEFAULT_DEBOUNCE_MS = 400;
  /* 后台轮询拉取的间隔（D14 从 3s 压到 2s）。2s 对免费额度的
     PostgREST 单行 select 压力可忽略（每小时 1800 次轻查询）；
     配套的省额度措施：页面隐藏时轮询跳过（D14），切回页面的即时拉取
     仍由 visibilitychange / focus 负责（那是真正"回来就看"的时刻）。 */
  var DEFAULT_PULL_INTERVAL_MS = 2000;

  /**
   * @param {{
   *   engine: object,
   *   subscribe: function(function):function,
   *   debounceMs?: number,
   *   setTimer?: function(Function,number):any,
   *   clearTimer?: function(any):void,
   *   now?: function():string,
   *   onStatus?: function(object):void
   * }} cfg
   */
  function createSteady(cfg) {
    if (!cfg || !cfg.engine || typeof cfg.subscribe !== 'function') {
      throw new TypeError('createSteady 需要 engine 与 subscribe');
    }
    var engine = cfg.engine;
    var debounceMs = typeof cfg.debounceMs === 'number' && cfg.debounceMs >= 0
      ? cfg.debounceMs : DEFAULT_DEBOUNCE_MS;
    var setTimer = cfg.setTimer || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = cfg.clearTimer || function (id) { clearTimeout(id); };
    var setIntervalImpl = cfg.setIntervalImpl || function (fn, ms) {
      var id = setInterval(fn, ms);
      /* Node（跑测试）下不让他拦住进程退出；浏览器里没有 unref，忽略。 */
      if (id && typeof id.unref === 'function') id.unref();
      return id;
    };
    var clearIntervalImpl = cfg.clearIntervalImpl || function (id) { clearInterval(id); };
    var pullIntervalMs = typeof cfg.pullIntervalMs === 'number' && cfg.pullIntervalMs >= 1000
      ? cfg.pullIntervalMs : DEFAULT_PULL_INTERVAL_MS;
    var now = cfg.now || function () { return new Date().toISOString(); };
    var onStatus = typeof cfg.onStatus === 'function' ? cfg.onStatus : function () {};

    var disposed = false;
    var timer = null;
    var pullTimer = null;
    var inflight = null;
    var dirty = false;      // 推送期间又发生变更
    var status = null;

    function report(st) {
      status = st;
      try {
        onStatus(st);
      } catch (e) {
        /* 上报回调自己出错不能影响同步 */
      }
    }

    function isSyncing() {
      return engine.getState() === 'syncing';
    }

    function cancel() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    }

    /** 排一次推送。已排队时不重复排（真正的防抖：每次变更重置等待） */
    function schedule() {
      if (disposed) return;
      dirty = true;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(function () {
        timer = null;
        runPush();
      }, debounceMs);
    }

    function runPush() {
      if (disposed) return Promise.resolve(null);
      if (inflight) return inflight;      // 串行：不并发推
      if (!isSyncing()) {
        // 未进入稳态：不推。
        dirty = false;
        /* 唯一必须出声的例外（契约 §4.9 第 5 条）：引擎已经因为冲突/报错停在
           paused-error，从此不会再推送。此时用户继续录入，改动只落在本机——
           若连状态都不上报，界面就完全没有痕迹，用户会以为已经上云。
           其余状态（local / checking / awaiting-choice）是流程中的正常停顿，
           由界面按状态提示，不必每条变更都念一遍。 */
        if (engine.getState() === 'paused-error') {
          report({
            kind: 'push', ok: false, code: 'E_PAUSED',
            message: '同步已暂停，这次改动只留在本机',
            at: now()
          });
        }
        return Promise.resolve(null);
      }
      // 起飞即清：这次推送已覆盖此刻的所有变更；之后到达的才算「期间的变更」
      dirty = false;

      var p;
      try {
        p = Promise.resolve(engine.push());
      } catch (err) {
        p = Promise.reject(err);
      }

      inflight = p.then(function (res) {
        inflight = null;
        if (res && res.ok) {
          report({
            kind: 'push', ok: true, skipped: !!res.skipped,
            code: res.skipped ? 'E_NO_CHANGE' : 'OK',
            message: res.skipped ? '没有变化，跳过' : '已上传',
            at: now()
          });
        } else {
          report({
            kind: 'push', ok: false,
            code: (res && res.code) || 'E_UNKNOWN',
            message: (res && res.message) || '推送失败',
            retryable: !!(res && res.retryable),
            at: now()
          });
          /* 租约被另一个标签页占着（§5.4）：这次改动**没有**上传，而它不会自己再
             触发一次变更事件。不在这里补一次重试，这次改动就一直躺在本地，
             用户既看不到失败细节，也不知道何时会上云。 */
          if (res && res.retryable && !disposed) dirty = true;
        }
        // 推送期间攒下的变更：尾随再推一次，否则最后一次改动永远上不了云
        if (dirty && !disposed) schedule();
        return res;
      }, function (err) {
        inflight = null;
        report({
          kind: 'push', ok: false, code: 'E_PUSH_THREW',
          message: (err && err.message) || '推送异常',
          at: now()
        });
        if (dirty && !disposed) schedule();
        return null;
      });
      return inflight;
    }

    /** 变更入口：订阅 store 后由 store 调用 */
    function onChange() {
      if (disposed) return;
      schedule();
    }

    /**
     * 手动立即推送（设置页的「立即同步」）。
     * 与 schedule 的区别：不等防抖窗口，因此必须先取消已排队的定时器，
     * 否则同一个变更会被推两次（一次手动、一次定时器）。
     */
    function pushNow() {
      if (disposed) {
        return Promise.resolve({ ok: false, code: 'E_DISPOSED', message: '已停止' });
      }
      cancel();
      if (!isSyncing()) {
        var blocked = {
          kind: 'push', ok: false, code: 'E_BAD_STATE',
          message: '同步未启用：' + engine.getState(), at: now()
        };
        report(blocked);
        return Promise.resolve({ ok: false, code: blocked.code, message: blocked.message });
      }
      dirty = true;          // 手动即视为「有一次待推的变更」
      var p = runPush();
      return p.then(function (res) {
        return res || { ok: true, skipped: true, code: 'E_NO_CHANGE' };
      });
    }

    /** 显式拉取。非 syncing 直接拒绝，不发请求。 */
    function pullNow() {
      if (disposed) {
        return Promise.resolve({ ok: false, code: 'E_DISPOSED', message: '已停止' });
      }
      if (!isSyncing()) {
        var pausedState = engine.getState();
        /* D17（2026-10-28 用户反馈）：paused-error / awaiting-choice 下，横幅与面板
           已经在解释「为什么停」（比如另一个标签页改了数据）。切回页面触发的
           pullNow 再记一条「拉取失败：同步未启用（E_BAD_STATE）」，只会把更有
           信息量的最近同步状态冲掉，用户看到的是一句看不懂的错误。这两类状态
           保持安静；其余状态（checking 等）仍如实上报（ST-06）。 */
        if (pausedState === 'paused-error' || pausedState === 'awaiting-choice') {
          return Promise.resolve({ ok: false, code: 'E_BAD_STATE', message: '同步未启用：' + pausedState, silent: true });
        }
        // 拦下也要上报：否则「切回页面什么都没发生」时，用户无法区分
        // 「云端没更新」和「当前根本没在同步」。
        var blocked = {
          kind: 'pull', ok: false, code: 'E_BAD_STATE',
          message: '同步未启用：' + pausedState, at: now()
        };
        report(blocked);
        return Promise.resolve({ ok: false, code: 'E_BAD_STATE', message: blocked.message });
      }
      var p;
      try {
        p = Promise.resolve(engine.pull());
      } catch (err) {
        p = Promise.reject(err);
      }
      return p.then(function (res) {
        report({
          kind: 'pull',
          ok: !!(res && res.ok),
          skipped: !!(res && res.skipped),
          code: (res && res.ok) ? ((res && res.skipped) ? 'E_NO_CHANGE' : 'OK') : ((res && res.code) || 'E_UNKNOWN'),
          message: (res && res.ok) ? ((res && res.skipped) ? '云端无更新' : '已拉取') : ((res && res.message) || '拉取失败'),
          at: now()
        });
        return res;
      }, function (err) {
        report({
          kind: 'pull', ok: false, code: 'E_PULL_THREW',
          message: (err && err.message) || '拉取异常',
          at: now()
        });
        return { ok: false, code: 'E_PULL_THREW', message: (err && err.message) || '拉取异常' };
      });
    }

    /** 后台轮询用的静默拉取：只在「真的拉到了新内容」时上报，其余一律无声。
        与 pullNow（显式动作必须反馈）不同：轮询每 10s 一次，
        「云端无更新」和瞬时网络抖动都不值得刷掉面板上的最近状态。 */
    function pullQuiet() {
      if (disposed || !isSyncing() || inflight) return Promise.resolve(null);
      /* D14 省额度：页面隐藏时跳过后台轮询（切回页面时 visibilitychange
         会立即拉一次，用户感知不到这段空窗；隐藏页面的轮询纯属白烧额度）。 */
      try {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          return Promise.resolve(null);
        }
      } catch (e) { /* 无 document 环境（测试/Worker）：照常轮询 */ }
      var p;
      try {
        p = Promise.resolve(engine.pull());
      } catch (e) {
        return Promise.resolve(null);
      }
      return p.then(function (res) {
        if (res && res.ok && !res.skipped) {
          report({
            kind: 'pull', ok: true, code: 'OK',
            message: '已自动拉取云端更新', at: now(), auto: true
          });
        }
        return res;
      }, function () {
        /* 轮询失败不上报：下个周期会再试；显式「立即同步」仍然会报错 */
        return null;
      });
    }

    /** 等待当前在飞的推送结束（测试与「关闭页面前冲刷」用） */
    function flush() {
      if (!inflight) return Promise.resolve(null);
      return inflight.then(function () {
        if (inflight && inflight !== null) return flush();
        return null;
      });
    }

    var unsubscribe = cfg.subscribe(onChange);

    /* 后台自动拉取（2026-10-27）：steady 挂上即开始轮询。非 syncing 时
       pullQuiet 直接返回，不发请求、不上报——engine 暂停后这里自动安静。 */
    pullTimer = setIntervalImpl(pullQuiet, pullIntervalMs);

    return {
      schedule: schedule,
      pushNow: pushNow,
      pullNow: pullNow,
      pullQuiet: pullQuiet,
      flush: flush,
      pendingMs: function () { return timer === null ? 0 : debounceMs; },
      isPending: function () { return timer !== null; },
      getStatus: function () { return status; },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        cancel();
        if (pullTimer !== null) {
          clearIntervalImpl(pullTimer);
          pullTimer = null;
        }
        dirty = false;
        if (typeof unsubscribe === 'function') unsubscribe();
      }
    };
  }

  return {
    DEFAULT_DEBOUNCE_MS: DEFAULT_DEBOUNCE_MS,
    DEFAULT_PULL_INTERVAL_MS: DEFAULT_PULL_INTERVAL_MS,
    createSteady: createSteady
  };
});
