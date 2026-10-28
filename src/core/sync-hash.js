/**
 * DayPlan · 同步投影、规范化 JSON 与哈希（纯函数，无 DOM / 存储 / 网络依赖）
 *
 * 契约：docs/spec/13-sync-contract.md §1.1、§1.2、§1.9、§3.2。
 *   · payloadProjection  = §1.1 十字段（D7 起含 countdowns，D9 起含 finishDock）
 *   · contentProjection  = 九字段去掉 updatedAt（内容八字段）
 *   · contentHash        = SHA-256(UTF-8(canonicalJson(contentProjection(doc))))
 *   · canonicalJson      = 对象键按 UTF-16 码元递归升序、数组保序、无空白、undefined 省略
 *   · itemFingerprint    = 演示条目的固定投影键集合（不含 id / createdAt / updatedAt）
 *
 * 哈希通过 Web Crypto（crypto.subtle）异步完成，可注入 opts.subtle 便于测试。
 * 本模块不自行实现 SHA-256；没有 crypto.subtle 时明确拒绝（code = E_NO_SHA256），
 * 由上层按 §4.8 暂停云同步，绝不把非加密值写进 lastSyncedHash。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.syncHash = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PAYLOAD_FIELDS = [
    'schemaVersion', 'app', 'categories', 'items',
    'notes', 'weekNotes', 'monthPlans', 'countdowns', 'finishDock', 'updatedAt'
  ];
  var CONTENT_FIELDS = [
    'schemaVersion', 'app', 'categories', 'items',
    'notes', 'weekNotes', 'monthPlans', 'countdowns', 'finishDock'
  ];
  var FINGERPRINT_KEYS = [
    'kind', 'title', 'date', 'time', 'note', 'categoryId',
    'done', 'starred', 'order', 'repeat', 'exceptions', 'meta'
  ];
  var CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

  function makeError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /**
   * 确定性序列化。数字遵循 JSON（NaN/Infinity → null），
   * 数组中的 undefined/函数/符号 → null（与 JSON.stringify 一致），
   * 对象中的同类值直接省略。
   */
  function canonicalJson(value) {
    if (value === null) return 'null';
    var t = typeof value;
    if (t === 'number') return isFinite(value) ? JSON.stringify(value) : 'null';
    if (t === 'string' || t === 'boolean') return JSON.stringify(value);
    if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) {
        var item = canonicalJson(value[i]);
        parts.push(item === undefined ? 'null' : item);
      }
      return '[' + parts.join(',') + ']';
    }
    if (t === 'object') {
      var keys = Object.keys(value).filter(function (k) {
        var v = value[k];
        return v !== undefined && typeof v !== 'function' && typeof v !== 'symbol';
      }).sort();
      var out = [];
      keys.forEach(function (k) {
        out.push(JSON.stringify(k) + ':' + canonicalJson(value[k]));
      });
      return '{' + out.join(',') + '}';
    }
    return undefined;
  }

  /** §1.1：只取九字段；updatedAt 来自 meta.updatedAt（仅诊断）。 */
  function payloadProjection(doc) {
    if (!isPlainObject(doc)) return null;
    var meta = isPlainObject(doc.meta) ? doc.meta : {};
    // D7：投影恒输出 countdowns 键——缺失 / null 一律视为空数组，
    // 否则「旧数据没带」与「用户清空」在合并侧无法区分。
    // 非数组（损坏形状）刻意原样透传，交给推送前的 validateDocument 拒绝，
    // 不在此洗成 []，避免把数据损坏伪装成「用户清空」。
    var cds = doc.countdowns;
    if (cds === undefined || cds === null) cds = [];
    else cds = JSON.parse(JSON.stringify(cds));
    // D9（2026-10-27）：finishDock 同口径——缺失 / null 视为空数组，损坏形状原样透传。
    var dock = doc.finishDock;
    if (dock === undefined || dock === null) dock = [];
    else dock = JSON.parse(JSON.stringify(dock));
    return {
      schemaVersion: doc.schemaVersion,
      app: doc.app,
      categories: doc.categories,
      items: doc.items,
      notes: doc.notes,
      weekNotes: doc.weekNotes,
      monthPlans: doc.monthPlans,
      countdowns: cds,
      finishDock: dock,
      updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : null
    };
  }

  /** §1.2：内容投影 = 九字段去掉 updatedAt。 */
  function contentProjection(doc) {
    var payload = payloadProjection(doc);
    if (!payload) return null;
    var out = {};
    CONTENT_FIELDS.forEach(function (k) { out[k] = payload[k]; });
    return out;
  }

  function defaultSubtle() {
    var g = typeof globalThis !== 'undefined' ? globalThis : {};
    var c = g.crypto;
    return c && c.subtle && typeof c.subtle.digest === 'function' ? c.subtle : null;
  }

  function resolveSubtle(opts) {
    if (opts && opts.subtle !== undefined) return opts.subtle;
    return defaultSubtle();
  }

  function hasSha256(opts) {
    var subtle = resolveSubtle(opts);
    return !!subtle && typeof subtle.digest === 'function';
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return out;
  }

  /** SHA-256 / UTF-8 / 64 位小写十六进制。返回 Promise<string>。 */
  function sha256Hex(text, opts) {
    var subtle = resolveSubtle(opts);
    if (!subtle || typeof subtle.digest !== 'function') {
      return Promise.reject(makeError('E_NO_SHA256', '当前环境没有 crypto.subtle，无法计算 SHA-256'));
    }
    if (typeof TextEncoder !== 'function') {
      return Promise.reject(makeError('E_NO_SHA256', '当前环境没有 TextEncoder'));
    }
    var data = new TextEncoder().encode(String(text));
    return Promise.resolve(subtle.digest('SHA-256', data)).then(function (buf) {
      return bytesToHex(new Uint8Array(buf));
    });
  }

  function isValidContentHash(value) {
    return typeof value === 'string' && CONTENT_HASH_RE.test(value);
  }

  /** contentHash(doc) -> Promise<64 位小写十六进制>。 */
  function contentHash(doc, opts) {
    var projection = contentProjection(doc);
    if (!projection) {
      return Promise.reject(makeError('E_INVALID_DOC', '无法对非对象文档计算内容哈希'));
    }
    return sha256Hex(canonicalJson(projection), opts);
  }

  /** §3.2：单条演示条目的固定投影；缺省键补 null。 */
  function itemFingerprintInput(item) {
    if (!isPlainObject(item)) return null;
    var out = {};
    FINGERPRINT_KEYS.forEach(function (k) {
      out[k] = item[k] === undefined ? null : item[k];
    });
    return out;
  }

  /** 逐条指纹（SHA-256）；用于 sha256 基准。 */
  function itemFingerprint(item, opts) {
    var input = itemFingerprintInput(item);
    if (!input) {
      return Promise.reject(makeError('E_INVALID_ITEM', '无法对非对象事项计算指纹'));
    }
    return sha256Hex(canonicalJson(input), opts);
  }

  /**
   * 逐条基准字符串（canonical 降级形式）。
   * 仅用于无 crypto.subtle 时的演示基准，绝不写进 lastSyncedHash。
   */
  function itemBaseline(item) {
    var input = itemFingerprintInput(item);
    if (!input) return null;
    return canonicalJson(input);
  }

  return {
    PAYLOAD_FIELDS: PAYLOAD_FIELDS,
    CONTENT_FIELDS: CONTENT_FIELDS,
    FINGERPRINT_KEYS: FINGERPRINT_KEYS,
    CONTENT_HASH_RE: CONTENT_HASH_RE,
    canonicalJson: canonicalJson,
    payloadProjection: payloadProjection,
    contentProjection: contentProjection,
    hasSha256: hasSha256,
    sha256Hex: sha256Hex,
    isValidContentHash: isValidContentHash,
    contentHash: contentHash,
    itemFingerprintInput: itemFingerprintInput,
    itemFingerprint: itemFingerprint,
    itemBaseline: itemBaseline
  };
});
