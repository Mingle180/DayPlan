/**
 * DayPlan · 同步记录校验（纯函数，无 DOM / 存储 / 网络依赖）
 *
 * 契约：docs/spec/13-sync-contract-v0.5.md §1.9（同步记录与哈希）。
 * 本模块只判断记录形状是否可用，不读取存储、不决定同步走向。
 *
 * 版本分歧的处理（不擅自选边）：
 *   v0.3 对 state="reset" 只要求三个锚点为 null，未约束 hashMethod；
 *   v0.5 额外要求 hashMethod === null。
 * 因此结果同时返回 compat.v03 / compat.v05；ok 采用 v0.5 严格口径（保守），
 * 仅 v0.3 合法的记录会得到 ok=false、compat.v03=true、disputed=true，
 * 由后续阶段在契约裁定后再决定如何归类，校验层不静默接受。
 *
 * 未知顶层字段不算非法（向前兼容），记为 warning。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.syncRecord = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var RECORD_VERSION = 3;
  var STATES = { active: true, closed: true, reset: true };
  var RECORD_KEYS = [
    'v', 'state', 'enabled', 'enabledAt', 'closedAt',
    'lastKnownRevision', 'hashMethod', 'lastSyncedHash', 'lastSyncedAt',
    'pendingPushAfterLossyApply'
  ];
  var HASH_RE = /^[0-9a-f]{64}$/;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isIsoString(v) {
    return typeof v === 'string' && ISO_RE.test(v) && !isNaN(Date.parse(v));
  }

  function isRevision(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 1;
  }

  function err(path, message) {
    return { path: path, message: message };
  }

  /**
   * @param {*} raw
   * @param {'v03'|'v05'} resetHashRule reset 状态下是否要求 hashMethod 为 null
   */
  function checkRecord(raw, resetHashRule) {
    var errors = [];
    var warnings = [];
    if (!isPlainObject(raw)) {
      return { errors: [err('$', '同步记录必须是对象')], warnings: warnings };
    }
    if (raw.v !== RECORD_VERSION) {
      errors.push(err('$.v', '同步记录版本必须是 ' + RECORD_VERSION));
    }
    var state = raw.state;
    if (!STATES[state]) {
      errors.push(err('$.state', 'state 必须是 active / closed / reset'));
    }
    if (typeof raw.enabled !== 'boolean') {
      errors.push(err('$.enabled', 'enabled 必须是布尔值'));
    } else if (state === 'active' && raw.enabled !== true) {
      errors.push(err('$.enabled', 'active 记录的 enabled 必须为 true'));
    } else if ((state === 'closed' || state === 'reset') && raw.enabled !== false) {
      errors.push(err('$.enabled', state + ' 记录的 enabled 必须为 false'));
    }
    if (!isIsoString(raw.enabledAt)) {
      errors.push(err('$.enabledAt', 'enabledAt 必须是 ISO 时间字符串'));
    }

    if (state === 'active') {
      if (raw.closedAt !== null) errors.push(err('$.closedAt', 'active 记录的 closedAt 必须为 null'));
    } else if (state === 'closed') {
      if (!isIsoString(raw.closedAt)) errors.push(err('$.closedAt', 'closed 记录的 closedAt 必须是 ISO 时间字符串'));
    } else if (state === 'reset') {
      if (raw.closedAt !== null && !isIsoString(raw.closedAt)) {
        errors.push(err('$.closedAt', 'reset 记录的 closedAt 必须是 null 或 ISO 时间字符串'));
      }
    }

    if (state === 'reset') {
      if (raw.lastKnownRevision !== null) errors.push(err('$.lastKnownRevision', 'reset 记录的 lastKnownRevision 必须为 null'));
      if (raw.lastSyncedHash !== null) errors.push(err('$.lastSyncedHash', 'reset 记录的 lastSyncedHash 必须为 null'));
      if (raw.lastSyncedAt !== null) errors.push(err('$.lastSyncedAt', 'reset 记录的 lastSyncedAt 必须为 null'));
      if (resetHashRule === 'v05' && raw.hashMethod !== null) {
        errors.push(err('$.hashMethod', 'reset 记录的 hashMethod 必须为 null（v0.5）'));
      }
    } else if (state === 'active' || state === 'closed') {
      if (!isRevision(raw.lastKnownRevision)) {
        errors.push(err('$.lastKnownRevision', 'lastKnownRevision 必须是 ≥ 1 的整数'));
      }
      if (raw.hashMethod !== 'sha256') {
        errors.push(err('$.hashMethod', 'hashMethod 必须是 "sha256"'));
      }
      if (typeof raw.lastSyncedHash !== 'string' || !HASH_RE.test(raw.lastSyncedHash)) {
        errors.push(err('$.lastSyncedHash', 'lastSyncedHash 必须是 64 位小写十六进制'));
      }
      if (!isIsoString(raw.lastSyncedAt)) {
        errors.push(err('$.lastSyncedAt', 'lastSyncedAt 必须是 ISO 时间字符串'));
      }
    }

    if (typeof raw.pendingPushAfterLossyApply !== 'boolean') {
      errors.push(err('$.pendingPushAfterLossyApply', 'pendingPushAfterLossyApply 必须是布尔值'));
    }

    Object.keys(raw).forEach(function (k) {
      if (RECORD_KEYS.indexOf(k) === -1) {
        warnings.push(err('$.' + k, '未知字段（已忽略）'));
      }
    });

    return { errors: errors, warnings: warnings };
  }

  /**
   * 校验同步记录。
   * @returns {{ok:boolean,status:string,state:(string|null),errors:Array,warnings:Array,
   *            compat:{v03:boolean,v05:boolean},disputed:boolean}}
   */
  function validateSyncRecord(raw) {
    var v05 = checkRecord(raw, 'v05');
    var v03 = checkRecord(raw, 'v03');
    var ok = v05.errors.length === 0;
    var state = isPlainObject(raw) && STATES[raw.state] ? raw.state : null;
    var status;
    if (ok) status = state;
    else if (v03.errors.length === 0 && state === 'reset') status = 'disputed-reset';
    else status = 'invalid';
    return {
      ok: ok,
      status: status,
      state: state,
      errors: v05.errors,
      warnings: v05.warnings,
      compat: { v03: v03.errors.length === 0, v05: ok },
      disputed: v03.errors.length === 0 && !ok
    };
  }

  /**
   * 解析存储中的原始值（对象或 JSON 字符串）。
   * raw 缺失 → status "missing"；JSON 解析失败 → "unparseable"。
   */
  function parseSyncRecord(raw) {
    if (raw === undefined || raw === null) {
      return {
        ok: false, status: 'missing', state: null, record: null,
        errors: [err('$', '同步记录不存在')], warnings: [],
        compat: { v03: false, v05: false }, disputed: false
      };
    }
    var parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return {
          ok: false, status: 'unparseable', state: null, record: null,
          errors: [err('$', '同步记录不是合法 JSON：' + e.message)], warnings: [],
          compat: { v03: false, v05: false }, disputed: false
        };
      }
    }
    var result = validateSyncRecord(parsed);
    result.record = isPlainObject(parsed) ? parsed : null;
    return result;
  }

  /** §1.10：下一 revision 只能由有效锚点加一；无效锚点直接拒绝。 */
  function nextRevision(record) {
    if (!isPlainObject(record) || !isRevision(record.lastKnownRevision)) {
      var e = new TypeError('无法从无效的 lastKnownRevision 计算下一 revision');
      e.code = 'E_INVALID_REVISION';
      throw e;
    }
    return record.lastKnownRevision + 1;
  }

  /* ------------------------------------------------------------------ *
   * §2.1 同步历史标记
   * ------------------------------------------------------------------ */

  var HISTORY_VERSION = 1;
  var HISTORY_FIELD = 'firstEstablishedAt';
  var HISTORY_LEGACY_FIELD = 'firstEnabledAt';
  var HISTORY_KEYS = ['v', HISTORY_FIELD, HISTORY_LEGACY_FIELD];

  /**
   * 校验历史标记 `{v:1, firstEstablishedAt}`。
   *
   * 标记的唯一语义是“存在过”，时间戳不参与判定。v0.3 的 `firstEnabledAt`
   * 仍被接受（否则旧标记会被当成“从未同步”，反而危险），但只用于诊断：
   * 结果标记 legacy=true，新写入一律使用 firstEstablishedAt。
   *
   * @returns {{ok:boolean, legacy:boolean, field:(string|null), errors:Array, warnings:Array}}
   */
  function validateHistoryMarker(raw) {
    var errors = [];
    var warnings = [];
    if (!isPlainObject(raw)) {
      return {
        ok: false, legacy: false, field: null,
        errors: [err('$', '历史标记必须是对象')], warnings: warnings
      };
    }
    if (raw.v !== HISTORY_VERSION) {
      errors.push(err('$.v', '历史标记版本必须是 ' + HISTORY_VERSION));
    }

    var hasNew = Object.prototype.hasOwnProperty.call(raw, HISTORY_FIELD);
    var hasLegacy = Object.prototype.hasOwnProperty.call(raw, HISTORY_LEGACY_FIELD);
    var newOk = isIsoString(raw[HISTORY_FIELD]);
    var legacyOk = isIsoString(raw[HISTORY_LEGACY_FIELD]);

    if (hasNew && !newOk) {
      errors.push(err('$.' + HISTORY_FIELD, 'firstEstablishedAt 必须是 ISO 时间字符串'));
    }
    if (hasLegacy && !legacyOk) {
      warnings.push(err('$.' + HISTORY_LEGACY_FIELD, '旧字段 firstEnabledAt 不是合法 ISO 时间，已忽略'));
    }
    if (!newOk && !legacyOk) {
      if (!hasNew && !hasLegacy) {
        errors.push(err('$', '缺少 firstEstablishedAt'));
      }
      return {
        ok: false, legacy: false, field: null,
        errors: errors, warnings: warnings
      };
    }
    if (newOk && hasLegacy) {
      warnings.push(err('$.' + HISTORY_LEGACY_FIELD, '旧字段 firstEnabledAt 已弃用（仅诊断用）'));
    } else if (!newOk && legacyOk) {
      warnings.push(err('$.' + HISTORY_LEGACY_FIELD, '读取到 v0.3 旧标记，仅作存在性判定；后续写入使用 firstEstablishedAt'));
    }

    Object.keys(raw).forEach(function (k) {
      if (HISTORY_KEYS.indexOf(k) === -1) {
        warnings.push(err('$.' + k, '未知字段（已忽略）'));
      }
    });

    return {
      ok: errors.length === 0,
      legacy: !newOk && legacyOk,
      field: newOk ? HISTORY_FIELD : HISTORY_LEGACY_FIELD,
      errors: errors,
      warnings: warnings
    };
  }

  /**
   * 构造 v0.5 形状的历史标记。时间戳缺失时取当前时刻。
   * @param {string} [at]
   */
  function buildHistoryMarker(at) {
    if (at === undefined || at === null) at = new Date().toISOString();
    if (!isIsoString(at)) {
      var e = new TypeError('历史标记时间必须是 ISO 时间字符串');
      e.code = 'E_INVALID_TIMESTAMP';
      throw e;
    }
    var marker = { v: HISTORY_VERSION };
    marker[HISTORY_FIELD] = at;
    return marker;
  }

  /* ------------------------------------------------------------------ *
   * §1.9 reset 记录构造
   * ------------------------------------------------------------------ */

  /**
   * 构造完整 v0.5 reset 记录（清空本机 / 删除云端 / 恢复流程共用）。
   * 所有锚点与 hashMethod 一次性写为 null，不保留旧值。
   *
   * @param {{enabledAt?:string, closedAt?:string|null, now?:string}} [opts]
   * @returns {object}
   */
  function buildResetRecord(opts) {
    opts = opts || {};
    var now = opts.now || new Date().toISOString();
    if (!isIsoString(now)) {
      var e1 = new TypeError('now 必须是 ISO 时间字符串');
      e1.code = 'E_INVALID_TIMESTAMP';
      throw e1;
    }
    var enabledAt = opts.enabledAt === undefined || opts.enabledAt === null ? now : opts.enabledAt;
    if (!isIsoString(enabledAt)) {
      var e2 = new TypeError('enabledAt 必须是 ISO 时间字符串');
      e2.code = 'E_INVALID_TIMESTAMP';
      throw e2;
    }
    var closedAt = opts.closedAt === undefined ? null : opts.closedAt;
    if (closedAt !== null && !isIsoString(closedAt)) {
      var e3 = new TypeError('closedAt 必须是 null 或 ISO 时间字符串');
      e3.code = 'E_INVALID_TIMESTAMP';
      throw e3;
    }
    return {
      v: RECORD_VERSION,
      state: 'reset',
      enabled: false,
      enabledAt: enabledAt,
      closedAt: closedAt,
      lastKnownRevision: null,
      hashMethod: null,
      lastSyncedHash: null,
      lastSyncedAt: null,
      pendingPushAfterLossyApply: false
    };
  }

  return {
    RECORD_VERSION: RECORD_VERSION,
    RECORD_KEYS: RECORD_KEYS,
    HASH_RE: HASH_RE,
    HISTORY_VERSION: HISTORY_VERSION,
    HISTORY_FIELD: HISTORY_FIELD,
    HISTORY_LEGACY_FIELD: HISTORY_LEGACY_FIELD,
    HISTORY_KEYS: HISTORY_KEYS,
    isIsoString: isIsoString,
    isRevision: isRevision,
    validateSyncRecord: validateSyncRecord,
    parseSyncRecord: parseSyncRecord,
    nextRevision: nextRevision,
    validateHistoryMarker: validateHistoryMarker,
    buildHistoryMarker: buildHistoryMarker,
    buildResetRecord: buildResetRecord
  };
});
