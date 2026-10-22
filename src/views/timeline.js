/**
 * DayPlan - src/views/timeline.js
 * 时间轴几何与重叠分层（纯函数，零 DOM、零第三方依赖）。
 *
 * 契约来源：
 *   - docs/spec/04-system-design.md §2.6（几何契约）、§4.4（时间轴细节）
 *   - docs/spec/02-functional-spec.md F-04.1（几何）、F-04.2（重叠分层）
 *   - task-2（T4）冻结签名
 *
 * 说明：本模块只负责「算位置」，不创建任何 DOM；渲染层拿到 blocks 后自行定位。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.DayPlan = root.DayPlan || {}; root.DayPlan.timeline = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 时间轴总分钟数：00:00–24:00 → [0, 1440)。 */
  var TIMELINE_TOTAL_MINUTES = 1440;

  /** 时间轴起点固定为 00:00（DM-10 的 timelineStartHour 默认 0）。 */
  var TIMELINE_START_MINUTES = 0;

  /** 默认缩放：60px/小时，即 1 分钟 = 1px（F-04.1）。 */
  var DEFAULT_PX_PER_HOUR = 60;
  /** 默认最大道数：3（F-04.2 第 4 道起并入第 3 道）。 */
  var DEFAULT_LANES_MAX = 3;
  /** 默认每道高度：48px（§4.4 时段层总高 = laneCount * 48px）。 */
  var DEFAULT_LANE_HEIGHT = 48;
  /** 最小可点宽度：12px（F-04.1）。 */
  var DEFAULT_MIN_BLOCK_WIDTH = 12;
  /** 每道之间的垂直间距，块高 = laneHeight - LANE_GAP（F-04.2 的上下 4px 留白）。 */
  var LANE_GAP = 4;
  /** 溢出块横向偏移步长：+8px 累计（F-04.2）。 */
  var OVERFLOW_OFFSET_STEP = 8;

  /** 合法时间串：HH:mm，00:00–23:59（DM-2）。 */
  var HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  function charCode(str, i) {
    return String.prototype.charCodeAt.call(str, i);
  }

  function isDigitPair(str, a, b) {
    var x = charCode(str, a);
    var y = charCode(str, b);
    return x >= 48 && x <= 57 && y >= 48 && y <= 57;
  }

  function pairValue(str, i) {
    return (charCode(str, i) - 48) * 10 + (charCode(str, i + 1) - 48);
  }

  /**
   * 把 "HH:mm" 解析为当日分钟数。
   * 与 src/core/order.js 的 minutesOf 同语义（本模块不依赖 order.js，保持可独立加载）。
   * @returns {number|null} 0..1439；非法返回 null
   */
  function minutesOf(hhmm) {
    if (typeof hhmm !== 'string' || hhmm.length !== 5) { return null; }
    if (charCode(hhmm, 2) !== 58) { return null; }
    if (!isDigitPair(hhmm, 0, 1) || !isDigitPair(hhmm, 3, 4)) { return null; }
    var h = pairValue(hhmm, 0);
    var m = pairValue(hhmm, 3);
    if (h > 23 || m > 59) { return null; }
    return h * 60 + m;
  }

  /** 取带默认值的数字选项。 */
  function numberOption(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback;
  }

  /**
   * 把「分钟」换算成时间轴上的像素横坐标。
   * @param {number} minute 当日分钟数
   * @param {number} [pxPerHour=60]
   * @returns {number} 像素坐标
   */
  function minuteToX(minute, pxPerHour) {
    var rate = numberOption(pxPerHour, DEFAULT_PX_PER_HOUR);
    return minute * rate / 60;
  }

  /**
   * 贪心分道（F-04.2）：
   * 按 start 升序（同 start 则 end 降序，再按 order / key）依次尝试放入
   * 第一条满足 lastEnd <= block.start 的道（闭区间边界：10:00 结束与 10:00 开始同一条道）；
   * 若已有 lanesMax 条道都放不下，则并入第 lanesMax 道，并追加 laneOverflow 计数。
   *
   * @param {Array} blocks 形如 {occ, left, width, start, end} 的块（本函数按值处理，不修改入参）
   * @param {number} [lanesMax=3]
   * @returns {{blocks: Array, laneCount: number}} blocks 为新的块对象数组（输入顺序）
   */
  function assignLanes(blocks, lanesMax) {
    var src = blocks || [];
    var max = Math.floor(numberOption(lanesMax, DEFAULT_LANES_MAX));
    if (max < 1) { max = 1; }

    /* 分道决策次序：start 升序 → end 降序 → order 升序 → key 升序（与 order.js 一致） */
    var positions = [];
    for (var i = 0; i < src.length; i += 1) {
      positions.push({ block: src[i], index: i });
    }
    positions.sort(function (a, b) {
      var ba = a.block || {};
      var bb = b.block || {};
      if (ba.start !== bb.start) { return ba.start - bb.start; }
      if (ba.end !== bb.end) { return bb.end - ba.end; }
      var oa = numberOption(ba.occ && ba.occ.order, 0);
      var ob = numberOption(bb.occ && bb.occ.order, 0);
      if (oa !== ob) { return oa - ob; }
      var ka = (ba.occ && typeof ba.occ.key === 'string') ? ba.occ.key : '';
      var kb = (bb.occ && typeof bb.occ.key === 'string') ? bb.occ.key : '';
      if (ka !== kb) { return ka < kb ? -1 : 1; }
      return a.index - b.index;
    });

    var lastEnds = [];
    var laneByIndex = [];
    var overflowByIndex = [];
    var overflowSeq = 0;

    for (var p = 0; p < positions.length; p += 1) {
      var entry = positions[p];
      var block = entry.block || {};
      var start = block.start;
      var lane = -1;

      for (var L = 0; L < lastEnds.length; L += 1) {
        if (lastEnds[L] <= start) { lane = L; break; }
      }

      if (lane === -1 && lastEnds.length < max) {
        /* 所有已开道都冲突：新开一道（新道下标 = 当前道数） */
        lane = lastEnds.length;
        lastEnds.push(block.end);
      } else if (lane === -1) {
        /* 超出道数上限：并入第 lanesMax 道，并累计溢出计数 */
        lane = max - 1;
        lastEnds[lane] = block.end;
        overflowSeq += 1;
        overflowByIndex[entry.index] = overflowSeq;
      } else {
        lastEnds[lane] = block.end;
      }

      laneByIndex[entry.index] = lane;
    }

    var out = [];
    for (var k = 0; k < src.length; k += 1) {
      var original = src[k] || {};
      var copy = {};
      for (var prop in original) {
        if (Object.prototype.hasOwnProperty.call(original, prop)) { copy[prop] = original[prop]; }
      }
      copy.lane = laneByIndex[k];
      copy.top = copy.lane * DEFAULT_LANE_HEIGHT;
      copy.blockHeight = DEFAULT_LANE_HEIGHT - LANE_GAP;
      if (overflowByIndex[k] !== undefined) {
        copy.laneOverflow = overflowByIndex[k];
        copy.overflowOffsetX = overflowByIndex[k] * OVERFLOW_OFFSET_STEP;
      }
      out.push(copy);
    }

    return { blocks: out, laneCount: lastEnds.length };
  }

  /**
   * 计算时间轴布局。
   * @param {Array} occurrences 「发生」列表
   * @param {Object} [options] {pxPerHour=60, lanesMax=3, laneHeight=48, minBlockWidth=12}
   * @returns {{blocks: Array, laneCount: number, height: number}}
   *   block = {occ, left, width, lane, top}
   *   返回的 blocks 保持输入次序；无 time 或时段非法的条目被跳过（不产生 block）。
   */
  function layoutTimeline(occurrences, options) {
    var opts = options || {};
    var pxPerHour = numberOption(opts.pxPerHour, DEFAULT_PX_PER_HOUR);
    var lanesMax = numberOption(opts.lanesMax, DEFAULT_LANES_MAX);
    var laneHeight = numberOption(opts.laneHeight, DEFAULT_LANE_HEIGHT);
    var minBlockWidth = numberOption(opts.minBlockWidth, DEFAULT_MIN_BLOCK_WIDTH);
    var src = occurrences || [];

    var blocks = [];
    for (var i = 0; i < src.length; i += 1) {
      var occ = src[i];
      if (!occ || occ.time === null || occ.time === undefined) { continue; }
      var start = minutesOf(occ.time.start);
      var end = minutesOf(occ.time.end);
      /* INV-6：end > start；零宽或反向时段不产生 block（它们本来也不该进入 timed 分区） */
      if (start === null || end === null || end <= start) { continue; }

      var left = (start - TIMELINE_START_MINUTES) * pxPerHour / 60;
      var width = Math.max((end - start) * pxPerHour / 60, minBlockWidth);
      blocks.push({
        occ: occ,
        left: left,
        width: width,
        start: start,
        end: end,
        lane: 0,
        top: 0
      });
    }

    var assigned = assignLanes(blocks, lanesMax);
    var laneCount = assigned.laneCount > 0 ? assigned.laneCount : 1; /* §4.4：最少 1 道 */

    var out = [];
    for (var b = 0; b < assigned.blocks.length; b += 1) {
      var block = assigned.blocks[b];
      out.push({
        occ: block.occ,
        left: block.left,
        width: block.width,
        lane: block.lane,
        top: block.lane * laneHeight,
        laneOverflow: block.laneOverflow,
        overflowOffsetX: block.overflowOffsetX
      });
    }

    return {
      blocks: out,
      laneCount: laneCount,
      height: laneCount * laneHeight
    };
  }

  return {
    TIMELINE_TOTAL_MINUTES: TIMELINE_TOTAL_MINUTES,
    TIMELINE_START_MINUTES: TIMELINE_START_MINUTES,
    DEFAULT_PX_PER_HOUR: DEFAULT_PX_PER_HOUR,
    DEFAULT_LANES_MAX: DEFAULT_LANES_MAX,
    DEFAULT_LANE_HEIGHT: DEFAULT_LANE_HEIGHT,
    DEFAULT_MIN_BLOCK_WIDTH: DEFAULT_MIN_BLOCK_WIDTH,
    OVERFLOW_OFFSET_STEP: OVERFLOW_OFFSET_STEP,
    layoutTimeline: layoutTimeline,
    assignLanes: assignLanes,
    minuteToX: minuteToX,
    minutesOf: minutesOf
  };
});
