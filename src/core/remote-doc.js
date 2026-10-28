/**
 * DayPlan · 远端 payload 严格校验（纯函数，无 DOM / 存储 / 网络依赖）
 *
 * 契约：docs/spec/13-sync-contract.md §1.1（字段白名单）、§1.3（字段级校验）、
 *       §1.5 G2–G5、§1.6（版本策略）。
 *
 * 与 schema.validateDocument 的区别（刻意不复用其宽松口径）：
 *   · app 必须严格等于 "DayPlan"；
 *   · schemaVersion 必须存在且严格等于本机 SCHEMA_VERSION，不做迁移；
 *   · notes / weekNotes / monthPlans 三个字段必须存在；
 *   · countdowns 必须是数组且不可缺失（D7 起为远端必填，可为空数组）；
 *   · finishDock 必须是数组且不可缺失（D9 起为远端必填，可为空数组）；
 *   · 顶层未知字段一律拒绝（§1.6：拉取时不属于合法文档）。
 *
 * 本模块只校验，不归一、不合并、不写入。调用方传入的应是 schedule_data 的 payload，
 * 而不是包含 id / user_id / revision / updated_at 的整行。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(
    isNode ? require('./schema.js') : root.DayPlan.schema,
    isNode ? require('./datetime.js') : root.DayPlan.datetime
  );
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.remoteDoc = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (schema, dt) {
  'use strict';

  var REQUIRED_FIELDS = [
    'schemaVersion', 'app', 'categories', 'items',
    'notes', 'weekNotes', 'monthPlans', 'countdowns', 'finishDock'
  ];
  var ALLOWED_FIELDS = REQUIRED_FIELDS.concat(['updatedAt']);
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

  function err(path, message) {
    return { path: path, message: message };
  }

  function isIsoString(v) {
    return typeof v === 'string' && ISO_RE.test(v) && !isNaN(Date.parse(v));
  }

  function validateNotes(notes, path, errors) {
    Object.keys(notes).forEach(function (k) {
      var p = path + '["' + k + '"]';
      if (!dt.isValidDate(k)) {
        errors.push(err(p, '键必须是合法日期'));
        return;
      }
      var n = notes[k];
      if (!schema.isPlainObject(n)) {
        errors.push(err(p, '必须是对象'));
        return;
      }
      if (!schema.isNonEmptyString(n.text)) {
        errors.push(err(p + '.text', '必须是可显示的非空文本'));
      }
      if (n.updatedAt !== undefined && n.updatedAt !== null && !isIsoString(n.updatedAt)) {
        errors.push(err(p + '.updatedAt', 'updatedAt 必须是 ISO 时间字符串'));
      }
    });
  }

  function validateWeekNotes(weekNotes, path, errors) {
    Object.keys(weekNotes).forEach(function (k) {
      var p = path + '["' + k + '"]';
      if (!dt.isValidDate(k)) {
        errors.push(err(p, '键必须是合法日期'));
        return;
      }
      if (!schema.isMondayISO(k)) {
        errors.push(err(p, '键必须是周一'));
        return;
      }
      var w = weekNotes[k];
      if (!schema.isPlainObject(w)) {
        errors.push(err(p, '必须是对象'));
        return;
      }
      if (!schema.isNonEmptyString(w.text)) {
        errors.push(err(p + '.text', '必须是可显示的非空文本'));
      }
      if (w.updatedAt !== undefined && w.updatedAt !== null && !isIsoString(w.updatedAt)) {
        errors.push(err(p + '.updatedAt', 'updatedAt 必须是 ISO 时间字符串'));
      }
    });
  }

  /**
   * 严格校验远端文档。
   * @returns {{ok:boolean, errors:Array<{path:string,message:string}>, versionStatus:string}}
   *          versionStatus: equal | higher | lower | invalid
   */
  function validateRemoteDocument(raw) {
    var errors = [];
    var versionStatus = 'invalid';
    if (!schema.isPlainObject(raw)) {
      return { ok: false, errors: [err('$', '远端 payload 必须是对象')], versionStatus: versionStatus };
    }

    Object.keys(raw).forEach(function (k) {
      if (ALLOWED_FIELDS.indexOf(k) === -1) {
        errors.push(err('$.' + k, '不在远端 payload 白名单内'));
      }
    });

    if (typeof raw.schemaVersion !== 'number' || !isFinite(raw.schemaVersion)
      || Math.floor(raw.schemaVersion) !== raw.schemaVersion) {
      errors.push(err('$.schemaVersion', 'schemaVersion 必须是整数'));
    } else if (raw.schemaVersion > schema.SCHEMA_VERSION) {
      versionStatus = 'higher';
      errors.push(err('$.schemaVersion', '云端数据来自更新版本（' + raw.schemaVersion + ' > ' + schema.SCHEMA_VERSION + '）'));
    } else if (raw.schemaVersion < schema.SCHEMA_VERSION) {
      versionStatus = 'lower';
      errors.push(err('$.schemaVersion', '云端数据版本较低（' + raw.schemaVersion + ' < ' + schema.SCHEMA_VERSION + '），不自动迁移'));
    } else {
      versionStatus = 'equal';
    }

    if (raw.app !== schema.APP_NAME) {
      errors.push(err('$.app', 'app 必须严格等于 "' + schema.APP_NAME + '"'));
    }

    ['notes', 'weekNotes', 'monthPlans'].forEach(function (k) {
      if (!schema.isPlainObject(raw[k])) {
        errors.push(err('$.' + k, '必须是对象且不可缺失'));
      }
    });
    if (!Array.isArray(raw.categories)) errors.push(err('$.categories', '必须是数组'));
    if (!Array.isArray(raw.items)) errors.push(err('$.items', '必须是数组'));

    var catIds = {};
    if (Array.isArray(raw.categories)) {
      raw.categories.forEach(function (c, i) {
        schema.validateCategory(c, '$.categories[' + i + ']').forEach(function (e) { errors.push(e); });
        if (schema.isPlainObject(c) && schema.isNonEmptyString(c.id)) {
          if (catIds[c.id]) errors.push(err('$.categories[' + i + '].id', 'id 重复：' + c.id));
          catIds[c.id] = true;
        }
      });
      schema.BUILTIN_CATEGORIES.forEach(function (b) {
        if (b.special !== 'urgent') return;
        if (!catIds[b.id]) errors.push(err('$.categories', '缺少紧急类别 ' + b.id));
      });
    }

    var itemIds = {};
    if (Array.isArray(raw.items)) {
      raw.items.forEach(function (it, i) {
        schema.validateItem(it, '$.items[' + i + ']').forEach(function (e) { errors.push(e); });
        if (schema.isPlainObject(it) && schema.isNonEmptyString(it.id)) {
          if (itemIds[it.id]) errors.push(err('$.items[' + i + '].id', 'id 重复：' + it.id));
          itemIds[it.id] = true;
        }
        if (schema.isPlainObject(it) && schema.isNonEmptyString(it.categoryId)
          && Array.isArray(raw.categories) && !catIds[it.categoryId]) {
          errors.push(err('$.items[' + i + '].categoryId', '引用了不存在的类别 ' + it.categoryId));
        }
      });
    }

    if (schema.isPlainObject(raw.notes)) {
      validateNotes(raw.notes, '$.notes', errors);
    }
    if (schema.isPlainObject(raw.weekNotes)) {
      validateWeekNotes(raw.weekNotes, '$.weekNotes', errors);
    }
    if (schema.isPlainObject(raw.monthPlans)) {
      schema.validateMonthPlans(raw.monthPlans, '$.monthPlans').forEach(function (e) { errors.push(e); });
    }

    // D7：countdowns 为远端必填字段（可为空数组）。schema.validateCountdowns 对
    // undefined / null 返回空错误（本地宽松口径），故存在性必须在远端单独判定，
    // 否则「缺失」会被当成合法，plan 与投影两侧的歧义就回来了。
    if (!Array.isArray(raw.countdowns)) {
      errors.push(err('$.countdowns', '必须是数组且不可缺失'));
    } else {
      schema.validateCountdowns(raw.countdowns, '$.countdowns', catIds)
        .forEach(function (e) { errors.push(e); });
    }

    // D9（2026-10-27）：finishDock 同口径 —— 远端必填（可为空数组），条目级校验。
    if (!Array.isArray(raw.finishDock)) {
      errors.push(err('$.finishDock', '必须是数组且不可缺失'));
    } else {
      schema.validateFinishDock(raw.finishDock, '$.finishDock')
        .forEach(function (e) { errors.push(e); });
    }

    // §1.3：updatedAt 缺失可用当前时间，但出现时必须是 ISO 字符串。
    if (raw.updatedAt !== undefined && raw.updatedAt !== null && !isIsoString(raw.updatedAt)) {
      errors.push(err('$.updatedAt', 'updatedAt 必须是 ISO 时间字符串或缺失'));
    }

    return { ok: errors.length === 0, errors: errors, versionStatus: versionStatus };
  }

  return {
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    ALLOWED_FIELDS: ALLOWED_FIELDS,
    isIsoString: isIsoString,
    validateRemoteDocument: validateRemoteDocument
  };
});
