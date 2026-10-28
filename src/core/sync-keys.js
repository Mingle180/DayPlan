/**
 * DayPlan · 同步键与数据作用域（纯函数，无 DOM / 存储 / 网络依赖）
 *
 * 契约：docs/spec/13-sync-contract.md §2.1（键清单）、§2.2（活动数据源）。
 * 本模块只生成键名与解析作用域，不读取也不写入任何存储。
 *
 * uid 约束：Supabase uid（UUID）只含字母、数字、连字符与下划线。
 * 键名用 "." 分段，因此 uid 中禁止出现 "."、":"、空白等会破坏键结构的字符；
 * 非法 uid 一律抛 TypeError（code = E_INVALID_UID），避免生成可碰撞的键。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.syncKeys = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var GUEST_SCOPE_ID = 'guest';
  var USER_SCOPE_PREFIX = 'user:';
  var UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

  var KEYS = {
    guestDb: 'dayplan.db.v1',
    ui: 'dayplan.ui.v1',
    auth: 'dayplan.auth.v1',
    active: 'dayplan.active.v1',
    seedGuest: 'dayplan.seed.v1'
  };

  function makeError(code, message) {
    var e = new TypeError(message);
    e.code = code;
    return e;
  }

  function isValidUid(uid) {
    return typeof uid === 'string' && UID_RE.test(uid);
  }

  function assertUid(uid) {
    if (!isValidUid(uid)) {
      throw makeError('E_INVALID_UID', 'uid 必须是 1–128 位字母/数字/下划线/连字符');
    }
  }

  function guestScope() {
    return { kind: 'guest' };
  }

  function userScope(uid) {
    assertUid(uid);
    return { kind: 'user', uid: uid };
  }

  function isValidScope(scope) {
    if (!scope || typeof scope !== 'object') return false;
    if (scope.kind === 'guest') return true;
    return scope.kind === 'user' && isValidUid(scope.uid);
  }

  function assertScope(scope) {
    if (!isValidScope(scope)) {
      throw makeError('E_INVALID_SCOPE', '作用域必须是 guest 或 user:<合法 uid>');
    }
  }

  function isGuestScope(scope) {
    return !!scope && scope.kind === 'guest';
  }

  function isUserScope(scope) {
    return !!scope && scope.kind === 'user' && isValidUid(scope.uid);
  }

  /** 作用域标识："guest" / "user:<uid>"（与 dayplan.active.v1 同格式） */
  function scopeId(scope) {
    assertScope(scope);
    return isGuestScope(scope) ? GUEST_SCOPE_ID : USER_SCOPE_PREFIX + scope.uid;
  }

  /**
   * 解析 "guest" / "user:<uid>"。
   * @returns {{ok:true,id:string,scope:object}|{ok:false,reason:string,value:*}}
   */
  function parseScopeId(value) {
    if (value === GUEST_SCOPE_ID) {
      return { ok: true, id: GUEST_SCOPE_ID, scope: guestScope() };
    }
    if (typeof value === 'string' && value.indexOf(USER_SCOPE_PREFIX) === 0) {
      var uid = value.slice(USER_SCOPE_PREFIX.length);
      if (isValidUid(uid)) {
        return { ok: true, id: value, scope: userScope(uid) };
      }
      return { ok: false, reason: 'invalid-uid', value: value };
    }
    return { ok: false, reason: 'invalid-scope', value: value };
  }

  /**
   * 解析活动数据源指针。
   * 缺失/空值按契约回落 guest（implicit=true）；未知值只报告非法，
   * 由调用方按 §2.2 回落 guest 并暂停同步——本函数不做任何写入。
   */
  function parseActivePointer(raw) {
    if (raw === undefined || raw === null || raw === '') {
      return { ok: true, id: GUEST_SCOPE_ID, scope: guestScope(), implicit: true };
    }
    var parsed = parseScopeId(raw);
    if (!parsed.ok) {
      return { ok: false, reason: 'invalid-active-pointer', value: raw };
    }
    return parsed;
  }

  function dbKeyForScope(scope) {
    assertScope(scope);
    return isGuestScope(scope) ? KEYS.guestDb : 'dayplan.user.' + scope.uid + '.db';
  }

  /** 演示基准键：游客 dayplan.seed.v1；账号 dayplan.seed.<uid>.v1 */
  function seedKeyForScope(scope) {
    assertScope(scope);
    return isGuestScope(scope) ? KEYS.seedGuest : 'dayplan.seed.' + scope.uid + '.v1';
  }

  /** 同步记录只属于账号；游客没有同步记录键。 */
  function syncRecordKey(uid) {
    assertUid(uid);
    return 'dayplan.sync.v1.' + uid;
  }

  function syncHistoryKey(uid) {
    assertUid(uid);
    return 'dayplan.sync.history.' + uid;
  }

  /**
   * 合并基线键（D20）：上次同步成功时两端的共同内容。
   *
   * 只给三向合并判定「谁删了什么」用，不参与任何展示。
   * 与同步记录分开存：记录的形状由 §1.9 严格约束，塞一份文档进去会把
   * 校验规则搞脏；基线缺失时合并自动退化为二向并集（宁可复活不丢）。
   */
  function syncBaseKey(uid) {
    assertUid(uid);
    return 'dayplan.sync.base.' + uid;
  }

  function syncLeaseKey(uid) {
    assertUid(uid);
    return 'dayplan.sync.lease.' + uid;
  }

  /** 旧版本只写了字符串 "done"，读取时需与对象基准区分（§3.1）。 */
  function isSeedDoneMarker(raw) {
    return raw === 'done';
  }

  function scopeEquals(a, b) {
    if (!isValidScope(a) || !isValidScope(b)) return false;
    if (a.kind !== b.kind) return false;
    return a.kind === 'guest' || a.uid === b.uid;
  }

  return {
    GUEST_SCOPE_ID: GUEST_SCOPE_ID,
    USER_SCOPE_PREFIX: USER_SCOPE_PREFIX,
    KEYS: KEYS,
    isValidUid: isValidUid,
    guestScope: guestScope,
    userScope: userScope,
    isValidScope: isValidScope,
    isGuestScope: isGuestScope,
    isUserScope: isUserScope,
    scopeId: scopeId,
    parseScopeId: parseScopeId,
    parseActivePointer: parseActivePointer,
    dbKeyForScope: dbKeyForScope,
    seedKeyForScope: seedKeyForScope,
    syncRecordKey: syncRecordKey,
    syncHistoryKey: syncHistoryKey,
    syncLeaseKey: syncLeaseKey,
    syncBaseKey: syncBaseKey,
    isSeedDoneMarker: isSeedDoneMarker,
    scopeEquals: scopeEquals
  };
});
