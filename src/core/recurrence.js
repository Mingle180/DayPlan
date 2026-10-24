/**
 * DayPlan · 重复规则展开引擎（纯函数，无 DOM 依赖）
 *
 * 契约：docs/spec/03-data-model.md DM-5 / DM-6 / DM-7、docs/spec/02-functional-spec.md F-06/F-07。
 *
 * 三条硬约束：
 *   BR-5  endDate 为半开区间（含 startDate，不含 endDate）
 *   BR-7  农历规则跟随农历日期、忽略闰月（该年无该月则该年跳过）
 *   BR-8  展开必须有界（MAX_OCCURRENCES_PER_QUERY）
 *
 * 性能：单日查询为 O(序列数)，不随序列跨度增长（见 04-§3.1）。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;

  // 农历模块可能尚未加载（T2 依赖）：降级为 null，lunarYearly 规则会抛出可诊断的错误。
  function safeLunar() {
    if (isNode) {
      try {
        return require('./lunar.js');
      } catch (e) {
        return null;
      }
    }
    return (root.DayPlan = root.DayPlan || {}), root.DayPlan.lunar || null;
  }

  var api = factory(
    isNode ? require('./datetime.js') : root.DayPlan.datetime,
    safeLunar()
  );
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.recurrence = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dt, lunar) {
  'use strict';

  var MAX_OCCURRENCES_PER_QUERY = 1000;
  var LUNAR_MIN_YEAR = 1901;
  var LUNAR_MAX_YEAR = 2100;
  var DATA_MIN_DATE = '1901-01-01';
  var DATA_MAX_DATE = '2101-01-01'; // 半开：最后一个可用农历年为 2100

  var WEEKDAY_CN = ['', '一', '二', '三', '四', '五', '六', '日'];
  var LUNAR_MONTH_CN = ['', '正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
  var DAY_CN_ONES = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  function fail(msg) {
    var e = new Error(msg);
    e.name = 'RecurrenceError';
    return e;
  }

  function requireRepeat(repeat) {
    if (!repeat || typeof repeat !== 'object') throw fail('缺少重复规则对象');
    if (['daily', 'weekly', 'monthly', 'yearly', 'lunarYearly'].indexOf(repeat.type) === -1) {
      throw fail('未知重复类型：' + (repeat && repeat.type));
    }
    if (!dt.isValidDate(repeat.startDate)) throw fail('重复规则 startDate 非法：' + repeat.startDate);
    return repeat;
  }

  function defaultMax(max) {
    return typeof max === 'number' && max > 0 ? Math.floor(max) : MAX_OCCURRENCES_PER_QUERY;
  }

  /* ------------------------------------------------------------------ *
   * 节假日判定（F-47 / R-28 / R-29 / R-31）
   *
   * core 不许依赖 src/data/（保持无数据依赖、可离线 Node 断言），因此节假日表由调用方
   * 经 setHolidayResolver(fn) 注入：浏览器在 app.js::boot()，Node 用例直接注入。
   * 未注入 / 注入值非函数 / resolver 抛错 → 一律视为「不是法定放假日」，即该规则不生效
   * （不抛错、不改变迭代 6 的既有行为）。
   * ------------------------------------------------------------------ */

  var holidayResolver = null;
  var holidayResolveWarned = false;

  /** 覆盖式设置节假日解析器；传 null / 非函数即清除（回到"不生效"） */
  function setHolidayResolver(fn) {
    holidayResolver = typeof fn === 'function' ? fn : null;
    holidayResolveWarned = false;
    return holidayResolver;
  }

  /** 安全取用注入的 resolver：抛错容错为 false，并只告警一次 */
  function isExcludedHoliday(iso) {
    if (!holidayResolver) return false;
    try {
      return holidayResolver(iso) === true;
    } catch (e) {
      if (!holidayResolveWarned) {
        holidayResolveWarned = true;
        var g = (typeof globalThis !== 'undefined') ? globalThis : null;
        var c = g && g.console ? g.console : ((typeof console !== 'undefined') ? console : null);
        if (c && typeof c.warn === 'function') c.warn('recurrence: 节假日解析器抛错，本次不生效：' + (e && e.message));
      }
      return false;
    }
  }

  /** 该规则是否要求排除法定节假日（只有显式 true 才生效） */
  function excludesHolidays(repeat) {
    return !!repeat && repeat.excludeHolidays === true;
  }

  /** 该规则是否要求排除周六 / 周日（只有显式 true 才生效） */
  function excludesWeekends(repeat) {
    return !!repeat && repeat.excludeWeekends === true;
  }

  /** 周六 / 周日（ISO 星期 6、7）；调休补班日仍按周末处理（与字面「周末」同口径）。 */
  function isWeekend(iso) {
    var wd = dt.isoWeekday(iso);
    return wd === 6 || wd === 7;
  }

  /* ------------------------------------------------------------------ *
   * 日期比较辅助
   *
   * 约定：dt.diffDays(a, b) 返回 (b - a)，因此
   *   a 早于 b  <=>  diffDays(a, b) > 0
   *   a 不晚于 b <=>  diffDays(a, b) >= 0
   * 为避免方向写反，所有"取较早/较晚"都走下面两个辅助函数。
   * ------------------------------------------------------------------ */

  /** 返回较早的日期（含相等） */
  function dateMin(a, b) {
    if (!a) return b;
    if (!b) return a;
    return dt.diffDays(a, b) >= 0 ? a : b;
  }

  /** 返回较晚的日期（含相等） */
  function dateMax(a, b) {
    if (!a) return b;
    if (!b) return a;
    return dt.diffDays(a, b) >= 0 ? b : a;
  }

  /** 计算规则的有效上界（半开），综合 endDate / 数据范围 / 查询范围 */
  function effectiveEnd(repeat, rangeTo) {
    var limit = DATA_MAX_DATE;
    if (rangeTo && dt.isValidDate(rangeTo)) limit = dateMin(limit, rangeTo);
    if (repeat.endDate && dt.isValidDate(repeat.endDate)) limit = dateMin(limit, repeat.endDate);
    return limit;
  }

  /** 计算规则的有效下界（含） */
  function effectiveStart(repeat, rangeFrom) {
    var lo = repeat.startDate;
    lo = dateMax(lo, DATA_MIN_DATE); // 数据范围下限
    if (rangeFrom && dt.isValidDate(rangeFrom)) lo = dateMax(lo, rangeFrom);
    return lo;
  }

  /* ------------------------------------------------------------------ *
   * 各类型的候选日枚举（只在 [from, to) 内枚举）
   * ------------------------------------------------------------------ */

  function expandDaily(repeat, from, to) {
    var interval = Math.max(1, Math.floor(repeat.interval || 1));
    var out = [];
    if (dt.diffDays(from, to) <= 0) return out;
    // 对齐到 <= from 的最后一个候选，再逐个推进：
    // 这样 from 恰好落在候选日当天时不会漏掉（下界闭）。
    // 循环天然有界：候选日按 interval 单调递增，越过 to 即停；总次数上限由 expandSeries 负责。
    var offset = dt.diffDays(repeat.startDate, from); // from - startDate
    var k = offset <= 0 ? 0 : Math.floor(offset / interval);
    var cur = dt.addDays(repeat.startDate, k * interval);
    while (dt.diffDays(cur, to) > 0) {
      if (dt.diffDays(from, cur) >= 0) out.push(cur); // 闭下界：diffDays(from,x) = x - from >= 0
      cur = dt.addDays(cur, interval);
    }
    return out;
  }

  function expandWeekly(repeat, from, to) {
    var interval = Math.max(1, Math.floor(repeat.interval || 1));
    var days = (repeat.weekdays || []).slice().sort(function (a, b) { return a - b; });
    var out = [];
    if (!days.length || dt.diffDays(from, to) <= 0) return out;

    // 起始候选 = 覆盖 from 的周一（可能早于 from），再按间隔对齐，最后按 [from, to) 过滤。
    var anchorMonday = dt.startOfWeek(repeat.startDate);
    var curMonday = dt.startOfWeek(from);
    var weekIndex = Math.max(0, Math.round(dt.diffDays(anchorMonday, curMonday) / 7));
    var rem = ((weekIndex % interval) + interval) % interval;
    if (rem !== 0) curMonday = dt.addDays(curMonday, (interval - rem) * 7);

    while (dt.diffDays(curMonday, to) > 0) {
      for (var i = 0; i < days.length; i++) {
        var d = dt.addDays(curMonday, days[i] - 1);
        // 闭下界 + 开上界：diffDays(from,d) = d - from >= 0，diffDays(d,to) = to - d > 0
        if (dt.diffDays(from, d) >= 0 && dt.diffDays(d, to) > 0) out.push(d);
      }
      curMonday = dt.addDays(curMonday, interval * 7);
    }
    out.sort();
    return out;
  }

  /** 月索引：year*12 + (month-1) */
  function monthIndex(iso) {
    var ymd = dt.parseYearMonth(iso);
    return ymd.year * 12 + (ymd.month - 1);
  }

  function expandMonthly(repeat, from, to) {
    var interval = Math.max(1, Math.floor(repeat.interval || 1));
    var day = Math.max(1, Math.min(31, Math.floor(repeat.day || 1)));
    var out = [];
    if (dt.diffDays(from, to) <= 0) return out;

    // 起始候选 = from 所在月（可能早于 from），按间隔对齐，最后按 [from, to) 过滤。
    var anchorIdx = monthIndex(repeat.startDate);
    var startIdx = Math.max(anchorIdx, monthIndex(from));
    var diff = startIdx - anchorIdx;
    var rem = ((diff % interval) + interval) % interval;
    if (rem !== 0) startIdx += interval - rem;

    var endIdx = monthIndex(to); // 直达 to 所在月即停（候选仍需通过 [from,to) 过滤）
    var idx = startIdx;
    while (idx <= endIdx) {
      var y = Math.floor(idx / 12);
      var m = (idx % 12) + 1;
      var dim = dt.daysInMonth(y, m);
      if (day <= dim) {
        var iso = y + '-' + dt.pad2(m) + '-' + dt.pad2(day);
        // 该月无此日则跳过（F-06.1）；闭下界 + 开上界
        if (dt.diffDays(from, iso) >= 0 && dt.diffDays(iso, to) > 0) out.push(iso);
      }
      idx += interval;
    }
    out.sort();
    return out;
  }

  /**
   * 每年（公历）：指定公历月日，每年命中一次。
   * 2 月 29 日在平年不存在 → 该年跳过（与 monthly 的"该月无此日则跳过"一致）。
   */
  function expandYearly(repeat, from, to) {
    var out = [];
    if (dt.diffDays(from, to) <= 0) return out;
    var month = Math.max(1, Math.min(12, Math.floor(repeat.month || 1)));
    var day = Math.max(1, Math.min(31, Math.floor(repeat.day || 1)));

    var yStart = dt.parseYearMonth(from).year;
    var yEnd = dt.parseYearMonth(to).year;
    for (var y = yStart; y <= yEnd; y++) {
      if (day > dt.daysInMonth(y, month)) continue; // 平年 2 月 29 日等
      var iso = y + '-' + dt.pad2(month) + '-' + dt.pad2(day);
      // 闭下界 + 开上界
      if (dt.diffDays(from, iso) >= 0 && dt.diffDays(iso, to) > 0) out.push(iso);
    }
    out.sort();
    return out;
  }

  function expandLunarYearly(repeat, from, to) {
    var out = [];
    if (dt.diffDays(from, to) <= 0) return out;
    if (!lunar || typeof lunar.lunarToSolarSafe !== 'function') {
      throw fail('农历模块未加载，无法展开 lunarYearly 规则');
    }
    var ly = dt.parseYearMonth(from).year;
    var lyEnd = dt.parseYearMonth(to).year;
    // 农历年可能跨公历年后移，多试一年以覆盖 12 月的农历新年之前的日期
    var yStart = Math.max(LUNAR_MIN_YEAR, ly - 1);
    var yEnd = Math.min(LUNAR_MAX_YEAR, lyEnd);
    for (var y = yStart; y <= yEnd; y++) {
      var iso = lunar.lunarToSolarSafe(y, repeat.lunarMonth, repeat.lunarDay, !!repeat.leap);
      if (!iso) continue; // 该年无此月/日 → 跳过（BR-7）
      if (dt.diffDays(from, iso) >= 0 && dt.diffDays(iso, to) > 0) out.push(iso);
    }
    out.sort();
    return out;
  }

  var EXPANDERS = {
    daily: expandDaily,
    weekly: expandWeekly,
    monthly: expandMonthly,
    yearly: expandYearly,
    lunarYearly: expandLunarYearly
  };

  /* ------------------------------------------------------------------ *
   * 例外应用
   * ------------------------------------------------------------------ */

  /**
   * 把序列级字段与例外覆盖合并成一次发生。
   * 迭代 3（DM-5）：新增 `starred`（序列级，例外可覆盖）与 `origin`（`item.meta.origin`）。
   * @param {object} series
   * @param {string} dateISO
   * @param {object|null} ex
   */
  function buildOccurrence(series, dateISO, ex) {
    var label = repeatLabel(series.repeat, series.meta);
    var occ = {
      key: series.id + '@' + dateISO,
      seriesId: series.id,
      date: dateISO,
      kind: 'series',
      title: series.title,
      categoryId: series.categoryId,
      time: series.time || null,
      note: typeof series.note === 'string' ? series.note : '',
      order: typeof series.order === 'number' ? series.order : 0,
      done: !!series.done,
      starred: !!series.starred,
      dirty: false,
      // 周计划（ADR-11 / DM-6.3）：meta.origin 仅影响文案与标识，不影响展开
      repeatLabel: label,
      /* 四十五轮：是否在事项上显示重复类型与起止日期。缺省显示（兼容旧数据 /
         既有未排列表），只有显式 showLabel === false 才隐藏。 */
      showRepeat: !!label && !(series.repeat && series.repeat.showLabel === false),
      origin: series.meta ? series.meta.origin : undefined
    };
    if (ex && ex.deleted !== true) {
      occ.dirty = true;
      if (Object.prototype.hasOwnProperty.call(ex, 'time')) occ.time = ex.time;
      if (ex.title !== undefined) occ.title = ex.title;
      if (ex.categoryId !== undefined) occ.categoryId = ex.categoryId;
      if (ex.note !== undefined) occ.note = ex.note;
      if (ex.done !== undefined) occ.done = !!ex.done;
      if (ex.starred !== undefined) occ.starred = !!ex.starred;
    }
    return occ;
  }

  /** 把定日事项转成发生形状 */
  function singleToOccurrence(item) {
    return {
      key: item.id + '@' + item.date,
      seriesId: item.id,
      date: item.date,
      kind: 'single',
      title: item.title,
      categoryId: item.categoryId,
      time: item.time || null,
      note: typeof item.note === 'string' ? item.note : '',
      order: typeof item.order === 'number' ? item.order : 0,
      done: !!item.done,
      starred: !!item.starred,
      dirty: false,
      repeatLabel: null,
      showRepeat: false,
      origin: item.meta ? item.meta.origin : undefined
    };
  }

  /* ------------------------------------------------------------------ *
   * 展开入口
   * ------------------------------------------------------------------ */

  /**
   * 展开一个重复序列在 [from, to) 内的所有发生。
   * @param {object} series
   * @param {{from:string, to:string, max?:number}} range
   * @returns {{occurrences:Array, truncated:boolean}}
   */
  function expandSeries(series, range) {
    if (!series || typeof series !== 'object') throw fail('缺少序列对象（series 不能为空）');
    var repeat = requireRepeat(series.repeat);
    if (!range || typeof range !== 'object') throw fail('缺少查询区间 range');
    if (!dt.isValidDate(range.from)) throw fail('range.from 非法：' + range.from);
    if (!dt.isValidDate(range.to)) throw fail('range.to 非法：' + range.to);
    if (!repeat.startDate || !dt.isValidDate(repeat.startDate)) throw fail('重复规则 startDate 非法：' + repeat.startDate);
    var max = defaultMax(range.max);
    var from = effectiveStart(repeat, range.from);
    var to = effectiveEnd(repeat, range.to);
    if (dt.diffDays(from, to) <= 0) return { occurrences: [], truncated: false };

    var dates = EXPANDERS[repeat.type](repeat, from, to);

    // F-47 / R-28：excludeHolidays 对五种重复方式全部生效，且与 seriesMayHit 同口径。
    // 2026-10-23 三十四轮：excludeWeekends（周六 / 周日）同样在截断之前过滤。
    if (excludesHolidays(repeat) || excludesWeekends(repeat)) {
      var skipHolidays = excludesHolidays(repeat);
      var skipWeekends = excludesWeekends(repeat);
      var kept = [];
      for (var f = 0; f < dates.length; f++) {
        var date = dates[f];
        if (skipWeekends && isWeekend(date)) continue;
        if (skipHolidays && isExcludedHoliday(date)) continue;
        kept.push(date);
      }
      dates = kept;
    }

    var truncated = false;
    if (dates.length > max) {
      dates = dates.slice(0, max);
      truncated = true;
    }

    var exceptions = series.exceptions || {};
    var out = [];
    for (var i = 0; i < dates.length; i++) {
      var d = dates[i];
      var ex = exceptions[d] || null;
      if (ex && ex.deleted === true) continue; // BR-9：该次被单独删除
      out.push(buildOccurrence(series, d, ex));
    }
    return { occurrences: out, truncated: truncated };
  }

  /** O(1) 判定：某个序列是否可能在某天发生（用于单日/月视图快速排除） */
  function seriesMayHit(repeat, dateISO) {
    if (!repeat || !dt.isValidDate(dateISO)) return false;
    if (dt.diffDays(dateISO, repeat.startDate) > 0) return false; // date 早于 startDate
    if (repeat.endDate && dt.diffDays(dateISO, repeat.endDate) <= 0) return false; // date 不早于 endDate（半开上界）
    // F-47 / SC-49b：与 expandSeries 同口径 —— 被排除的法定放假日直接判 false，
    // 否则同一天会出现「展开不产出、快速判定却命中」的分叉。
    if (excludesHolidays(repeat) && isExcludedHoliday(dateISO)) return false;
    if (excludesWeekends(repeat) && isWeekend(dateISO)) return false;

    switch (repeat.type) {
      case 'daily': {
        var interval = Math.max(1, Math.floor(repeat.interval || 1));
        return ((dt.diffDays(repeat.startDate, dateISO) % interval) + interval) % interval === 0;
      }
      case 'weekly': {
        var wd = repeat.weekdays || [];
        var iso = dt.isoWeekday(dateISO);
        if (wd.indexOf(iso) === -1) return false;
        var iv = Math.max(1, Math.floor(repeat.interval || 1));
        var anchor = dt.startOfWeek(repeat.startDate);
        var cur = dt.startOfWeek(dateISO);
        // 用整周差（同一周一之间的天数必为 7 的整数倍），避免除以 7 后的浮点取整误差
        var weekIndex = Math.round(dt.diffDays(anchor, cur) / 7);
        return ((weekIndex % iv) + iv) % iv === 0;
      }
      case 'monthly': {
        var day = Math.floor(repeat.day || 0);
        if (dt.parseYearMonth(dateISO).day !== day) return false;
        var ivm = Math.max(1, Math.floor(repeat.interval || 1));
        var delta = monthIndex(dateISO) - monthIndex(repeat.startDate);
        return ((delta % ivm) + ivm) % ivm === 0;
      }
      case 'yearly': {
        var ymd = dt.parseYearMonth(dateISO);
        if (ymd.month !== Math.floor(repeat.month || 0)) return false;
        if (ymd.day !== Math.floor(repeat.day || 0)) return false;
        return true; // 每年一次；2 月 29 日在平年不会出现（该日期本身不存在）
      }
      case 'lunarYearly': {
        if (!lunar || typeof lunar.solarToLunar !== 'function') return false;
        var l = lunar.solarToLunar(dateISO);
        if (!l) return false;
        if (l.month !== repeat.lunarMonth || l.day !== repeat.lunarDay) return false;
        // 必须与 F-06.4 的解析优先级一致（否则 O(1) 判定与展开会分叉）：
        //   leap=true  → 只认闰月
        //   leap=false → 优先正常月；该年无正常月时退化为闰月（故闰月也命中）
        if (repeat.leap) return !!l.isLeap;
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * 某一天的全部发生（定日事项 + 命中该日的重复序列）。
   * @param {object} doc 完整文档
   * @param {string} dateISO
   * @returns {Array}
   */
  function occurrencesForDate(doc, dateISO) {
    if (!doc || !dt.isValidDate(dateISO)) return [];
    var items = Array.isArray(doc.items) ? doc.items : [];
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      if (it.kind === 'single') {
        if (it.date === dateISO) out.push(singleToOccurrence(it));
      } else if (it.kind === 'series') {
        if (!seriesMayHit(it.repeat, dateISO)) continue;
        var ex = (it.exceptions || {})[dateISO] || null;
        if (ex && ex.deleted === true) continue;
        out.push(buildOccurrence(it, dateISO, ex));
      }
    }
    return out;
  }

  /**
   * 区间内的全部发生（`from` 含、`to` 不含）：按天调用 occurrencesForDate 后扁平化。
   * 迭代 3 新增（04-§2.3，周/月视图批量取数）。
   *
   * 契约（RC-31）：结果与「逐日调用 occurrencesForDate 再拼接」**逐项完全一致**——
   * 按 `date` 升序，同一天内保持 occurrencesForDate 的顺序。非法入参与 from >= to 返回空数组。
   * @param {object} doc 完整文档
   * @param {string} fromISO
   * @param {string} toISO
   * @returns {Array}
   */
  function occurrencesInRange(doc, fromISO, toISO) {
    if (!doc || !dt.isValidDate(fromISO) || !dt.isValidDate(toISO)) return [];
    var out = [];
    // diffDays(d, toISO) = toISO - d > 0 <=> d < toISO（开上界）
    for (var d = fromISO; dt.diffDays(d, toISO) > 0; d = dt.addDays(d, 1)) {
      var list = occurrencesForDate(doc, d);
      for (var i = 0; i < list.length; i++) out.push(list[i]);
    }
    return out;
  }

  /**
   * 月视图标记：返回 Map<iso, {count, categoryId, hasNote}>
   * 使用 O(1) 命中判定 + 每周/每月批量推进，避免逐日全量展开。
   */
  function monthMarkers(doc, yearMonth) {
    var grid = dt.monthGrid(yearMonth);
    var map = {};
    if (!grid.length) return map;
    var items = (doc && Array.isArray(doc.items)) ? doc.items : [];
    var notes = (doc && doc.notes) ? doc.notes : {};

    var singlesByDate = {};
    var seriesList = [];
    var i;
    for (i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      if (it.kind === 'single') {
        (singlesByDate[it.date] = singlesByDate[it.date] || []).push(it);
      } else if (it.kind === 'series') {
        seriesList.push(it);
      }
    }

    var first = grid[0];
    var last = grid[grid.length - 1];
    // 序列在本月网格内可命中的日期集合（一次展开，避免 42 次判定）
    var seriesHitsByDate = {};
    for (i = 0; i < seriesList.length; i++) {
      var s = seriesList[i];
      if (!s.repeat) continue;
      var range = { from: first, to: dt.addDays(last, 1), max: MAX_OCCURRENCES_PER_QUERY };
      var res;
      try {
        res = expandSeries(s, range);
      } catch (e) {
        res = { occurrences: [] };
      }
      res.occurrences.forEach(function (occ) {
        (seriesHitsByDate[occ.date] = seriesHitsByDate[occ.date] || []).push(occ);
      });
    }

    grid.forEach(function (iso) {
      var hits = [];
      var singles = singlesByDate[iso] || [];
      for (var k = 0; k < singles.length; k++) {
        hits.push({ categoryId: singles[k].categoryId, time: singles[k].time || null });
      }
      var sh = seriesHitsByDate[iso] || [];
      for (var j = 0; j < sh.length; j++) {
        hits.push({ categoryId: sh[j].categoryId, time: sh[j].time || null });
      }
      if (!hits.length && !notes[iso]) return;
      // 类别色取该日第一条有时段的条目，否则取第一条
      var timed = hits.filter(function (h) { return h.time; });
      var firstOne = timed.length ? timed[0] : hits[0];
      map[iso] = {
        count: hits.length,
        categoryId: firstOne ? firstOne.categoryId : null,
        hasNote: !!notes[iso]
      };
    });
    return map;
  }

  /* ------------------------------------------------------------------ *
   * 文案
   * ------------------------------------------------------------------ */

  function lunarDayCN(day) {
    if (day === 10) return '初十';
    if (day === 20) return '二十';
    if (day === 30) return '三十';
    var tens = Math.floor(day / 10);
    var ones = day % 10;
    if (tens === 0) return '初' + DAY_CN_ONES[ones];
    if (tens === 1) return '十' + DAY_CN_ONES[ones];
    if (tens === 2) return '廿' + DAY_CN_ONES[ones];
    return '三十';
  }

  /**
   * 生成重复规则的中文说明（F-07）。
   * 迭代 3：`meta.origin === "weekPlan"` 时前缀 `周计划 · `（ADR-11：仅文案差异）；
   * 不传 `meta` 时与迭代 2 的输出完全一致（向后兼容）。
   */
  function repeatLabel(repeat, meta) {
    if (!repeat) return '';
    var head = '';
    if (repeat.type === 'daily') {
      var iv = Math.max(1, Math.floor(repeat.interval || 1));
      head = iv === 1 ? '每天' : '每 ' + iv + ' 天';
    } else if (repeat.type === 'weekly') {
      var ivw = Math.max(1, Math.floor(repeat.interval || 1));
      var names = (repeat.weekdays || []).slice().sort(function (a, b) { return a - b; })
        .map(function (d) { return '周' + WEEKDAY_CN[d]; }).join('、');
      head = (ivw === 1 ? '每周' : '每 ' + ivw + ' 周') + (names ? ' ' + names : '');
    } else if (repeat.type === 'monthly') {
      var ivm = Math.max(1, Math.floor(repeat.interval || 1));
      head = (ivm === 1 ? '每月' : '每 ' + ivm + ' 月') + ' ' + repeat.day + ' 日';
    } else if (repeat.type === 'yearly') {
      head = '每年 ' + repeat.month + ' 月 ' + repeat.day + ' 日';
      if (repeat.month === 2 && repeat.day === 29) head += '（仅闰年）';
    } else if (repeat.type === 'lunarYearly') {
      head = '每年农历' + (repeat.leap ? '闰' : '') + LUNAR_MONTH_CN[repeat.lunarMonth] + '月' + lunarDayCN(repeat.lunarDay);
    }
    var tail = '';
    if (repeat.startDate) tail += '（' + repeat.startDate + ' 起）';
    if (repeat.endDate) {
      var lastDay = dt.addDays(repeat.endDate, -1);
      tail += '（至 ' + lastDay + '）';
    }
    var label = head + tail;
    if (meta && meta.origin === 'weekPlan') label = '周计划 · ' + label;
    else if (meta && meta.origin === 'monthPlan') label = '月计划 · ' + label;
    // F-47.6：开启该规则时在文案末尾如实标注；不含该键（或非 true）时输出逐字节不变。
    // 未注入 resolver 也照样标注 —— 文案描述的是规则本身，不是本次运行是否生效。
    // 三十四轮：节假日 + 周末同时开启时合并为一条，避免两个括号叠在一起。
    var skipHol = excludesHolidays(repeat);
    var skipWkd = excludesWeekends(repeat);
    if (skipHol && skipWkd) label += '（不含节假日和周末）';
    else if (skipHol) label += '（不含法定节假日）';
    else if (skipWkd) label += '（不含周末）';
    return label;
  }

  /**
   * 展开工具：给出规则在给定范围内是否超过上限（用于表单提示，F-06.2）
   */
  function probeSeries(repeat, range) {
    var fake = { id: '__probe__', kind: 'series', repeat: repeat, time: null, title: 'probe' };
    return expandSeries(fake, range);
  }

  return {
    MAX_OCCURRENCES_PER_QUERY: MAX_OCCURRENCES_PER_QUERY,
    LUNAR_MIN_YEAR: LUNAR_MIN_YEAR,
    LUNAR_MAX_YEAR: LUNAR_MAX_YEAR,
    DATA_MIN_DATE: DATA_MIN_DATE,
    DATA_MAX_DATE: DATA_MAX_DATE,
    expandSeries: expandSeries,
    expandDaily: expandDaily,
    expandWeekly: expandWeekly,
    expandMonthly: expandMonthly,
    expandYearly: expandYearly,
    expandLunarYearly: expandLunarYearly,
    seriesMayHit: seriesMayHit,
    /** 迭代 7（F-47 / R-31）：注入式节假日解析器（覆盖式；传 null 清除） */
    setHolidayResolver: setHolidayResolver,
    excludesHolidays: excludesHolidays,
    excludesWeekends: excludesWeekends,
    isWeekend: isWeekend,
    occurrencesForDate: occurrencesForDate,
    occurrencesInRange: occurrencesInRange,
    monthMarkers: monthMarkers,
    buildOccurrence: buildOccurrence,
    singleToOccurrence: singleToOccurrence,
    repeatLabel: repeatLabel,
    lunarDayCN: lunarDayCN,
    probeSeries: probeSeries,
    effectiveEnd: effectiveEnd,
    effectiveStart: effectiveStart
  };
});
