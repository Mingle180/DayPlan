/**
 * DayPlan - src/views/week-layout.js
 * 周视图 7 列的纯几何（纯函数，零 DOM、零全局状态、零依赖）。
 *
 * 契约：docs/spec/07-iteration-4-delta.md §3 **DM-22 v2**（取代 04 §2.7 的 v1）
 *       + §3 DM-26 裁定 R-5 / R-6 / R-7
 * 功能：02 F-18.1（7 列并行、纵向时间尺、不做空闲压缩，ADR-12）、
 *       S32 / US-28（每日列内按类别分道）、S33 / US-29（按需加宽当天列）
 * 用例：07 §6 LG-33（+ 05 §3.5 LG-22/LG-23 的 layoutWeek 分支按 DM-22 修订）
 *
 * 与 core/layout.js 的关系：本模块**内联**同一张贪心分道决策表
 * （DM-22.2b 要求「决策表同 core/layout.js::greedyAssignLanes」），
 * 但**不 require** 它，避免浏览器加载顺序耦合；一致性由 tests/cases/layout.test.js
 * 的 LG-EXT-05 交叉断言兜底（单类别且 ≤laneCap 时分道结果与 timeline.assignLanes 一致）。
 *
 * 时间映射（DM-22.3）：`top = start × rate`、`height = max((end−start) × rate − gapY, blockHeightMin)`；
 * `height` 与 `pxPerHour` 同源返回（BR-36 / ADR-20），渲染层不得自行换算。
 * 非时段事项（time === null）与非法时段不计入本模块。
 *
 * 迭代 6（F-38 / R-16）：新增可选 `projectY(minute)` 与 `axisLength` 两个入口，
 * 供周视图把「首末空闲折叠轴」（core/layout.js::computeAxisGeometry）作为唯一几何源传入；
 * 两者缺省时行为与迭代 4 完全一致（等价于 `minute × rate` 与 `1440 × rate`）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.DayPlan = root.DayPlan || {}; root.DayPlan.weekLayout = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ===== DM-22 常量 ===== */
  var DEFAULT_PX_PER_HOUR = 56;      /* F-18.1：settings.weekPxPerHour 默认 56 */
  var DEFAULT_LANES_MAX = 3;         /* DM-19.2：周视图只把它当**列宽权重下限** */
  var LANE_HARD_CAP = 6;             /* DM-19.4：周视图道数硬上限 */
  /* DM-26 R-5：DM-22.1 引用的 DEFAULT_LANE_HEIGHT 在 DM-22 常量表里缺失，
     按 DM-21 的 MAX_LANE_HEIGHT_DEFAULT（=48，BR-26 车道高下限）取值。 */
  var DEFAULT_LANE_HEIGHT = 48;
  var DEFAULT_BLOCK_HEIGHT_MIN = 22;
  var DEFAULT_GAP_Y = 2;
  var OVERFLOW_OFFSET_PERCENT = 6;   /* DM-22.1 / US-29.3：溢出序号 × 6（百分点） */
  var DEFAULT_PIN_FIRST = 'urgent';  /* DM-22.1 / BR-29 */
  var DEFAULT_COLUMN_COUNT = 7;      /* 仅作契约占位（DM-22 不再使用该选项） */
  var TOTAL_MINUTES = 1440;
  /* 迭代 8（F-52）：列宽的下限（保证时间不换行）与上限（封顶，用户裁定可调） */
  var WEEK_DEFAULT_MIN_ITEM_WIDTH = 74;
  var WEEK_DEFAULT_MAX_CATEGORY_WIDTH = 320;

  var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function numberOption(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback;
  }

  function positiveIntOption(value, fallback) {
    var n = Math.floor(numberOption(value, fallback));
    return n < 1 ? 1 : n;
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** "HH:mm" → 分钟；end 位置容忍 "24:00"（与 core/layout.js 语义一致）。 */
  function minutesOfTime(value, allowEndOfDay) {
    if (typeof value !== 'string') { return null; }
    if (allowEndOfDay && value === '24:00') { return TOTAL_MINUTES; }
    var m = TIME_RE.exec(value);
    if (!m) { return null; }
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /** 归一化 pinFirst：字符串 / 数组 / 缺省 → 类别 id 数组。 */
  function pinList(pinFirst) {
    if (pinFirst === undefined || pinFirst === null || pinFirst === '') { return []; }
    var list = (Object.prototype.toString.call(pinFirst) === '[object Array]') ? pinFirst : [pinFirst];
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var v = list[i];
      if (v === undefined || v === null) { continue; }
      var key = String(v);
      if (key && out.indexOf(key) < 0) { out.push(key); }
    }
    return out;
  }

  /**
   * 归一化 days 入参，兼容三种形状（保持迭代 3 的宽容度）：
   *   1. [{iso, occurrences}]（也接受 items / occs / list 字段）
   *   2. ["2026-10-12", ...]（无事项的纯日期列）
   *   3. { "2026-10-12": Occurrence[], ... }（按日映射，key 插入序）
   * @returns {Array<{iso: string, occurrences: Array}>}
   */
  function normalizeDays(days) {
    var out = [];
    if (!days) { return out; }

    if (Object.prototype.toString.call(days) === '[object Array]') {
      for (var i = 0; i < days.length; i += 1) {
        var day = days[i];
        if (typeof day === 'string') {
          out.push({ iso: day, occurrences: [] });
        } else if (day && typeof day === 'object') {
          var list = day.occurrences || day.items || day.occs || day.list || [];
          out.push({ iso: typeof day.iso === 'string' ? day.iso : '', occurrences: list });
        }
      }
      return out;
    }

    if (typeof days === 'object') {
      for (var iso in days) {
        if (hasOwn(days, iso)) { out.push({ iso: iso, occurrences: days[iso] || [] }); }
      }
    }
    return out;
  }

  /**
   * 类别内贪心分道（决策表与 core/layout.js::greedyAssignLanes 完全一致）：
   * start 升序 → end 降序 → occ.order 升序 → occ.key 升序 → 输入序；
   * 放入第一条满足 `lastEnd <= start` 的道（闭区间可复用同一条道）。
   * 本函数**不设道数上限**（DM-22.2b：类别内先如实分道，全局上限在编号阶段处理）。
   *
   * @param {Array} blocks [{occ, start, end}]（不修改入参）
   * @returns {{lanes: Array<number>, count: number}} lanes 按输入下标
   */
  function assignLanesWithinCategory(blocks) {
    var src = blocks || [];
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
    var lanes = [];
    for (var p = 0; p < positions.length; p += 1) {
      var entry = positions[p];
      var block = entry.block || {};
      var lane = -1;
      for (var L = 0; L < lastEnds.length; L += 1) {
        if (lastEnds[L] <= block.start) { lane = L; break; }
      }
      if (lane === -1) {
        lane = lastEnds.length;
        lastEnds.push(block.end);
      } else {
        lastEnds[lane] = block.end;
      }
      lanes[entry.index] = lane;
    }

    return { lanes: lanes, count: lastEnds.length };
  }

  /**
   * 类别桶序（DM-22.2a / BR-29）：pinFirst 命中 → categoryOrder 顺序 → 首次出现序。
   */
  function bucketOrder(buckets, firstSeen, categoryOrder, pinFirst) {
    var used = {};
    var out = [];
    var pins = pinList(pinFirst);
    var i;
    for (i = 0; i < pins.length; i += 1) {
      if (!used[pins[i]] && hasOwn(buckets, pins[i])) { used[pins[i]] = true; out.push(pins[i]); }
    }
    var order = categoryOrder || [];
    for (i = 0; i < order.length; i += 1) {
      var key = (order[i] === null || order[i] === undefined) ? '' : String(order[i]);
      if (!used[key] && hasOwn(buckets, key)) { used[key] = true; out.push(key); }
    }
    for (i = 0; i < firstSeen.length; i += 1) {
      if (!used[firstSeen[i]]) { used[firstSeen[i]] = true; out.push(firstSeen[i]); }
    }
    return out;
  }

  /**
   * 周视图布局（DM-22；迭代 8 / F-52 起列宽由内容决定）。
   *
   * @param {Array|Object} days 见 normalizeDays（7 天为常态）
   * @param {Object} [options] {pxPerHour=56, lanesMax=3, laneCap=6, categoryOrder,
   *                            pinFirst="urgent", laneHeight=48, blockHeightMin=22, gapY=2,
   *                            projectY, axisLength}
   *   - lanesMax：只作为 `widthWeight` 的下限（DM-19.2）；**不是**周视图分道上限
   *   - laneCap：全局道数硬上限（默认 6），超出者并入最后一道 + overflowOffsetX
   *   - projectY(minute) → 像素（迭代 6 / F-38）：给了就用它算 top/height（供周视图的
   *     「首末空闲折叠轴」复用 core/layout.js::computeAxisGeometry 的 getY）；缺省 =
   *     `minute × pxPerHour/60`（迭代 4 口径，逐字节等价）。
   *   - axisLength：给了有限数就作为返回的 `height`（与 projectY 同源，保证「轴高 = 内容区高」）；
   *     缺省 = `1440 × pxPerHour/60`（不做空闲压缩的旧口径）。
   *   - measureWidth(occ, cellItems) → 像素（迭代 8 / F-52）：给了就按**内容**算列宽。
   *     口径（用户裁定）：
   *       · 某类别的列宽 = 该类别事项所需宽度的**最大值**，下限 `minItemWidth`
   *         （保证时间不换行），上限 `maxCategoryWidth`（封顶，可调）；
   *       · 某天的列宽 = 该天**各构成类别列宽之和**；
   *       · 一周总宽 = 7 天列宽之和（可超过容器 → 由渲染层横向滚动）。
   *     未提供 measureWidth 时退回迭代 4 的等分权重口径（`widthWeight`）。
   *   - tooNarrow(occ, laneWidthPx) → boolean（迭代 8 / F-53）：给了就给每个 item 打
   *     `tooNarrow` 标记（渲染层据此加 `.is-tiny`）。**必须传真实像素宽**。
   * @returns {{columns: Array, height: number, pxPerHour: number, laneWidthWeightMax: number,
   *            totalWidth: number, anyContentWidth: boolean}}
   *   column = {iso, laneCount, laneHeight, widthWeight, widthPx, overflowCount, items}
   *   item   = {occ, categoryId, lane, left, width, top, height, laneOverflow?, overflowOffsetX?}
   *           left/width 为**列内百分比**；top/height 为像素。
   *           R-7：left = lane / laneCount × 100（**不含**溢出偏移，偏移由渲染层相加）
   *           迭代 8：给 measureWidth 时，left/width 按「该类别实际列宽占当天总宽的比例」算，
   *           故不同类别的列不再等分（用户裁定：按需占用）。
   */
  function layoutWeek(days, options) {
    var opts = options || {};
    var pxPerHour = numberOption(opts.pxPerHour, DEFAULT_PX_PER_HOUR);
    if (pxPerHour <= 0) { pxPerHour = DEFAULT_PX_PER_HOUR; }
    var lanesMax = numberOption(opts.lanesMax, DEFAULT_LANES_MAX);
    var laneCap = positiveIntOption(opts.laneCap, LANE_HARD_CAP);
    var laneHeight = numberOption(opts.laneHeight, DEFAULT_LANE_HEIGHT);
    var blockHeightMin = numberOption(opts.blockHeightMin, DEFAULT_BLOCK_HEIGHT_MIN);
    var gapY = numberOption(opts.gapY, DEFAULT_GAP_Y);
    var categoryOrder = opts.categoryOrder || [];
    var pinFirst = opts.pinFirst === undefined ? DEFAULT_PIN_FIRST : opts.pinFirst;
    var projectY = (typeof opts.projectY === 'function') ? opts.projectY : null;
    var measureWidth = (typeof opts.measureWidth === 'function') ? opts.measureWidth : null;
    /* 迭代 8（F-53）：tooNarrow(occ, laneWidthPx) → 该块折叠态是否「什么都不显示」
       （由渲染层注入 core/layout.js 的判定；本模块只负责给出真实像素宽） */
    var tooNarrowFn = (typeof opts.tooNarrow === 'function') ? opts.tooNarrow : null;
    /* 2026-10-20：omit(occ, laneWidthPx, laneHeightPx) → 该块「放不下标题，但放得下
       『…』+ 类别首字」→ 渲染层打 .is-omitted。与 tooNarrowFn 同为两级判定。 */
    var omitFn = (typeof opts.omit === 'function') ? opts.omit : null;
    var minItemWidth = numberOption(opts.minItemWidth, WEEK_DEFAULT_MIN_ITEM_WIDTH);
    var maxCategoryWidth = numberOption(opts.maxCategoryWidth, WEEK_DEFAULT_MAX_CATEGORY_WIDTH);
    numberOption(opts.columnCount, DEFAULT_COLUMN_COUNT); /* 契约占位：不参与纯几何 */

    var rate = pxPerHour / 60;
    /* 迭代 6（F-38）：给了 projectY + axisLength 就用折叠轴的高度；否则 = 整日 1:1（旧口径） */
    var axisLength = numberOption(opts.axisLength, NaN);
    var height = (isFinite(axisLength) && axisLength >= 0) ? axisLength : TOTAL_MINUTES * rate;

    /** 分钟 → 纵向像素：projectY 优先；缺省/非法值回落 `minute × rate`。 */
    function topOf(minute) {
      if (projectY) {
        var v = projectY(minute);
        if (typeof v === 'number' && isFinite(v)) { return v; }
      }
      return minute * rate;
    }

    var normalized = normalizeDays(days);
    var columns = [];
    var laneWidthWeightMax = lanesMax;
    var totalWidth = 0;

    for (var d = 0; d < normalized.length; d += 1) {
      var day = normalized[d];
      var occs = day.occurrences || [];

      /* 1) 合法时段 → block（保持输入序；非时段/非法不计入） */
      var blocks = [];
      for (var i = 0; i < occs.length; i += 1) {
        var occ = occs[i];
        var time = occ ? occ.time : null;
        if (!time) { continue; }
        var start = minutesOfTime(time.start, false);
        var end = minutesOfTime(time.end, true);
        if (start === null || end === null || end <= start) { continue; }
        var cid = (occ.categoryId === null || occ.categoryId === undefined) ? '' : String(occ.categoryId);
        /* index 为该 block 在**当天全局**的下标：分桶后仍按它回填道号（不能用品类内下标） */
        blocks.push({ occ: occ, categoryId: cid, start: start, end: end, index: blocks.length });
      }

      /* 2) 按 categoryId 分桶（桶内保持输入序；桶序见 DM-22.2a） */
      var buckets = {};
      var firstSeen = [];
      for (var b = 0; b < blocks.length; b += 1) {
        var key = blocks[b].categoryId;
        if (!hasOwn(buckets, key)) { buckets[key] = []; firstSeen.push(key); }
        buckets[key].push(blocks[b]);
      }
      var order = bucketOrder(buckets, firstSeen, categoryOrder, pinFirst);

      /* 3) 类别内贪心分道 → 全局道号按「类别序 → 该类别第 k 道」编号，超 laneCap 回落溢出 */
      var laneByIndex = [];
      var overflowByIndex = [];
      var usedLanes = 0;
      var overflowSeq = 0;
      for (var o = 0; o < order.length; o += 1) {
        var bucket = buckets[order[o]];
        var res = assignLanesWithinCategory(bucket);
        for (var k = 0; k < res.count; k += 1) {
          var globalLane = usedLanes + k;
          var overflowing = globalLane >= laneCap;
          for (var m = 0; m < bucket.length; m += 1) {
            if (res.lanes[m] !== k) { continue; }
            var blockIndex = bucket[m].index;
            if (overflowing) {
              overflowSeq += 1;
              laneByIndex[blockIndex] = laneCap - 1;
              overflowByIndex[blockIndex] = overflowSeq;
            } else {
              laneByIndex[blockIndex] = globalLane;
            }
          }
        }
        usedLanes += res.count;
      }

      var laneCount = Math.min(usedLanes, laneCap);
      var unit = laneCount > 0 ? 100 / laneCount : 0;

      /* 迭代 8（F-52）：按内容算各构成类别的列宽（像素），并记下每个类别的累计起点 */
      var laneCountByCat = {};
      if (measureWidth) {
        for (var q = 0; q < order.length; q += 1) {
          var qb = buckets[order[q]];
          var qres = assignLanesWithinCategory(qb);
          laneCountByCat[order[q]] = Math.max(1, Math.min(qres.count, laneCap));
        }
      }
      var catWidthPx = {};
      var catLeftPx = {};
      var cursorPx = 0;
      for (var s = 0; s < order.length; s += 1) {
        var sk = order[s];
        var wpx = 0;
        if (measureWidth) {
          var voted = 0;
          try { voted = Number(measureWidth(null, buckets[sk])) || 0; } catch (e) { voted = 0; }
          if (!isFinite(voted) || voted < 0) { voted = 0; }
          wpx = Math.min(Math.max(voted, minItemWidth), maxCategoryWidth);
        }
        catWidthPx[sk] = wpx;
        catLeftPx[sk] = cursorPx;
        cursorPx += wpx;
      }
      var dayWidthPx = cursorPx;   /* 该天总宽 = 各构成类别列宽之和 */

      /* 4) 输出（保持输入序） */
      var items = [];
      for (var n = 0; n < blocks.length; n += 1) {
        var lane = laneByIndex[n];
        if (lane === undefined) { continue; }
        /* 迭代 6（F-38）：top/height 与轴共用同一映射（projectY 缺省时 = start × rate） */
        var top = topOf(blocks[n].start);
        var rawHeight = topOf(blocks[n].end) - top;
        var item = {
          occ: blocks[n].occ,
          categoryId: blocks[n].categoryId,
          lane: lane,
          top: top,
          height: Math.max(rawHeight - gapY, blockHeightMin)
        };
        if (measureWidth && dayWidthPx > 0) {
          /* 迭代 8：left/width 是「列内百分比」，但按类别实际列宽换算 →
             不同类别的列按需占用，不再等分（用户裁定） */
          var cw = catWidthPx[blocks[n].categoryId] || 0;
          var lanesInCat = Math.max(1, laneCountByCat[blocks[n].categoryId] || 1);
          var laneInCat = Math.min(Number(lane) || 0, lanesInCat - 1);
          item.left = (catLeftPx[blocks[n].categoryId] + laneInCat * cw / lanesInCat) / dayWidthPx * 100;
          item.width = (cw / lanesInCat) / dayWidthPx * 100;
          /* 2026-10-21：块的**真实像素宽**（渲染层展开时按它挑按钮排布；百分比无法判断） */
          item.pxWidth = cw / lanesInCat;
        } else {
          /* R-7：纯净道内百分比；溢出偏移由渲染层用 overflowOffsetX 相加 */
          item.left = lane * unit;
          item.width = unit;
        }
        if (overflowByIndex[n] !== undefined) {
          item.laneOverflow = overflowByIndex[n];
          item.overflowOffsetX = overflowByIndex[n] * OVERFLOW_OFFSET_PERCENT;
        }
        /* 迭代 8（F-53）：窄/矮到「显示不完整」的块 → 渲染层只留色块（点击展开看全部）。
           判定必须用**真实像素**（宽 = 类别列宽 ÷ 道数；高 = item.height），
           绝不能用渲染层的 ctx.width（百分比）—— 曾因此把 220px 的大块误判为 2px。 */
        if ((tooNarrowFn || omitFn) && measureWidth && dayWidthPx > 0) {
          var laneWpx2 = (catWidthPx[blocks[n].categoryId] || 0) /
            Math.max(1, laneCountByCat[blocks[n].categoryId] || 1);
          if (tooNarrowFn) { item.tooNarrow = !!tooNarrowFn(blocks[n].occ, laneWpx2, item.height); }
          /* 省略态只在「不是微块」时成立（两级：微块什么都不显示） */
          if (omitFn && !item.tooNarrow) {
            item.omit = !!omitFn(blocks[n].occ, laneWpx2, item.height);
          }
        }
        items.push(item);
      }

      var widthWeight = Math.max(lanesMax, laneCount);
      if (widthWeight > laneWidthWeightMax) { laneWidthWeightMax = widthWeight; }
      if (dayWidthPx > 0) { totalWidth += dayWidthPx; }

      columns.push({
        iso: day.iso,
        laneCount: laneCount,
        /* 保留字段（DM-26 R-5）：周视图单道像素宽由 widthWeight + 列像素宽决定，
           本模块不参与纵向定位（纵向由 top/height 表达）。 */
        laneHeight: laneHeight,
        widthWeight: widthWeight,
        widthPx: dayWidthPx,
        overflowCount: overflowSeq,
        items: items
      });
    }

    return {
      columns: columns,
      height: height,
      pxPerHour: pxPerHour,
      laneWidthWeightMax: laneWidthWeightMax,
      /* 迭代 8（F-52）：一周总宽（= 7 天列宽之和），渲染层据此决定是否横向滚动 */
      totalWidth: totalWidth,
      anyContentWidth: !!measureWidth
    };
  }

  return {
    DEFAULT_PX_PER_HOUR: DEFAULT_PX_PER_HOUR,
    DEFAULT_LANES_MAX: DEFAULT_LANES_MAX,
    LANE_HARD_CAP: LANE_HARD_CAP,
    DEFAULT_LANE_HEIGHT: DEFAULT_LANE_HEIGHT,
    DEFAULT_BLOCK_HEIGHT_MIN: DEFAULT_BLOCK_HEIGHT_MIN,
    DEFAULT_GAP_Y: DEFAULT_GAP_Y,
    OVERFLOW_OFFSET_PERCENT: OVERFLOW_OFFSET_PERCENT,
    DEFAULT_PIN_FIRST: DEFAULT_PIN_FIRST,
    DEFAULT_COLUMN_COUNT: DEFAULT_COLUMN_COUNT,
    WEEK_DEFAULT_MIN_ITEM_WIDTH: WEEK_DEFAULT_MIN_ITEM_WIDTH,
    WEEK_DEFAULT_MAX_CATEGORY_WIDTH: WEEK_DEFAULT_MAX_CATEGORY_WIDTH,
    TOTAL_MINUTES: TOTAL_MINUTES,
    minutesOfTime: minutesOfTime,
    layoutWeek: layoutWeek
  };
});
