/**
 * DayPlan · 日期与时间工具（纯函数，无 DOM 依赖）
 *
 * 契约见 docs/spec/03-data-model.md DM-2。
 * 重要：禁止依赖 `Date.parse("YYYY-MM-DD")` 的隐式 UTC 语义，
 * 本模块所有 "YYYY-MM-DD" 一律按浏览器本地时区解释。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.datetime = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
  var WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
  var MS_PER_DAY = 86400000;

  /** 两位补零 */
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * 解析 "YYYY-MM-DD" 为本地零点的 Date。
   * @returns {Date|null} 非法或日历无效（如 2026-02-30）返回 null
   */
  function parseDate(iso) {
    if (typeof iso !== 'string') return null;
    var m = DATE_RE.exec(iso);
    if (!m) return null;
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    var dt = new Date(y, mo - 1, d, 0, 0, 0, 0);
    // 回读校验，拦截 2026-02-30 这类"溢出"日期
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  /** Date -> "YYYY-MM-DD" */
  function formatDate(dt) {
    if (!(dt instanceof Date) || isNaN(dt.getTime())) return null;
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
  }

  /** 校验字符串是否为合法日期 */
  function isValidDate(iso) {
    return parseDate(iso) !== null;
  }

  /** 今天的本地日期 "YYYY-MM-DD" */
  function todayISO() {
    return formatDate(new Date());
  }

  /** 与基准日相减的纯日历天数（不受夏令时影响，按本地零点计算） */
  function diffDays(aISO, bISO) {
    var a = parseDate(aISO);
    var b = parseDate(bISO);
    if (!a || !b) return null;
    // 用 UTC 日期序数做减法，避免跨夏令时造成的 23/25 小时误差
    var ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    var ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / MS_PER_DAY);
  }

  /** 日期加减 n 天，返回 "YYYY-MM-DD" */
  function addDays(iso, n) {
    var dt = parseDate(iso);
    if (!dt || typeof n !== 'number' || !isFinite(n)) return null;
    var t = Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) + Math.round(n) * MS_PER_DAY;
    var d2 = new Date(t);
    return d2.getUTCFullYear() + '-' + pad2(d2.getUTCMonth() + 1) + '-' + pad2(d2.getUTCDate());
  }

  /** 该日期所在周的周一（ISO 周，周一为一周之始） */
  function startOfWeek(iso) {
    var dt = parseDate(iso);
    if (!dt) return null;
    var dow = dt.getDay(); // 0=周日
    var back = dow === 0 ? 6 : dow - 1;
    return addDays(iso, -back);
  }

  /** 该日期所在周的周日 */
  function endOfWeek(iso) {
    var monday = startOfWeek(iso);
    return monday === null ? null : addDays(monday, 6);
  }

  /** ISO 星期：1=周一 … 7=周日 */
  function isoWeekday(iso) {
    var dt = parseDate(iso);
    if (!dt) return null;
    var dow = dt.getDay();
    return dow === 0 ? 7 : dow;
  }

  /** 该月天数 */
  function daysInMonth(year, month /* 1-12 */) {
    return new Date(year, month, 0).getDate();
  }

  /** ISO -> {year, month(1-12), day} */
  function parseYearMonth(iso) {
    var dt = parseDate(iso);
    if (!dt) return null;
    return { year: dt.getFullYear(), month: dt.getMonth() + 1, day: dt.getDate() };
  }

  /** 该月的第一天 / 最后一天 */
  function startOfMonth(iso) {
    var ymd = parseYearMonth(iso);
    if (!ymd) return null;
    return ymd.year + '-' + pad2(ymd.month) + '-01';
  }

  function endOfMonth(iso) {
    var ymd = parseYearMonth(iso);
    if (!ymd) return null;
    return ymd.year + '-' + pad2(ymd.month) + '-' + pad2(daysInMonth(ymd.year, ymd.month));
  }

  /** 月份偏移，返回该月 1 日 */
  function addMonths(iso, n) {
    var ymd = parseYearMonth(iso);
    if (!ymd) return null;
    var total = (ymd.year * 12 + (ymd.month - 1)) + n;
    var y = Math.floor(total / 12);
    var m = total - y * 12 + 1;
    return y + '-' + pad2(m) + '-01';
  }

  /** 中文星期名 */
  function weekdayName(iso) {
    var dt = parseDate(iso);
    if (!dt) return null;
    return '星期' + WEEKDAY_NAMES[dt.getDay()];
  }

  /** 标题用日期文案：2026年10月14日 星期三 */
  function formatDateCN(iso) {
    var ymd = parseYearMonth(iso);
    if (!ymd) return null;
    return ymd.year + '年' + ymd.month + '月' + ymd.day + '日 ' + weekdayName(iso);
  }

  /** "HH:mm" -> 分钟数（0..1439），非法返回 null */
  function minutesOf(hhmm) {
    if (typeof hhmm !== 'string') return null;
    var m = TIME_RE.exec(hhmm);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /** 分钟数 -> "HH:mm"（0..1440 允许；1440 表示午夜终点） */
  function formatMinutes(min) {
    if (typeof min !== 'number' || !isFinite(min)) return null;
    var v = Math.max(0, Math.min(1440, Math.round(min)));
    var h = Math.floor(v / 60);
    var m = v % 60;
    if (h === 24) return '24:00';
    return pad2(h) + ':' + pad2(m);
  }

  /** 校验 "HH:mm" */
  function isValidTime(hhmm) {
    return minutesOf(hhmm) !== null;
  }

  /** 生成 [from, to) 区间内的所有日期（含 from，不含 to） */
  function dateRange(fromISO, toISO) {
    var out = [];
    if (diffDays(fromISO, toISO) === null) return out;
    var cur = fromISO;
    var guard = 0;
    while (diffDays(cur, toISO) > 0 && guard < 200000) {
      out.push(cur);
      cur = addDays(cur, 1);
      guard++;
    }
    return out;
  }

  /** 月份网格：返回 42 个日期（周一开头，含上下月补位），参数为 "YYYY-MM" */
  function monthGrid(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(ym);
    if (!m) return [];
    var first = m[1] + '-' + m[2] + '-01';
    if (!isValidDate(first)) return [];
    var gridStart = startOfWeek(first);
    var out = [];
    for (var i = 0; i < 42; i++) out.push(addDays(gridStart, i));
    return out;
  }

  /** 当前时间对应的分钟数（用于"今天"指示线） */
  function nowMinutes() {
    var now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  return {
    DATE_RE: DATE_RE,
    TIME_RE: TIME_RE,
    MS_PER_DAY: MS_PER_DAY,
    pad2: pad2,
    parseDate: parseDate,
    formatDate: formatDate,
    isValidDate: isValidDate,
    todayISO: todayISO,
    diffDays: diffDays,
    addDays: addDays,
    startOfWeek: startOfWeek,
    endOfWeek: endOfWeek,
    isoWeekday: isoWeekday,
    daysInMonth: daysInMonth,
    parseYearMonth: parseYearMonth,
    startOfMonth: startOfMonth,
    endOfMonth: endOfMonth,
    addMonths: addMonths,
    weekdayName: weekdayName,
    formatDateCN: formatDateCN,
    minutesOf: minutesOf,
    formatMinutes: formatMinutes,
    isValidTime: isValidTime,
    dateRange: dateRange,
    monthGrid: monthGrid,
    nowMinutes: nowMinutes
  };
});
