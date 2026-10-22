/**
 * DayPlan 农历换算模块（零依赖，Node 与浏览器共用）
 *
 * 数据来源与校验
 * --------------
 * LUNAR_INFO 覆盖农历 1900..2100 共 201 项。1901..2100 的各项由香港天文台
 * 《公历与农历对照表》（reference/hko/T<YEAR>e.txt）**逐日反推**得到：
 * 以「月初行 + 逐日数字行」重建 (公历日 -> 农历年,月,日,是否闰月) 后，
 * 月长 = 下一个月初 - 本月初，再按本模块的编码规则打包。
 * tools/lunar_reference.py --check 会逐日比对官方表，要求 0 差异（白名单除外）。
 *
 * 编码规则（既定，勿改）
 * --------------------
 * 逐年一个整数：
 *   bit  0..3  : 闰月月份（0 = 无闰月）
 *   bit  4..15 : 正月..十二月大小月标记，1 = 30 天，0 = 29 天（bit 15 为正月）
 *   bit 16     : 闰月天数，1 = 30 天，0 = 29 天
 *
 * 算法基准
 * --------
 * 公历 1900-01-31 = 农历 1900 年正月初一。
 * 农历 1900 年内部月序取自通行表值 0x04BD8（该年官方 1901 文件只覆盖其年末
 * 两个月，无法唯一反推全部月长；已用「1901 年正月初一 = 1901-02-19」等年份级
 * 约束校验，详见 tools/lunar_reference.py 的 derive_1900_base()）。
 *
 * 范围约定
 * --------
 * - 规则输入范围（F-06.4 / DM-6.4）：农历年 1901..2100，即 MIN_YEAR..MAX_YEAR；
 * - 换算函数额外接受数据表基准年 1900（公历 1900-01-31 起），使
 *   1901-01-01..1901-02-18（属农历 1900 年）也能完成往返；
 * - 公历区间 1900-01-31 .. 2101-01-29 之外一律返回 null。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.DayPlan = root.DayPlan || {}; root.DayPlan.lunar = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 公历/农历年范围（API 契约） */
  var MIN_YEAR = 1901;
  var MAX_YEAR = 2100;

  /** 数据表起始农历年 */
  var TABLE_START_YEAR = 1900;

  /**
   * 公历换算覆盖区间：农历 1900 年正月初一 = 1900-01-31 起，
   * 至农历 2100 年十二月三十日 = 2101-01-29 止。
   *
   * 注意：官方天文台表止于 2100-12-31（即 2100 年十二月初一），年末最后 30 天
   * 的换算依赖「十二月为 30 天」这一已登记假设（见 tests/cases/lunar.json
   * knownIssues 与 tools/lunar_reference.py 的 assumptions）。
   */
  var MAX_SOLAR = Date.UTC(2101, 0, 29);

  /** 基准日：公历 1900-01-31 = 农历 1900 年正月初一 */
  var BASE_SOLAR = Date.UTC(1900, 0, 31);
  var MS_PER_DAY = 86400000;

  /** 农历数据表，长度 201，对应农历 1900..2100（索引 i 对应 1900 + i 年） */
  var LUNAR_INFO = [
    0x04BD8, 0x04AE0, 0x0A570, 0x054D5, 0x0D260, 0x0D950, 0x16554, 0x056A0,
    0x09AD0, 0x055D2, 0x04AE0, 0x0A5B6, 0x0A4D0, 0x0D250, 0x1D255, 0x0B540,
    0x0D6A0, 0x0ADA2, 0x095B0, 0x14977, 0x04970, 0x0A4B0, 0x0B4B5, 0x06A50,
    0x06D40, 0x1AB54, 0x02B60, 0x09570, 0x052F2, 0x04970, 0x06566, 0x0D4A0,
    0x0EA50, 0x16A95, 0x05AD0, 0x02B60, 0x186E3, 0x092E0, 0x1C8D7, 0x0C950,
    0x0D4A0, 0x1D8A6, 0x0B550, 0x056A0, 0x1A5B4, 0x025D0, 0x092D0, 0x0D2B2,
    0x0A950, 0x0B557, 0x06CA0, 0x0B550, 0x15355, 0x04DA0, 0x0A5B0, 0x14573,
    0x052B0, 0x0A9A8, 0x0E950, 0x06AA0, 0x0AEA6, 0x0AB50, 0x04B60, 0x0AAE4,
    0x0A570, 0x05260, 0x0F263, 0x0D950, 0x05B57, 0x056A0, 0x096D0, 0x04DD5,
    0x04AD0, 0x0A4D0, 0x0D4D4, 0x0D250, 0x0D558, 0x0B540, 0x0B6A0, 0x195A6,
    0x095B0, 0x049B0, 0x0A974, 0x0A4B0, 0x0B27A, 0x06A50, 0x06D40, 0x0AF46,
    0x0AB60, 0x09570, 0x04AF5, 0x04970, 0x064B0, 0x074A3, 0x0EA50, 0x06B58,
    0x05AC0, 0x0AB60, 0x096D5, 0x092E0, 0x0C960, 0x0D954, 0x0D4A0, 0x0DA50,
    0x07552, 0x056A0, 0x0ABB7, 0x025D0, 0x092D0, 0x0CAB5, 0x0A950, 0x0B4A0,
    0x0BAA4, 0x0AD50, 0x055D9, 0x04BA0, 0x0A5B0, 0x15176, 0x052B0, 0x0A930,
    0x07954, 0x06AA0, 0x0AD50, 0x05B52, 0x04B60, 0x0A6E6, 0x0A4E0, 0x0D260,
    0x0EA65, 0x0D530, 0x05AA0, 0x076A3, 0x096D0, 0x04AFB, 0x04AD0, 0x0A4D0,
    0x1D0B6, 0x0D250, 0x0D520, 0x0DD45, 0x0B5A0, 0x056D0, 0x055B2, 0x049B0,
    0x0A577, 0x0A4B0, 0x0AA50, 0x1B255, 0x06D20, 0x0ADA0, 0x14B63, 0x09370,
    0x049F8, 0x04970, 0x064B0, 0x168A6, 0x0EA50, 0x06AA0, 0x1A6C4, 0x0AAE0,
    0x092E0, 0x0D2E3, 0x0C960, 0x0D557, 0x0D4A0, 0x0DA50, 0x05D55, 0x056A0,
    0x0A6D0, 0x055D4, 0x052D0, 0x0A9B8, 0x0A950, 0x0B4A0, 0x0B6A6, 0x0AD50,
    0x055A0, 0x0ABA4, 0x0A5B0, 0x052B0, 0x0B273, 0x06930, 0x07337, 0x06AA0,
    0x0AD50, 0x14B55, 0x04B60, 0x0A570, 0x054E4, 0x0D160, 0x0E968, 0x0D520,
    0x0DAA0, 0x16AA6, 0x056D0, 0x04AE0, 0x0A9D4, 0x0A2D0, 0x0D150, 0x0F252,
    0x0D530
  ];

  /** 农历月名（不含「正月」的月序前缀处理） */
  var MONTH_NAMES = [
    '', '正月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月'
  ];

  /** 农历日前缀与数字字符 */
  var DAY_PREFIX = ['初', '十', '廿', '三'];
  var DAY_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

  /**
   * 取某农历年的数据表项。
   * @param {number} lunarYear 农历年（1900..2100）
   * @returns {number|null}
   */
  function infoOf(lunarYear) {
    if (!Number.isInteger(lunarYear)) { return null; }
    var idx = lunarYear - TABLE_START_YEAR;
    if (idx < 0 || idx >= LUNAR_INFO.length) { return null; }
    return LUNAR_INFO[idx];
  }

  /**
   * 闰月月份。
   * @param {number} lunarYear
   * @returns {number} 0 表示无闰月，否则 1..12
   */
  function leapMonth(lunarYear) {
    var info = infoOf(lunarYear);
    return info === null ? 0 : info & 0xf;
  }

  /**
   * 闰月天数（该年无闰月时返回 0）。
   * @param {number} lunarYear
   * @returns {number} 0 | 29 | 30
   */
  function leapDays(lunarYear) {
    var info = infoOf(lunarYear);
    if (info === null || (info & 0xf) === 0) { return 0; }
    return (info & 0x10000) ? 30 : 29;
  }

  /**
   * 农历某月天数。
   * @param {number} lunarYear 农历年
   * @param {number} month 月序 1..12
   * @param {boolean} [isLeap] true 表示闰月
   * @returns {number} 29 | 30（参数非法或该月不存在时为 0）
   */
  function monthDays(lunarYear, month, isLeap) {
    if (!Number.isInteger(month) || month < 1 || month > 12) { return 0; }
    var info = infoOf(lunarYear);
    if (info === null) { return 0; }
    if (isLeap) {
      if ((info & 0xf) !== month) { return 0; }
      return (info & 0x10000) ? 30 : 29;
    }
    // bit 15 = 正月，bit 4 = 十二月
    return (info >> (16 - month)) & 1 ? 30 : 29;
  }

  /**
   * 农历年总天数（含闰月）。
   * @param {number} lunarYear
   * @returns {number} 353..385（越界返回 0）
   */
  function yearDays(lunarYear) {
    var info = infoOf(lunarYear);
    if (info === null) { return 0; }
    var total = 0;
    var leap = info & 0xf;
    for (var m = 1; m <= 12; m++) {
      total += ((info >> (16 - m)) & 1) ? 30 : 29;
    }
    if (leap) {
      total += (info & 0x10000) ? 30 : 29;
    }
    return total;
  }

  /**
   * 该农历年是否存在闰月（即是否存在「闰{month}月」）。
   * @param {number} lunarYear
   * @param {number} month 月序 1..12
   * @returns {boolean}
   */
  function isLeapMonth(lunarYear, month) {
    if (!Number.isInteger(month) || month < 1 || month > 12) { return false; }
    return leapMonth(lunarYear) === month;
  }

  /**
   * 农历日名。
   * @param {number} day 1..30
   * @returns {string|null} "初一".."三十"；越界返回 null
   */
  function lunarDayName(day) {
    if (!Number.isInteger(day) || day < 1 || day > 30) { return null; }
    if (day === 10) { return '初十'; }
    if (day === 20) { return '二十'; }
    if (day === 30) { return '三十'; }
    var prefix = DAY_PREFIX[Math.floor(day / 10)];
    return prefix + DAY_DIGITS[day % 10];
  }

  /**
   * 农历月名。
   * @param {number} month 月序 1..12
   * @param {boolean} [isLeap] true 表示闰月
   * @returns {string|null} 如 "正月"、"闰八月"；越界返回 null
   */
  function lunarMonthName(month, isLeap) {
    if (!Number.isInteger(month) || month < 1 || month > 12) { return null; }
    return (isLeap ? '闰' : '') + MONTH_NAMES[month];
  }

  /**
   * 解析 "YYYY-MM-DD"（可带时间部分）为公历日序号（自基准日起的天数）。
   * 严格校验日历有效性，不使用 Date.parse 以避免 UTC 陷阱。
   * @param {string} iso
   * @returns {number|null} 自 1900-01-31 起的天数
   */
  function parseIsoToDays(iso) {
    if (typeof iso !== 'string') { return null; }
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(iso);
    if (!m) { return null; }
    var y = +m[1];
    var mo = +m[2];
    var d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) { return null; }
    var utc = Date.UTC(y, mo - 1, d);
    var dt = new Date(utc);
    // 回读校验，拒绝 2026-02-30 之类的非法日期
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      return null;
    }
    // 覆盖区间之外（早于 1900-01-31 或晚于 2101-01-29）返回 null
    if (utc < BASE_SOLAR || utc > MAX_SOLAR) { return null; }
    return Math.round((utc - BASE_SOLAR) / MS_PER_DAY);
  }

  /**
   * 天数序号转 "YYYY-MM-DD"。
   * @param {number} days
   * @returns {string}
   */
  function daysToIso(days) {
    var dt = new Date(BASE_SOLAR + days * MS_PER_DAY);
    var y = dt.getUTCFullYear();
    var mo = dt.getUTCMonth() + 1;
    var d = dt.getUTCDate();
    return (y < 1000 ? String(y).padStart(4, '0') : String(y)) + '-' +
      (mo < 10 ? '0' + mo : String(mo)) + '-' +
      (d < 10 ? '0' + d : String(d));
  }

  /**
   * 公历 → 农历。
   *
   * 算法：自基准日 1900-01-31 起按 yearDays 累减定位农历年，
   * 再按月长定位月与日；闰月紧随同名正常月之后插入。
   *
   * @param {string} iso "YYYY-MM-DD"
   * @returns {{year:number, month:number, day:number, isLeap:boolean}|null}
   *          非法日期、早于基准日或农历年超出 1900..2100 时返回 null
   */
  function solarToLunar(iso) {
    var offset = parseIsoToDays(iso);
    if (offset === null || offset < 0) { return null; }

    var lunarYear = TABLE_START_YEAR;
    var info = LUNAR_INFO[0];
    var days = yearDays(lunarYear);
    while (offset >= days) {
      offset -= days;
      lunarYear += 1;
      if (lunarYear - TABLE_START_YEAR >= LUNAR_INFO.length) { return null; }
      info = LUNAR_INFO[lunarYear - TABLE_START_YEAR];
      days = yearDays(lunarYear);
    }
    // 农历年范围为数据表范围 1900..2100
    if (lunarYear < TABLE_START_YEAR || lunarYear > MAX_YEAR) { return null; }

    var leap = info & 0xf;
    var month = 1;
    var isLeap = false;
    for (;;) {
      var mdays = isLeap
        ? ((info & 0x10000) ? 30 : 29)
        : (((info >> (16 - month)) & 1) ? 30 : 29);
      if (offset < mdays) { break; }
      offset -= mdays;
      if (!isLeap && leap !== 0 && month === leap) {
        isLeap = true; // 闰月紧随同名正常月
      } else {
        isLeap = false;
        month += 1;
        if (month > 12) { return null; }
      }
    }
    return {
      year: lunarYear,
      month: month,
      day: offset + 1,
      isLeap: isLeap
    };
  }

  /**
   * 农历 → 公历（含 F-06.4 闰月降级策略）。
   *
   * - `leap === true`：仅取闰月；该年无此闰月（含该年无闰月）→ null；
   * - `leap === false`（默认）：取正常月；该月为小月（29 天）而请求 day=30 → null。
   *   本数据表 1900..2100 每个农历年的 1..12 月序都有正常月，因此不存在
   *   「该月序只以闰月形式存在」的降级分支（F-06.4 的该分支在 201 年内不触发，
   *   若未来换用其他数据源需在此处补上）。
   *
   * @param {number} lunarYear 农历年 1900..2100（规则输入契约范围为 1901..2100）
   * @param {number} month 月序 1..12
   * @param {number} day 1..30
   * @param {boolean} leap
   * @returns {string|null} "YYYY-MM-DD"
   */
  function lunarToSolarSafe(lunarYear, month, day, leap) {
    if (!Number.isInteger(lunarYear) || lunarYear < TABLE_START_YEAR || lunarYear > MAX_YEAR) {
      return null;
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) { return null; }
    if (!Number.isInteger(day) || day < 1 || day > 30) { return null; }

    var info = infoOf(lunarYear);
    if (info === null) { return null; }
    var lmonth = info & 0xf;
    var useLeap = false;

    if (leap === true) {
      // 仅取闰月；该年无此闰月 → null
      if (lmonth !== month) { return null; }
      useLeap = true;
    } else {
      // 优先取正常月（本表 1900..2100 每年 1..12 月序均有正常月，
      // 不存在「只有闰月没有正常月」的年份，故正常月恒可用）
      useLeap = false;
    }

    var mdays = useLeap
      ? ((info & 0x10000) ? 30 : 29)
      : (((info >> (16 - month)) & 1) ? 30 : 29);
    if (day > mdays) { return null; }

    var offset = 0;
    if (useLeap) {
      // 闰月位于同名正常月之后：先累加 正月..该月 的正常月长
      for (var m = 1; m <= lmonth; m++) {
        offset += ((info >> (16 - m)) & 1) ? 30 : 29;
      }
    } else {
      for (var k = 1; k < month; k++) {
        offset += ((info >> (16 - k)) & 1) ? 30 : 29;
      }
      // 若闰月位于本月之前，需先加上闰月
      if (lmonth !== 0 && lmonth < month) {
        offset += (info & 0x10000) ? 30 : 29;
      }
    }

    // 该月之前各农历年的天数
    for (var y = TABLE_START_YEAR; y < lunarYear; y++) {
      offset += yearDays(y);
    }
    return daysToIso(offset + day - 1);
  }

  /**
   * 农历 → 公历（正常月；不指定闰月）。
   * @param {number} lunarYear
   * @param {number} month
   * @param {number} day
   * @returns {string|null}
   */
  function lunarToSolar(lunarYear, month, day) {
    return lunarToSolarSafe(lunarYear, month, day, false);
  }

  return {
    LUNAR_INFO: LUNAR_INFO,
    MIN_YEAR: MIN_YEAR,
    MAX_YEAR: MAX_YEAR,
    TABLE_START_YEAR: TABLE_START_YEAR,
    solarToLunar: solarToLunar,
    lunarToSolar: lunarToSolar,
    lunarToSolarSafe: lunarToSolarSafe,
    yearDays: yearDays,
    monthDays: monthDays,
    leapMonth: leapMonth,
    leapDays: leapDays,
    lunarDayName: lunarDayName,
    lunarMonthName: lunarMonthName,
    isLeapMonth: isLeapMonth
  };
});
