/**
 * DayPlan · 提醒行同步（D34）
 *
 * 契约：docs/spec/19-notifications.md §2 / §3。
 * 把文档物化成 p_rows，交给 replace_reminders()；签名没变就不发请求。
 * 设备换时区后 fire_at 会变，签名随之变化 → 下一次保存自然覆盖。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(
    isNode ? require('../core/reminder.js') : root.DayPlan.reminder,
    isNode ? require('./supabase.js') : root.DayPlan.supabase
  );
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.remindersCloud = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (R, Supa) {
  'use strict';

  /** 物化结果 → replace_reminders 的 p_rows（字段名与 SQL 对齐）。 */
  function rowsOf(materialized) {
    return (Array.isArray(materialized) ? materialized : []).map(function (r) {
      return {
        source_kind: r.sourceKind,
        source_id: r.sourceId,
        occurrence_key: r.occurrenceKey,
        fire_at: r.fireAt,
        title: r.title
      };
    });
  }

  /** 文档 → replace_reminders 的 p_rows（字段名与 SQL 对齐）。 */
  function toRows(doc, nowMs) {
    if (!R || typeof R.materialize !== 'function') return [];
    return rowsOf(R.materialize(doc, { nowMs: nowMs }));
  }

  /**
   * @param {object} opts
   *   - session    会话（withToken）
   *   - config     Supabase 配置
   *   - fetchImpl  可注入 fetch
   *   - rpcCall    可选：自定义 RPC（测试注入）；默认走 Supabase.rpcCall
   */
  function createSync(opts) {
    opts = opts || {};
    var session = opts.session;
    var lastUid = null;
    var lastSig = '';

    function callRpc(params, token) {
      if (typeof opts.rpcCall === 'function') return opts.rpcCall(params, token);
      return Supa.rpcCall({
        config: opts.config,
        fetchImpl: opts.fetchImpl,
        fn: 'replace_reminders',
        params: params,
        accessToken: token
      });
    }

    function reset() {
      lastUid = null;
      lastSig = '';
    }

    /**
     * @returns {Promise<{ok:boolean, skipped?:boolean, count?:number, code?:string, message?:string}>}
     */
    function sync(args) {
      args = args || {};
      var uid = typeof args.uid === 'string' ? args.uid : '';
      if (!uid) return Promise.resolve({ ok: false, code: 'E_NO_UID' });
      if (!session || typeof session.withToken !== 'function') {
        return Promise.resolve({ ok: false, code: 'E_CONFIG_MISSING', message: '会话不可用' });
      }
      if (!Supa) return Promise.resolve({ ok: false, code: 'E_CONFIG_MISSING', message: '云端模块未加载' });

      var materialized;
      try {
        materialized = R.materialize(args.doc, { nowMs: args.nowMs });
      } catch (e) {
        return Promise.resolve({ ok: false, code: 'E_MATERIALIZE', message: e && e.message ? e.message : '提醒展开失败' });
      }
      var rows = rowsOf(materialized);
      var sig = R && typeof R.signature === 'function' ? R.signature(materialized) : '';
      if (!args.force && uid === lastUid && sig === lastSig) {
        return Promise.resolve({ ok: true, skipped: true, count: rows.length });
      }

      return session.withToken(function (token) {
        return callRpc({ p_rows: rows }, token);
      }).then(function (res) {
        if (res && res.ok) {
          lastUid = uid;
          lastSig = sig;
          return { ok: true, skipped: false, count: rows.length };
        }
        return {
          ok: false,
          code: (res && res.code) || 'E_UNKNOWN',
          message: (res && res.message) || '提醒同步失败'
        };
      }, function (e) {
        return { ok: false, code: 'E_NETWORK', message: e && e.message ? e.message : '提醒同步失败' };
      });
    }

    return {
      sync: sync,
      reset: reset,
      signature: function (doc, nowMs) {
        try {
          return R && R.signature ? R.signature(R.materialize(doc, { nowMs: nowMs })) : '';
        } catch (e) {
          return '';
        }
      }
    };
  }

  return {
    toRows: toRows,
    createSync: createSync
  };
});
