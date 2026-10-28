/**
 * DayPlan · 同步后端 mock（内存行 + revision 条件写 + 可注入故障）
 *
 * 用途：在不接真实 Supabase 的前提下，让同步引擎跑通完整链路（开启 → 推送 →
 * 拉取 → 冲突）。**不产生任何真实网络请求**，也不读写 Supabase。
 *
 * 放在 `src/dev/` 而不是测试目录：`src/sync/wiring.js` 的 mock 模式（演示）
 * 与异步用例必须共用同一份后端语义，两份实现必然 drift。
 *
 * 行结构对齐契约 §9：每个用户一行 `{ revision, payload, updated_at }`，
 * `payload` 即 §1.1 的九字段上云投影。
 *
 * 写语义（对应契约 §5.5）：
 *   expectedRevision === null  → 插入；已存在则 CONFLICT（不静默覆盖）
 *   expectedRevision === n     → 仅当当前 revision === n 才更新，否则 CONFLICT
 * 冲突一律报告 0 行受影响，**不得**当成成功——这是防止双设备静默覆盖的核心。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.mockBackend = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * @param {{now?:function():string}} [opts]
   */
  function createMockBackend(opts) {
    opts = opts || {};
    var now = opts.now || function () { return new Date().toISOString(); };

    var rows = Object.create(null);
    var calls = [];
    var faults = [];

    function record(op) {
      calls.push({ op: op });
    }

    function nextFault(kind) {
      for (var i = 0; i < faults.length; i++) {
        if (faults[i].kind === kind) {
          var f = faults.splice(i, 1)[0];
          return f;
        }
      }
      return null;
    }

    /**
     * 读该用户的行。
     * @returns {{ok:true, row:(null|{revision:number,payload:object,updatedAt:string})}
     *          |{ok:false, code:string, message:string}}
     */
    function read(uid) {
      record('read');
      var f = nextFault('read');
      if (f) return { ok: false, code: f.code || 'E_NETWORK', message: f.message || '读取失败（注入）' };
      var row = rows[uid];
      if (!row) return { ok: true, row: null };
      return {
        ok: true,
        row: {
          revision: row.revision,
          payload: JSON.parse(JSON.stringify(row.payload)),
          updatedAt: row.updatedAt
        }
      };
    }

    /**
     * 条件写。
     * @param {string} uid
     * @param {object} payload 九字段投影
     * @param {(number|null)} expectedRevision null = 仅插入
     * @returns {{ok:true, revision:number}|{ok:false, code:string, message:string}}
     */
    function write(uid, payload, expectedRevision) {
      record('write');
      var f = nextFault('write');
      if (f) return { ok: false, code: f.code || 'E_NETWORK', message: f.message || '写入失败（注入）' };

      var existing = rows[uid];
      if (expectedRevision === null || expectedRevision === undefined) {
        if (existing) {
          return { ok: false, code: 'E_CONFLICT', message: '行已存在，插入被拒绝' };
        }
        rows[uid] = { revision: 1, payload: JSON.parse(JSON.stringify(payload)), updatedAt: now() };
        return { ok: true, revision: 1 };
      }

      if (!existing) {
        return { ok: false, code: 'E_CONFLICT', message: '行不存在，条件更新被拒绝' };
      }
      if (existing.revision !== expectedRevision) {
        return { ok: false, code: 'E_CONFLICT', message: 'revision 不匹配（期望 ' + expectedRevision + '，实际 ' + existing.revision + '）' };
      }
      existing.revision += 1;
      existing.payload = JSON.parse(JSON.stringify(payload));
      existing.updatedAt = now();
      return { ok: true, revision: existing.revision };
    }

    /**
     * 删除该用户的行（§2.3「删除云端数据」）。
     * 行本就不存在时同样报成功：对调用方来说「现在没有这一行」就是目标状态。
     */
    function remove(uid) {
      record('remove');
      var f = nextFault('remove');
      if (f) return { ok: false, code: f.code || 'E_NETWORK', message: f.message || '删除失败（注入）' };
      var existed = !!rows[uid];
      delete rows[uid];
      return { ok: true, existed: existed };
    }

    /** 注入一次故障：kind = 'read' | 'write' | 'remove' */
    function failNext(kind, code, message) {
      faults.push({ kind: kind, code: code || 'E_NETWORK', message: message || '' });
    }

    function dump(uid) {
      return rows[uid] ? JSON.parse(JSON.stringify(rows[uid])) : null;
    }

    function stats() {
      var reads = 0;
      var writes = 0;
      var removes = 0;
      calls.forEach(function (c) {
        if (c.op === 'read') reads++;
        else if (c.op === 'write') writes++;
        else if (c.op === 'remove') removes++;
      });
      return { reads: reads, writes: writes, removes: removes, total: calls.length };
    }

    return {
      read: read,
      write: write,
      remove: remove,
      failNext: failNext,
      dump: dump,
      stats: stats,
      calls: calls,
      reset: function () { rows = Object.create(null); calls.length = 0; faults.length = 0; }
    };
  }

  return { createMockBackend: createMockBackend };
});
