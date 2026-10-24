/**
 * DayPlan · 作用域存储与活动指针（Phase 1B 第一切片）
 *
 * 契约：docs/spec/13-sync-contract-v0.5.md §2.1（键清单）、§2.2（活动数据源）、
 *       §2.3（状态转换中的本地键变化）、§1.9（reset 记录）。
 *
 * 本模块只接受调用方注入的存储对象（localStorage 兼容），不自行访问
 * `localStorage`、不联网、不改 Store、不删除任何非当前作用域的键。
 *
 * 所有写入都做“写入后回读”验证；失败时尽可能恢复原值，并把结果返回给调用方，
 * 由 Store 决定是否改变内存状态。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(
    isNode ? require('./sync-keys.js') : root.DayPlan.syncKeys,
    isNode ? require('./sync-record.js') : root.DayPlan.syncRecord
  );
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.scopeStorage = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (K, syncRecord) {
  'use strict';

  function fail(code, message, detail) {
    return { ok: false, code: code, message: message, detail: detail || null };
  }

  function readRaw(storage, key) {
    try {
      return { ok: true, raw: storage.getItem(key) };
    } catch (e) {
      return fail('E_STORAGE_READ', '读取存储失败：' + (e && e.message ? e.message : '未知错误'), e);
    }
  }

  /** 写入并回读；回读不一致视为失败。 */
  function writeVerified(storage, key, value) {
    try {
      storage.setItem(key, value);
    } catch (e) {
      // Store 包装层已给出面向用户的原因（配额 / 隐私模式），不要重复加前缀
      var message = (e && e.code) ? e.message : '写入存储失败：' + (e && e.message ? e.message : '未知错误');
      return fail(e && e.code ? e.code : 'E_STORAGE_WRITE', message, e);
    }
    var back = readRaw(storage, key);
    if (!back.ok) return back;
    if (back.raw !== value) {
      return fail('E_WRITE_VERIFY', '写入后回读不一致：' + key);
    }
    return { ok: true, raw: back.raw };
  }

  /** 删除并回读；仍存在视为失败。 */
  function removeVerified(storage, key) {
    try {
      storage.removeItem(key);
    } catch (e) {
      return fail('E_STORAGE_REMOVE', '删除存储失败：' + (e && e.message ? e.message : '未知错误'), e);
    }
    var back = readRaw(storage, key);
    if (!back.ok) return back;
    if (back.raw !== null && back.raw !== undefined) {
      return fail('E_REMOVE_VERIFY', '删除后回读仍存在：' + key);
    }
    return { ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 活动指针
   * ------------------------------------------------------------------ */

  /**
   * 读取并解释活动指针（不写入）。
   * 未登录、会话不匹配、指针非法、账号副本缺失 → 一律回落 guest，
   * 由 resolveBootScope 决定是否写回。
   *
   * @param {object} storage
   * @param {string|null} sessionUid 当前会话 uid；null 表示未登录
   * @returns {{scope:object,id:string,repaired:boolean,reason:string,implicit?:boolean,
   *            pointerRaw:(string|null|undefined)}}
   */
  function readActiveScope(storage, sessionUid) {
    var r = readRaw(storage, K.KEYS.active);
    if (!r.ok) {
      return { scope: K.guestScope(), id: K.GUEST_SCOPE_ID, repaired: true, reason: 'read-failed', pointerRaw: null };
    }
    var parsed = K.parseActivePointer(r.raw);
    if (!parsed.ok) {
      return { scope: K.guestScope(), id: K.GUEST_SCOPE_ID, repaired: true, reason: 'invalid-pointer', pointerRaw: r.raw };
    }
    if (parsed.implicit) {
      return { scope: K.guestScope(), id: K.GUEST_SCOPE_ID, repaired: false, reason: 'implicit-guest', implicit: true, pointerRaw: r.raw };
    }
    if (parsed.scope.kind === 'user') {
      if (!sessionUid) {
        return { scope: K.guestScope(), id: K.GUEST_SCOPE_ID, repaired: true, reason: 'no-session', pointerRaw: r.raw };
      }
      if (sessionUid !== parsed.scope.uid) {
        return { scope: K.guestScope(), id: K.GUEST_SCOPE_ID, repaired: true, reason: 'session-mismatch', pointerRaw: r.raw };
      }
      if (!hasScopeRecord(storage, parsed.scope)) {
        return { scope: K.guestScope(), id: K.GUEST_SCOPE_ID, repaired: true, reason: 'account-copy-missing', pointerRaw: r.raw };
      }
    }
    return { scope: parsed.scope, id: parsed.id, repaired: false, reason: 'pointer-ok', pointerRaw: r.raw };
  }

  /**
   * 启动解析：需要回落时写回 "guest"（契约 §2.2 “一律回落并写回”）。
   * 写回失败不阻塞启动，但结果会标记 pointerWrite。
   */
  function resolveBootScope(storage, sessionUid) {
    var read = readActiveScope(storage, sessionUid);
    var out = {
      scope: read.scope,
      id: read.id,
      repaired: read.repaired,
      reason: read.reason,
      implicit: !!read.implicit,
      pointerWrite: null
    };
    if (read.repaired) out.pointerWrite = writeActiveScope(storage, K.guestScope());
    return out;
  }

  /** 写入活动指针并回读验证。 */
  function writeActiveScope(storage, scope) {
    return writeVerified(storage, K.KEYS.active, K.scopeId(scope));
  }

  /**
   * 切换指针：写入目标；失败时恢复原值。
   * @returns {{ok:boolean, code?:string, message?:string, rolledBack?:boolean}}
   */
  function switchActiveScope(storage, targetScope) {
    var before = readRaw(storage, K.KEYS.active);
    var w = writeActiveScope(storage, targetScope);
    if (w.ok) return { ok: true };
    var rolledBack = false;
    if (before.ok) {
      var rb;
      if (before.raw === null || before.raw === undefined) rb = removeVerified(storage, K.KEYS.active);
      else rb = writeVerified(storage, K.KEYS.active, String(before.raw));
      rolledBack = rb.ok;
    }
    return {
      ok: false,
      code: w.code,
      message: w.message,
      rolledBack: rolledBack
    };
  }

  /* ------------------------------------------------------------------ *
   * 作用域数据与演示标记
   * ------------------------------------------------------------------ */

  function readScopeRecord(storage, scope) {
    var key = K.dbKeyForScope(scope);
    var r = readRaw(storage, key);
    if (!r.ok) return r;
    return {
      ok: true,
      key: key,
      exists: r.raw !== null && r.raw !== undefined && r.raw !== '',
      raw: r.raw
    };
  }

  function hasScopeRecord(storage, scope) {
    var r = readScopeRecord(storage, scope);
    return !!(r.ok && r.exists);
  }

  /** 仅由显式候选持久化调用；不做任何指针切换。 */
  function writeScopeRecord(storage, scope, serialized) {
    return writeVerified(storage, K.dbKeyForScope(scope), serialized);
  }

  function removeScopeRecord(storage, scope) {
    return removeVerified(storage, K.dbKeyForScope(scope));
  }

  function writeSeedDone(storage, scope) {
    return writeVerified(storage, K.seedKeyForScope(scope), 'done');
  }

  function readSeedMarker(storage, scope) {
    return readRaw(storage, K.seedKeyForScope(scope));
  }

  /* ------------------------------------------------------------------ *
   * reset 同步记录
   * ------------------------------------------------------------------ */

  /**
   * 写合法 v0.5 reset 记录（§1.9）：enabled=false、hashMethod=null、三个锚点为 null。
   * 保留历史标记（本函数不触碰 history 键）。写入失败时尝试恢复旧记录。
   *
   * @param {object} storage
   * @param {string} uid
   * @param {{now?:string, closedAt?:string|null}} [opts]
   */
  function writeResetSyncRecord(storage, uid, opts) {
    opts = opts || {};
    var key = K.syncRecordKey(uid);
    var before = readRaw(storage, key);
    var nowIso = opts.now || new Date().toISOString();
    var enabledAt = nowIso;
    if (before.ok && before.raw) {
      try {
        var prev = JSON.parse(before.raw);
        if (prev && syncRecord.isIsoString(prev.enabledAt)) enabledAt = prev.enabledAt;
      } catch (e) { /* 旧记录不可解析时按当前时间建立 reset */ }
    }
    var record = syncRecord.buildResetRecord({
      enabledAt: enabledAt,
      closedAt: opts.closedAt === undefined ? null : opts.closedAt,
      now: nowIso
    });
    var w = writeVerified(storage, key, JSON.stringify(record));
    if (w.ok) return { ok: true, record: record };

    var rolledBack = false;
    if (before.ok) {
      var rb;
      if (before.raw === null || before.raw === undefined) rb = removeVerified(storage, key);
      else rb = writeVerified(storage, key, String(before.raw));
      rolledBack = rb.ok;
    }
    return { ok: false, code: w.code, message: w.message, rolledBack: rolledBack };
  }

  /** 把某个键恢复为快照值；快照不存在则删除该键。 */
  function restoreKey(storage, key, before) {
    if (!before || !before.ok) return false;
    if (before.raw === null || before.raw === undefined) return removeVerified(storage, key).ok;
    return writeVerified(storage, key, String(before.raw)).ok;
  }

  /**
   * 清空指定作用域：
   * - 先快照当前数据键与账号同步记录（任一步读取失败则零写入）；
   * - 账号作用域先写合法 reset 记录（写失败则不动数据）；
   * - 再删除该作用域数据键、写该作用域 seed 标记 "done"；
   * - 删除或 seed 写入失败时，把数据键与同步记录恢复为操作前的值；
   * - 游客作用域不触碰任何账号同步记录（Q-14 / A-1）。
   *
   * @returns {{ok:boolean, resetWritten:boolean, removed:boolean, rolledBack:boolean,
   *            code?:string, message?:string}}
   */
  function clearScope(storage, scope, opts) {
    opts = opts || {};
    var dataBefore = readScopeRecord(storage, scope);
    if (!dataBefore.ok) {
      return { ok: false, resetWritten: false, removed: false, rolledBack: false, code: dataBefore.code, message: dataBefore.message };
    }

    var isUser = K.isUserScope(scope);
    var recordKey = isUser ? K.syncRecordKey(scope.uid) : null;
    var recordBefore = null;
    if (isUser) {
      recordBefore = readRaw(storage, recordKey);
      if (!recordBefore.ok) {
        return { ok: false, resetWritten: false, removed: false, rolledBack: false, code: recordBefore.code, message: recordBefore.message };
      }
    }

    var resetWritten = false;
    if (isUser) {
      var reset = writeResetSyncRecord(storage, scope.uid, opts);
      if (!reset.ok) {
        return { ok: false, resetWritten: false, removed: false, rolledBack: false, code: reset.code, message: reset.message };
      }
      resetWritten = true;
    }

    var rm = removeScopeRecord(storage, scope);
    if (!rm.ok) {
      var recordBack = isUser ? restoreKey(storage, recordKey, recordBefore) : false;
      return {
        ok: false, resetWritten: resetWritten, removed: false,
        rolledBack: !isUser || recordBack, code: rm.code, message: rm.message
      };
    }

    var seed = writeSeedDone(storage, scope);
    if (!seed.ok) {
      var dataBack = dataBefore.exists
        ? writeVerified(storage, K.dbKeyForScope(scope), String(dataBefore.raw)).ok
        : removeVerified(storage, K.dbKeyForScope(scope)).ok;
      var recordBack2 = isUser ? restoreKey(storage, recordKey, recordBefore) : false;
      return {
        ok: false, resetWritten: resetWritten, removed: !dataBack,
        rolledBack: dataBack && (!isUser || recordBack2), code: seed.code, message: seed.message
      };
    }
    return { ok: true, resetWritten: resetWritten, removed: true, rolledBack: false };
  }

  return {
    KEYS: K.KEYS,
    readActiveScope: readActiveScope,
    resolveBootScope: resolveBootScope,
    writeActiveScope: writeActiveScope,
    switchActiveScope: switchActiveScope,
    readScopeRecord: readScopeRecord,
    hasScopeRecord: hasScopeRecord,
    writeScopeRecord: writeScopeRecord,
    removeScopeRecord: removeScopeRecord,
    writeSeedDone: writeSeedDone,
    readSeedMarker: readSeedMarker,
    writeResetSyncRecord: writeResetSyncRecord,
    clearScope: clearScope
  };
});
