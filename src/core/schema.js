/**
 * DayPlan · 校验 / 归一 / 迁移（纯函数，无 DOM 依赖）
 *
 * 契约见 docs/spec/03-data-model.md 与 docs/spec/07-iteration-4-delta.md：
 *   DM-1（不变量 INV-1…INV-10）、DM-3（类别次序）、DM-4.5（starred，迭代 4 起仅作迁移输入）、
 *   DM-8.1（weekNotes）、DM-9（导入导出）、DM-10（设置）、DM-12（迁移 v1→v2）、
 *   DM-18（紧急特殊类别）、DM-20（v2→v3 星标迁移）、DM-24（导出列）。
 * 纪律：本模块所有函数**不抛异常**；未知字段一律保留（向前兼容）。
 * 注：DM-13 中 `sanitizeDocument(doc) -> doc | null` 的写法为简写，
 *     实际返回 `{doc, warnings}`（迭代 1 起的既有契约，store 与用例依赖）。
 */
(function (root, factory) {
  var api = factory(
    typeof module === 'object' && module.exports
      ? require('./datetime.js')
      : ((root.DayPlan = root.DayPlan || {}), root.DayPlan.datetime)
  );
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.schema = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dt) {
  'use strict';

  /* 2026-10-27（D9）：4 → 5。v5 与 v4 的唯一形状差异是 `finishDock` 从「不存在」变成
     「必备顶层字段（可空数组）」——事项完成台的条目与计时快照（迭代 10 批次 5）此前
     只存 UI 状态（dayplan.ui.v1），从未参与同步；用户 2026-10-27 要求多设备同步完成台。
     吸取 D8 的教训（字段加入却不升版本 = 「缺失」与「清空」歧义），这次直接升版本：
     旧 v4 云端文档在新端会被判「版本较低」，由面板用「以本机为准」完成一次升级推送。 */
  var SCHEMA_VERSION = 5;
  var APP_NAME = 'DayPlan';
  var TITLE_MAX = 200;
  var NOTE_MAX = 4000;
  var CATEGORY_NAME_MAX = 10;
  var NAMED_MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
  var COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  /* 2026-10-20 六轮：本月计划（月维度清单）
     · 只按月存一段文字清单，**不产生 items** —— 所以天然「不同步到每天」；
     · 键为 "YYYY-MM"；每条 {id, text, createdAt, updatedAt}，次序即数组顺序。 */
  var MONTH_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
  var MONTH_PLAN_TEXT_MAX = 300;
  var MONTH_PLAN_MAX = 300;         /* 单月条目上限（防御异常数据撑爆面板） */

  /* 五十一轮：倒计时（全局截止时刻清单）
     · 与 items / notes 并列，**不产生事项**；数组顺序即显示顺序（拖动排序 = 数组重排）。
     · targetAt 用本地墙钟 "YYYY-MM-DDTHH:mm"（分钟精度）：
       用户设的是「那天几点」，不能因为换时区/夏令时把时刻挪走。 */
  var COUNTDOWN_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
  var COUNTDOWN_MAX = 1000;         /* 条目上限（防御异常数据撑爆栏） */

  /* 2026-10-27（D9）：事项完成台快照（迭代 10 批次 5）。
     · 数组顺序 = 台内显示顺序；条目是 finishdock.snapshotItem() 的形状。
     · occ 是发生（occurrence）的**嵌入副本**（recurrence.js buildOccurrence /
       singleToOccurrence 的产物）：key = "<seriesId>@<date>"，跨设备凭 seriesId
       回查当前文档；事项若已被删除，完成后静默不动（非关键状态的降级口径）。
     · 计时读数不存盘，只存状态快照（running + lastTs），读数由时间差推出。 */
  var FINISH_DOCK_MAX = 200;
  var DOCK_MODES = ['choose', 'stopwatch', 'countdown', 'pomodoro'];

  /** 迭代 4（DM-18）：紧急特殊类别 id（冻结接口） */
  var URGENT_CATEGORY_ID = 'urgent';
  /** DM-18.1：紧急类别的固定 order（严格小于所有普通类别） */
  var URGENT_ORDER = -1;
  var URGENT_CREATED_AT = '2026-01-01T00:00:00.000Z';

  /** 紧急内置类别（DM-18.1） */
  var URGENT_CATEGORY = {
    id: URGENT_CATEGORY_ID,
    name: '紧急',
    color: '#dc2626',
    order: URGENT_ORDER,
    builtin: true,
    special: 'urgent',
    createdAt: URGENT_CREATED_AT
  };

  /** 内置类别（固定 id；四十八轮起除紧急外均可删除；非紧急者可改名、改色、排序；紧急恒首位且颜色固定） */
  var BUILTIN_CATEGORIES = [
    {
      id: URGENT_CATEGORY_ID, name: '紧急', color: '#dc2626', builtin: true,
      special: 'urgent', order: URGENT_ORDER, createdAt: URGENT_CREATED_AT
    },
    { id: 'cat_long_term', name: '长期目标', color: '#7c3aed', builtin: true, order: 0 },
    { id: 'cat_short_task', name: '短期任务', color: '#2563eb', builtin: true, order: 1 },
    { id: 'cat_temp_event', name: '临时活动', color: '#ea580c', builtin: true, order: 2 }
  ];

  /** 迭代 4 迁移告警码（DM-20.2a/b） */
  var E_MIGRATE_URGENT = 'E_MIGRATE_URGENT';
  /** v3→v4 迁移告警码（D8 / Q-17）：countdowns 形状非法被重置为空数组 */
  var E_MIGRATE_COUNTDOWNS = 'E_MIGRATE_COUNTDOWNS';
  /** v4→v5 迁移告警码（D9）：finishDock 形状非法被重置为空数组 */
  var E_MIGRATE_FINISHDOCK = 'E_MIGRATE_FINISHDOCK';

  /** DM-10：默认设置（迭代 3） */
  var DEFAULT_SETTINGS = {
    dayPxPerHour: 96,
    pxPerHour: 96,
    weekPxPerHour: 56,
    idleCompressHeight: 26,
    idleCompressEnabled: true,
    timelineStartHour: 0,
    timelineEndHour: 24,
    showLunarInCalendar: true,
    showNoteMarker: true,
    showHolidayMarker: true,
    maxLanes: 3,
    defaultCategoryId: 'cat_short_task',
    weekStartsOn: 1,
    theme: 'auto'                     /* 'auto' | 'light' | 'dark'（美化迭代 3：设置里可选深浅色） */
  };

  /** 数值设置项的夹取范围（DM-10） */
  var SETTINGS_RANGES = {
    dayPxPerHour: [60, 160],
    weekPxPerHour: [40, 96],
    idleCompressHeight: [16, 48],
    maxLanes: [1, 6]
  };

  var BOOLEAN_SETTINGS = ['idleCompressEnabled', 'showLunarInCalendar', 'showNoteMarker', 'showHolidayMarker'];

  /** 迁移链（DM-12 / DM-20）：按 schemaVersion 依次执行 */
  var MIGRATIONS = { 1: migrateV1toV2, 2: migrateV2toV3, 3: migrateV3toV4, 4: migrateV4toV5 };

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
  }

  function err(path, message) {
    return { path: path, message: message };
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** DM-4.5：显式真值（"true"/1/"1"/true）→ true，其余 → false */
  function toBool(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
  }

  function cloneJSON(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function shallow(v) {
    var out = {};
    Object.keys(v).forEach(function (k) { out[k] = v[k]; });
    return out;
  }

  function clampInt(v, lo, hi, fallback) {
    var n = Number(v);
    if (v === null || v === undefined || v === '' || !isFinite(n)) return fallback;
    n = Math.round(n);
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  /** 该日期是否为周一（当周记录键，DM-8.1） */
  function isMondayISO(iso) {
    if (!dt.isValidDate(iso)) return false;
    if (typeof dt.isMonday === 'function') return !!dt.isMonday(iso);
    return dt.startOfWeek(iso) === iso;
  }

  /**
   * 五十一轮：倒计时目标时刻是否合法。
   * 只接受本地墙钟 "YYYY-MM-DDTHH:mm"（秒/时区不参与，避免「几点」被时区挪走）。
   */
  function isCountdownTargetAt(value) {
    if (typeof value !== 'string') return false;
    var m = COUNTDOWN_AT_RE.exec(value);
    if (!m) return false;
    if (!dt.isValidDate(m[1] + '-' + m[2] + '-' + m[3])) return false;
    return dt.isValidTime(m[4] + ':' + m[5]);
  }

  /** DM-3 类别次序比较：order 升序 → createdAt 升序 → id 字典序 */
  function compareCategoryOrder(a, b) {
    var oa = isFiniteNumber(a && a.order) ? a.order : 0;
    var ob = isFiniteNumber(b && b.order) ? b.order : 0;
    if (oa !== ob) return oa - ob;
    var ta = a && a.createdAt ? Date.parse(a.createdAt) : 0;
    var tb = b && b.createdAt ? Date.parse(b.createdAt) : 0;
    if (isNaN(ta)) ta = 0;
    if (isNaN(tb)) tb = 0;
    if (ta !== tb) return ta - tb;
    var ia = String((a && a.id) || '');
    var ib = String((b && b.id) || '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  }

  /** DM-18.2（冻结接口）：类别对象或 id 是否为紧急类别 */
  function isUrgentCategory(catOrId) {
    if (catOrId === null || catOrId === undefined) return false;
    if (typeof catOrId === 'string') return catOrId === URGENT_CATEGORY_ID;
    if (typeof catOrId === 'object') return catOrId.id === URGENT_CATEGORY_ID;
    return false;
  }

  /**
   * 按 DM-3 次序排序并压实（迭代 4：紧急恒首位且 order = -1，其余 0..n-1）。
   * 返回新数组；不修改入参数组（但会写入元素上的 order 字段，元素来自调用方时可接受，
   * 调用方请传入深拷贝/自建对象）。
   */
  function compactCategories(list) {
    var urgent = null;
    var others = [];
    (list || []).forEach(function (c) {
      if (isUrgentCategory(c)) {
        if (!urgent) urgent = c; // 重复的 urgent 只保留第一个
        return;
      }
      others.push(c);
    });
    others = others.slice().sort(compareCategoryOrder);
    others.forEach(function (c, i) { c.order = i; });
    if (!urgent) return others;
    urgent.order = URGENT_ORDER;
    urgent.builtin = true;
    urgent.special = 'urgent';
    return [urgent].concat(others);
  }

  /* ------------------------------------------------------------------ *
   * 时间 / 日期
   * ------------------------------------------------------------------ */

  /** 校验 time 对象；返回错误数组 */
  function validateTime(time, path) {
    var errors = [];
    path = path || 'time';
    if (time === null || time === undefined) return errors; // null 合法：无时段
    if (!isPlainObject(time)) return [err(path, '必须是对象或 null')];
    if (!dt.isValidTime(time.start)) errors.push(err(path + '.start', '时间格式非法，应为 HH:mm'));
    if (!dt.isValidTime(time.end)) errors.push(err(path + '.end', '时间格式非法，应为 HH:mm'));
    if (errors.length === 0) {
      var s = dt.minutesOf(time.start);
      var e = dt.minutesOf(time.end);
      if (e <= s) errors.push(err(path, '结束时间需晚于开始时间'));
    }
    return errors;
  }

  /* ------------------------------------------------------------------ *
   * 类别
   * ------------------------------------------------------------------ */

  function validateCategory(cat, path) {
    path = path || 'category';
    var errors = [];
    if (!isPlainObject(cat)) return [err(path, '必须是对象')];
    if (!isNonEmptyString(cat.id)) errors.push(err(path + '.id', 'id 不能为空'));
    if (!isNonEmptyString(cat.name)) {
      errors.push(err(path + '.name', '名称不能为空'));
    } else {
      var len = cat.name.trim().length;
      if (len > CATEGORY_NAME_MAX) errors.push(err(path + '.name', '名称不能超过 ' + CATEGORY_NAME_MAX + ' 字'));
    }
    if (cat.color !== undefined && !COLOR_RE.test(String(cat.color))) {
      errors.push(err(path + '.color', '颜色格式非法，应为 #rrggbb'));
    }
    // DM-18：special 只允许紧急类别携带
    if (cat.special !== undefined && !isUrgentCategory(cat)) {
      errors.push(err(path + '.special', 'special 只允许紧急类别携带'));
    } else if (cat.special !== undefined && cat.special !== 'urgent') {
      errors.push(err(path + '.special', 'special 取值非法，应为 urgent'));
    }
    // INV-9 + DM-18.1：order 若存在必须为整数；仅紧急类别允许为负（固定 -1）
    if (cat.order !== undefined && cat.order !== null) {
      if (!isFiniteNumber(cat.order) || Math.floor(cat.order) !== cat.order) {
        errors.push(err(path + '.order', 'order 需为整数'));
      } else if (!isUrgentCategory(cat) && cat.order < 0) {
        errors.push(err(path + '.order', '普通类别的 order 需为 ≥ 0 的整数'));
      }
    }
    return errors;
  }

  /* ------------------------------------------------------------------ *
   * 重复规则
   * ------------------------------------------------------------------ */

  var REPEAT_TYPES = ['daily', 'weekly', 'monthly', 'yearly', 'lunarYearly'];

  function validateRepeat(repeat, path) {
    path = path || 'repeat';
    var errors = [];
    if (!isPlainObject(repeat)) return [err(path, '必须是对象')];
    if (REPEAT_TYPES.indexOf(repeat.type) === -1) {
      errors.push(err(path + '.type', '重复类型非法，应为 ' + REPEAT_TYPES.join(' / ')));
      return errors; // 类型未知时后续校验无意义
    }
    if (!dt.isValidDate(repeat.startDate)) {
      errors.push(err(path + '.startDate', '开始日期非法，应为 YYYY-MM-DD'));
    }
    if (repeat.endDate !== null && repeat.endDate !== undefined) {
      if (!dt.isValidDate(repeat.endDate)) {
        errors.push(err(path + '.endDate', '结束日期非法，应为 YYYY-MM-DD'));
      } else if (dt.isValidDate(repeat.startDate) && dt.diffDays(repeat.startDate, repeat.endDate) <= 0) {
        errors.push(err(path + '.endDate', '结束日期需晚于开始日期'));
      } else if (dt.isValidDate(repeat.startDate)) {
        // DM-13 / DM-6.3：daily 的有界区间健全性（周计划场景）；endDate = null 的无限区间不受限
        var span = dt.diffDays(repeat.startDate, repeat.endDate);
        if (repeat.type === 'daily' && span > 366) {
          errors.push(err(path + '.endDate', '每天重复的结束日期距开始日期不能超过 366 天'));
        }
      }
    }

    if (repeat.type === 'daily' || repeat.type === 'weekly' || repeat.type === 'monthly') {
      var interval = repeat.interval;
      var maxInterval = repeat.type === 'daily' ? 365 : repeat.type === 'weekly' ? 52 : 12;
      if (typeof interval !== 'number' || !isFinite(interval) || interval < 1 || interval > maxInterval || Math.floor(interval) !== interval) {
        errors.push(err(path + '.interval', '间隔需为 1–' + maxInterval + ' 的整数'));
      }
    }

    if (repeat.type === 'weekly') {
      var wd = repeat.weekdays;
      if (!Array.isArray(wd) || wd.length === 0) {
        errors.push(err(path + '.weekdays', '每周重复至少需要选择一个星期'));
      } else {
        var bad = wd.filter(function (d) { return !(typeof d === 'number' && d >= 1 && d <= 7 && Math.floor(d) === d); });
        if (bad.length) errors.push(err(path + '.weekdays', '星期取值需为 1–7 的整数'));
        var uniq = {};
        wd.forEach(function (d) { uniq[d] = true; });
        if (Object.keys(uniq).length !== wd.length) errors.push(err(path + '.weekdays', '星期不能重复选择'));
      }
    }

    if (repeat.type === 'monthly') {
      if (typeof repeat.day !== 'number' || repeat.day < 1 || repeat.day > 31 || Math.floor(repeat.day) !== repeat.day) {
        errors.push(err(path + '.day', '每月日期需为 1–31 的整数'));
      }
    }

    if (repeat.type === 'yearly') {
      if (typeof repeat.month !== 'number' || repeat.month < 1 || repeat.month > 12 || Math.floor(repeat.month) !== repeat.month) {
        errors.push(err(path + '.month', '公历月份需为 1–12 的整数'));
      }
      if (typeof repeat.day !== 'number' || repeat.day < 1 || repeat.day > 31 || Math.floor(repeat.day) !== repeat.day) {
        errors.push(err(path + '.day', '公历日期需为 1–31 的整数'));
      }
    }

    if (repeat.type === 'lunarYearly') {
      if (typeof repeat.lunarMonth !== 'number' || repeat.lunarMonth < 1 || repeat.lunarMonth > 12 || Math.floor(repeat.lunarMonth) !== repeat.lunarMonth) {
        errors.push(err(path + '.lunarMonth', '农历月份需为 1–12 的整数'));
      }
      if (typeof repeat.lunarDay !== 'number' || repeat.lunarDay < 1 || repeat.lunarDay > 30 || Math.floor(repeat.lunarDay) !== repeat.lunarDay) {
        errors.push(err(path + '.lunarDay', '农历日期需为 1–30 的整数'));
      }
    }

    // F-47.9（DM-6 增量）：excludeHolidays 可选布尔；缺省合法，非布尔一律非法。
    if (repeat.excludeHolidays !== undefined && repeat.excludeHolidays !== null
      && typeof repeat.excludeHolidays !== 'boolean') {
      errors.push(err(path + '.excludeHolidays', '不含法定节假日需为布尔值'));
    }
    // 2026-10-23 三十四轮（DM-6 增量）：excludeWeekends 可选布尔，口径同上。
    if (repeat.excludeWeekends !== undefined && repeat.excludeWeekends !== null
      && typeof repeat.excludeWeekends !== 'boolean') {
      errors.push(err(path + '.excludeWeekends', '不含周末需为布尔值'));
    }
    // 2026-10-24 四十五轮（DM-6 增量）：showLabel 可选布尔；缺省视为显示。
    if (repeat.showLabel !== undefined && repeat.showLabel !== null
      && typeof repeat.showLabel !== 'boolean') {
      errors.push(err(path + '.showLabel', '显示重复类型和起止日期需为布尔值'));
    }
    return errors;
  }

  /* ------------------------------------------------------------------ *
   * 事项
   * ------------------------------------------------------------------ */

  function validateException(ex, path) {
    path = path || 'exception';
    var errors = [];
    if (!isPlainObject(ex)) return [err(path, '必须是对象')];
    if (ex.deleted === true && (ex.time !== undefined || ex.title !== undefined || ex.note !== undefined || ex.categoryId !== undefined || ex.done !== undefined || ex.starred !== undefined)) {
      errors.push(err(path, 'deleted 不能与覆盖字段同时存在'));
    }
    if (ex.time !== undefined) {
      validateTime(ex.time, path + '.time').forEach(function (e) { errors.push(e); });
    }
    if (ex.title !== undefined && !isNonEmptyString(ex.title)) {
      errors.push(err(path + '.title', '标题不能为空'));
    }
    if (ex.done !== undefined && typeof ex.done !== 'boolean') {
      errors.push(err(path + '.done', 'done 必须是布尔值'));
    }
    if (ex.starred !== undefined && typeof ex.starred !== 'boolean') {
      errors.push(err(path + '.starred', 'starred 必须是布尔值'));
    }
    return errors;
  }

  function validateItem(item, path) {
    path = path || 'item';
    var errors = [];
    if (!isPlainObject(item)) return [err(path, '必须是对象')];
    if (!isNonEmptyString(item.id)) errors.push(err(path + '.id', 'id 不能为空'));
    if (!isNonEmptyString(item.title)) {
      errors.push(err(path + '.title', '标题不能为空'));
    } else {
      var t = item.title.trim();
      if (t.length > TITLE_MAX) errors.push(err(path + '.title', '标题不能超过 ' + TITLE_MAX + ' 字'));
    }
    if (!isNonEmptyString(item.categoryId)) errors.push(err(path + '.categoryId', 'categoryId 不能为空'));
    if (item.kind !== 'single' && item.kind !== 'series') {
      errors.push(err(path + '.kind', 'kind 必须是 single 或 series'));
    }
    if (item.note !== undefined && item.note !== null && typeof item.note !== 'string') {
      errors.push(err(path + '.note', '备注必须是字符串'));
    } else if (typeof item.note === 'string' && item.note.length > NOTE_MAX) {
      errors.push(err(path + '.note', '备注不能超过 ' + NOTE_MAX + ' 字'));
    }
    if (item.done !== undefined && typeof item.done !== 'boolean') {
      errors.push(err(path + '.done', 'done 必须是布尔值'));
    }
    if (item.starred !== undefined && typeof item.starred !== 'boolean') {
      errors.push(err(path + '.starred', 'starred 必须是布尔值'));
    }
    if (item.order !== undefined && (typeof item.order !== 'number' || !isFinite(item.order))) {
      errors.push(err(path + '.order', 'order 必须是数字'));
    }
    validateTime(item.time, path + '.time').forEach(function (e) { errors.push(e); });

    if (item.kind === 'single') {
      if (!dt.isValidDate(item.date)) errors.push(err(path + '.date', '日期非法，应为 YYYY-MM-DD'));
    } else if (item.kind === 'series') {
      validateRepeat(item.repeat, path + '.repeat').forEach(function (e) { errors.push(e); });
      if (item.exceptions !== undefined && item.exceptions !== null) {
        if (!isPlainObject(item.exceptions)) {
          errors.push(err(path + '.exceptions', 'exceptions 必须是对象'));
        } else {
          Object.keys(item.exceptions).forEach(function (k) {
            if (!dt.isValidDate(k)) {
              errors.push(err(path + '.exceptions["' + k + '"]', '例外键必须是合法日期'));
              return;
            }
            validateException(item.exceptions[k], path + '.exceptions["' + k + '"]').forEach(function (e) { errors.push(e); });
          });
        }
      }
    }
    return errors;
  }

  /* ------------------------------------------------------------------ *
   * 文档
   * ------------------------------------------------------------------ */

  function validateDocument(doc) {
    var errors = [];
    if (!isPlainObject(doc)) return { ok: false, errors: [err('$', '根节点必须是对象')] };
    if (typeof doc.schemaVersion !== 'number' || Math.floor(doc.schemaVersion) !== doc.schemaVersion) {
      errors.push(err('$.schemaVersion', 'schemaVersion 必须是整数'));
    } else if (doc.schemaVersion > SCHEMA_VERSION) {
      errors.push(err('$.schemaVersion', '数据版本 ' + doc.schemaVersion + ' 高于当前应用支持的 ' + SCHEMA_VERSION));
    } else if (doc.schemaVersion < SCHEMA_VERSION) {
      // INV-1：当前文档必须为 v2；v1 应先走 migrateDocument（DM-12）
      errors.push(err('$.schemaVersion', '数据版本 ' + doc.schemaVersion + ' 需要迁移到 ' + SCHEMA_VERSION));
    }
    if (!Array.isArray(doc.categories)) errors.push(err('$.categories', '必须是数组'));
    if (!Array.isArray(doc.items)) errors.push(err('$.items', '必须是数组'));

    var catIds = {};
    if (Array.isArray(doc.categories)) {
      doc.categories.forEach(function (c, i) {
        validateCategory(c, '$.categories[' + i + ']').forEach(function (e) { errors.push(e); });
        if (isPlainObject(c) && isNonEmptyString(c.id)) {
          if (catIds[c.id]) errors.push(err('$.categories[' + i + '].id', 'id 重复：' + c.id));
          catIds[c.id] = true;
        }
      });
      /* 四十八轮（用户口径「内置类别除了紧急都可删除」）：只保证紧急类别存在；
         其余内置类别允许被用户删掉，不能在这里补回来。 */
      BUILTIN_CATEGORIES.forEach(function (b) {
        if (!catIds[b.id] && b.special === 'urgent') {
          errors.push(err('$.categories', '缺少内置类别 ' + b.id));
        }
      });
    }

    var itemIds = {};
    if (Array.isArray(doc.items)) {
      doc.items.forEach(function (it, i) {
        validateItem(it, '$.items[' + i + ']').forEach(function (e) { errors.push(e); });
        if (isPlainObject(it) && isNonEmptyString(it.id)) {
          if (itemIds[it.id]) errors.push(err('$.items[' + i + '].id', 'id 重复：' + it.id));
          itemIds[it.id] = true;
        }
        if (isPlainObject(it) && isNonEmptyString(it.categoryId) && Array.isArray(doc.categories) && !catIds[it.categoryId]) {
          errors.push(err('$.items[' + i + '].categoryId', '引用了不存在的类别 ' + it.categoryId));
        }
      });
    }

    if (doc.notes !== undefined && doc.notes !== null) {
      if (!isPlainObject(doc.notes)) {
        errors.push(err('$.notes', '必须是对象'));
      } else {
        Object.keys(doc.notes).forEach(function (k) {
          if (!dt.isValidDate(k)) {
            errors.push(err('$.notes["' + k + '"]', '键必须是合法日期'));
            return;
          }
          var n = doc.notes[k];
          if (!isPlainObject(n)) {
            errors.push(err('$.notes["' + k + '"]', '必须是对象'));
          } else if (!isNonEmptyString(n.text)) {
            errors.push(err('$.notes["' + k + '"].text', '空记录不应存在，应删除该键'));
          }
        });
      }
    }

    // DM-8.1 / INV-7：当周记录（键必须是周一）
    if (doc.weekNotes !== undefined && doc.weekNotes !== null) {
      if (!isPlainObject(doc.weekNotes)) {
        errors.push(err('$.weekNotes', '必须是对象'));
      } else {
        Object.keys(doc.weekNotes).forEach(function (k) {
          if (!dt.isValidDate(k)) {
            errors.push(err('$.weekNotes["' + k + '"]', '键必须是合法日期'));
            return;
          }
          if (!isMondayISO(k)) {
            errors.push(err('$.weekNotes["' + k + '"]', '当周记录的键必须是周一'));
            return;
          }
          var w = doc.weekNotes[k];
          if (!isPlainObject(w)) {
            errors.push(err('$.weekNotes["' + k + '"]', '必须是对象'));
          } else if (!isNonEmptyString(w.text)) {
            errors.push(err('$.weekNotes["' + k + '"].text', '空记录不应存在，应删除该键'));
          }
        });
      }
    }

    // DM-10：设置（存在时校验；缺失键由 sanitizeSettings 补默认）
    if (doc.settings !== undefined && doc.settings !== null) {
      validateSettings(doc.settings, '$.settings').forEach(function (e) { errors.push(e); });
    }

    // 2026-10-20 六轮：本月计划（存在时校验；旧数据没有该字段同样合法）
    validateMonthPlans(doc.monthPlans, '$.monthPlans').forEach(function (e) { errors.push(e); });

    // 五十一轮：倒计时（存在时校验；旧数据没有该字段同样合法）
    validateCountdowns(doc.countdowns, '$.countdowns', catIds).forEach(function (e) { errors.push(e); });

    // D9（2026-10-27）：完成台快照（存在时校验；v4 旧数据没有该字段同样合法）
    validateFinishDock(doc.finishDock, '$.finishDock').forEach(function (e) { errors.push(e); });

    return { ok: errors.length === 0, errors: errors };
  }

  /* ------------------------------------------------------------------ *
   * 归一（sanitize）：只做契约允许的自动修复
   * ------------------------------------------------------------------ */

  function sanitizeCategory(cat, index) {
    if (!isPlainObject(cat)) return null;
    var out = {};
    Object.keys(cat).forEach(function (k) { out[k] = cat[k]; }); // 保留未知字段
    if (!isNonEmptyString(out.id)) return null;
    if (!isNonEmptyString(out.name)) out.name = '未命名类别';
    out.name = out.name.trim().slice(0, CATEGORY_NAME_MAX);
    if (!COLOR_RE.test(String(out.color))) out.color = '#6b7280';
    out.builtin = !!out.builtin;
    // DM-18：special 只允许紧急类别携带；紧急必须是内置且 order = -1（恒首位）
    if (isUrgentCategory(out)) {
      out.builtin = true;
      out.special = 'urgent';
      out.order = URGENT_ORDER;
      /* 2026-10-20：紧急只可改名，颜色属于它的身份（红 = 急）。
         旧版本允许改色，导入旧备份时在这里静默归一到固定红色，
         避免「紧急」在界面里换了颜色就认不出来。 */
      out.color = URGENT_CATEGORY.color;
      if (!isNonEmptyString(out.createdAt)) out.createdAt = URGENT_CREATED_AT;
      return out;
    }
    delete out.special;
    // INV-9 / DM-13：order 整数化（"2" → 2），缺失时回退为数组下标；非负
    if (out.order !== undefined && out.order !== null && out.order !== '') {
      var n = Number(out.order);
      out.order = isFinite(n) ? Math.max(0, Math.floor(n)) : (typeof index === 'number' ? index : 0);
    } else {
      out.order = typeof index === 'number' ? index : 0;
    }
    return out;
  }

  function sanitizeException(ex) {
    if (!isPlainObject(ex)) return null;
    var out = {};
    Object.keys(ex).forEach(function (k) { out[k] = ex[k]; });
    if (out.deleted) return { deleted: true };
    if (out.time !== undefined) {
      if (out.time === null) {
        // null 表示"该次改为无时段"，合法
      } else if (isPlainObject(out.time) && dt.isValidTime(out.time.start) && dt.isValidTime(out.time.end) && dt.minutesOf(out.time.end) > dt.minutesOf(out.time.start)) {
        out.time = { start: out.time.start, end: out.time.end };
      } else {
        delete out.time;
      }
    }
    if (typeof out.title === 'string') out.title = out.title.trim().slice(0, TITLE_MAX);
    if (out.done !== undefined) out.done = toBool(out.done);
    if (out.starred !== undefined) out.starred = toBool(out.starred); // 缺省 = 继承序列值，不写入
    return out;
  }

  function sanitizeTime(time) {
    if (time === null) return null;
    if (!isPlainObject(time)) return null;
    if (!dt.isValidTime(time.start) || !dt.isValidTime(time.end)) return null;
    if (dt.minutesOf(time.end) <= dt.minutesOf(time.start)) return null;
    return { start: time.start, end: time.end };
  }

  /**
   * 归一单个事项。
   * @param {object} item
   * @param {{categoryIds: Object, fallbackCategoryId: string}} ctx
   * @returns {object|null} null 表示不可修复，应丢弃
   */
  function sanitizeItem(item, ctx) {
    ctx = ctx || {};
    if (!isPlainObject(item)) return null;
    if (!isNonEmptyString(item.id)) return null;
    var out = {};
    Object.keys(item).forEach(function (k) { out[k] = item[k]; });
    out.title = isNonEmptyString(out.title) ? out.title.trim().slice(0, TITLE_MAX) : null;
    if (out.title === null) return null; // 无标题不可修复
    var known = ctx.categoryIds || {};
    if (!isNonEmptyString(out.categoryId) || !known[out.categoryId]) {
      out.categoryId = ctx.fallbackCategoryId || URGENT_CATEGORY_ID;
    }
    out.time = sanitizeTime(out.time);
    if (typeof out.note !== 'string') out.note = out.note === undefined || out.note === null ? '' : String(out.note);
    out.note = out.note.slice(0, NOTE_MAX);
    out.done = toBool(out.done);
    out.starred = toBool(out.starred); // DM-4.5：缺省 false，非布尔归一到显式真值
    // DM-13：数字字段 Number() 归一；DM-4.3：order ≥ 0
    var itemOrder = Number(out.order);
    out.order = (out.order === undefined || out.order === null || out.order === '' || !isFinite(itemOrder))
      ? 0
      : Math.max(0, Math.floor(itemOrder));

    if (out.kind === 'single') {
      if (!dt.isValidDate(out.date)) return null;
    } else if (out.kind === 'series') {
      if (validateRepeat(out.repeat).length > 0) return null;
      var ex = {};
      if (isPlainObject(out.exceptions)) {
        Object.keys(out.exceptions).forEach(function (k) {
          if (!dt.isValidDate(k)) return;
          var s = sanitizeException(out.exceptions[k]);
          if (s) ex[k] = s;
        });
      }
      out.exceptions = ex;
    } else {
      return null;
    }
    return out;
  }

  /** 归一整个文档；返回 {doc, warnings} */
  function sanitizeDocument(doc, opts) {
    opts = opts || {};
    var warnings = [];
    if (!isPlainObject(doc)) {
      return { doc: createEmptyDocument(), warnings: [err('$', '文档不是对象，已重置为空文档')] };
    }
    var out = {};
    Object.keys(doc).forEach(function (k) { out[k] = doc[k]; });

    // 类别：只保证紧急类别存在（四十八轮起其余内置类别允许被用户删除，不再自动补回）；
    // 内置的 name / color 以文档为准（可自定义），只有紧急的 special / order / color 由契约固定。
    // 次序按 DM-3（紧急恒首位，其余 order 升序）
    var rawCats = Array.isArray(doc.categories) ? doc.categories : [];
    var catMap = {};
    rawCats.forEach(function (c, i) {
      var s = sanitizeCategory(c, i);
      if (s && !catMap[s.id]) catMap[s.id] = s;
      else if (s) warnings.push(err('$.categories[' + i + ']', '类别 id 重复，已丢弃：' + s.id));
    });
    BUILTIN_CATEGORIES.forEach(function (b) {
      if (!catMap[b.id]) {
        if (b.special !== 'urgent') return;
        var fresh = { id: b.id, name: b.name, color: b.color, builtin: true, order: b.order };
        fresh.special = b.special;
        if (b.createdAt) fresh.createdAt = b.createdAt;
        catMap[b.id] = fresh;
        warnings.push(err('$.categories', '补充缺失的内置类别：' + b.name));
      } else {
        catMap[b.id].builtin = true; // 内置标记不可被外部数据取消
        if (isUrgentCategory(catMap[b.id])) {
          catMap[b.id].special = 'urgent';
          catMap[b.id].order = URGENT_ORDER;
        }
      }
    });
    var categories = compactCategories(Object.keys(catMap).map(function (k) { return catMap[k]; }));

    var categoryIds = {};
    categories.forEach(function (c) { categoryIds[c.id] = true; });

    /* 事项类别兜底：优先文档设置的默认类别，其次紧急，最后第一个类别。
       旧实现固定回退 cat_short_task —— 该类别四十八轮起可能已被删除。 */
    var fallbackCategoryId = (isNonEmptyString(doc.settings && doc.settings.defaultCategoryId)
      && categoryIds[doc.settings.defaultCategoryId])
      ? doc.settings.defaultCategoryId
      : (categoryIds[URGENT_CATEGORY_ID] ? URGENT_CATEGORY_ID : (categories[0] && categories[0].id));

    // 事项
    var items = [];
    var itemIds = {};
    var rawItems = Array.isArray(doc.items) ? doc.items : [];
    rawItems.forEach(function (it, i) {
      var originalCategoryId = isPlainObject(it) ? it.categoryId : undefined;
      var s = sanitizeItem(it, { categoryIds: categoryIds, fallbackCategoryId: fallbackCategoryId });
      if (!s) {
        warnings.push(err('$.items[' + i + ']', '无法修复，已丢弃'));
        return;
      }
      if (originalCategoryId !== s.categoryId) {
        warnings.push(err('$.items[' + i + '].categoryId',
          '类别 ' + originalCategoryId + ' 不存在，已回退到 ' + s.categoryId));
      }
      if (itemIds[s.id]) {
        warnings.push(err('$.items[' + i + '].id', 'id 重复，已丢弃：' + s.id));
        return;
      }
      itemIds[s.id] = true;
      items.push(s);
    });

    // 记录
    var notes = {};
    if (isPlainObject(doc.notes)) {
      Object.keys(doc.notes).forEach(function (k) {
        var n = doc.notes[k];
        if (!dt.isValidDate(k) || !isPlainObject(n) || !isNonEmptyString(n.text)) {
          warnings.push(err('$.notes["' + k + '"]', '无效记录，已丢弃'));
          return;
        }
        notes[k] = {
          text: String(n.text),
          updatedAt: isNonEmptyString(n.updatedAt) ? n.updatedAt : new Date().toISOString()
        };
      });
    }

    // 当周记录（DM-8.1）：键必须是周一；与 notes 完全并列、互不覆盖（INV-10）
    var weekNotes = {};
    if (isPlainObject(doc.weekNotes)) {
      Object.keys(doc.weekNotes).forEach(function (k) {
        var w = doc.weekNotes[k];
        if (!dt.isValidDate(k)) {
          warnings.push(err('$.weekNotes["' + k + '"]', '键必须是合法日期，已丢弃'));
          return;
        }
        if (!isMondayISO(k)) {
          warnings.push(err('$.weekNotes["' + k + '"]', '当周记录的键必须是周一，已丢弃：' + k));
          return;
        }
        if (!isPlainObject(w) || !isNonEmptyString(w.text)) {
          warnings.push(err('$.weekNotes["' + k + '"]', '无效记录，已丢弃'));
          return;
        }
        weekNotes[k] = {
          text: String(w.text),
          updatedAt: isNonEmptyString(w.updatedAt) ? w.updatedAt : new Date().toISOString()
        };
      });
    } else if (doc.weekNotes !== undefined && doc.weekNotes !== null) {
      warnings.push(err('$.weekNotes', '必须是对象，已重置为空'));
    }

    out.schemaVersion = SCHEMA_VERSION;
    out.app = APP_NAME;
    out.meta = isPlainObject(doc.meta) ? doc.meta : {};
    if (!isNonEmptyString(out.meta.createdAt)) out.meta.createdAt = new Date().toISOString();
    if (!isNonEmptyString(out.meta.updatedAt)) out.meta.updatedAt = out.meta.createdAt;
    out.meta.app = APP_NAME;
    out.categories = categories;
    out.items = items;
    out.notes = notes;
    out.weekNotes = weekNotes;
    out.monthPlans = sanitizeMonthPlans(doc.monthPlans, warnings);
    out.countdowns = sanitizeCountdowns(doc.countdowns, {
      categoryIds: categoryIds,
      fallbackCategoryId: fallbackCategoryId
    }, warnings);
    out.finishDock = sanitizeFinishDock(doc.finishDock, warnings);
    out.settings = sanitizeSettings(doc.settings);
    /* 四十八轮：默认类别可能已被用户删除 —— 归一到一个仍然存在的类别（优先紧急）。 */
    if (!categoryIds[out.settings.defaultCategoryId]) {
      out.settings.defaultCategoryId = fallbackCategoryId;
      warnings.push(err('$.settings.defaultCategoryId', '默认类别不存在，已回退到 ' + fallbackCategoryId));
    }
    return { doc: out, warnings: warnings };
  }

  /**
   * DM-10：设置归一 —— 补齐默认键、夹取数值范围、布尔归一；未知键保留。
   * dayPxPerHour 为权威字段，兼容字段 pxPerHour 与其保持同步。
   */
  function sanitizeSettings(settings) {
    var src = isPlainObject(settings) ? settings : {};
    var out = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = DEFAULT_SETTINGS[k]; });
    Object.keys(src).forEach(function (k) { out[k] = src[k]; });

    var zoomSrc;
    if (src.dayPxPerHour !== undefined && src.dayPxPerHour !== null) zoomSrc = src.dayPxPerHour;
    else if (src.pxPerHour !== undefined && src.pxPerHour !== null) zoomSrc = src.pxPerHour;
    else zoomSrc = DEFAULT_SETTINGS.dayPxPerHour;
    out.dayPxPerHour = clampInt(zoomSrc, 60, 160, DEFAULT_SETTINGS.dayPxPerHour);
    out.pxPerHour = out.dayPxPerHour; // 兼容字段（DM-10：与 dayPxPerHour 保持一致）
    out.weekPxPerHour = clampInt(out.weekPxPerHour, 40, 96, DEFAULT_SETTINGS.weekPxPerHour);
    out.idleCompressHeight = clampInt(out.idleCompressHeight, 16, 48, DEFAULT_SETTINGS.idleCompressHeight);
    out.maxLanes = clampInt(out.maxLanes, 1, 6, DEFAULT_SETTINGS.maxLanes);
    out.timelineStartHour = clampInt(out.timelineStartHour, 0, 24, DEFAULT_SETTINGS.timelineStartHour);
    out.timelineEndHour = clampInt(out.timelineEndHour, 0, 24, DEFAULT_SETTINGS.timelineEndHour);
    if (out.timelineEndHour <= out.timelineStartHour) {
      out.timelineStartHour = DEFAULT_SETTINGS.timelineStartHour;
      out.timelineEndHour = DEFAULT_SETTINGS.timelineEndHour;
    }
    BOOLEAN_SETTINGS.forEach(function (k) { out[k] = out[k] !== false; });
    if (!isNonEmptyString(out.defaultCategoryId)) out.defaultCategoryId = DEFAULT_SETTINGS.defaultCategoryId;
    out.weekStartsOn = clampInt(out.weekStartsOn, 1, 7, DEFAULT_SETTINGS.weekStartsOn);
    if (['auto', 'light', 'dark'].indexOf(out.theme) < 0) out.theme = DEFAULT_SETTINGS.theme;
    return out;
  }

  /** 兼容旧名：store.updateSettings 与既有用例使用（等价于 sanitizeSettings） */
  function mergeSettings(settings) {
    return sanitizeSettings(settings);
  }

  /* ------------------------------------------------------------------ *
   * 本月计划（2026-10-20 六轮）
   * ------------------------------------------------------------------ */

  /** "YYYY-MM" 且年份在可显示范围内 */
  function isMonthKey(key) {
    if (typeof key !== 'string') return false;
    var m = MONTH_KEY_RE.exec(key);
    if (!m) return false;
    var y = Number(m[1]);
    return y >= 1900 && y <= 2100;
  }

  /**
   * 月计划归一：非法键 / 非数组 / 空白条目 / 重复 id 一律丢弃并告警。
   * 只保留 {id, text, done, createdAt, updatedAt}，其余字段不落盘。
   */
  function sanitizeMonthPlans(src, warnings) {
    var out = {};
    if (src === undefined || src === null) return out;
    if (!isPlainObject(src)) {
      if (warnings) warnings.push(err('$.monthPlans', '必须是对象，已重置为空'));
      return out;
    }
    Object.keys(src).forEach(function (key) {
      var list = src[key];
      var path = '$.monthPlans["' + key + '"]';
      if (!isMonthKey(key)) {
        if (warnings) warnings.push(err(path, '键必须是合法年月（YYYY-MM，1900–2100），已丢弃'));
        return;
      }
      if (!Array.isArray(list)) {
        if (warnings) warnings.push(err(path, '必须是数组，已丢弃'));
        return;
      }
      var seen = {};
      var items = [];
      var stamp = new Date().toISOString();
      for (var i = 0; i < list.length; i += 1) {
        if (items.length >= MONTH_PLAN_MAX) {
          if (warnings) warnings.push(err(path, '超过单月上限 ' + MONTH_PLAN_MAX + ' 条，其余已丢弃'));
          break;
        }
        var entry = list[i];
        if (!isPlainObject(entry)) {
          if (warnings) warnings.push(err(path + '[' + i + ']', '必须是对象，已丢弃'));
          continue;
        }
        var text = isNonEmptyString(entry.text) ? String(entry.text).trim() : '';
        if (!text) {
          if (warnings) warnings.push(err(path + '[' + i + '].text', '文本为空，已丢弃'));
          continue;
        }
        if (text.length > MONTH_PLAN_TEXT_MAX) text = text.slice(0, MONTH_PLAN_TEXT_MAX);
        /* 缺 id 时按位置补一个确定性 id：同一份数据多次归一结果一致，不会反复改写 */
        var id = isNonEmptyString(entry.id) ? entry.id : ('mp_' + key.replace('-', '') + '_' + i);
        if (seen[id]) {
          if (warnings) warnings.push(err(path + '[' + i + '].id', 'id 重复，已丢弃：' + id));
          continue;
        }
        seen[id] = true;
        items.push({
          id: id,
          text: text,
          done: entry.done === true,
          createdAt: isNonEmptyString(entry.createdAt) ? entry.createdAt : stamp,
          updatedAt: isNonEmptyString(entry.updatedAt) ? entry.updatedAt : stamp
        });
      }
      if (items.length) out[key] = items;
    });
    return out;
  }

  /** 月计划校验（缺失合法 —— 旧数据没有这个字段） */
  function validateMonthPlans(src, path) {
    var errors = [];
    if (src === undefined || src === null) return errors;
    if (!isPlainObject(src)) return [err(path, '必须是对象')];
    Object.keys(src).forEach(function (key) {
      var p = path + '["' + key + '"]';
      if (!isMonthKey(key)) {
        errors.push(err(p, '键必须是合法年月（YYYY-MM，1900–2100）'));
        return;
      }
      if (!Array.isArray(src[key])) {
        errors.push(err(p, '必须是数组'));
        return;
      }
      src[key].forEach(function (entry, i) {
        var ep = p + '[' + i + ']';
        if (!isPlainObject(entry)) { errors.push(err(ep, '必须是对象')); return; }
        if (!isNonEmptyString(entry.id)) errors.push(err(ep + '.id', 'id 不能为空'));
        if (!isNonEmptyString(entry.text)) {
          errors.push(err(ep + '.text', '文本不能为空'));
        } else if (String(entry.text).length > MONTH_PLAN_TEXT_MAX) {
          errors.push(err(ep + '.text', '文本不能超过 ' + MONTH_PLAN_TEXT_MAX + ' 字'));
        }
        if (entry.done !== undefined && typeof entry.done !== 'boolean') {
          errors.push(err(ep + '.done', 'done 必须是布尔值'));
        }
      });
    });
    return errors;
  }

  /** 五十一轮：单条倒计时校验 */
  function validateCountdown(cd, path) {
    var errors = [];
    if (!isPlainObject(cd)) return [err(path, '必须是对象')];
    if (!isNonEmptyString(cd.id)) errors.push(err(path + '.id', 'id 不能为空'));
    if (!isNonEmptyString(cd.title)) {
      errors.push(err(path + '.title', '标题不能为空'));
    } else if (String(cd.title).trim().length > TITLE_MAX) {
      errors.push(err(path + '.title', '标题不能超过 ' + TITLE_MAX + ' 字'));
    }
    if (!isNonEmptyString(cd.categoryId)) errors.push(err(path + '.categoryId', 'categoryId 不能为空'));
    if (!isCountdownTargetAt(cd.targetAt)) {
      errors.push(err(path + '.targetAt', '目标时刻必须是 YYYY-MM-DDTHH:mm'));
    }
    if (cd.note !== undefined && cd.note !== null) {
      if (typeof cd.note !== 'string') errors.push(err(path + '.note', '备注必须是字符串'));
      else if (cd.note.length > NOTE_MAX) errors.push(err(path + '.note', '备注不能超过 ' + NOTE_MAX + ' 字'));
    }
    ['createdAt', 'updatedAt'].forEach(function (k) {
      if (cd[k] !== undefined && cd[k] !== null && typeof cd[k] !== 'string') {
        errors.push(err(path + '.' + k, k + ' 必须是字符串'));
      }
    });
    return errors;
  }

  /**
   * 五十一轮：倒计时数组校验（缺失合法 —— 旧数据没有该字段）。
   * 类别引用在这里交叉校验（与 items 同口径）。
   */
  function validateCountdowns(src, path, categoryIds) {
    var errors = [];
    if (src === undefined || src === null) return errors;
    if (!Array.isArray(src)) return [err(path, '必须是数组')];
    if (src.length > COUNTDOWN_MAX) errors.push(err(path, '最多 ' + COUNTDOWN_MAX + ' 条'));
    var seen = {};
    src.forEach(function (cd, i) {
      var p = path + '[' + i + ']';
      validateCountdown(cd, p).forEach(function (e) { errors.push(e); });
      if (!isPlainObject(cd)) return;
      if (isNonEmptyString(cd.id)) {
        if (seen[cd.id]) errors.push(err(p + '.id', 'id 重复：' + cd.id));
        seen[cd.id] = true;
      }
      if (isNonEmptyString(cd.categoryId) && categoryIds && !categoryIds[cd.categoryId]) {
        errors.push(err(p + '.categoryId', '引用了不存在的类别 ' + cd.categoryId));
      }
    });
    return errors;
  }

  /**
   * 五十一轮：倒计时归一。
   * 丢弃：非对象 / 缺 id / 缺标题 / 目标时刻非法 / id 重复 / 超过上限（均告警）。
   * 类别不存在时回退到文档默认类别；数组顺序保持原样（= 显示顺序）。
   */
  function sanitizeCountdowns(src, ctx, warnings) {
    var out = [];
    if (src === undefined || src === null) return out;
    if (!Array.isArray(src)) {
      if (warnings) warnings.push(err('$.countdowns', '必须是数组，已重置为空'));
      return out;
    }
    var known = (ctx && ctx.categoryIds) || {};
    var fallback = (ctx && ctx.fallbackCategoryId) || URGENT_CATEGORY_ID;
    var seen = {};
    var stamp = new Date().toISOString();
    for (var i = 0; i < src.length; i += 1) {
      var path = '$.countdowns[' + i + ']';
      if (out.length >= COUNTDOWN_MAX) {
        if (warnings) warnings.push(err('$.countdowns', '超过上限 ' + COUNTDOWN_MAX + ' 条，其余已丢弃'));
        break;
      }
      var cd = src[i];
      if (!isPlainObject(cd)) {
        if (warnings) warnings.push(err(path, '必须是对象，已丢弃'));
        continue;
      }
      if (!isNonEmptyString(cd.id)) {
        if (warnings) warnings.push(err(path + '.id', 'id 为空，已丢弃'));
        continue;
      }
      if (seen[cd.id]) {
        if (warnings) warnings.push(err(path + '.id', 'id 重复，已丢弃：' + cd.id));
        continue;
      }
      if (!isCountdownTargetAt(cd.targetAt)) {
        if (warnings) warnings.push(err(path + '.targetAt', '目标时刻不合法，已丢弃'));
        continue;
      }
      var title = isNonEmptyString(cd.title) ? String(cd.title).trim().slice(0, TITLE_MAX) : '';
      if (!title) {
        if (warnings) warnings.push(err(path + '.title', '标题为空，已丢弃'));
        continue;
      }
      var entry = {};
      Object.keys(cd).forEach(function (k) { entry[k] = cd[k]; }); // 未知字段保留
      entry.id = cd.id;
      entry.title = title;
      if (!isNonEmptyString(cd.categoryId) || !known[cd.categoryId]) {
        entry.categoryId = fallback;
      }
      entry.targetAt = cd.targetAt;
      entry.note = typeof cd.note === 'string' ? cd.note.slice(0, NOTE_MAX) : '';
      if (!isNonEmptyString(entry.createdAt)) entry.createdAt = stamp;
      if (!isNonEmptyString(entry.updatedAt)) entry.updatedAt = entry.createdAt;
      seen[entry.id] = true;
      out.push(entry);
    }
    return out;
  }

  /**
   * D9（2026-10-27）：完成台条目校验。远端严格口径（数组不可缺失）+ 条目级形状检查。
   * occ 只验「回查所需的最小集」（key/seriesId/date/kind/categoryId），
   * 显示字段（title/time/note…）不做严格校验 —— 嵌入副本允许随版本演化。
   * 计时读数必须是有限非负数；mode/phase 必须在枚举内。
   */
  function validateFinishDock(list, path) {
    var errors = [];
    if (!Array.isArray(list)) {
      errors.push(err(path || '$.finishDock', '必须是数组'));
      return errors;
    }
    if (list.length > FINISH_DOCK_MAX) {
      errors.push(err(path || '$.finishDock', '超过上限 ' + FINISH_DOCK_MAX + ' 条'));
    }
    var seen = {};
    list.forEach(function (it, i) {
      var p = (path || '$.finishDock') + '[' + i + ']';
      if (!isPlainObject(it)) {
        errors.push(err(p, '必须是对象'));
        return;
      }
      var occ = it.occ;
      if (!isPlainObject(occ)) {
        errors.push(err(p + '.occ', '必须是对象'));
      } else {
        if (!isNonEmptyString(occ.key)) errors.push(err(p + '.occ.key', '必须是非空字符串'));
        else if (seen[occ.key]) errors.push(err(p + '.occ.key', 'key 重复：' + occ.key));
        if (!isNonEmptyString(occ.seriesId)) errors.push(err(p + '.occ.seriesId', '必须是非空字符串'));
        if (occ.date !== undefined && !dt.isValidDate(occ.date)) {
          errors.push(err(p + '.occ.date', '必须是合法日期'));
        }
        if (occ.kind !== undefined && occ.kind !== 'single' && occ.kind !== 'series') {
          errors.push(err(p + '.occ.kind', '必须是 single 或 series'));
        }
      }
      if (it.mode !== undefined && it.mode !== null && DOCK_MODES.indexOf(it.mode) < 0) {
        errors.push(err(p + '.mode', '非法计时方式：' + String(it.mode)));
      }
      if (it.phase !== undefined && it.phase !== 'focus' && it.phase !== 'break') {
        errors.push(err(p + '.phase', '必须是 focus 或 break'));
      }
      ['elapsedMs', 'remainingMs', 'countdownSec', 'cdH', 'cdM', 'cdS', 'focusMin', 'breakMin', 'lastTs']
        .forEach(function (k) {
          if (it[k] !== undefined && (!isFiniteNumber(it[k]) || it[k] < 0)) {
            errors.push(err(p + '.' + k, '必须是有限非负数'));
          }
        });
      if (seen[occ && occ.key]) return; // 重复 key 已报，不重复报
      if (isPlainObject(occ) && isNonEmptyString(occ.key)) seen[occ.key] = true;
    });
    return errors;
  }

  /**
   * D9：完成台条目归一。丢弃：非对象 / occ 无效 / key 为空或重复 / 超上限（均告警）。
   * 数值夹取为有限非负数；布尔归一；数组顺序保持原样（= 台内显示顺序）。
   * 与 sanitizeCountdowns 的差异：不查类别表（occ.categoryId 是嵌入副本，
   * 悬空引用在界面上只是不显示类别胶囊，不值得为它改写用户数据）。
   */
  function sanitizeFinishDock(src, warnings) {
    var out = [];
    if (src === undefined || src === null) return out;
    if (!Array.isArray(src)) {
      if (warnings) warnings.push(err('$.finishDock', '必须是数组，已重置为空'));
      return out;
    }
    var seen = {};
    for (var i = 0; i < src.length; i += 1) {
      var path = '$.finishDock[' + i + ']';
      if (out.length >= FINISH_DOCK_MAX) {
        if (warnings) warnings.push(err('$.finishDock', '超过上限 ' + FINISH_DOCK_MAX + ' 条，其余已丢弃'));
        break;
      }
      var it = src[i];
      if (!isPlainObject(it)) {
        if (warnings) warnings.push(err(path, '必须是对象，已丢弃'));
        continue;
      }
      var occ = isPlainObject(it.occ) ? it.occ : null;
      if (!occ || !isNonEmptyString(occ.key)) {
        if (warnings) warnings.push(err(path + '.occ.key', '发生键缺失，已丢弃'));
        continue;
      }
      if (seen[occ.key]) {
        if (warnings) warnings.push(err(path + '.occ.key', 'key 重复，已丢弃：' + occ.key));
        continue;
      }
      var entry = {};
      Object.keys(it).forEach(function (k) { entry[k] = it[k]; }); // 未知字段保留
      entry.occ = {};
      Object.keys(occ).forEach(function (k) { entry.occ[k] = occ[k]; });
      entry.occ.key = occ.key;
      if (!isNonEmptyString(entry.occ.seriesId)) entry.occ.seriesId = String(occ.key).split('@')[0] || occ.key;
      if (entry.occ.title !== undefined && entry.occ.title !== null) {
        entry.occ.title = String(entry.occ.title);
      }
      if (entry.mode !== undefined && entry.mode !== null && DOCK_MODES.indexOf(entry.mode) < 0) entry.mode = null;
      if (entry.phase !== 'break') entry.phase = 'focus';
      ['running', 'setting', 'finished'].forEach(function (k) { entry[k] = toBool(entry[k]); });
      ['elapsedMs', 'remainingMs', 'countdownSec', 'cdH', 'cdM', 'cdS', 'focusMin', 'breakMin', 'lastTs']
        .forEach(function (k) {
          var n = Number(entry[k]);
          entry[k] = (isFiniteNumber(n) && n >= 0) ? n : 0;
        });
      seen[occ.key] = true;
      out.push(entry);
    }
    return out;
  }

  /** DM-10：设置校验；缺失键合法（由 sanitizeSettings 补默认），存在则必须合法 */
  function validateSettings(settings, path) {
    path = path || 'settings';
    var errors = [];
    if (settings === undefined || settings === null) return errors;
    if (!isPlainObject(settings)) return [err(path, '必须是对象')];
    Object.keys(SETTINGS_RANGES).forEach(function (k) {
      if (settings[k] === undefined || settings[k] === null) return;
      var r = SETTINGS_RANGES[k];
      if (!isFiniteNumber(settings[k]) || settings[k] < r[0] || settings[k] > r[1]) {
        errors.push(err(path + '.' + k, k + ' 需为 ' + r[0] + '–' + r[1] + ' 的数值'));
      }
    });
    if (settings.pxPerHour !== undefined && settings.pxPerHour !== null && !isFiniteNumber(settings.pxPerHour)) {
      errors.push(err(path + '.pxPerHour', 'pxPerHour 必须是数字'));
    }
    BOOLEAN_SETTINGS.forEach(function (k) {
      if (settings[k] !== undefined && typeof settings[k] !== 'boolean') {
        errors.push(err(path + '.' + k, k + ' 必须是布尔值'));
      }
    });
    if (settings.defaultCategoryId !== undefined && !isNonEmptyString(settings.defaultCategoryId)) {
      errors.push(err(path + '.defaultCategoryId', 'defaultCategoryId 不能为空'));
    }
    if (settings.weekStartsOn !== undefined && settings.weekStartsOn !== null &&
        (!isFiniteNumber(settings.weekStartsOn) || settings.weekStartsOn < 1 || settings.weekStartsOn > 7)) {
      errors.push(err(path + '.weekStartsOn', 'weekStartsOn 需为 1–7'));
    }
    return errors;
  }

  function createEmptyDocument() {
    var now = new Date().toISOString();
    return {
      schemaVersion: SCHEMA_VERSION,
      app: APP_NAME,
      meta: { createdAt: now, updatedAt: now, app: APP_NAME },
      categories: compactCategories(BUILTIN_CATEGORIES.map(function (c) { return cloneJSON(c); })),
      items: [],
      notes: {},
      weekNotes: {},
      monthPlans: {},
      countdowns: [],
      finishDock: [],
      settings: sanitizeSettings(null)
    };
  }

  /* ------------------------------------------------------------------ *
   * 迁移（DM-12 / DM-20）
   * ------------------------------------------------------------------ */

  /** 补齐紧急类别（DM-18.1 / DM-20.2c）：缺失时补入并置首 */
  function ensureUrgentCategory(categories) {
    var list = Array.isArray(categories) ? categories : [];
    if (!list.some(function (c) { return isUrgentCategory(c); })) {
      list = [cloneJSON(URGENT_CATEGORY)].concat(list);
    }
    return compactCategories(list);
  }

  /** 收集迁移告警（warningsOut 非数组时静默丢弃） */
  function pushWarning(warningsOut, path, code, message) {
    if (Array.isArray(warningsOut)) {
      warningsOut.push({ path: path, code: code, message: message });
    }
  }

  /** v1 → v2（DM-12）。在深拷贝上操作，保证不修改入参；仅处理 v1 缺失项。 */
  function migrateV1toV2(doc) {
    var out = cloneJSON(doc);

    // 1. 类别：无 order → 数组下标；随后压实为 0..n-1
    if (Array.isArray(out.categories)) {
      out.categories.forEach(function (c, i) {
        if (!isPlainObject(c)) return;
        if (c.order === undefined || c.order === null || c.order === '') {
          c.order = i; // 保证与 v1 的显示顺序完全一致
        } else {
          var n = Number(c.order);
          c.order = isFinite(n) ? Math.max(0, Math.floor(n)) : i;
        }
      });
      out.categories = compactCategories(out.categories);
    }

    // 2. 事项：缺 starred → false；meta 原样保留
    if (Array.isArray(out.items)) {
      out.items.forEach(function (it) {
        if (isPlainObject(it) && it.starred === undefined) it.starred = false;
      });
    }

    // 3. weekNotes
    if (!isPlainObject(out.weekNotes)) out.weekNotes = {};

    // 4. settings：dayPxPerHour = clamp(pxPerHour ?? 60, 60, 160)，并补齐迭代 3 新键
    if (!isPlainObject(out.settings)) out.settings = {};
    var st = out.settings;
    var derived = false;
    if (st.dayPxPerHour === undefined || st.dayPxPerHour === null) {
      var legacy = (st.pxPerHour === undefined || st.pxPerHour === null) ? 60 : st.pxPerHour;
      st.dayPxPerHour = clampInt(legacy, 60, 160, 60);
      derived = true;
    }
    if (st.pxPerHour === undefined || st.pxPerHour === null || derived) {
      st.pxPerHour = st.dayPxPerHour; // DM-10：迁移后与 dayPxPerHour 保持一致
    }
    ['weekPxPerHour', 'idleCompressHeight', 'idleCompressEnabled', 'showHolidayMarker'].forEach(function (k) {
      if (st[k] === undefined) st[k] = DEFAULT_SETTINGS[k];
    });

    // 5. schemaVersion
    out.schemaVersion = 2;
    return out;
  }

  /**
   * v2 → v3（DM-20.2）：星标条目归入紧急（BR-40），补齐紧急类别。
   * 幂等：已转紧急的条目（categoryId === "urgent"）不再处理、不覆盖 previousCategoryId。
   */
  function migrateV2toV3(doc, warningsOut) {
    var out = cloneJSON(doc);

    // a/b) starred === true 且类别非紧急 → categoryId = "urgent"，记录原类别
    if (Array.isArray(out.items)) {
      out.items.forEach(function (it, i) {
        if (!isPlainObject(it)) return;
        var path = '$.items[' + i + ']';
        if (it.categoryId !== URGENT_CATEGORY_ID && toBool(it.starred) === true) {
          if (!isPlainObject(it.meta)) it.meta = {};
          it.meta.previousCategoryId = it.categoryId; // BR-38：覆盖旧值
          it.categoryId = URGENT_CATEGORY_ID;
          pushWarning(warningsOut, path, E_MIGRATE_URGENT,
            '原「重要（星标）」条目已归入紧急：' + it.id);
        }

        // 例外：自带 categoryId 或继承序列类别；starred === true 时同样归入紧急
        if (isPlainObject(it.exceptions)) {
          Object.keys(it.exceptions).forEach(function (dateISO) {
            var ex = it.exceptions[dateISO];
            if (!isPlainObject(ex) || ex.deleted === true) return;
            var cur = ex.categoryId !== undefined ? ex.categoryId : it.categoryId;
            if (cur === URGENT_CATEGORY_ID) return;
            if (!toBool(ex.starred)) return;
            if (!isPlainObject(ex.meta)) ex.meta = {};
            ex.meta.previousCategoryId = cur;
            ex.categoryId = URGENT_CATEGORY_ID;
            pushWarning(warningsOut, path + '.exceptions["' + dateISO + '"]', E_MIGRATE_URGENT,
              '原「重要（星标）」的该次发生已归入紧急');
          });
        }
      });
    }

    // c) 补齐紧急类别（置首，order = -1）
    out.categories = ensureUrgentCategory(out.categories);

    // d) schemaVersion
    out.schemaVersion = 3;
    return out;
  }

  /**
   * v3 → v4（D8，2026-10-26）：**只补形状，不做条目级清洗**。
   *
   * 五十一轮把 `countdowns` 加进了 v3 却没升版本号，于是「v3」同时指「没有倒计时的旧文档」
   * 和「有的新文档」。本步把「countdowns 是必备顶层字段（可空数组）」写进数据：
   *
   *   · 缺失 / null → `[]`（旧 v3 文档，静默补齐，不告警——这是预期内的常态）
   *   · 非数组      → `[]` + 一条 `E_MIGRATE_COUNTDOWNS`（Q-18：只告警，不拒绝整份文档）
   *   · 数组        → **原样保留**（条目级清洗留给随后的 sanitizeDocument，迁移不得丢条目）
   *
   * 幂等：已是 v4 时 `migrateDocument` 直接返回深拷贝，不会进入本步。
   */
  function migrateV3toV4(doc, warningsOut) {
    var out = cloneJSON(doc);
    var raw = out.countdowns;

    if (raw === undefined || raw === null) {
      out.countdowns = [];
    } else if (!Array.isArray(raw)) {
      out.countdowns = [];
      pushWarning(warningsOut, '$.countdowns', E_MIGRATE_COUNTDOWNS,
        '倒计时字段形状非法，已重置为空数组');
    } else {
      out.countdowns = raw;
    }

    out.schemaVersion = 4;
    return out;
  }

  /**
   * v4 → v5（D9，2026-10-27）：**只补形状，不做条目级清洗**。
   *
   * 完成台快照（finishDock）此前只存 UI 状态、不参与同步；升 v5 后成为必备顶层字段。
   *
   *   · 缺失 / null → `[]`（v4 文档的常态：完成台要么没开过、要么条目还在 UI 状态里
   *     由完成台初始化时一次性搬进 doc，静默补齐不告警）
   *   · 非数组      → `[]` + 一条 `E_MIGRATE_FINISHDOCK`（只告警，不拒绝整份文档）
   *   · 数组        → **原样保留**（条目级清洗留给随后的 sanitizeDocument，迁移不得丢条目）
   *
   * 幂等：已是 v5 时 `migrateDocument` 直接返回深拷贝，不会进入本步。
   */
  function migrateV4toV5(doc, warningsOut) {
    var out = cloneJSON(doc);
    var raw = out.finishDock;

    if (raw === undefined || raw === null) {
      out.finishDock = [];
    } else if (!Array.isArray(raw)) {
      out.finishDock = [];
      pushWarning(warningsOut, '$.finishDock', E_MIGRATE_FINISHDOCK,
        '完成台快照形状非法，已重置为空数组');
    } else {
      out.finishDock = raw;
    }

    out.schemaVersion = 5;
    return out;
  }

  /**
   * DM-12 / DM-20：按 schemaVersion 链式迁移。纯函数、幂等、不抛异常。
   * 已是当前版本的文档原样（深拷贝）返回，不产生任何变化。
   * @param {object} doc
   * @param {Array} [warningsOut] 可选：收集迁移告警（含 code: E_MIGRATE_URGENT）
   * @returns {object|null} null = 不可修复，由调用方走 F-09.1 损坏流程
   */
  function migrateDocument(doc, warningsOut) {
    try {
      if (!isPlainObject(doc)) return null;
      var v = doc.schemaVersion;
      if (v === undefined || v === null) v = 1;
      if (!isFiniteNumber(v) || Math.floor(v) !== v) return null;
      if (v > SCHEMA_VERSION) return null; // 高于当前版本：交给调用方的 E_VERSION 分支
      if (v < 1) v = 1;
      var current = cloneJSON(doc);
      if (v >= SCHEMA_VERSION) return current; // 已是当前版本：不产生变化（幂等）
      current.schemaVersion = v;
      var guard = 0;
      while (current.schemaVersion < SCHEMA_VERSION) {
        var step = MIGRATIONS[current.schemaVersion];
        if (typeof step !== 'function') return null;
        current = step(current, warningsOut);
        if (!isPlainObject(current)) return null;
        guard++;
        if (guard > 8) return null; // 防御：迁移链死循环
      }
      return current;
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 导入校验（DM-9）
   * ------------------------------------------------------------------ */

  var IMPORT_MODES = ['merge', 'replace'];

  /**
   * 校验导入载荷。
   * @returns {{ok:boolean, code?:string, errors:Array, doc?:object}}
   */
  function validateImportPayload(payload) {
    var errors = [];
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (e) {
        return { ok: false, code: 'E_PARSE', errors: [err('$', 'JSON 解析失败：' + e.message)] };
      }
    }
    if (!isPlainObject(payload)) {
      return { ok: false, code: 'E_SHAPE', errors: [err('$', '导入内容必须是 JSON 对象')] };
    }
    var doc = isPlainObject(payload.data) ? payload.data : payload;
    var looksLikeDoc = Array.isArray(doc.categories) && Array.isArray(doc.items);
    if (payload.app !== APP_NAME && !looksLikeDoc) {
      return { ok: false, code: 'E_SHAPE', errors: [err('$', '不是 DayPlan 数据文件（缺少 app 标记与 categories/items）')] };
    }
    if (!looksLikeDoc) {
      return { ok: false, code: 'E_SHAPE', errors: [err('$', '缺少 categories 或 items 数组')] };
    }
    if (doc.schemaVersion !== undefined && (!isFinite(doc.schemaVersion) || doc.schemaVersion > SCHEMA_VERSION)) {
      return { ok: false, code: 'E_VERSION', errors: [err('$.schemaVersion', '数据版本 ' + doc.schemaVersion + ' 高于当前应用支持的 ' + SCHEMA_VERSION)] };
    }
    // DM-9 步骤 3：≤当前版本可导入；v1/v2 先走 DM-12/DM-20 迁移，再按 INV-1…INV-10 校验
    var sv = doc.schemaVersion;
    var needsMigration = (sv === undefined || sv === null) || (typeof sv === 'number' && sv < SCHEMA_VERSION);
    var migrated = doc;
    var warnings = [];
    if (needsMigration) {
      migrated = migrateDocument(doc, warnings);
      if (!migrated) {
        return { ok: false, code: 'E_MIGRATE', errors: [err('$', '数据无法迁移到当前版本 v' + SCHEMA_VERSION)] };
      }
    }
    var result = validateDocument(migrated);
    if (!result.ok) {
      return { ok: false, code: 'E_INVALID', errors: result.errors };
    }
    return { ok: true, errors: [], doc: migrated, warnings: warnings };
  }

  /** 合并两份文档（DM-9：按 id 去重，冲突取 updatedAt 较新者；类别次序保留本机） */
  function mergeDocuments(base, incoming) {
    var out = sanitizeDocument(base).doc;
    var incomingClean = sanitizeDocument(incoming).doc;
    var warnings = [];

    // 类别：本机次序为权威（导入方的 order 不覆盖本机），导入方的新类别追加到末尾
    var catById = {};
    out.categories.forEach(function (c) { catById[c.id] = c; });
    var ordered = out.categories.slice();
    incomingClean.categories.forEach(function (c) {
      var cur = catById[c.id];
      if (!cur) {
        catById[c.id] = c;
        ordered.push(c);
        return;
      }
      if (cur.builtin) return; // 内置类别保留本地定义
      if (newer(c, cur)) {
        var idx = ordered.indexOf(cur);
        catById[c.id] = c;
        if (idx >= 0) ordered[idx] = c;
      }
    });
    var categories = compactCategories(ordered);

    var itemById = {};
    out.items.forEach(function (it) { itemById[it.id] = it; });
    incomingClean.items.forEach(function (it) {
      var cur = itemById[it.id];
      if (!cur) {
        itemById[it.id] = it;
        return;
      }
      if (newer(it, cur)) itemById[it.id] = it;
      else warnings.push(err('$.items', 'id 冲突，保留本地较新版本：' + it.id));
    });
    var items = Object.keys(itemById).map(function (k) { return itemById[k]; });

    var notes = {};
    Object.keys(out.notes).forEach(function (k) { notes[k] = out.notes[k]; });
    Object.keys(incomingClean.notes).forEach(function (k) {
      var cur = notes[k];
      if (!cur) {
        notes[k] = incomingClean.notes[k];
        return;
      }
      if (newer(incomingClean.notes[k], cur)) notes[k] = incomingClean.notes[k];
    });

    // DM-8.1：当周记录同样按日期键合并（与 notes 互不覆盖）
    var weekNotes = {};
    Object.keys(out.weekNotes || {}).forEach(function (k) { weekNotes[k] = out.weekNotes[k]; });
    Object.keys(incomingClean.weekNotes || {}).forEach(function (k) {
      var cur = weekNotes[k];
      if (!cur) {
        weekNotes[k] = incomingClean.weekNotes[k];
        return;
      }
      if (newer(incomingClean.weekNotes[k], cur)) weekNotes[k] = incomingClean.weekNotes[k];
    });

    /* 2026-10-20 六轮：本月计划按月合并 —— 同 id 取较新；本机次序为权威，导入方新条目追加到月末 */
    var monthPlans = {};
    Object.keys(out.monthPlans || {}).forEach(function (k) { monthPlans[k] = out.monthPlans[k].slice(); });
    Object.keys(incomingClean.monthPlans || {}).forEach(function (k) {
      var local = monthPlans[k];
      if (!local) { monthPlans[k] = incomingClean.monthPlans[k].slice(); return; }
      var byId = {};
      local.forEach(function (e, i) { byId[e.id] = i; });
      incomingClean.monthPlans[k].forEach(function (e) {
        var idx = byId[e.id];
        if (idx === undefined) {
          byId[e.id] = local.length;
          local.push(e);
          return;
        }
        if (newer(e, local[idx])) local[idx] = e;
      });
    });

    /* 五十一轮：倒计时按 id 合并 —— 同 id 取较新；本机次序为权威，导入方新条目追加到末尾 */
    var countdowns = (out.countdowns || []).slice();
    var cdIndex = {};
    countdowns.forEach(function (e, i) { cdIndex[e.id] = i; });
    (incomingClean.countdowns || []).forEach(function (e) {
      var idx = cdIndex[e.id];
      if (idx === undefined) {
        cdIndex[e.id] = countdowns.length;
        countdowns.push(e);
        return;
      }
      if (newer(e, countdowns[idx])) countdowns[idx] = e;
    });

    /* D9（2026-10-27）：完成台按 occ.key 合并 —— 同 key 取 lastTs 较新者（最近动过的
       快照赢）；导入方新条目追加到末尾。完成台条目没有 updatedAt（非关键状态），
       lastTs 是它唯一可信的「最近触碰」信号。 */
    var dock = (out.finishDock || []).slice();
    var dockIndex = {};
    dock.forEach(function (e, i) { if (e && e.occ) dockIndex[e.occ.key] = i; });
    (incomingClean.finishDock || []).forEach(function (e) {
      if (!e || !e.occ || !isNonEmptyString(e.occ.key)) return;
      var idx = dockIndex[e.occ.key];
      if (idx === undefined) {
        dockIndex[e.occ.key] = dock.length;
        dock.push(e);
        return;
      }
      var a = Number(e.lastTs) || 0;
      var b = Number(dock[idx].lastTs) || 0;
      if (a > b) dock[idx] = e;
    });

    out.categories = categories;
    out.items = items;
    out.notes = notes;
    out.weekNotes = weekNotes;
    out.monthPlans = monthPlans;
    out.countdowns = countdowns;
    out.finishDock = dock;
    out.meta.updatedAt = new Date().toISOString();
    var v = validateDocument(out);
    return { doc: out, ok: v.ok, errors: v.errors, warnings: warnings };
  }

  function newer(a, b) {
    var ta = a && a.updatedAt ? Date.parse(a.updatedAt) : 0;
    var tb = b && b.updatedAt ? Date.parse(b.updatedAt) : 0;
    if (isNaN(ta)) ta = 0;
    if (isNaN(tb)) tb = 0;
    return ta > tb;
  }

  /** 按模式导入，返回 {doc, ok, code, errors, warnings} */
  function importInto(base, payload, mode) {
    mode = IMPORT_MODES.indexOf(mode) === -1 ? 'merge' : mode;
    var check = validateImportPayload(payload);
    if (!check.ok) return check;
    var migWarnings = check.warnings || [];
    if (mode === 'replace') {
      var clean = sanitizeDocument(check.doc).doc;
      clean.meta.updatedAt = new Date().toISOString();
      var v = validateDocument(clean);
      return {
        doc: clean, ok: v.ok, errors: v.errors,
        warnings: migWarnings, code: v.ok ? undefined : 'E_INVALID'
      };
    }
    var merged = mergeDocuments(base, check.doc);
    merged.warnings = migWarnings.concat(merged.warnings || []);
    return merged;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    APP_NAME: APP_NAME,
    TITLE_MAX: TITLE_MAX,
    NOTE_MAX: NOTE_MAX,
    CATEGORY_NAME_MAX: CATEGORY_NAME_MAX,
    MONTH_PLAN_TEXT_MAX: MONTH_PLAN_TEXT_MAX,
    MONTH_PLAN_MAX: MONTH_PLAN_MAX,
    COUNTDOWN_MAX: COUNTDOWN_MAX,
    FINISH_DOCK_MAX: FINISH_DOCK_MAX,
    NAMED_MONTHS: NAMED_MONTHS,
    COLOR_RE: COLOR_RE,
    URGENT_CATEGORY_ID: URGENT_CATEGORY_ID,
    URGENT_CATEGORY: URGENT_CATEGORY,
    E_MIGRATE_URGENT: E_MIGRATE_URGENT,
    E_MIGRATE_COUNTDOWNS: E_MIGRATE_COUNTDOWNS,
    E_MIGRATE_FINISHDOCK: E_MIGRATE_FINISHDOCK,
    BUILTIN_CATEGORIES: BUILTIN_CATEGORIES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    SETTINGS_RANGES: SETTINGS_RANGES,
    REPEAT_TYPES: REPEAT_TYPES,
    IMPORT_MODES: IMPORT_MODES,
    MIGRATIONS: MIGRATIONS,
    isPlainObject: isPlainObject,
    isNonEmptyString: isNonEmptyString,
    isMondayISO: isMondayISO,
    isMonthKey: isMonthKey,
    isCountdownTargetAt: isCountdownTargetAt,
    isUrgentCategory: isUrgentCategory,
    compareCategoryOrder: compareCategoryOrder,
    compactCategories: compactCategories,
    validateTime: validateTime,
    validateCategory: validateCategory,
    validateRepeat: validateRepeat,
    validateException: validateException,
    validateItem: validateItem,
    validateDocument: validateDocument,
    validateSettings: validateSettings,
    sanitizeCategory: sanitizeCategory,
    sanitizeException: sanitizeException,
    sanitizeTime: sanitizeTime,
    sanitizeItem: sanitizeItem,
    sanitizeDocument: sanitizeDocument,
    sanitizeMonthPlans: sanitizeMonthPlans,
    validateMonthPlans: validateMonthPlans,
    validateCountdown: validateCountdown,
    validateCountdowns: validateCountdowns,
    sanitizeCountdowns: sanitizeCountdowns,
    validateFinishDock: validateFinishDock,
    sanitizeFinishDock: sanitizeFinishDock,
    sanitizeSettings: sanitizeSettings,
    mergeSettings: mergeSettings,
    migrateDocument: migrateDocument,
    createEmptyDocument: createEmptyDocument,
    validateImportPayload: validateImportPayload,
    mergeDocuments: mergeDocuments,
    importInto: importInto
  };
});
