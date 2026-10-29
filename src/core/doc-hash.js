/**
 * DayPlan · 文档内容指纹（纯函数，无 DOM / 存储 / 网络依赖）
 *
 * 只回答一个问题：两份文档的**内容**是否一致。
 * 因此指纹只覆盖会同步的九个字段，`settings`（设备本地偏好）与
 * `meta.updatedAt`（每次落盘都会变的元数据）都不参与。
 *
 * 用途：判断本机相对「上次保存到云端的版本」有没有改动。
 * 指纹只在本机比较（不与别的设备交换），所以用 64 位 FNV-1a 足够，
 * 不需要 Web Crypto，也不受 `file://` 下没有 crypto.subtle 的影响。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.docHash = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 会同步的内容字段（与云端 payload 的十字段去掉 updatedAt 一致）。 */
  var CONTENT_FIELDS = [
    'schemaVersion', 'app', 'categories', 'items',
    'notes', 'weekNotes', 'monthPlans', 'countdowns', 'finishDock'
  ];

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** 键按码元升序、无空白、undefined 省略；数组保序。 */
  function canonicalJson(v) {
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i += 1) parts.push(canonicalJson(v[i]));
      return '[' + parts.join(',') + ']';
    }
    if (t === 'object') {
      var keys = Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort();
      var pairs = [];
      for (var j = 0; j < keys.length; j += 1) {
        pairs.push(JSON.stringify(keys[j]) + ':' + canonicalJson(v[keys[j]]));
      }
      return '{' + pairs.join(',') + '}';
    }
    return 'null';
  }

  function fnv1a(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul ? Math.imul(h, 16777619) >>> 0 : (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function hex8(n) {
    var s = (n >>> 0).toString(16);
    while (s.length < 8) s = '0' + s;
    return s;
  }

  /** 内容投影：缺失的 countdowns / finishDock 一律视为空数组（与云端写入口径一致）。 */
  function contentProjection(doc) {
    if (!isPlainObject(doc)) return null;
    var out = {};
    for (var i = 0; i < CONTENT_FIELDS.length; i += 1) {
      var k = CONTENT_FIELDS[i];
      if (doc[k] === undefined) continue;
      out[k] = doc[k];
    }
    if (out.countdowns === undefined || out.countdowns === null) out.countdowns = [];
    if (out.finishDock === undefined || out.finishDock === null) out.finishDock = [];
    return out;
  }

  /**
   * @param {object} doc 整份文档或云端 payload（只取九个内容字段）
   * @returns {string} 稳定指纹；非对象返回空串
   */
  function contentHash(doc) {
    var proj = contentProjection(doc);
    if (!proj) return '';
    var text = canonicalJson(proj);
    return hex8(fnv1a(text, 2166136261)) + hex8(fnv1a(text, 1099511628)) + ':' + text.length.toString(16);
  }

  return {
    CONTENT_FIELDS: CONTENT_FIELDS,
    canonicalJson: canonicalJson,
    contentProjection: contentProjection,
    contentHash: contentHash
  };
});
