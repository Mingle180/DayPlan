/**
 * DayPlan · 云端版本栈（纯函数，无 DOM / 存储 / 网络依赖）
 *
 * 存储形状：`schedules.versions` 是 jsonb 数组，**新在前**，每项
 *   { revision, savedAt, device, items, doc }
 * `doc` 是那一次被覆盖前的完整云端 payload（可原样回溯）。
 *
 * 容量：当前版本在 schedule_data 里，versions 只存最近 MAX_OLD 份旧版本，
 * 合计 5 份可回溯。
 *
 * 去重按内容指纹：连续多次「保存但内容没变」不会把历史挤掉。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(isNode ? require('./doc-hash.js') : root.DayPlan.docHash);
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.cloudVersions = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (docHash) {
  'use strict';

  var MAX_OLD = 4;
  var DEVICE_MAX = 40;

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
  }

  function countItems(doc) {
    return isPlainObject(doc) && Array.isArray(doc.items) ? doc.items.length : 0;
  }

  function numOrNull(v) {
    return typeof v === 'number' && isFinite(v) ? Math.floor(v) : null;
  }

  function normalizeEntry(entry) {
    if (!isPlainObject(entry) || !isPlainObject(entry.doc)) return null;
    if (!isNonEmptyString(entry.savedAt)) return null;
    return {
      revision: numOrNull(entry.revision),
      savedAt: entry.savedAt,
      device: isNonEmptyString(entry.device) ? entry.device.trim().slice(0, DEVICE_MAX) : '',
      items: typeof entry.items === 'number' && isFinite(entry.items) && entry.items >= 0
        ? Math.floor(entry.items)
        : countItems(entry.doc),
      doc: entry.doc
    };
  }

  /** 过滤坏项、按内容去重（保留靠前那个），截到 MAX_OLD。不排序：顺序即存储顺序。 */
  function normalizeVersions(raw) {
    var list = Array.isArray(raw) ? raw : [];
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX_OLD; i += 1) {
      var entry = normalizeEntry(list[i]);
      if (!entry) continue;
      var hash = docHash.contentHash(entry.doc);
      if (seen[hash]) continue;
      seen[hash] = true;
      out.push(entry);
    }
    return out;
  }

  /** 把一份新历史压入栈顶：内容重复的旧项先移除，再按 MAX_OLD 截断。 */
  function pushHead(list, entry) {
    var next = normalizeEntry(entry);
    if (!next) return normalizeVersions(list);
    var hash = docHash.contentHash(next.doc);
    var kept = normalizeVersions(list).filter(function (e) {
      return docHash.contentHash(e.doc) !== hash;
    });
    kept.unshift(next);
    return kept.slice(0, MAX_OLD);
  }

  /**
   * 覆盖云端前，把「被覆盖的那份」记进历史。
   * @param {object|null} prevRow 覆盖前的云端行（含 schedule_data / revision / updated_at / saved_by / versions）
   * @returns {Array} 新的 versions 数组（可直接写回）
   */
  function nextVersions(prevRow) {
    if (!isPlainObject(prevRow) || !isPlainObject(prevRow.schedule_data)) {
      return normalizeVersions(prevRow && prevRow.versions);
    }
    return pushHead(prevRow.versions, {
      revision: numOrNull(prevRow.revision),
      savedAt: prevRow.updated_at,
      device: prevRow.saved_by,
      items: countItems(prevRow.schedule_data),
      doc: prevRow.schedule_data
    });
  }

  /**
   * 设置面板要显示的两段：当前版本 + 可回溯的历史。
   * @param {object|null} row 云端行
   * @returns {{ok:boolean, current:(object|null), older:Array}}
   *          current/older 每项：{ revision, savedAt, device, items, doc, isCurrent }
   */
  function listForUi(row) {
    if (!isPlainObject(row) || !isPlainObject(row.schedule_data)) {
      return { ok: false, current: null, older: [] };
    }
    var current = {
      revision: numOrNull(row.revision),
      savedAt: isNonEmptyString(row.updated_at) ? row.updated_at : '',
      device: isNonEmptyString(row.saved_by) ? row.saved_by.trim().slice(0, DEVICE_MAX) : '',
      items: countItems(row.schedule_data),
      doc: row.schedule_data,
      isCurrent: true
    };
    var older = normalizeVersions(row.versions).map(function (e) {
      return {
        revision: e.revision,
        savedAt: e.savedAt,
        device: e.device,
        items: e.items,
        doc: e.doc,
        isCurrent: false
      };
    });
    return { ok: true, current: current, older: older };
  }

  return {
    MAX_OLD: MAX_OLD,
    normalizeVersions: normalizeVersions,
    pushHead: pushHead,
    nextVersions: nextVersions,
    listForUi: listForUi
  };
});
