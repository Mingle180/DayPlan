/**
 * DayPlan · 远端应用前的纯函数（合并 / defaultCategoryId 兜底 / 归一审计）
 *
 * 契约：docs/spec/13-sync-contract.md §1.2（投影与合并）、§1.4（兜底链）、
 *       §1.7（无损 / 有损判定）、§1.5 G6–G10。
 *
 * 本模块只操作内存对象：不写存储、不联网、不修改入参。
 * 它不负责 G2–G5 的结构/身份/版本校验（见 remote-doc.js），也不负责 G12 落盘。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(isNode ? require('./schema.js') : root.DayPlan.schema);
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.remoteApply = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (schema) {
  'use strict';

  var CONTENT_FIELDS = [
    'schemaVersion', 'app', 'categories', 'items',
    'notes', 'weekNotes', 'monthPlans', 'countdowns', 'finishDock'
  ];
  var SHORT_TASK_ID = 'cat_short_task';

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
  }

  function err(path, message) {
    return { path: path, message: message };
  }

  function cloneJson(v) {
    if (v === undefined) return undefined;
    return JSON.parse(JSON.stringify(v));
  }

  function categoryIdMap(categories) {
    var map = {};
    (Array.isArray(categories) ? categories : []).forEach(function (c) {
      if (isPlainObject(c) && isNonEmptyString(c.id)) map[c.id] = true;
    });
    return map;
  }

  function textLen(v) {
    return typeof v === 'string' ? v.trim().length : 0;
  }

  /* ------------------------------------------------------------------ *
   * §1.4 defaultCategoryId 兜底链
   * ------------------------------------------------------------------ */

  /**
   * @param {string} preferredId 本机当前 defaultCategoryId
   * @param {Array} categories 入云文档的类别
   * @returns {{ok:boolean,id:(string|null),reason:string}}
   */
  function resolveDefaultCategoryId(preferredId, categories) {
    if (!Array.isArray(categories) || categories.length === 0) {
      return { ok: false, id: null, reason: 'no-categories' };
    }
    var ids = {};
    categories.forEach(function (c) {
      if (isPlainObject(c) && isNonEmptyString(c.id)) ids[c.id] = true;
    });
    if (isNonEmptyString(preferredId) && ids[preferredId]) {
      return { ok: true, id: preferredId, reason: 'kept' };
    }
    var ordered = categories.slice().sort(schema.compareCategoryOrder);
    var valid = ordered.filter(function (c) {
      return isPlainObject(c) && isNonEmptyString(c.id);
    });
    if (valid.length === 0) {
      return { ok: false, id: null, reason: 'no-valid-category' };
    }
    for (var i = 0; i < valid.length; i++) {
      if (!schema.isUrgentCategory(valid[i])) {
        return { ok: true, id: valid[i].id, reason: 'first-non-urgent' };
      }
    }
    if (ids[SHORT_TASK_ID]) {
      return { ok: true, id: SHORT_TASK_ID, reason: 'short-task' };
    }
    return { ok: true, id: valid[0].id, reason: 'any' };
  }

  /* ------------------------------------------------------------------ *
   * §1.2 mergeRemote
   * ------------------------------------------------------------------ */

  /**
   * 把远端文档并进本机（D20 起是真合并，不再整块替换）。
   *
   * 语义边界：
   *   · 八类内容（categories / items / notes / weekNotes / monthPlans / countdowns /
   *     finishDock）按 id / 日期键做三向合并 —— 两端各自新增的都保留，同 id 取较新者；
   *     opts.prev（上次同步成功的共同祖先）在场时，双向删除也能正确生效。
   *   · settings 整块取本机：它是设备本地偏好（默认类别、视图密度），不参与云端合并。
   *   · meta 重建：createdAt 沿用本机，updatedAt 沿用远端。
   *
   * @param {object} remoteDoc 已通过 G2–G7 的远端文档
   * @param {object} localDoc 本机活动文档
   * @param {{now?:string, prev?:object}} [opts] prev = 上次同步的共同祖先，缺省退化为二向并集
   * @returns {{ok:boolean, doc:(object|null), errors:Array, warnings:Array}}
   */
  function mergeRemote(remoteDoc, localDoc, opts) {
    opts = opts || {};
    var errors = [];
    if (!isPlainObject(remoteDoc)) errors.push(err('$remote', '远端文档必须是对象'));
    if (!isPlainObject(localDoc)) errors.push(err('$local', '本地文档必须是对象'));
    if (errors.length) return { ok: false, doc: null, errors: errors, warnings: [] };

    if (!Array.isArray(remoteDoc.categories) || remoteDoc.categories.length === 0) {
      return {
        ok: false, doc: null, warnings: [],
        errors: [err('$remote.categories', '类别为空，拒绝应用')]
      };
    }

    var now = opts.now || new Date().toISOString();
    var localMeta = isPlainObject(localDoc.meta) ? localDoc.meta : {};
    var localCreatedAt = isNonEmptyString(localMeta.createdAt) ? localMeta.createdAt : now;

    /* D20（2026-10-28）：这段以前是直接 cloneJson(remoteDoc.xxx) —— 名字叫 mergeRemote，
       实际是「整份取远端」。后果：本机还没推上去的改动，在一次拉取里被无声抹掉；
       两台设备谁后动谁赢，另一台的编辑必然消失，用户看到的就是「只能有一台为主」。
       现在分两种口径，由调用方按「本机有没有未同步的改动」决定：
         · opts.replace = true —— 本机干净（自上次同步后没动过），远端就是唯一真相，
           整份应用。此时合并反而有害：本机残留的旧条目会被当成「本机新增」留下来。
         · 默认 —— 本机也有改动，按 id / 日期键三向合并，两边的改动都留住。 */
    var content;
    var mergedWarnings = [];
    if (opts.replace) {
      content = {
        categories: cloneJson(remoteDoc.categories),
        items: cloneJson(remoteDoc.items),
        notes: cloneJson(remoteDoc.notes),
        weekNotes: cloneJson(remoteDoc.weekNotes),
        monthPlans: cloneJson(remoteDoc.monthPlans),
        countdowns: cloneJson(remoteDoc.countdowns),
        finishDock: cloneJson(remoteDoc.finishDock)
      };
    } else {
      var merged = schema.mergeDocuments(
        localDoc, remoteDoc, isPlainObject(opts.prev) ? opts.prev : null
      );
      if (!merged.doc) {
        return { ok: false, doc: null, warnings: [], errors: [err('$', '两端文档无法归一，合并中止')] };
      }
      mergedWarnings = merged.warnings || [];
      content = {
        categories: merged.doc.categories,
        items: merged.doc.items,
        notes: merged.doc.notes,
        weekNotes: merged.doc.weekNotes,
        monthPlans: merged.doc.monthPlans,
        countdowns: merged.doc.countdowns,
        finishDock: merged.doc.finishDock
      };
    }

    var doc = {
      schemaVersion: remoteDoc.schemaVersion,
      app: remoteDoc.app,
      meta: {
        createdAt: localCreatedAt,
        updatedAt: isNonEmptyString(remoteDoc.updatedAt) ? remoteDoc.updatedAt : now,
        app: 'DayPlan'
      },
      categories: cloneJson(content.categories),
      items: cloneJson(content.items),
      notes: cloneJson(content.notes),
      weekNotes: cloneJson(content.weekNotes),
      monthPlans: cloneJson(content.monthPlans),
      // settings 整块取本机，不逐项合并；先归一以补齐缺省与剔除非法值。
      settings: schema.sanitizeSettings(localDoc.settings)
    };

    var resolved = resolveDefaultCategoryId(doc.settings.defaultCategoryId, doc.categories);
    if (!resolved.ok) {
      return { ok: false, doc: null, warnings: mergedWarnings, errors: [err('$.settings.defaultCategoryId', '无法为入云类别选择默认类别（' + resolved.reason + '）')] };
    }
    doc.settings.defaultCategoryId = resolved.id;

    // D7：倒计时不再整块替换，随合并结果走；仍按合并后的类别表归一，
    // 防止留下悬空类别引用。数组顺序不变（= 显示顺序）。
    doc.countdowns = schema.sanitizeCountdowns(content.countdowns, {
      categoryIds: categoryIdMap(doc.categories),
      fallbackCategoryId: resolved.id
    });

    // D9 / D20：完成台同样走合并（同 occ.key 取 lastTs 较新者）
    doc.finishDock = schema.sanitizeFinishDock(content.finishDock);

    return { ok: true, doc: doc, errors: [], warnings: mergedWarnings };
  }

  /* ------------------------------------------------------------------ *
   * §1.7 归一审计
   * ------------------------------------------------------------------ */

  function itemSnapshot(item) {
    var exceptions = isPlainObject(item.exceptions) ? item.exceptions : {};
    return {
      categoryId: item.categoryId,
      hasTime: isPlainObject(item.time),
      titleLen: textLen(item.title),
      noteLen: textLen(item.note),
      exceptionCount: Object.keys(exceptions).length
    };
  }

  /** G6 快照：只记录判定有损所需的规模与逐条关键字段。 */
  function snapshotDocument(doc) {
    var src = isPlainObject(doc) ? doc : {};
    var items = Array.isArray(src.items) ? src.items : [];
    var categories = Array.isArray(src.categories) ? src.categories : [];

    var itemIds = {};
    var itemById = {};
    items.forEach(function (it) {
      if (!isPlainObject(it) || !isNonEmptyString(it.id)) return;
      if (itemIds[it.id]) return;
      itemIds[it.id] = true;
      itemById[it.id] = itemSnapshot(it);
    });

    var categoryIds = {};
    categories.forEach(function (c) {
      if (isPlainObject(c) && isNonEmptyString(c.id)) categoryIds[c.id] = true;
    });

    var monthPlanCounts = {};
    var monthPlanTexts = {};
    if (isPlainObject(src.monthPlans)) {
      Object.keys(src.monthPlans).forEach(function (month) {
        var list = src.monthPlans[month];
        monthPlanCounts[month] = Array.isArray(list) ? list.length : 0;
        if (Array.isArray(list)) {
          monthPlanTexts[month] = {};
          list.forEach(function (entry) {
            if (!isPlainObject(entry) || !isNonEmptyString(entry.id)) return;
            if (!monthPlanTexts[month][entry.id] && monthPlanTexts[month][entry.id] !== 0) {
              monthPlanTexts[month][entry.id] = textLen(entry.text);
            }
          });
        } else {
          monthPlanTexts[month] = {};
        }
      });
    }

    return {
      itemCount: items.length,
      itemIds: itemIds,
      itemById: itemById,
      categoryCount: categories.length,
      categoryIds: categoryIds,
      noteCount: isPlainObject(src.notes) ? Object.keys(src.notes).length : 0,
      weekNoteCount: isPlainObject(src.weekNotes) ? Object.keys(src.weekNotes).length : 0,
      dockCount: Array.isArray(src.finishDock) ? src.finishDock.length : 0,
      monthPlanCounts: monthPlanCounts,
      monthPlanTexts: monthPlanTexts
    };
  }

  /** §1.7 A 类：唯一允许出现的 warning 是补齐内置类别（合法文档由 G5 拦截，不应发生）。 */
  function isNonLossyWarning(w) {
    return !!w && typeof w.message === 'string'
      && w.message.indexOf('补充缺失的内置类别') !== -1;
  }

  /**
   * @param {object} beforeDoc G6 快照对应的文档（归一前）
   * @param {object} afterDoc  G7 sanitizeDocument 的结果
   * @param {Array} warnings   G7 sanitizeDocument 返回的 warnings
   * @returns {{lossy:boolean, signals:Array, beforeSummary:object, afterSummary:object}}
   */
  function auditNormalization(beforeDoc, afterDoc, warnings) {
    var before = snapshotDocument(beforeDoc);
    var after = snapshotDocument(afterDoc);
    var signals = [];

    function push(code, detail) {
      var s = { code: code };
      if (detail) Object.keys(detail).forEach(function (k) { s[k] = detail[k]; });
      signals.push(s);
    }

    var droppedItemIds = Object.keys(before.itemIds).filter(function (id) { return !after.itemIds[id]; });
    if (droppedItemIds.length) {
      push('ITEM_DROPPED', { ids: droppedItemIds, count: droppedItemIds.length });
    } else if (after.itemCount < before.itemCount) {
      push('ITEM_DROPPED', { count: before.itemCount - after.itemCount });
    }

    var droppedCategoryIds = Object.keys(before.categoryIds).filter(function (id) { return !after.categoryIds[id]; });
    if (droppedCategoryIds.length) {
      push('CATEGORY_DROPPED', { ids: droppedCategoryIds, count: droppedCategoryIds.length });
    } else if (after.categoryCount < before.categoryCount) {
      push('CATEGORY_DROPPED', { count: before.categoryCount - after.categoryCount });
    }

    Object.keys(before.itemById).forEach(function (id) {
      var b = before.itemById[id];
      var a = after.itemById[id];
      if (!a) return;
      if (b.categoryId !== a.categoryId) {
        push('CATEGORY_REF_CHANGED', { id: id, before: b.categoryId, after: a.categoryId });
      }
      if (b.hasTime && !a.hasTime) {
        push('TIME_CLEARED', { id: id });
      }
      if (a.titleLen < b.titleLen) {
        push('TEXT_TRUNCATED', { id: id, field: 'title', before: b.titleLen, after: a.titleLen });
      }
      if (a.noteLen < b.noteLen) {
        push('TEXT_TRUNCATED', { id: id, field: 'note', before: b.noteLen, after: a.noteLen });
      }
      if (a.exceptionCount < b.exceptionCount) {
        push('EXCEPTION_DROPPED', { id: id, before: b.exceptionCount, after: a.exceptionCount });
      }
    });

    if (after.noteCount < before.noteCount) {
      push('NOTE_DROPPED', { before: before.noteCount, after: after.noteCount });
    }
    if (after.weekNoteCount < before.weekNoteCount) {
      push('WEEK_NOTE_DROPPED', { before: before.weekNoteCount, after: after.weekNoteCount });
    }

    // D9：完成台条目在归一中被丢弃（形状非法 / 超上限）同样算有损信号。
    if (after.dockCount < before.dockCount) {
      push('FINISH_DOCK_DROPPED', { before: before.dockCount, after: after.dockCount });
    }

    Object.keys(before.monthPlanCounts).forEach(function (month) {
      var afterCount = after.monthPlanCounts[month] === undefined ? 0 : after.monthPlanCounts[month];
      if (afterCount < before.monthPlanCounts[month]) {
        push('MONTH_PLAN_DROPPED', { month: month, before: before.monthPlanCounts[month], after: afterCount });
      }
    });

    Object.keys(before.monthPlanTexts).forEach(function (month) {
      var beforeTexts = before.monthPlanTexts[month];
      var afterTexts = after.monthPlanTexts[month] || {};
      Object.keys(beforeTexts).forEach(function (id) {
        if (afterTexts[id] === undefined) return; // 条目被丢弃已由计数信号覆盖
        if (afterTexts[id] < beforeTexts[id]) {
          push('TEXT_TRUNCATED', { month: month, id: id, field: 'monthPlan.text', before: beforeTexts[id], after: afterTexts[id] });
        }
      });
    });

    (warnings || []).forEach(function (w) {
      if (!isNonLossyWarning(w)) {
        push('UNEXPECTED_WARNING', { path: w && w.path ? w.path : '$', message: w && w.message ? w.message : String(w) });
      }
    });

    return {
      lossy: signals.length > 0,
      signals: signals,
      beforeSummary: {
        items: before.itemCount,
        categories: before.categoryCount,
        notes: before.noteCount,
        weekNotes: before.weekNoteCount
      },
      afterSummary: {
        items: after.itemCount,
        categories: after.categoryCount,
        notes: after.noteCount,
        weekNotes: after.weekNoteCount
      }
    };
  }

  /**
   * G7：对远端原始 payload 执行 sanitizeDocument，并对比归一前后。
   * 不修改入参；不写入任何存储。
   */
  function normalizeAndAudit(rawDoc) {
    var result = schema.sanitizeDocument(rawDoc);
    return {
      doc: result.doc,
      warnings: result.warnings,
      audit: auditNormalization(rawDoc, result.doc, result.warnings)
    };
  }

  return {
    CONTENT_FIELDS: CONTENT_FIELDS,
    resolveDefaultCategoryId: resolveDefaultCategoryId,
    mergeRemote: mergeRemote,
    snapshotDocument: snapshotDocument,
    isNonLossyWarning: isNonLossyWarning,
    auditNormalization: auditNormalization,
    normalizeAndAudit: normalizeAndAudit
  };
});
