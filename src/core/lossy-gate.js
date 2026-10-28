/**
 * DayPlan · 归一审计的「有损判定」与预览（纯函数，无 DOM / 存储 / 网络依赖）
 *
 * 契约：docs/spec/13-sync-contract.md §1.7（A/B 两类的判定信号）、
 *       §1.8（预览内容、双下载、不得自动回写）。
 *
 * 为什么单独一层：
 *   `remote-apply.normalizeAndAudit` 只回答「有没有损」，它不知道界面要什么。
 *   界面要的是「丢了几条、哪几条、warning 有几条」——把这件事塞进 remote-apply
 *   会让那个纯审计模块长出展示逻辑（前 5 条、前 10 条这类数字开始散落各处）。
 *   集中在这里，界面与引擎共用同一份清单（REQUIRED_DOWNLOADS），改名只改一处。
 *
 * 判定的口径完全来自 §1.7，本模块不新增规则：
 *   A 类（补齐缺省、类型归一、首尾空白裁剪、紧急类别固定）不算有损；
 *   B 类（丢条目/类别、改类别引用、清时段、截文本、丢 exception、丢记录）算有损；
 *   其它任何 warning 也算有损 —— 不得因为「只是 warning」就继续覆盖本地数据。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(
    isNode ? require('./remote-apply.js') : root.DayPlan.remoteApply
  );
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.lossyGate = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (remoteApply) {
  'use strict';

  /** §1.8.3 的两份必需下载：界面按它导出，引擎按它核对。 */
  var REQUIRED_DOWNLOADS = ['remote-raw.json', 'local-current.json'];

  var TITLE_MAX = 5;      // §1.8.2「前 5 条标题」
  var WARN_MAX = 10;      // 展示用截断，总数另行如实返回

  /** 信号 code → 计数桶。新增信号时在这里登记，否则会被总计数兜住但分类缺失。 */
  var BUCKET = {
    ITEM_DROPPED: 'items',
    CATEGORY_DROPPED: 'categories',
    CATEGORY_REF_CHANGED: 'categoryRefs',
    TIME_CLEARED: 'times',
    TEXT_TRUNCATED: 'texts',
    EXCEPTION_DROPPED: 'exceptions',
    NOTE_DROPPED: 'notes',
    WEEK_NOTE_DROPPED: 'weekNotes',
    MONTH_PLAN_DROPPED: 'monthPlans',
    UNEXPECTED_WARNING: 'warnings'
  };

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function textOf(v) {
    return typeof v === 'string' ? v : '';
  }

  /** 一条信号「影响了几条」。没有 count 但有 before/after 的按差值算。 */
  function weightOf(s) {
    if (!s) return 0;
    if (typeof s.count === 'number') return s.count;
    if (typeof s.before === 'number' && typeof s.after === 'number') {
      return Math.max(0, s.before - s.after);
    }
    return 1;
  }

  /** 从「丢弃前的文档」里按 id 取标题。 */
  function titleFromItems(doc, ids) {
    var out = [];
    if (!Array.isArray(ids) || !isPlainObject(doc) || !Array.isArray(doc.items)) return out;
    var byId = {};
    doc.items.forEach(function (it) {
      if (isPlainObject(it) && typeof it.id === 'string') byId[it.id] = it;
    });
    ids.forEach(function (id) {
      var it = byId[id];
      if (it) out.push(textOf(it.title));
    });
    return out;
  }

  /**
   * 月计划被截断时，signal 只有 month/before/after，没有 id。
   * 取「归前后存在、归后不存在」的那几条，顺序保持原文（用户更容易认出来）。
   */
  function titleFromMonthPlans(beforeDoc, afterDoc, month) {
    var out = [];
    if (!isPlainObject(beforeDoc) || !isPlainObject(beforeDoc.monthPlans)) return out;
    var before = beforeDoc.monthPlans[month];
    if (!Array.isArray(before)) return out;
    var afterIds = {};
    var after = isPlainObject(afterDoc) && isPlainObject(afterDoc.monthPlans)
      ? afterDoc.monthPlans[month] : null;
    if (Array.isArray(after)) {
      after.forEach(function (e) {
        if (isPlainObject(e) && typeof e.id === 'string') afterIds[e.id] = true;
      });
    }
    before.forEach(function (e) {
      if (!isPlainObject(e)) return;
      if (typeof e.id === 'string' && afterIds[e.id]) return;
      out.push(textOf(e.text));
    });
    return out;
  }

  function collectTitles(signals, beforeDoc, afterDoc) {
    var titles = [];
    (signals || []).forEach(function (s) {
      if (titles.length >= TITLE_MAX || !s) return;
      if (s.code === 'ITEM_DROPPED' && s.ids) {
        titleFromItems(beforeDoc, s.ids).forEach(function (t) {
          if (titles.length < TITLE_MAX) titles.push(t);
        });
      } else if (s.code === 'MONTH_PLAN_DROPPED' && s.month) {
        titleFromMonthPlans(beforeDoc, afterDoc, s.month).forEach(function (t) {
          if (titles.length < TITLE_MAX) titles.push(t);
        });
      }
    });
    return titles;
  }

  /**
   * 把 audit 的 signals 归纳成「用户能看懂的一屏」。
   *
   * @param {object} audit   remoteApply.auditNormalization 的产物
   * @param {object} beforeDoc G6 快照对应的文档（归一前）
   * @param {object} afterDoc  G7 结果
   * @returns {{lossy:boolean, counts:object, total:number, titles:Array<string>,
   *            signals:Array, warnings:Array}}
   */
  function summarize(audit, beforeDoc, afterDoc) {
    var signals = (audit && Array.isArray(audit.signals)) ? audit.signals : [];
    var counts = {};
    Object.keys(BUCKET).forEach(function (code) { counts[BUCKET[code]] = 0; });
    var total = 0;

    signals.forEach(function (s) {
      if (!s) return;
      var n = weightOf(s);
      total += n;
      var bucket = BUCKET[s.code];
      if (bucket) counts[bucket] += n;
    });

    var warnings = [];
    signals.forEach(function (s) {
      if (!s || s.code !== 'UNEXPECTED_WARNING') return;
      if (warnings.length >= WARN_MAX) return;
      warnings.push({ path: s.path || '$', message: s.message || '' });
    });

    return {
      lossy: !!(audit && audit.lossy),
      counts: counts,
      total: total,
      titles: collectTitles(signals, beforeDoc, afterDoc),
      signals: signals,
      warnings: warnings
    };
  }

  /**
   * G6 → G7 → 判定。**不做写入、不做合并**，只把结论和可直接落盘的归一结果交出去。
   *
   * @param {*} payload 远端原始 payload
   * @returns {{lossy:boolean, doc:(object|null), warnings:Array, audit:object, preview:object}}
   */
  function inspect(payload) {
    var norm = remoteApply.normalizeAndAudit(payload);
    var preview = summarize(norm.audit, payload, norm.doc);
    var doc = norm.doc;
    /* sanitizeDocument 不保留顶层 updatedAt（它在 payload 里是平行字段）。
       mergeRemote 会用它作为 meta.updatedAt，丢了就只能取「现在」——
       那会让「最后修改时间」凭空前移，排查时分不清是谁改的。 */
    if (isPlainObject(payload) && typeof payload.updatedAt === 'string' && isPlainObject(doc)) {
      doc.updatedAt = payload.updatedAt;
    }
    return {
      lossy: preview.lossy,
      doc: doc,
      warnings: (norm.warnings || []).slice(),
      audit: norm.audit,
      preview: preview
    };
  }

  return {
    REQUIRED_DOWNLOADS: REQUIRED_DOWNLOADS,
    TITLE_MAX: TITLE_MAX,
    WARN_MAX: WARN_MAX,
    BUCKET: BUCKET,
    summarize: summarize,
    inspect: inspect
  };
});
