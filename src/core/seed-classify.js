/**
 * DayPlan · 演示数据识别与基准生成（纯函数，无 DOM / 存储 / 网络依赖）
 *
 * 契约：docs/spec/13-sync-contract.md §3.1–§3.5。
 *   · 基准只回答“演示条目是否被改过”，不参与云端等值判断；
 *   · sha256 基准用 itemHashes，canonical 降级用 itemBaselines，两者不混用；
 *   · 任何不确定情况（MIXED / UNKNOWN）都不得自动上传——本模块只分类，不触发上传。
 *
 * 已知契约字面后果（不在本模块“修复”）：
 *   内置演示文档含一条 notes 记录，而 §3.1 规定注入时“含任何 notes / weekNotes /
 *   monthPlans 内容 → hasForeignContentAtInjection = true”。因此按字面生成的内置基准
 *   会让全新安装落入 MIXED（需人工确认）。这是保守行为，等待契约裁定后再调整。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(isNode ? require('./sync-hash.js') : root.DayPlan.syncHash);
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.seedClassify = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (hash) {
  'use strict';

  var MARKER_VERSION = 1;
  var MARKER_STATE = 'seeded';
  var MARKER_DONE = 'done';
  var METHOD_SHA256 = 'sha256';
  var METHOD_CANONICAL = 'canonical';
  var SOURCES = { builtin: true, snapshot: true };
  var KINDS = {
    PURE_DEMO: 'PURE_DEMO',
    MIXED: 'MIXED',
    USER: 'USER',
    UNKNOWN: 'UNKNOWN',
    EMPTY: 'EMPTY'
  };
  var HASH_RE = /^[0-9a-f]{64}$/;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
  }

  function isIsoString(v) {
    return typeof v === 'string' && ISO_RE.test(v) && !isNaN(Date.parse(v));
  }

  function err(path, message) {
    return { path: path, message: message };
  }

  /** notes / weekNotes / monthPlans 任一有键即视为“有其他内容”。 */
  function hasRecordContent(doc) {
    if (!isPlainObject(doc)) return false;
    var keys = ['notes', 'weekNotes', 'monthPlans'];
    for (var i = 0; i < keys.length; i++) {
      var v = doc[keys[i]];
      if (v === undefined || v === null) continue;
      if (!isPlainObject(v)) return true;
      if (Object.keys(v).length > 0) return true;
    }
    return false;
  }

  function isEmptyDocument(doc) {
    if (!isPlainObject(doc)) return false;
    var items = Array.isArray(doc.items) ? doc.items : [];
    return items.length === 0 && !hasRecordContent(doc);
  }

  function validateSeedMarker(marker) {
    var errors = [];
    if (!isPlainObject(marker)) {
      return { ok: false, errors: [err('$', '基准必须是对象')] };
    }
    if (marker.v !== MARKER_VERSION) errors.push(err('$.v', '基准版本必须是 ' + MARKER_VERSION));
    if (marker.state !== MARKER_STATE) errors.push(err('$.state', 'state 必须是 "' + MARKER_STATE + '"'));
    if (!isIsoString(marker.at)) errors.push(err('$.at', 'at 必须是 ISO 时间字符串'));
    if (!SOURCES[marker.source]) errors.push(err('$.source', 'source 必须是 builtin / snapshot'));
    if (!Array.isArray(marker.seedItemIds) || marker.seedItemIds.length === 0) {
      errors.push(err('$.seedItemIds', 'seedItemIds 必须是非空数组'));
    } else {
      var seen = {};
      marker.seedItemIds.forEach(function (id, i) {
        if (!isNonEmptyString(id)) {
          errors.push(err('$.seedItemIds[' + i + ']', 'id 必须是非空字符串'));
        } else if (seen[id]) {
          errors.push(err('$.seedItemIds[' + i + ']', 'id 重复：' + id));
        } else {
          seen[id] = true;
        }
      });
    }
    if (marker.hashMethod === METHOD_SHA256) {
      if (!isPlainObject(marker.itemHashes)) {
        errors.push(err('$.itemHashes', 'sha256 基准必须提供 itemHashes'));
      } else if (Array.isArray(marker.seedItemIds)) {
        marker.seedItemIds.forEach(function (id) {
          if (typeof marker.itemHashes[id] !== 'string' || !HASH_RE.test(marker.itemHashes[id])) {
            errors.push(err('$.itemHashes["' + id + '"]', '必须是 64 位小写十六进制'));
          }
        });
      }
    } else if (marker.hashMethod === METHOD_CANONICAL) {
      if (!isPlainObject(marker.itemBaselines)) {
        errors.push(err('$.itemBaselines', 'canonical 基准必须提供 itemBaselines'));
      } else if (Array.isArray(marker.seedItemIds)) {
        marker.seedItemIds.forEach(function (id) {
          if (!isNonEmptyString(marker.itemBaselines[id])) {
            errors.push(err('$.itemBaselines["' + id + '"]', '必须是非空 canonical 字符串'));
          }
        });
      }
    } else {
      errors.push(err('$.hashMethod', 'hashMethod 必须是 sha256 / canonical'));
    }
    if (typeof marker.hasForeignContentAtInjection !== 'boolean') {
      errors.push(err('$.hasForeignContentAtInjection', '必须是布尔值'));
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function result(kind, reason, extra) {
    var out = {
      kind: kind,
      reason: reason,
      presentDemoIds: [],
      foreignIds: [],
      mismatchIds: [],
      seedItemCount: 0,
      hasOtherContent: false,
      hasForeignContentAtInjection: false,
      markerState: 'object'
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    }
    return out;
  }

  /**
   * 分类前置：完成基准解析与“无需指纹即可判定”的分支。
   * @returns {{early:object}|{marker:object,items:Array,presentDemo:Array,seedItemIds:Array,foreign:Array,hasOther:boolean}}
   */
  function preflight(doc, marker) {
    if (!isPlainObject(doc)) {
      return { early: result(KINDS.UNKNOWN, 'invalid-doc', { markerState: 'missing' }) };
    }
    if (marker === undefined || marker === null) {
      return { early: result(KINDS.UNKNOWN, 'no-marker', { markerState: 'missing' }) };
    }
    if (marker === MARKER_DONE) {
      return { early: result(KINDS.USER, 'marker-done', { markerState: 'done' }) };
    }
    var check = validateSeedMarker(marker);
    if (!check.ok) {
      return { early: result(KINDS.UNKNOWN, 'marker-invalid', { markerState: 'invalid', markerErrors: check.errors }) };
    }

    var items = Array.isArray(doc.items) ? doc.items : [];
    var seedSet = {};
    marker.seedItemIds.forEach(function (id) { seedSet[id] = true; });
    var presentDemo = [];
    var foreign = [];
    items.forEach(function (it) {
      var id = isPlainObject(it) ? it.id : null;
      if (isNonEmptyString(id) && seedSet[id]) presentDemo.push(it);
      else foreign.push(it);
    });
    var hasOther = hasRecordContent(doc);
    var foreignIds = foreign.map(function (it) {
      return isPlainObject(it) && isNonEmptyString(it.id) ? it.id : null;
    });

    if (presentDemo.length === 0) {
      var kind = isEmptyDocument(doc) ? KINDS.EMPTY : KINDS.USER;
      return {
        early: result(kind, isEmptyDocument(doc) ? 'empty-document' : 'no-demo-items', {
          foreignIds: foreignIds,
          seedItemCount: marker.seedItemIds.length,
          hasOtherContent: hasOther,
          hasForeignContentAtInjection: marker.hasForeignContentAtInjection === true
        })
      };
    }
    if (marker.hasForeignContentAtInjection === true) {
      return {
        early: result(KINDS.MIXED, 'foreign-at-injection', {
          presentDemoIds: presentDemo.map(function (it) { return it.id; }),
          foreignIds: foreignIds,
          seedItemCount: marker.seedItemIds.length,
          hasOtherContent: hasOther,
          hasForeignContentAtInjection: true
        })
      };
    }
    if (foreign.length > 0 || hasOther) {
      return {
        early: result(KINDS.MIXED, foreign.length > 0 ? 'foreign-items' : 'other-content', {
          presentDemoIds: presentDemo.map(function (it) { return it.id; }),
          foreignIds: foreignIds,
          seedItemCount: marker.seedItemIds.length,
          hasOtherContent: hasOther,
          hasForeignContentAtInjection: false
        })
      };
    }

    return {
      marker: marker,
      items: items,
      presentDemo: presentDemo,
      seedItemIds: marker.seedItemIds,
      foreign: foreign,
      hasOther: hasOther
    };
  }

  /**
   * 同步分类：调用方已算好逐条指纹（id → 指纹）。
   * @param {object} doc
   * @param {object|string} marker
   * @param {Object<string,string>} fingerprints
   * @param {{method?:string}} [opts]
   */
  function classifyFromFingerprints(doc, marker, fingerprints, opts) {
    var pre = preflight(doc, marker);
    if (pre.early) return pre.early;
    opts = opts || {};
    var method = opts.method || marker.hashMethod;
    if (marker.hashMethod !== method) {
      return result(KINDS.MIXED, 'hash-method-mismatch', {
        presentDemoIds: pre.presentDemo.map(function (it) { return it.id; }),
        seedItemCount: pre.seedItemIds.length,
        hasOtherContent: pre.hasOther
      });
    }
    var expected = method === METHOD_SHA256 ? marker.itemHashes : marker.itemBaselines;
    var fp = isPlainObject(fingerprints) ? fingerprints : {};
    var mismatchIds = [];
    pre.presentDemo.forEach(function (it) {
      var want = expected[it.id];
      var got = fp[it.id];
      if (typeof want !== 'string' || want.length === 0 || got !== want) mismatchIds.push(it.id);
    });
    var pure = mismatchIds.length === 0 && pre.presentDemo.length === pre.seedItemIds.length;
    return result(pure ? KINDS.PURE_DEMO : KINDS.MIXED, pure ? 'all-demo-matches' : 'fingerprint-mismatch', {
      presentDemoIds: pre.presentDemo.map(function (it) { return it.id; }),
      mismatchIds: mismatchIds,
      seedItemCount: pre.seedItemIds.length,
      hasOtherContent: pre.hasOther
    });
  }

  /**
   * 异步分类：按基准方法计算逐条指纹后交给 classifyFromFingerprints。
   * @param {object} doc
   * @param {object|string} marker
   * @param {{method?:string, subtle?:*}} [opts]
   * @returns {Promise<object>}
   */
  function classifyDocument(doc, marker, opts) {
    var pre = preflight(doc, marker);
    if (pre.early) return Promise.resolve(pre.early);
    opts = opts || {};
    var method = opts.method || (hash.hasSha256(opts) ? METHOD_SHA256 : METHOD_CANONICAL);
    if (marker.hashMethod !== method) {
      return Promise.resolve(result(KINDS.MIXED, 'hash-method-mismatch', {
        presentDemoIds: pre.presentDemo.map(function (it) { return it.id; }),
        seedItemCount: pre.seedItemIds.length,
        hasOtherContent: pre.hasOther
      }));
    }
    if (method === METHOD_CANONICAL) {
      var baselines = {};
      pre.presentDemo.forEach(function (it) { baselines[it.id] = hash.itemBaseline(it); });
      return Promise.resolve(classifyFromFingerprints(doc, marker, baselines, { method: method }));
    }
    if (!hash.hasSha256(opts)) {
      return Promise.resolve(result(KINDS.MIXED, 'sha256-unavailable', {
        presentDemoIds: pre.presentDemo.map(function (it) { return it.id; }),
        seedItemCount: pre.seedItemIds.length,
        hasOtherContent: pre.hasOther
      }));
    }
    return Promise.all(pre.presentDemo.map(function (it) {
      return hash.itemFingerprint(it, opts).then(function (fp) { return { id: it.id, fp: fp }; });
    })).then(function (list) {
      var fingerprints = {};
      list.forEach(function (x) { fingerprints[x.id] = x.fp; });
      return classifyFromFingerprints(doc, marker, fingerprints, { method: method });
    });
  }

  /**
   * 生成注入时的演示基准（§3.1 / §3.2）。
   * @param {object} doc 已完成 sanitizeDocument 的文档
   * @param {{seedItemIds:string[], method?:string, subtle?:*, at?:string, source?:string}} opts
   * @returns {Promise<object>}
   */
  function computeSeedBaseline(doc, opts) {
    opts = opts || {};
    if (!isPlainObject(doc)) {
      return Promise.reject(makeError('E_INVALID_DOC', '无法对非对象文档生成演示基准'));
    }
    var seedItemIds = opts.seedItemIds;
    if (!Array.isArray(seedItemIds) || seedItemIds.length === 0) {
      return Promise.reject(makeError('E_INVALID_SEED_IDS', 'seedItemIds 必须是非空数组'));
    }
    var seedSet = {};
    for (var i = 0; i < seedItemIds.length; i++) {
      var sid = seedItemIds[i];
      if (!isNonEmptyString(sid)) {
        return Promise.reject(makeError('E_INVALID_SEED_IDS', 'seedItemIds 只能包含非空字符串'));
      }
      if (seedSet[sid]) {
        return Promise.reject(makeError('E_INVALID_SEED_IDS', 'seedItemIds 不能重复：' + sid));
      }
      seedSet[sid] = true;
    }
    var method = opts.method || METHOD_SHA256;
    if (method !== METHOD_SHA256 && method !== METHOD_CANONICAL) {
      return Promise.reject(makeError('E_INVALID_METHOD', 'method 必须是 sha256 / canonical'));
    }
    var source = opts.source || 'builtin';
    if (!SOURCES[source]) {
      return Promise.reject(makeError('E_INVALID_SOURCE', 'source 必须是 builtin / snapshot'));
    }
    var at = opts.at || new Date().toISOString();
    if (!isIsoString(at)) {
      return Promise.reject(makeError('E_INVALID_TIME', 'at 必须是 ISO 时间字符串'));
    }

    var items = Array.isArray(doc.items) ? doc.items : [];
    var present = [];
    var presentSet = {};
    var hasForeignItem = false;
    items.forEach(function (it) {
      var id = isPlainObject(it) ? it.id : null;
      if (isNonEmptyString(id) && seedSet[id] && !presentSet[id]) {
        presentSet[id] = true;
        present.push(it);
      } else {
        hasForeignItem = true;
      }
    });

    var marker = {
      v: MARKER_VERSION,
      state: MARKER_STATE,
      at: at,
      source: source,
      seedItemIds: present.map(function (it) { return it.id; }),
      hashMethod: method,
      // 契约字面口径：注入时含任何记录内容即标记为 true（内置演示自带一条记录）。
      hasForeignContentAtInjection: hasForeignItem || hasRecordContent(doc)
    };

    if (method === METHOD_CANONICAL) {
      marker.itemBaselines = {};
      present.forEach(function (it) { marker.itemBaselines[it.id] = hash.itemBaseline(it); });
      return Promise.resolve(marker);
    }
    if (!hash.hasSha256(opts)) {
      return Promise.reject(makeError('E_NO_SHA256', '当前环境没有 crypto.subtle，无法生成 sha256 基准'));
    }
    return Promise.all(present.map(function (it) {
      return hash.itemFingerprint(it, opts).then(function (fp) { return { id: it.id, fp: fp }; });
    })).then(function (list) {
      marker.itemHashes = {};
      list.forEach(function (x) { marker.itemHashes[x.id] = x.fp; });
      return marker;
    });
  }

  function makeError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  return {
    MARKER_VERSION: MARKER_VERSION,
    MARKER_STATE: MARKER_STATE,
    MARKER_DONE: MARKER_DONE,
    METHOD_SHA256: METHOD_SHA256,
    METHOD_CANONICAL: METHOD_CANONICAL,
    KINDS: KINDS,
    hasRecordContent: hasRecordContent,
    isEmptyDocument: isEmptyDocument,
    validateSeedMarker: validateSeedMarker,
    classifyFromFingerprints: classifyFromFingerprints,
    classifyDocument: classifyDocument,
    computeSeedBaseline: computeSeedBaseline
  };
});
