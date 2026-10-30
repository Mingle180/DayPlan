/**
 * DayPlan · 云端文档 <-> 本机文档（纯函数，无 DOM / 存储 / 网络依赖）
 *
 * 云端只保存「内容」：九个内容字段 + 一次保存的时间戳。
 * `settings` 是设备本地偏好（默认类别、视图密度），`meta.createdAt` 是账号数据的
 * 出生时间——两者都不上云，回读时沿用本机。
 *
 * 上传前必须归一（schema.sanitizeDocument）：云端那份要保证任何设备都吃得下，
 * 否则一次保存就会让别的端永远拉不下来。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(
    isNode ? require('./schema.js') : root.DayPlan.schema,
    isNode ? require('./doc-hash.js') : root.DayPlan.docHash
  );
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.cloudDoc = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (schema, docHash) {
  'use strict';

  var CLOUD_FIELDS = [
    'schemaVersion', 'app', 'categories', 'items',
    'notes', 'weekNotes', 'monthPlans', 'countdowns', 'finishDock'
  ];
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

  function err(path, message) {
    return { path: path, message: message };
  }

  function fail(code, path, message) {
    return { ok: false, code: code, errors: [err(path, message)], doc: null, payload: null, warnings: [] };
  }

  function cloneJson(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function isIsoString(v) {
    return typeof v === 'string' && ISO_RE.test(v) && !isNaN(Date.parse(v));
  }

  function countItems(doc) {
    return schema.isPlainObject(doc) && Array.isArray(doc.items) ? doc.items.length : 0;
  }

  function categoryIdsOf(categories) {
    var ids = {};
    (Array.isArray(categories) ? categories : []).forEach(function (c) {
      if (schema.isPlainObject(c) && schema.isNonEmptyString(c.id)) ids[c.id] = true;
    });
    return ids;
  }

  /** 默认类别被云端删掉时，退回紧急类别（保证存在），否则第一个类别。 */
  function pickFallbackCategoryId(categories) {
    var list = (Array.isArray(categories) ? categories : []).filter(function (c) {
      return schema.isPlainObject(c) && schema.isNonEmptyString(c.id);
    });
    for (var i = 0; i < list.length; i += 1) {
      if (schema.isUrgentCategory(list[i])) return list[i].id;
    }
    return list.length ? list[0].id : null;
  }

  /**
   * 本机文档 -> 云端 payload。
   * @param {object} doc 本机整份文档
   * @param {{now?:string}} [opts]
   * @returns {{ok:boolean, code?:string, errors:Array, payload:(object|null), warnings:Array}}
   *          warnings 非空表示归一时截断/丢弃过内容（上传的已不是本机原样）。
   */
  function toCloud(doc, opts) {
    opts = opts || {};
    if (!schema.isPlainObject(doc)) {
      return fail('E_SHAPE', '$', '文档必须是对象');
    }
    var normalized = schema.sanitizeDocument(doc);
    var proj = docHash.contentProjection(normalized.doc);
    var payload = {};
    CLOUD_FIELDS.forEach(function (k) { payload[k] = cloneJson(proj[k]); });
    var meta = schema.isPlainObject(normalized.doc.meta) ? normalized.doc.meta : {};
    payload.updatedAt = isIsoString(meta.updatedAt)
      ? meta.updatedAt
      : (isIsoString(opts.now) ? opts.now : new Date().toISOString());

    var checked = schema.validateDocument(payload);
    if (!checked.ok) {
      return {
        ok: false,
        code: 'E_INVALID',
        errors: checked.errors,
        payload: null,
        warnings: normalized.warnings
      };
    }
    return { ok: true, errors: [], payload: payload, warnings: normalized.warnings };
  }

  /**
   * 云端 payload -> 本机文档。
   * settings 与 meta.createdAt 取本机（它们不参与云端存储），meta.updatedAt 取云端。
   *
   * @param {object} payload 云端 schedule_data
   * @param {object} localDoc 本机当前文档（可为 null：本地偏好全用默认值）
   * @param {{now?:string}} [opts]
   * @returns {{ok:boolean, code?:string, errors:Array, doc:(object|null), warnings:Array}}
   */
  function fromCloud(payload, localDoc, opts) {
    opts = opts || {};
    if (!schema.isPlainObject(payload)) {
      return fail('E_SHAPE', '$', '云端内容不是对象');
    }
    if (payload.app !== schema.APP_NAME) {
      return fail('E_APP', '$.app', '不是 DayLight 的云端数据');
    }
    var sv = payload.schemaVersion;
    if (typeof sv !== 'number' || !isFinite(sv) || Math.floor(sv) !== sv) {
      return fail('E_VERSION', '$.schemaVersion', '云端数据的版本号无效');
    }
    if (sv > schema.SCHEMA_VERSION) {
      return fail('E_VERSION', '$.schemaVersion',
        '云端数据来自更新版本（' + sv + ' > ' + schema.SCHEMA_VERSION + '），请先更新应用');
    }
    var migrated = schema.migrateDocument(payload);
    if (!migrated) {
      return fail('E_MIGRATE', '$', '云端数据无法迁移到当前版本');
    }
    var checked = schema.validateDocument(migrated);
    if (!checked.ok) {
      return {
        ok: false,
        code: 'E_INVALID',
        errors: checked.errors,
        doc: null,
        warnings: []
      };
    }

    var local = schema.isPlainObject(localDoc) ? localDoc : null;
    var localSettings = local ? local.settings : null;
    var localFallback = localSettings && schema.isNonEmptyString(localSettings.defaultCategoryId)
      ? localSettings.defaultCategoryId
      : undefined;
    var normalized = schema.sanitizeDocument(migrated, { fallbackCategoryId: localFallback });
    var doc = normalized.doc;

    doc.settings = schema.sanitizeSettings(localSettings);
    var catIds = categoryIdsOf(doc.categories);
    if (!catIds[doc.settings.defaultCategoryId]) {
      var fallback = pickFallbackCategoryId(doc.categories);
      if (fallback) doc.settings.defaultCategoryId = fallback;
    }

    var localMeta = local && schema.isPlainObject(local.meta) ? local.meta : {};
    var createdAt = schema.isNonEmptyString(localMeta.createdAt)
      ? localMeta.createdAt
      : (isIsoString(payload.updatedAt) ? payload.updatedAt : (isIsoString(opts.now) ? opts.now : new Date().toISOString()));
    var updatedAt = isIsoString(payload.updatedAt)
      ? payload.updatedAt
      : (isIsoString(opts.now) ? opts.now : new Date().toISOString());
    doc.meta = { createdAt: createdAt, updatedAt: updatedAt, app: schema.APP_NAME };

    return { ok: true, errors: [], doc: doc, warnings: normalized.warnings };
  }

  return {
    CLOUD_FIELDS: CLOUD_FIELDS,
    countItems: countItems,
    toCloud: toCloud,
    fromCloud: fromCloud
  };
});
