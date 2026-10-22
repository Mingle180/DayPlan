/**
 * DayPlan - src/core/order.js
 * 排序与分区（纯函数，零 DOM、零第三方依赖）。
 *
 * 契约来源：
 *   - docs/spec/03-data-model.md DM-5（Occurrence 形状与排序键）
 *   - docs/spec/02-functional-spec.md F-04.3 / F-04.4
 *   - task-2（T4）冻结签名
 *
 * 全部函数均为纯函数：返回新数组，绝不修改入参数组，也不修改元素对象。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.DayPlan = root.DayPlan || {}; root.DayPlan.order = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 有具体时段（time 非 null）的「发生」类型标记。 */
  var TYPE_TIMED = 'timed';
  /** 无具体时段（time === null）的「发生」类型标记。 */
  var TYPE_UNTIMED = 'untimed';

  /** 合法时间字符串：HH:mm，00:00–23:59（DM-2）。 */
  var HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  /** 一天的总分钟数，固定 00:00–24:00 映射到 [0, 1440)。 */
  var TIMELINE_TOTAL_MINUTES = 1440;

  /** 取字符编码，用于零依赖的纯数字判断（不依赖 Number/parseInt 的宽松语义）。 */
  function charCode(str, i) {
    return String.prototype.charCodeAt.call(str, i);
  }

  /** 两个字符是否为等值 ASCII 数字（"00"、"30" 等）。 */
  function isDigitPair(str, a, b) {
    var x = charCode(str, a);
    var y = charCode(str, b);
    return x >= 48 && x <= 57 && y >= 48 && y <= 57;
  }

  /** 将两位数字字符解析为 0..99 的整数。 */
  function pairValue(str, i) {
    return (charCode(str, i) - 48) * 10 + (charCode(str, i + 1) - 48);
  }

  /**
   * 把 "HH:mm" 解析为当日分钟数。
   * @param {string} hhmm 形如 "09:30" 的时间串
   * @returns {number|null} 0..1439；格式或范围非法时返回 null（不抛异常）
   */
  function minutesOf(hhmm) {
    if (typeof hhmm !== 'string' || hhmm.length !== 5) { return null; }
    if (charCode(hhmm, 2) !== 58) { return null; } /* ':' */
    if (!isDigitPair(hhmm, 0, 1) || !isDigitPair(hhmm, 3, 4)) { return null; }
    var h = pairValue(hhmm, 0);
    var m = pairValue(hhmm, 3);
    if (h > 23 || m > 59) { return null; }
    return h * 60 + m;
  }

  /**
   * 把当日分钟数格式化为 "HH:mm"。
   * @param {number} min 0..1439
   * @returns {string|null} 非法输入（非有限数、负数、超出一天）返回 null
   */
  function formatMinutes(min) {
    if (typeof min !== 'number' || !isFinite(min) || min < 0 || min > TIMELINE_TOTAL_MINUTES - 1) {
      return null;
    }
    var total = Math.round(min);
    var h = Math.floor(total / 60);
    var m = total % 60;
    return (h < 10 ? '0' + h : '' + h) + ':' + (m < 10 ? '0' + m : '' + m);
  }

  /**
   * 通用比较器：按顺序依次应用一组「取键函数 + 方向」，全部相等则返回 0。
   * directions[i] = 1 表示升序，-1 表示降序。
   * 这样可以让每个键的语义都保持显式、可读。
   */
  function compareByKeys(a, b, getters, directions) {
    for (var i = 0; i < getters.length; i += 1) {
      var av = getters[i](a);
      var bv = getters[i](b);
      var dir = directions[i];
      if (av < bv) { return dir < 0 ? 1 : -1; }
      if (av > bv) { return dir < 0 ? -1 : 1; }
    }
    return 0;
  }

  /**
   * 稳定排序辅助：先按比较器排序，比较器返回 0 时保持原输入次序。
   * Array.prototype.sort 在 V8/JSC 中已是稳定排序，这里用原始下标做兜底，
   * 确保在任意引擎下结果都可复现。
   */
  function stableSort(list, compare) {
    var indexed = [];
    for (var i = 0; i < list.length; i += 1) {
      indexed.push({ value: list[i], index: i });
    }
    indexed.sort(function (a, b) {
      var r = compare(a.value, b.value);
      if (r !== 0) { return r; }
      return a.index - b.index;
    });
    var out = [];
    for (var j = 0; j < indexed.length; j += 1) { out.push(indexed[j].value); }
    return out;
  }

  /** 时段条目时段的开始分钟；无合法时段返回 null。 */
  function startMinutesOf(occ) {
    if (!occ || !occ.time) { return null; }
    return minutesOf(occ.time.start);
  }

  /** 时段条目的时长（分钟）；无合法时段或 end <= start 时返回 null。 */
  function durationMinutesOf(occ) {
    if (!occ || !occ.time) { return null; }
    var s = minutesOf(occ.time.start);
    var e = minutesOf(occ.time.end);
    if (s === null || e === null || e <= s) { return null; }
    return e - s;
  }

  /** 数值键：undefined / null / 非数按 0 处理（order 允许重复，缺省视为 0）。 */
  function numberKey(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0;
  }

  /** 字符串键：undefined / null / 非字符串按空串处理。 */
  function stringKey(value) {
    return typeof value === 'string' ? value : '';
  }

  /** 排序键 getter：start 升序（无效时段排在最后）。 */
  function getterStart(occ) {
    var m = startMinutesOf(occ);
    return m === null ? Infinity : m;
  }

  /** 排序键 getter：时长降序（无效时段排在最后）。 */
  function getterDuration(occ) {
    var d = durationMinutesOf(occ);
    return d === null ? -Infinity : d;
  }

  /**
   * 时间轴贪心分道的排序键（DM-5 + F-04.2）：
   * start 升序 → 时长降序 → order 升序 → key 升序。
   * 时间轴与时段分区必须共用同一套次序，否则分道结果不稳定。
   */
  function compareTimedOrder(a, b) {
    return compareByKeys(
      a,
      b,
      [getterStart, getterDuration, function (o) { return numberKey(o && o.order); }, function (o) { return stringKey(o && o.key); }],
      [1, -1, 1, 1]
    );
  }

  /**
   * 按 DM-5 排序键返回时段条目的新数组（不修改入参）。
   * @param {Array} list 时段区间的「发生」集合
   * @returns {Array} 新数组
   */
  function sortTimed(list) {
    var src = list || [];
    return stableSort(src, compareTimedOrder);
  }

  /**
   * 按 F-04.3 返回无时条目的新数组（不修改入参）。
   * 主键 order 升序 → 次键 createdAt 升序 → 稳定键 key 升序。
   * @param {Array} list 无时段区间的「发生」集合
   * @returns {Array} 新数组
   */
  function sortUntimed(list) {
    var src = list || [];
    return stableSort(src, function (a, b) {
      return compareByKeys(
        a,
        b,
        [
          function (o) { return numberKey(o && o.order); },
          function (o) { return stringKey(o && o.createdAt); },
          function (o) { return stringKey(o && o.key); }
        ],
        [1, 1, 1]
      );
    });
  }

  /**
   * 上下分区判定（F-04.4 / DM-5 第 1 条）。
   * time 为 null（或缺失）→ untimed；否则 timed。
   * @param {Array} occurrences
   * @returns {{timed: Array, untimed: Array}} 两个新数组；分区内保持输入次序
   */
  function partition(occurrences) {
    var src = occurrences || [];
    var timed = [];
    var untimed = [];
    for (var i = 0; i < src.length; i += 1) {
      var occ = src[i];
      if (occ && occ.time !== null && occ.time !== undefined) {
        timed.push(occ);
      } else {
        untimed.push(occ);
      }
    }
    return { timed: timed, untimed: untimed };
  }

  /**
   * 排序全部「发生」：先分区，再各自按 DM-5 排序键排序，时段在前。
   * @param {Array} list
   * @returns {Array} 新数组（元素为原对象引用）
   */
  function sortOccurrences(list) {
    var parts = partition(list);
    return sortTimed(parts.timed).concat(sortUntimed(parts.untimed));
  }

  return {
    TYPE_TIMED: TYPE_TIMED,
    TYPE_UNTIMED: TYPE_UNTIMED,
    TIMELINE_TOTAL_MINUTES: TIMELINE_TOTAL_MINUTES,
    partition: partition,
    sortTimed: sortTimed,
    sortUntimed: sortUntimed,
    sortOccurrences: sortOccurrences,
    compareTimedOrder: compareTimedOrder,
    minutesOf: minutesOf,
    formatMinutes: formatMinutes
  };
});
