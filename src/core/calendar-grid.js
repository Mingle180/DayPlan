/**
 * DayPlan - src/core/calendar-grid.js
 * 月视图网格与月份窗口（纯函数，零 DOM、零全局状态、零依赖、不用 Date）。
 *
 * 契约：docs/spec/04-system-design.md §2.6
 * 功能：docs/spec/02-functional-spec.md F-17.1 / F-17.2（月视图三列 + 无限纵向滚动）
 *       + docs/spec/07-iteration-4-delta.md F-27 / ADR-23 / US-23 / BR-32 / BR-33
 *         （迭代 4：连续多月列表的窗口函数、年分隔、响应式列数）
 * 用例：docs/spec/05-test-and-verification.md §3.5 LG-19 / LG-20 / LG-21
 *       + docs/spec/07-iteration-4-delta.md §6 LG-31 / LG-32
 *
 * 命名说明（迭代 4，DM-26 R-1 裁定）：
 *   既有 `monthWindow(centerYM, {back, ahead})` / `visibleMonths(...)` 是**按月偏移**的旧窗口，
 *   自迭代 4 起**不再被月视图调用**（保留为通用月偏移工具，语义与 LG-20 用例都不许变动）；
 *   迭代 4 需要的「选定年 ±N 年」窗口命名为 `initialMonthWindow(centerYM, {backYears, aheadYears})`，
 *   即 task-12 里的 monthWindow 语义。二者不可互相替代，故并存。
 *
 * 说明：为避免依赖 `Date` 的时区语义（也为了在无 Date 的宿主里可用），
 * 日期算术使用 Howard Hinnant 的 civil-from-days 算法，全部为整数运算。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.DayPlan = root.DayPlan || {}; root.DayPlan.calendarGrid = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 月视图可滚动范围（F-17.2 的 1900-01 / 2100-12 边界，与农历数据范围一致）。 */
  var MIN_YM = '1900-01';
  var MAX_YM = '2100-12';

  var YM_RE = /^(\d{4})-(\d{2})$/;
  var DAYS_PER_WEEK = 7;

  /** 1970-01-01（星期四，day number 0）→ 周一为 0 的星期下标偏移。 */
  var MONDAY_BASED_EPOCH_OFFSET = 3;

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** 公历年月日 → 自 1970-01-01 起的天数（Hinnant 算法）。 */
  function daysFromCivil(year, month, day) {
    var y = year - (month <= 2 ? 1 : 0);
    var era = Math.floor((y >= 0 ? y : y - 399) / 400);
    var yoe = y - era * 400;                                                     /* [0, 399] */
    var doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; /* [0, 365] */
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;      /* [0, 146096] */
    return era * 146097 + doe - 719468;
  }

  /** 天数 → 公历年月日。 */
  function civilFromDays(dayNumber) {
    var z = dayNumber + 719468;
    var era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
    var doe = z - era * 146097;                                                   /* [0, 146096] */
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));    /* [0, 365] */
    var mp = Math.floor((5 * doy + 2) / 153);                                     /* [0, 11] */
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1;                             /* [1, 31] */
    var m = mp + (mp < 10 ? 3 : -9);                                              /* [1, 12] */
    return { year: y + (m <= 2 ? 1 : 0), month: m, day: d };
  }

  /** 天数 → 周一为 0 的星期下标（0=一 … 6=日）。 */
  function weekdayMon0(dayNumber) {
    return ((dayNumber + MONDAY_BASED_EPOCH_OFFSET) % 7 + 7) % 7;
  }

  function formatCivil(c) {
    return c.year + '-' + pad2(c.month) + '-' + pad2(c.day);
  }

  function isoFromDayNumber(dayNumber) {
    return formatCivil(civilFromDays(dayNumber));
  }

  /** "YYYY-MM" → 月份序号（y*12 + m-1）；非法返回 null。 */
  function ymToIndex(ym) {
    if (typeof ym !== 'string') { return null; }
    var m = YM_RE.exec(ym);
    if (!m) { return null; }
    var year = Number(m[1]);
    var month = Number(m[2]);
    if (month < 1 || month > 12) { return null; }
    return year * 12 + (month - 1);
  }

  /** 月份序号 → "YYYY-MM"。 */
  function indexToYM(index) {
    var year = Math.floor(index / 12);
    var month = index - year * 12 + 1;
    return year + '-' + pad2(month);
  }

  var MIN_INDEX = ymToIndex(MIN_YM);
  var MAX_INDEX = ymToIndex(MAX_YM);

  /* ---- 迭代 4（DM-19.4）只读常量：月视图窗口与响应式列数 ---- */
  /** 初始窗口：选定年 ±2 年 → 5 年 = 60 个月（BR-32）。 */
  var MONTH_WINDOW_YEARS = 2;
  /** 触底/触顶时每次追加的年数（BR-32）。 */
  var MONTH_EXTEND_YEARS = 1;
  /** 月视图每行最少列数（BR-33）。 */
  var MONTH_COL_MIN = 3;
  /** 月视图每行最多列数（BR-33）。 */
  var MONTH_COL_MAX = 6;
  /** 每列基准像素宽（BR-33 / CSS minmax(240px,1fr)）。 */
  var MONTH_COL_PX = 240;
  /**
   * 视口宽 → 列数时的固定扣减：网格左右内边距 + 滚动条余量（BR-33 的「− 32」）。
   * CSS 用 `repeat(auto-fill, minmax(240px, 1fr))` 自动排布，这里只提供**断言口径**。
   */
  var MONTH_VIEWPORT_INSET_PX = 32;

  /** 取整数并按 [lo, hi] 夹取。 */
  function clampInt(value, lo, hi) {
    var v = Math.floor(Number(value));
    if (!isFinite(v)) { v = lo; }
    if (v < lo) { return lo; }
    if (v > hi) { return hi; }
    return v;
  }

  /** 取数字选项（有限数才生效，否则用默认值）。 */
  function numOption(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback;
  }

  /** 年月序号 → {year, month(1-12)}。 */
  function indexToParts(index) {
    var year = Math.floor(index / 12);
    return { year: year, month: index - year * 12 + 1 };
  }

  /**
   * 区间内的连续月份（升序），含年变化标记（迭代 4 / LG-31）。
   * 越出 [1900-01, 2100-12] 的月份被丢弃；startYM 晚于 endYM 时返回 []。
   * `isYearStart` 仅在 1 月为 true（DM-26 R-1 补充 1），窗口恰好从 1 月起也算年起点。
   * @param {string} startYM "YYYY-MM"
   * @param {string} endYM "YYYY-MM"
   * @returns {Array<{ym: string, year: number, month: number, isYearStart: boolean}>}
   */
  function monthsInRange(startYM, endYM) {
    var start = ymToIndex(startYM);
    var end = ymToIndex(endYM);
    if (start === null || end === null || start > end) { return []; }

    var out = [];
    for (var i = start; i <= end; i += 1) {
      if (i < MIN_INDEX || i > MAX_INDEX) { continue; }
      var parts = indexToParts(i);
      out.push({
        ym: indexToYM(i),
        year: parts.year,
        month: parts.month,
        isYearStart: parts.month === 1
      });
    }
    return out;
  }

  /**
   * 迭代 4 的初始月份窗口（BR-32）：以 centerYM 所在年为中心 ±backYears/aheadYears 年。
   * 默认 ±2 年 → 60 个月；结果被 [1900-01, 2100-12] 裁剪。
   * @param {string} centerYM
   * @param {Object} [options] {backYears = 2, aheadYears = 2}
   * @returns {{startYM: string, endYM: string, months: Array<{ym, year, month, isYearStart}>}}
   *          months 升序；startYM/endYM 为**裁剪后**的实际边界（DM-26 R-1）
   */
  function initialMonthWindow(centerYM, options) {
    var opts = options || {};
    var center = clampYM(centerYM);
    if (center === null) {
      return { startYM: MIN_YM, endYM: MIN_YM, months: [] };
    }
    var centerParts = indexToParts(ymToIndex(center));
    var backYears = Math.max(0, Math.floor(numOption(opts.backYears, MONTH_WINDOW_YEARS)));
    var aheadYears = Math.max(0, Math.floor(numOption(opts.aheadYears, MONTH_WINDOW_YEARS)));
    var startYM = clampYM((centerParts.year - backYears) + '-01');
    var endYM = clampYM((centerParts.year + aheadYears) + '-12');
    if (startYM === null) { startYM = MIN_YM; }
    if (endYM === null) { endYM = MAX_YM; }
    return {
      startYM: startYM,
      endYM: endYM,
      months: monthsInRange(startYM, endYM)
    };
  }

  /**
   * 迭代 4：向列表头部（'back'）或尾部（'ahead'）追加若干年（默认 1 年 = 12 个月）。
   * 返回**新区间**；已到 [1900-01, 2100-12] 边界时该方向不再变化（幂等）。
   * 与原区间保持重叠（追加而非替换），排序仍为升序。
   * @param {Object} range {startYM, endYM}
   * @param {"back"|"ahead"} direction
   * @param {Object} [options] {years = 1}
   * @returns {{startYM: string, endYM: string, added: number, months: Array}}
   *          added = 实际新增月份数（边界处少于 12×years）
   */
  function extendRange(range, direction, options) {
    var opts = options || {};
    var src = range || {};
    var startYM = clampYM(src.startYM);
    var endYM = clampYM(src.endYM);
    if (startYM === null || endYM === null) {
      return { startYM: MIN_YM, endYM: MAX_YM, added: 0, months: [] };
    }
    if (startYM > endYM) { var swap = startYM; startYM = endYM; endYM = swap; }

    var years = Math.max(0, Math.floor(numOption(opts.years, MONTH_EXTEND_YEARS)));
    var startIndex = ymToIndex(startYM);
    var endIndex = ymToIndex(endYM);
    var beforeCount = endIndex - startIndex + 1;

    if (direction === 'back') {
      startIndex -= years * 12;
      if (startIndex < MIN_INDEX) { startIndex = MIN_INDEX; }
    } else if (direction === 'ahead') {
      endIndex += years * 12;
      if (endIndex > MAX_INDEX) { endIndex = MAX_INDEX; }
    }
    /* 其它 direction：原样返回（不抛异常） */

    var newStartYM = indexToYM(startIndex);
    var newEndYM = indexToYM(endIndex);
    var months = monthsInRange(newStartYM, newEndYM);
    return {
      startYM: newStartYM,
      endYM: newEndYM,
      added: months.length - beforeCount,
      months: months
    };
  }

  /**
   * 响应式列数口径（BR-33 / AC-23.2）：`clamp(min, floor((宽 − 32) / colPx), max)`。
   * CSS 侧由 `repeat(auto-fill, minmax(240px, 1fr))` 实现，本函数供断言与测量口径使用。
   * @param {number} widthPx 视口/容器宽
   * @param {Object} [options] {min = 3, max = 6, colPx = 240}
   * @returns {number} 3–6
   */
  function monthColumnsFor(widthPx, options) {
    var opts = options || {};
    var min = clampInt(numOption(opts.min, MONTH_COL_MIN), 1, 99);
    var max = clampInt(numOption(opts.max, MONTH_COL_MAX), 1, 99);
    if (max < min) { var swap = min; min = max; max = swap; }
    var colPx = numOption(opts.colPx, MONTH_COL_PX);
    if (!(colPx > 0)) { colPx = MONTH_COL_PX; }

    var width = numOption(widthPx, 0);
    var usable = width - MONTH_VIEWPORT_INSET_PX;
    if (usable < 0) { usable = 0; }
    return clampInt(Math.floor(usable / colPx), min, max);
  }

  /**
   * 把月份键夹取到允许范围内（F-17.2 边界）。
   * @param {string} ym "YYYY-MM"
   * @param {Object} [options] {min = "1900-01", max = "2100-12"}
   * @returns {string|null} 非法输入返回 null
   */
  function clampYM(ym, options) {
    var opts = options || {};
    var index = ymToIndex(ym);
    if (index === null) { return null; }
    var minIndex = ymToIndex(opts.min === undefined ? MIN_YM : opts.min);
    var maxIndex = ymToIndex(opts.max === undefined ? MAX_YM : opts.max);
    if (minIndex === null) { minIndex = MIN_INDEX; }
    if (maxIndex === null) { maxIndex = MAX_INDEX; }
    if (maxIndex < minIndex) { var t = minIndex; minIndex = maxIndex; maxIndex = t; }
    if (index < minIndex) { index = minIndex; }
    if (index > maxIndex) { index = maxIndex; }
    return indexToYM(index);
  }

  /**
   * 以 centerYM 为中心的连续月份窗口（F-17.2）。
   * 越出 1900-01…2100-12 的月份**被丢弃**（不夹取，避免边界处出现重复月份）。
   * @param {string} centerYM
   * @param {Object} [options] {back = 3, ahead = 3}
   * @returns {Array<string>}
   */
  function monthWindow(centerYM, options) {
    var opts = options || {};
    var back = Math.floor(typeof opts.back === 'number' && isFinite(opts.back) ? opts.back : 3);
    var ahead = Math.floor(typeof opts.ahead === 'number' && isFinite(opts.ahead) ? opts.ahead : 3);
    if (back < 0) { back = 0; }
    if (ahead < 0) { ahead = 0; }

    var center = ymToIndex(centerYM);
    if (center === null) { return []; }
    if (center < MIN_INDEX) { center = MIN_INDEX; }
    if (center > MAX_INDEX) { center = MAX_INDEX; }

    var out = [];
    for (var i = center - back; i <= center + ahead; i += 1) {
      if (i < MIN_INDEX || i > MAX_INDEX) { continue; }
      out.push(indexToYM(i));
    }
    return out;
  }

  /**
   * 视口内固定 3 个月的窗口（F-17.1）。
   * @param {string} centerYM
   * @param {Object} [options] {back = 1, ahead = 1}
   * @returns {Array<string>}
   */
  function visibleMonths(centerYM, options) {
    var opts = options || {};
    return monthWindow(centerYM, {
      back: opts.back === undefined ? 1 : opts.back,
      ahead: opts.ahead === undefined ? 1 : opts.ahead
    });
  }

  /**
   * 周一起始的月网格（§2.6 / LG-19）。
   * @param {number} year
   * @param {number} month 1–12（注意是 1 基，与 monthGridMon(2026, 10) 一致）
   * @returns {null|{ym: string, weeks: Array<{dates: Array<string>}>}}
   *   行数 5 或 6（不强行补 6 行）；每行恰好 7 天，首列恒为周一。
   */
  function monthGridMon(year, month) {
    if (!isFinite(year) || !isFinite(month)) { return null; }
    year = Math.floor(year);
    month = Math.floor(month);
    if (month < 1 || month > 12) { return null; }

    var firstDayNumber = daysFromCivil(year, month, 1);
    var nextYear = month === 12 ? year + 1 : year;
    var nextMonth = month === 12 ? 1 : month + 1;
    var daysInMonth = daysFromCivil(nextYear, nextMonth, 1) - firstDayNumber;

    var offset = weekdayMon0(firstDayNumber);
    var weeksCount = Math.ceil((offset + daysInMonth) / DAYS_PER_WEEK);
    var weeks = [];
    var cursor = firstDayNumber - offset;
    for (var w = 0; w < weeksCount; w += 1) {
      var dates = [];
      for (var d = 0; d < DAYS_PER_WEEK; d += 1) {
        dates.push(isoFromDayNumber(cursor));
        cursor += 1;
      }
      weeks.push({ dates: dates });
    }

    return {
      ym: year + '-' + pad2(month),
      weeks: weeks
    };
  }

  return {
    MIN_YM: MIN_YM,
    MAX_YM: MAX_YM,
    DAYS_PER_WEEK: DAYS_PER_WEEK,
    MONTH_WINDOW_YEARS: MONTH_WINDOW_YEARS,
    MONTH_EXTEND_YEARS: MONTH_EXTEND_YEARS,
    MONTH_COL_MIN: MONTH_COL_MIN,
    MONTH_COL_MAX: MONTH_COL_MAX,
    MONTH_COL_PX: MONTH_COL_PX,
    MONTH_VIEWPORT_INSET_PX: MONTH_VIEWPORT_INSET_PX,
    monthGridMon: monthGridMon,
    monthsInRange: monthsInRange,
    initialMonthWindow: initialMonthWindow,
    extendRange: extendRange,
    monthColumnsFor: monthColumnsFor,
    monthWindow: monthWindow,
    visibleMonths: visibleMonths,
    clampYM: clampYM,
    daysFromCivil: daysFromCivil,
    civilFromDays: civilFromDays
  };
});
