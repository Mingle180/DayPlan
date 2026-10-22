/**
 * DayPlan - src/core/layout.js
 * 类别行组 / 组内分道 / 空闲压缩轴（纯函数，零 DOM、零全局状态、零依赖）。
 *
 * 冻结契约：docs/spec/03-data-model.md DM-15（字段名与返回形状以此为准）
 * 算法来源：docs/spec/04-system-design.md §2.5 / §3.4
 * 功能来源：docs/spec/02-functional-spec.md F-16.1…F-16.5（BR-18 / BR-20）
 * 用例来源：docs/spec/05-test-and-verification.md §2.3 不变式 1…6、§3.5 LG-01…LG-18
 *
 * 同源要求：assignGroupedLanes 的分道算法与 src/views/timeline.js::assignLanes 语义一致
 * （§3.4 明确要求在 core/layout.js 内联一份，而不是 require views/timeline.js）。
 * 两处唯一的差别：本模块的 block.top = lane * options.laneHeight（组内坐标），
 * timeline 的 block.top = lane * 48 固定值。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.DayPlan = root.DayPlan || {}; root.DayPlan.layout = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ===== DM-15 常量 ===== */
  var MAX_LANE_HEIGHT_DEFAULT = 48; /* 每道高度 */
  var GROUP_GAP = 10;               /* 类别行组之间的纵向间距 */
  var COMPRESS_HEIGHT_DEFAULT = 26; /* 空闲窄带高度 */
  var CAT_LABEL_WIDTH = 34;         /* 左侧竖排类别名列宽 */
  var GROUP_LABEL_GAP = 6;          /* 类别名与时段区之间的水平间距 */

  /* ===== DM-15 options 默认值 ===== */
  var DEFAULT_PX_PER_HOUR = 96;      /* F-19：settings.dayPxPerHour 默认 96 */
  var DEFAULT_LANES_MAX = 3;
  var DEFAULT_LANE_HEIGHT = MAX_LANE_HEIGHT_DEFAULT;
  var DEFAULT_MIN_BLOCK_WIDTH = 12;  /* F-04.1 最小可点宽度 */
  var DEFAULT_GROUP_GAP = GROUP_GAP;
  var OVERFLOW_OFFSET_STEP = 8;      /* F-04.2 溢出块横向偏移步长 */
  var TOTAL_MINUTES = 1440;

  /* ===== DM-21（迭代 4）常量 ===== */
  var BLOCK_GAP = 6;                /* 块高 = laneHeight − BLOCK_GAP（BR-26） */
  var LABEL_CHAR_PX = 14;           /* categoryLabelMetrics：每字像素 */
  var LABEL_PAD_PX = 8;             /* categoryLabelMetrics：内边距 */
  var BLOCK_HEIGHT_MIN = 22;        /* 块高下限 */

  /* ===== 迭代 8（F-52）：块尺寸的内容度量常量（纯函数，零 DOM） ===== */
  var TEXT_UNIT_PX = 13;            /* 1 个单位 ≈ 13px：CJK/全角=1，ASCII=1/2 */
  var BLOCK_LINE_PX = 17;           /* 一行文本占用的纵向像素（含行高） */
  var BLOCK_PAD_Y = 8;              /* 块上下内边距合计（真实 CSS：3+3，这里留余量） */
  var BLOCK_PAD_X = 14;             /* 块左右内边距合计（真实 CSS：7+8） */
  var BLOCK_NOTE_GAP = 2;           /* 标题与备注之间的间隙 */
  /* 时间不换行的下限：中文数字 + en dash 的实测宽度（"10:10–12:00" ≈ 66px） */
  var WEEK_MIN_ITEM_WIDTH = 74;
  /* 单个类别的最大列宽（用户裁定：上限封顶，可调） */
  var WEEK_CATEGORY_MAX_WIDTH = 320;
  /* 美化迭代 10：标题右侧的类别胶囊（真实 CSS：padding 3px 7px + 与标题的 gap 8px） */
  var CHIP_PAD_X = 14;
  var CHIP_GAP = 8;
  /* 2026-10-20（用户反馈）：胶囊改成**绝对定位**后，标题行只靠 padding-right 让位，
     实际值见 styles/app.css `.tl-block .tl-titlerow{padding-right:22px}` 与
     `.tl-block.is-narrow .tl-titlerow{padding-right:14px}`。度量必须与 CSS 同源，
     否则标题会多算 1–3 行、块高虚高。
     （2026-10-20：窄档 17 → 14 —— 17px 时 45px 宽的块标题只剩 20px，
       11px 的字只放得下 1 个，「每个字后面都有空间却一字一行」。）
     NARROW_BLOCK_PX 与 ui/itemcard.js 的窄块阈值是同一个数（那边引用本常量）。 */
  var NARROW_BLOCK_PX = 72;
  var TITLE_RESERVE = 22;
  var TITLE_RESERVE_NARROW = 14;

  /* ===== 2026-10-20：窄档的文字度量（与 CSS 同源）=====
   * 窄块（< NARROW_BLOCK_PX）在 CSS 里换了一整套排版：`.tl-block.is-narrow{padding:0 4px}`
   * + `.is-narrow .tl-title{font-size:11px}`。度量若仍用普通档的 13px / 14px 内边距，
   * 一条 45px 宽、6 个字的标题会被算成 6 行（真实 3 行），块高虚高一倍 ——
   * 上一轮「用了不必要的高度」的另一半根因就在这里。 */
  var BLOCK_PAD_X_NARROW = 8;      /* 真实 CSS：padding 0 4px */
  var TEXT_UNIT_NARROW = 11;       /* 真实 CSS：.is-narrow .tl-title{font-size:11px} */

  /* ===== 2026-10-20：块内容三级可见度（用户裁定）=====
   *   full    放得下时间/标题 → 全显示
   *   omit    放不下标题 → **保留类别首字胶囊 + 一个省略号**
   *   small   连「…」+ 首字都放不下 → 折叠态什么都不显示（点击/悬停才展开）
   * BLOCK_OMIT_MIN_W：「…」（约 10px）+ 首字胶囊（约 16px）+ 左右内边距（4px）≈ 34px。
   *   —— 这是「整体调整时间轴宽/高，让省略号一定放得下」的口径：块宽不足此值也按此值渲染。
   * BLOCK_SMALL_MIN_W：低于此值就不值得撑开（会与相邻块明显重叠）→ 归入 small。 */
  var BLOCK_OMIT_MIN_W = 34;
  var BLOCK_SMALL_MIN_W = 17;

  /* DM-2 的合法时间；「24:00」只在作为 end 时被容忍（见 minutesOfTime 注释）。 */
  var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  /** 取带默认值的数字选项。 */
  function numberOption(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback;
  }

  /** 取正数选项（< 1 时回落为 1）。 */
  function positiveIntOption(value, fallback) {
    var n = Math.floor(numberOption(value, fallback));
    return n < 1 ? 1 : n;
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** 归一化 pinFirst：字符串 / 数组 / 缺省 → 类别 id 数组（缺省为空）。 */
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
   * "HH:mm" → 当日分钟数。
   * DM-2 的合法时间不含 24:00，但 LG-15 要求「末事项 24:00 结束 → trailHeight === 0」，
   * 故 end 位置额外容忍字面量 "24:00"（= 1440）；start 位置不接受。
   * @param {*} value
   * @param {boolean} allowEndOfDay 是否把 "24:00" 视作 1440
   * @returns {number|null} 0..1440；非法返回 null
   */
  function minutesOfTime(value, allowEndOfDay) {
    if (typeof value !== 'string') { return null; }
    if (allowEndOfDay && value === '24:00') { return TOTAL_MINUTES; }
    var m = TIME_RE.exec(value);
    if (!m) { return null; }
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /**
   * 贪心分道（与 src/views/timeline.js::assignLanes 同源的决策表）：
   * 按 start 升序 → end 降序 → occ.order 升序 → occ.key 升序 → 输入下标升序 依次尝试放入
   * 第一条满足 lastEnd <= start 的道（闭区间边界：10:00 结束与 10:00 开始同一条道）；
   * 若已有 lanesMax 条道都放不下，则并入第 lanesMax 道并记溢出序号。
   *
   * @param {Array} blocks [{occ, start, end}]（不修改入参）
   * @param {number} lanesMax
   * @returns {{lanes: Array<number>, overflows: Array<number>, count: number}}
   *   lanes/overflows 为「按输入下标」的稀疏数组
   */
  function greedyAssignLanes(blocks, lanesMax) {
    var src = blocks || [];
    var max = positiveIntOption(lanesMax, DEFAULT_LANES_MAX);

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
    var overflows = [];
    var overflowSeq = 0;

    for (var p = 0; p < positions.length; p += 1) {
      var entry = positions[p];
      var block = entry.block || {};
      var start = block.start;
      var lane = -1;

      for (var L2 = 0; L2 < lastEnds.length; L2 += 1) {
        if (lastEnds[L2] <= start) { lane = L2; break; }
      }

      if (lane === -1 && lastEnds.length < max) {
        lane = lastEnds.length;
        lastEnds.push(block.end);
      } else if (lane === -1) {
        lane = max - 1;
        lastEnds[lane] = block.end;
        overflowSeq += 1;
        overflows[entry.index] = overflowSeq;
      } else {
        lastEnds[lane] = block.end;
      }

      lanes[entry.index] = lane;
    }

    return { lanes: lanes, overflows: overflows, count: lastEnds.length };
  }

  /**
   * 把当日的时段 occurrence 转成待分道的块（跳过缺字段 / 非法 / end <= start 的条目）。
   * @param {Array} occurrences
   * @param {number} pxPerHour
   * @param {number} minBlockWidth
   * @param {Function} [projectX] 分钟 → 像素（DM-21.6；给了就用它，否则用 start × pxPerHour/60）
   * @returns {Array<{occ, left, width, start, end}>}
   */
  function buildBlocks(occurrences, pxPerHour, minBlockWidth, projectX) {
    var rate = pxPerHour / 60;
    var project = (typeof projectX === 'function') ? projectX : null;
    var out = [];
    var src = occurrences || [];
    for (var i = 0; i < src.length; i += 1) {
      var occ = src[i];
      var time = occ ? occ.time : null;
      if (!time) { continue; }
      var start = minutesOfTime(time.start, false);
      var end = minutesOfTime(time.end, true);
      if (start === null || end === null || end <= start) { continue; }
      var left;
      var width;
      if (project) {
        /* BR-35：横向坐标唯一来源 = projectX（computeAxisGeometry 的 getX） */
        left = project(start);
        width = Math.max(project(end) - project(start), minBlockWidth);
      } else {
        left = start * rate;
        width = Math.max((end - start) * rate, minBlockWidth);
      }
      if (typeof left !== 'number' || !isFinite(left)) { left = start * rate; }
      if (typeof width !== 'number' || !isFinite(width)) { width = minBlockWidth; }
      out.push({
        occ: occ,
        left: left,
        width: width,
        start: start,
        end: end
      });
    }
    return out;
  }

  /**
   * 按 categoryId 分桶并排序（DM-15 / DM-21.5 / F-16.1 / BR-29 / 不变式 6）。
   * 输出顺序：`pinFirst` 命中的类别（且存在于 items 中）→ categoryOrder 命中顺序 →
   * 「categoryOrder 中不存在的类别」按首次出现顺序；空桶不出现。
   *
   * @param {Array} occurrences
   * @param {Array<string>} categoryOrder 已按 DM-3 次序排好的类别 id 数组
   * @param {Object} [options] {pinFirst} 需置顶的类别 id（字符串或数组；缺省 = 不置顶）
   * @returns {Array<{categoryId: string, items: Array}>}
   */
  function layoutDayGroups(occurrences, categoryOrder, options) {
    var src = occurrences || [];
    var buckets = {};
    var firstSeen = [];

    for (var i = 0; i < src.length; i += 1) {
      var occ = src[i];
      if (!occ) { continue; }
      var cid = (occ.categoryId === null || occ.categoryId === undefined) ? '' : String(occ.categoryId);
      if (!hasOwn(buckets, cid)) {
        buckets[cid] = [];
        firstSeen.push(cid);
      }
      buckets[cid].push(occ);
    }

    var used = {};
    var out = [];

    /* 1) pinFirst 命中且存在于 items 中 → 最前（BR-29 / AC-27.4） */
    var pins = pinList(options ? options.pinFirst : undefined);
    for (var p = 0; p < pins.length; p += 1) {
      if (used[pins[p]] || !hasOwn(buckets, pins[p])) { continue; }
      used[pins[p]] = true;
      out.push({ categoryId: pins[p], items: buckets[pins[p]] });
    }

    /* 2) categoryOrder 命中顺序（迭代 3 旧口径） */
    var order = categoryOrder || [];
    for (var k = 0; k < order.length; k += 1) {
      var key = (order[k] === null || order[k] === undefined) ? '' : String(order[k]);
      if (used[key] || !hasOwn(buckets, key)) { continue; }
      used[key] = true;
      out.push({ categoryId: key, items: buckets[key] });
    }

    /* 3) 其余按首次出现顺序 */
    for (var f = 0; f < firstSeen.length; f += 1) {
      var extra = firstSeen[f];
      if (used[extra]) { continue; }
      used[extra] = true;
      out.push({ categoryId: extra, items: buckets[extra] });
    }
    return out;
  }

  /**
   * 行组内分道 + 组间纵向排布（DM-15 / DM-21.6 / §3.4）。
   *
   * @param {Array} groups [{categoryId, items: occurrences}]
   * @param {Object} [options] {pxPerHour=96, lanesMax=3, laneHeight=48, laneHeightFor,
   *                            minBlockWidth=12, groupGap=10, projectX}
   *   - laneHeightFor(categoryId) → 该组车道高（BR-26）；缺省或返回非法值时用 laneHeight
   *   - projectX(minute) → 横向像素（BR-35）；给了就用它算 left/width
   * @returns {{groups: Array, height: number}}
   *   group = {categoryId, top, height, laneHeight, laneCount, items: [block]}
   *   block = {occ, left, width, lane, top, laneOverflow?, overflowOffsetX?}
   *           block.top 为组内坐标（= lane × 该组 laneHeight，**与开始时间无关**）
   */
  function assignGroupedLanes(groups, options) {
    var opts = options || {};
    var pxPerHour = numberOption(opts.pxPerHour, DEFAULT_PX_PER_HOUR);
    var lanesMax = numberOption(opts.lanesMax, DEFAULT_LANES_MAX);
    var laneHeight = numberOption(opts.laneHeight, DEFAULT_LANE_HEIGHT);
    var minBlockWidth = numberOption(opts.minBlockWidth, DEFAULT_MIN_BLOCK_WIDTH);
    var groupGap = numberOption(opts.groupGap, DEFAULT_GROUP_GAP);
    var laneHeightFor = (typeof opts.laneHeightFor === 'function') ? opts.laneHeightFor : null;
    var projectX = (typeof opts.projectX === 'function') ? opts.projectX : null;

    var src = groups || [];
    var outGroups = [];
    var y = 0;

    for (var g = 0; g < src.length; g += 1) {
      var group = src[g] || {};
      var groupLaneHeight = laneHeight;
      if (laneHeightFor) {
        var resolved = laneHeightFor(group.categoryId);
        if (typeof resolved === 'number' && isFinite(resolved) && resolved > 0) { groupLaneHeight = resolved; }
      }
      var blocks = buildBlocks(group.items, pxPerHour, minBlockWidth, projectX);
      var assigned = greedyAssignLanes(blocks, lanesMax);
      var laneCount = assigned.count > 0 ? assigned.count : 1; /* max(1, laneCount) */
      var height = laneCount * groupLaneHeight;

      if (y > 0) { y += groupGap; }
      var top = y;

      var items = [];
      for (var b = 0; b < blocks.length; b += 1) {
        var block = blocks[b];
        var lane = assigned.lanes[b];
        if (lane === undefined) { continue; }
        var item = {
          occ: block.occ,
          left: block.left,
          width: block.width,
          lane: lane,
          top: lane * groupLaneHeight
        };
        if (assigned.overflows[b] !== undefined) {
          item.laneOverflow = assigned.overflows[b];
          item.overflowOffsetX = assigned.overflows[b] * OVERFLOW_OFFSET_STEP;
        }
        items.push(item);
      }

      y = top + height;
      outGroups.push({
        categoryId: group.categoryId,
        top: top,
        height: height,
        laneHeight: groupLaneHeight,
        laneCount: laneCount,
        items: items
      });
    }

    return { groups: outGroups, height: y };
  }

  /**
   * 空闲压缩轴几何（DM-15 / F-16.4 / §3.4）。
   *
   * @param {Array} occurrences
   * @param {Object} [options] {pxPerHour=96, compressHeight=26, compressible=true}
   * @returns {null|{firstStart, lastEnd, leadHeight, trailHeight, realHeight, totalHeight,
   *                 getY: function, toAxisY: function}}
   *   toAxisY 是 F-16.4/F-16.5 使用的别名，与 getY 指向同一个函数（DM-15 只定义 getY）。
   *   occurrences 为空或无合法时段（缺 time / 非法格式 / end <= start）→ 返回 null。
   *   compressible === false 时实比例区 = 整个 [0, 1440]，故 firstStart = 0、lastEnd = 1440
   *   （此时它们表示「实比例区边界」而非「事项跨度」）。
   */
  function computeAxisGeometry(occurrences, options) {
    var opts = options || {};
    var pxPerHour = numberOption(opts.pxPerHour, DEFAULT_PX_PER_HOUR);
    var compressHeight = numberOption(opts.compressHeight, COMPRESS_HEIGHT_DEFAULT);
    var compressible = opts.compressible === undefined ? true : !!opts.compressible;

    var src = occurrences || [];
    var firstStart = null;
    var lastEnd = null;
    for (var i = 0; i < src.length; i += 1) {
      var time = src[i] ? src[i].time : null;
      if (!time) { continue; }
      var start = minutesOfTime(time.start, false);
      var end = minutesOfTime(time.end, true);
      if (start === null || end === null || end <= start) { continue; }
      if (firstStart === null || start < firstStart) { firstStart = start; }
      if (lastEnd === null || end > lastEnd) { lastEnd = end; }
    }
    if (firstStart === null) { return null; }

    var rate = pxPerHour / 60;

    /* 关闭紧凑（F-16.4 / §3.4 性质 4 / §2.3 不变式 4 / LG-16）：
     * 整日纯实比例 → 实比例区扩大为 [0, 1440]。
     * 这是唯一能同时满足下列全部条款的读法：
     *   - LG-16 / §3.4 性质 4：compressible=false ⇒ totalHeight === 1440 * rate；
     *   - DM-15 分支语义：minute ≤ firstStart 且 leadHeight===0 ⇒ 返回 0；
     *   - DM-15 端点不变式：getY(firstStart) === leadHeight、getY(lastEnd) === leadHeight + realHeight；
     *   - §2.3 不变式 3：实比例区内 getY(b) - getY(a) === (b - a) * rate。
     * 若仍把 firstStart/lastEnd 记为 min(start)/max(end)，则 getY(firstStart) 恒为 0，
     * 与「纯实比例」及 totalHeight === 1440 * rate 自相矛盾（详见交付汇报的冲突说明）。 */
    if (!compressible) {
      firstStart = 0;
      lastEnd = TOTAL_MINUTES;
    }

    var leadHeight = (compressible && firstStart > 0) ? compressHeight : 0;
    var trailHeight = (compressible && lastEnd < TOTAL_MINUTES) ? compressHeight : 0;
    var realHeight = (lastEnd - firstStart) * rate;
    var totalHeight = leadHeight + realHeight + trailHeight;

    /**
     * 分钟 → 纵向像素。
     * minute <= firstStart → [0, leadHeight]；firstStart < minute <= lastEnd → 实比例；
     * minute > lastEnd → 线性映射到 [0, trailHeight]。
     */
    function getY(minute) {
      if (minute <= firstStart) {
        return leadHeight === 0 ? 0 : minute / firstStart * leadHeight;
      }
      if (minute <= lastEnd) {
        return leadHeight + (minute - firstStart) * rate;
      }
      if (trailHeight === 0) { return leadHeight + realHeight; }
      return leadHeight + realHeight + (minute - lastEnd) / (TOTAL_MINUTES - lastEnd) * trailHeight;
    }

    return {
      firstStart: firstStart,
      lastEnd: lastEnd,
      leadHeight: leadHeight,
      trailHeight: trailHeight,
      realHeight: realHeight,
      totalHeight: totalHeight,
      getY: getY,
      toAxisY: getY,
      /* ===== DM-21.1（迭代 4）v0.4 别名：与旧字段同值、同函数（BR-35）===== */
      leadLength: leadHeight,
      trailLength: trailHeight,
      realLength: realHeight,
      axisLength: totalHeight,
      getX: getY,
      toAxisX: getY
    };
  }

  /**
   * 刻度契约（DM-15 / DM-21.2）：整点（或任意步长）刻度及其是否落在压缩区。
   * 渲染层对 outside === true 的刻度不绘制竖线，只在窄带上画折断标记。
   * pos === y（迭代 4 起横轴语义命名；y 保留兼容）。
   *
   * @param {Object|null} geometry computeAxisGeometry 的返回值
   * @param {Object} [options] {stepMinutes=60}
   * @returns {Array<{minute: number, y: number, pos: number, outside: boolean}>}
   *   无几何（null / 缺 getY）→ 返回空数组。
   */
  function axisTicks(geometry, options) {
    var opts = options || {};
    var step = positiveIntOption(opts.stepMinutes, 60);
    if (!geometry || typeof geometry.getY !== 'function') { return []; }

    var firstStart = numberOption(geometry.firstStart, 0);
    var lastEnd = numberOption(geometry.lastEnd, TOTAL_MINUTES);
    var leadCompressed = numberOption(geometry.leadHeight, 0) > 0;
    var trailCompressed = numberOption(geometry.trailHeight, 0) > 0;

    var out = [];
    for (var minute = 0; minute <= TOTAL_MINUTES; minute += step) {
      var outside;
      if (minute < firstStart) { outside = leadCompressed; }
      else if (minute > lastEnd) { outside = trailCompressed; }
      else { outside = false; }
      var y = geometry.getY(minute);
      out.push({ minute: minute, y: y, pos: y, outside: outside });
    }
    return out;
  }

  /**
   * 首末空闲窄带（DM-21.3 / AC-25.3）：迭代 4 的横向轴里它是**竖直**窄带。
   * 无几何或某段长度为 0 → 该项不出现；lead.start = 0、trail.start = leadLength + realLength。
   *
   * @param {Object|null} geometry
   * @returns {Array<{kind: "lead"|"trail", start: number, length: number,
   *                  fromMinute: number, toMinute: number}>}
   */
  function axisIdleBands(geometry) {
    if (!geometry) { return []; }
    var lead = numberOption(geometry.leadLength, numberOption(geometry.leadHeight, 0));
    var trail = numberOption(geometry.trailLength, numberOption(geometry.trailHeight, 0));
    var real = numberOption(geometry.realLength, numberOption(geometry.realHeight, 0));

    var out = [];
    if (lead > 0) {
      out.push({
        kind: 'lead',
        start: 0,
        length: lead,
        fromMinute: 0,
        toMinute: numberOption(geometry.firstStart, 0)
      });
    }
    if (trail > 0) {
      out.push({
        kind: 'trail',
        start: lead + real,
        length: trail,
        fromMinute: numberOption(geometry.lastEnd, TOTAL_MINUTES),
        toMinute: TOTAL_MINUTES
      });
    }
    return out;
  }

  /**
   * 类别名排版的纯函数度量（DM-21.4 / BR-26 / ADR-21）。
   * 竖排文本：CJK/全角/其它记 1 个单位，ASCII(0x20–0x7E) 记 0.5；
   * height = max(min, ceil(units × charPx) + padPx) —— 供日视图行组车道高使用。
   *
   * @param {*} name 类别名（非字符串按 String() 容错；null/undefined 视作空串）
   * @param {Object} [options] {charPx=14, padPx=8, min=48}
   * @returns {{units: number, height: number}}
   */
  function categoryLabelMetrics(name, options) {
    var opts = options || {};
    var charPx = numberOption(opts.charPx, LABEL_CHAR_PX);
    var padPx = numberOption(opts.padPx, LABEL_PAD_PX);
    var min = numberOption(opts.min, MAX_LANE_HEIGHT_DEFAULT);
    var text = (name === null || name === undefined) ? '' : String(name);

    var units = 0;
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      /* 代理对（emoji / CJK 扩展 B 等）按 1 个字符计 */
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
        var low = text.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          units += 1;
          i += 1;
          continue;
        }
      }
      units += (code >= 0x20 && code <= 0x7E) ? 0.5 : 1;
    }
    return { units: units, height: Math.max(min, Math.ceil(units * charPx) + padPx) };
  }

  /* ================================================================== *
   * 迭代 8（F-52）：事项块的「内容需要多大」度量（纯函数）
   * 目的：块高（日视图）/ 块宽（周视图）由内容决定，而不是由时长或等分列宽决定。
   * 口径：CJK/全角/其它记 1 个单位、ASCII(0x20–0x7E) 记 0.5 个单位，1 个单位 ≈ 13px
   *       （与 categoryLabelMetrics 同一套单位口径，便于人眼核对）。
   * ================================================================== */

  /**
   * 文本度量：单位宽度 + 单行像素宽。
   * @param {*} value 任意值（按 String() 容错；null/undefined 视作空串）
   * @param {{unitPx?:number}} [options]
   * @returns {{units:number, width:number, empty:boolean}}
   */
  function textMetrics(value, options) {
    var opts = options || {};
    var unitPx = numberOption(opts.unitPx, TEXT_UNIT_PX);
    var text = (value === null || value === undefined) ? '' : String(value);
    var units = 0;
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
        var low = text.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) { units += 1; i += 1; continue; }
      }
      units += (code >= 0x20 && code <= 0x7E) ? 0.5 : 1;
    }
    return { units: units, width: units * unitPx, empty: text.length === 0 };
  }

  /** "HH:mm"–"HH:mm" 的时间行文本（与 ui/itemcard.js::timeText 同形）。 */
  function itemTimeText(occ) {
    var t = occ ? occ.time : null;
    if (!t) { return ''; }
    return String(t.start === null || t.start === undefined ? '' : t.start) + '–' +
      String(t.end === null || t.end === undefined ? '' : t.end);
  }

  /**
   * 一个事项块完整显示所需的最小宽度（**不含备注**）。
   * 备注用于换行填充，不应把列宽/块宽无限拉宽（用户裁定：周视图列宽上限封顶）。
   * 美化迭代 10：opts.chipWidth = 标题右侧类别胶囊的占位宽（标题行一行放下 = 标题 + 胶囊）。
   * @param {object} occ
   * @param {{unitPx?:number, padX?:number, chipWidth?:number}} [options]
   * @returns {number} 像素宽（已含左右内边距）
   */
  function blockWidthNeed(occ, options) {
    var opts = options || {};
    var padX = numberOption(opts.padX, BLOCK_PAD_X);
    var chipWidth = Math.max(0, numberOption(opts.chipWidth, 0));
    var t = textMetrics(itemTimeText(occ), opts);
    var title = textMetrics(occ ? occ.title : '', opts);
    return Math.ceil(Math.max(t.width, title.width + chipWidth) + padX);
  }

  /**
   * 迭代 8（F-53）：块是否窄到「什么都不显示」。
   * 用户量化口径：**日视图**一行放不下 2 个汉字（= 2 个文本单位）→ 隐藏内容；
   * **周视图**放不下时间行（或标题）→ 隐藏内容。两种情况都改为「点击后显示全部」。
   * @param {number} width 块的可用宽度（像素，含内边距）
   * @param {number} minUnits 最少需要放下的文本单位数（日视图 = 2）
   * @param {object} [options] {unitPx?, padX?, timeWidth?, titleWidth?}
   * @returns {boolean}
   */
  function isBlockTooNarrow(width, minUnits, options) {
    var opts = options || {};
    var unitPx = numberOption(opts.unitPx, TEXT_UNIT_PX);
    var padX = numberOption(opts.padX, BLOCK_PAD_X);
    /* 宽度不可用时**判为不窄**（调用方在拿不到宽度时不该隐藏内容） */
    if (typeof width !== 'number' || !isFinite(width)) { return false; }
    var avail = width - padX;
    if (!(avail > 0)) { return true; }
    var floorPx = Math.max(0, numberOption(minUnits, 2)) * unitPx;
    if (avail < floorPx) { return true; }
    if (opts.timeWidth !== undefined && avail < numberOption(opts.timeWidth, 0)) { return true; }
    if (opts.titleWidth !== undefined && avail < numberOption(opts.titleWidth, 0)) { return true; }
    return false;
  }

  /** 日视图口径：一行放不下 2 个汉字 → 太窄。 */
  function isDayBlockTooNarrow(width, options) {
    return isBlockTooNarrow(width, 2, options);
  }

  /**
   * 周视图口径（迭代 8 / F-53 修正二）：**放不完整**就省略，两种情况：
   *   1) 宽度放不下时间行或标题（用户量化）；
   *   2) 高度放不下「时间行 + 标题行」（用户实测：09:00–09:05 这种块宽够一行时间、
   *      但高度只够一行，标题被裁掉半截 —— 也应改为只留色块）。
   * 美化迭代 10：标题行放不下「标题+胶囊」时，周视图**隐藏胶囊**（渲染层判定），
   * 标题保持单行 → 本判定口径不变（时间行 + 标题行 = 2 行）。
   * @param {object} occ
   * @param {number} width 块的真实像素宽
   * @param {number} [height] 块的真实像素高（缺省或非数时只看宽度）
   * @param {object} [options]
   * @returns {boolean}
   */
  function isWeekBlockTooNarrow(occ, width, height, options) {
    var opts = options || {};
    var t = textMetrics(itemTimeText(occ), opts);
    var title = textMetrics(occ ? occ.title : '', opts);
    var tooNarrow = isBlockTooNarrow(width, 2, {
      unitPx: opts.unitPx,
      padX: opts.padX,
      timeWidth: t.width,
      titleWidth: title.width
    });
    if (tooNarrow) { return true; }
    if (typeof height === 'number' && isFinite(height) && height > 0) {
      var padY = numberOption(opts.padY, BLOCK_PAD_Y);
      var linePx = numberOption(opts.linePx, BLOCK_LINE_PX);
      if (height - padY < 2 * linePx) { return true; }   /* 容不下时间行 + 标题行 */
    }
    return false;
  }

  /**
   * 2026-10-20（用户裁定）：日视图「连『…』+ 类别首字都放不下」→ 折叠态什么都不显示。
   * 与 `isDayBlockTooNarrow` 的分工：
   *   - `isDayBlockTooNarrow`（放不下标题）→ 渲染成**省略号 + 首字胶囊**（.is-omitted）
   *   - 本函数（更窄，低于 BLOCK_SMALL_MIN_W）→ 真·微块（.is-tiny，只剩色块）
   * 宽度非数时判 false（拿不到宽度不该隐藏内容）。
   * @param {number} width
   * @returns {boolean}
   */
  function isDayBlockTooSmall(width) {
    if (typeof width !== 'number' || !isFinite(width)) { return false; }
    return width < BLOCK_SMALL_MIN_W;
  }

  /**
   * 2026-10-20（用户裁定）：周视图「连『…』+ 类别首字都放不下」→ 折叠态什么都不显示。
   * 需要**一行**的空间即可（省略号与首字胶囊同在一行），
   * 比 `isWeekBlockTooNarrow`（要求「时间行 + 标题行」两行）低一档。
   * @param {object} occ
   * @param {number} width 真实像素宽
   * @param {number} [height] 真实像素高
   * @param {object} [options]
   * @returns {boolean}
   */
  function isWeekBlockTooSmall(occ, width, height, options) {
    var opts = options || {};
    var padX = numberOption(opts.padX, BLOCK_PAD_X);
    var padY = numberOption(opts.padY, BLOCK_PAD_Y);
    /* 放不下「…」+ 一个汉字（两者同一行，约 20px 内容宽） */
    if (typeof width === 'number' && isFinite(width) && width - padX < 20) { return true; }
    /* 连**一行**都放不下（省略态只需一行：胶囊高约 11px + 上下内边距） */
    if (typeof height === 'number' && isFinite(height) && height > 0 && height - padY < 12) {
      return true;
    }
    return false;
  }

  /**
   * 美化迭代 10：标题右侧类别胶囊的占位宽度（含水平内边距 + 与标题的间隙）。
   * @param {string} name 类别名
   * @param {{unitPx?:number, padX?:number, gap?:number}} [options]
   * @returns {number} 像素宽
   */
  function chipWidthFor(name, options) {
    var opts = options || {};
    var padX = numberOption(opts.padX, CHIP_PAD_X);
    var gap = numberOption(opts.gap, CHIP_GAP);
    return Math.ceil(textMetrics(name, opts).width + padX + gap);
  }

  /**
   * 2026-10-20（用户反馈）：标题行为了给右上角的胶囊**实际**让出多少宽度。
   *
   * `chipWidthFor` 算的是「胶囊自身占多宽」（首字 + 内边距 + 间隙 ≈ 35px），
   * 但胶囊已经改成绝对定位钉在右上角，标题行只靠 `padding-right` 让位 ——
   * CSS 里是 **22px（普通）/ 17px（窄块）**。拿 35px 当标题可用宽的扣减，
   * 会让标题多算 1–3 行，块高虚高一大截（用户看到的「用了不必要的高度」）。
   * 度量必须与 CSS 对齐，所以这里按档位返回真实让位宽度。
   * @param {number} [width] 块宽（像素；不可用时按普通档）
   * @returns {number} 像素宽
   */
  function titleChipReserve(width) {
    if (typeof width === 'number' && isFinite(width) && width > 0 && width < NARROW_BLOCK_PX) {
      return TITLE_RESERVE_NARROW;
    }
    return TITLE_RESERVE;
  }

  /**
   * 2026-10-20：按**宽度档位**给出块内文字度量（单一来源，视图层不许再各写一套）。
   * 块高、道高、时间行数、时间显隐四处都必须用这一份，否则同一条块会出现
   * 「渲染 3 行、按 6 行算高」这种虚高（用户反馈的「一个字一行 + 用了不必要的高度」）。
   * @param {number} width 块宽（像素；非数时按普通档）
   * @returns {{unitPx:number, padX:number, chipWidth:number}}
   */
  function blockMetricOpts(width) {
    var narrow = (typeof width === 'number' && isFinite(width) && width > 0 && width < NARROW_BLOCK_PX);
    if (narrow) {
      /* 2026-10-20 三轮补（用户反馈「标题每个字后面都有空间，却一个字一行」）：
         窄块的胶囊只在**首行**右侧占位（CSS 用 float 实现），后续行铺满块宽。
         度量必须跟着改，否则按「每行都让 14px」算高会虚高一倍。 */
      return {
        unitPx: TEXT_UNIT_NARROW, padX: BLOCK_PAD_X_NARROW,
        chipWidth: titleChipReserve(width), chipFirstLineOnly: true
      };
    }
    return { unitPx: TEXT_UNIT_PX, padX: BLOCK_PAD_X, chipWidth: titleChipReserve(width) };
  }

  /**
   * 在给定可用宽度下，一个事项块完整显示所需的最小高度。
   * 组成：时间行 + 标题行（美化迭代 10：标题不省略，放不下按宽度换行，可占多行）
   *       + 备注行数（按宽度自然换行）。标题行右侧留给类别胶囊（opts.chipWidth）。
   * @param {object} occ
   * @param {number} width 可用宽度（像素，含内边距；≤0 或非数时返回单行高度）
   * @param {{unitPx?:number, linePx?:number, padY?:number, padX?:number, noteGap?:number,
   *          chipWidth?:number, timeLines?:number, chipFirstLineOnly?:boolean}} [options]
   *   · chipFirstLineOnly：胶囊只在**首行**让位（窄块用 float 实现），后续行铺满宽度。
   *     不传时保持旧口径（每行都让位），普通块仍走这一套。
   * @returns {number} 像素高
   */
  function blockHeightNeed(occ, width, options) {
    var opts = options || {};
    var unitPx = numberOption(opts.unitPx, TEXT_UNIT_PX);
    var linePx = numberOption(opts.linePx, BLOCK_LINE_PX);
    var padY = numberOption(opts.padY, BLOCK_PAD_Y);
    var padX = numberOption(opts.padX, BLOCK_PAD_X);
    var noteGap = numberOption(opts.noteGap, BLOCK_NOTE_GAP);
    var chipWidth = Math.max(0, numberOption(opts.chipWidth, 0));

    /* 2026-10-20：时间行在窄块里会换行，行数由 timeLineCount 给定（默认 1 行） */
    var lines = Math.max(1, numberOption(opts.timeLines, 1));
    var title = textMetrics(occ ? occ.title : '', opts);
    var titleAvail = width - padX;
    var perFull = titleAvail > 0 ? Math.max(1, Math.floor(titleAvail / unitPx)) : 1;
    var perTitle = perFull;
    if (chipWidth > 0) {
      var afterChip = titleAvail - chipWidth;
      perTitle = afterChip > 0 ? Math.max(1, Math.floor(afterChip / unitPx)) : 1;
    }
    if (opts.chipFirstLineOnly && perTitle !== perFull) {
      /* 首行短、其余行满宽：首行先吃掉 perTitle 个字，剩下的按 perFull 排。
         7 字 / 43px 块（可用 35、让位 14）：旧口径 7 行，新口径 1 + ⌈6/3⌉ = 3 行。 */
      lines += (title.units <= perTitle)
        ? 1
        : 1 + Math.ceil((title.units - perTitle) / perFull);
    } else {
      lines += Math.max(1, Math.ceil(title.units / perTitle));   /* 标题可多行（不省略） */
    }
    var note = textMetrics(occ ? occ.note : '', opts);
    if (!note.empty) {
      var avail = width - padX;
      var perLine = avail > 0 ? Math.max(1, Math.floor(avail / unitPx)) : 1;
      lines += Math.max(1, Math.ceil(note.units / perLine));
      lines += (noteGap > 0 ? 1 : 0);                /* 备注与标题的间隙按半行计 */
    }
    return Math.ceil(lines * linePx + padY);
  }

  /**
   * 2026-10-20（用户反馈）：时间行在给定块宽下会占几行。
   * "09:00–09:40" 在 40px 宽的块里放不进一行，会断成两行；度量必须按真实行数算，
   * 否则「块高按 1 行算、显示时按 2 行排」→ 要么裁字，要么留白。
   * @param {object} occ
   * @param {number} width 块宽（像素）
   * @param {object} [options] {unitPx?, padX?}
   * @returns {number} 行数（≥1；宽度不可用时返回 1）
   */
  function timeLineCount(occ, width, options) {
    var opts = options || {};
    if (typeof width !== 'number' || !isFinite(width) || width <= 0) { return 1; }
    var padX = numberOption(opts.padX, BLOCK_PAD_X);
    var avail = width - padX;
    if (!(avail > 0)) { return 1; }
    var timeWidth = textMetrics(itemTimeText(occ), opts).width;
    if (!(timeWidth > avail)) { return 1; }
    return Math.ceil(timeWidth / avail);
  }

  /**
   * 2026-10-20（用户反馈）：日视图的窄块**到底要不要显示时间行**。
   *
   * 旧口径（`NARROW_PX = 72`）按宽度一刀切：块宽 <72px 就把 `.tl-time` 隐藏。
   * 但块高是按「时间行 + 标题 + 备注」的需求算出来的 —— 一块 40px 宽、被同类别的
   * 长备注撑到 200px 高的块，时间其实完全放得下，却被隐藏了，于是「又高又空还没时间」。
   *
   * 新口径：用与块高**完全相同**的度量（含真实时间行数）算需求高，再看块高够不够。
   * 正常情况恒为 true（块高就是按这个需求算的）；只有块高被外部封顶（如微块/道高上限）时才 false。
   *
   * @param {object} occ
   * @param {number} width 块宽（像素）
   * @param {number} height 块高（像素）
   * @param {object} [options] 与 blockHeightNeed 同口径（chipWidth 等）
   * @returns {boolean} 宽度或高度不可用时**判 true**（拿不到几何就不隐藏内容）
   */
  function dayBlockShowsTime(occ, width, height, options) {
    var opts = options || {};
    if (typeof width !== 'number' || !isFinite(width) || width <= 0) { return true; }
    if (typeof height !== 'number' || !isFinite(height) || height <= 0) { return true; }
    var need = blockHeightNeed(occ, width, {
      unitPx: opts.unitPx,
      linePx: opts.linePx,
      padY: opts.padY,
      padX: opts.padX,
      noteGap: opts.noteGap,
      chipWidth: opts.chipWidth,
      /* 2026-10-20 三轮：窄块「只让首行」的口径必须一起透传，否则这里按「每行让位」
         算出 7 行（144px），而块高只有 3 行（97px）→ 时间被误判为放不下而藏起来。 */
      chipFirstLineOnly: opts.chipFirstLineOnly,
      timeLines: timeLineCount(occ, width, opts)
    });
    /* 允许 1px 的取整误差（块高在渲染侧用了 Math.ceil） */
    return height + 1 >= need;
  }

  /** 内部：按 options.tooNarrow(occ) 判定「这个块窄到不显示内容」 */
  function isTooNarrowItem(occ, options) {
    var opts = options || {};
    if (typeof opts.tooNarrow !== 'function') { return false; }
    try { return opts.tooNarrow(occ) === true; } catch (e) { return false; }
  }

  /**
   * 一组事项在给定宽度下所需的高度（取最大值）——日视图行组高度用它。
   * options.tooNarrow(occ) === true 的事项**不参与**（它折叠态不显示内容，不该抬高道高）。
   *
   * 2026-10-20（用户反馈）：新增 `options.widthOf(occ)` / `options.optionsOf(occ, w)`，
   * 让每条块**按自身宽度**参与度量（旧行为是整组共用一个 `width`＝最宽块宽，
   * 窄块的换行行数会被低估，道高与块高对不上）。不传这两个回调时行为与历史一致，
   * 所以「把 maxBlockHeightNeed 打成返回 0」这类注入仍然有效（F-73 / SC-56）。
   * @param {Array} items occurrence 数组（也接受 {occ} 形状）
   * @param {number} width 缺省宽度（`widthOf` 返回不可用值时回落到它）
   * @param {object} [options]
   * @returns {number}
   */
  function maxBlockHeightNeed(items, width, options) {
    var opts = options || {};
    var src = items || [];
    var max = 0;
    for (var i = 0; i < src.length; i += 1) {
      var occ = src[i] && src[i].occ ? src[i].occ : src[i];
      if (isTooNarrowItem(occ, opts)) { continue; }
      var w = width;
      if (typeof opts.widthOf === 'function') {
        var ww = 0;
        try { ww = opts.widthOf(occ, i); } catch (e) { ww = 0; }
        if (typeof ww === 'number' && isFinite(ww) && ww > 0) { w = ww; }
      }
      var itemOpts = opts;
      if (typeof opts.optionsOf === 'function') {
        var oo = null;
        try { oo = opts.optionsOf(occ, w, i); } catch (e) { oo = null; }
        if (oo && typeof oo === 'object') { itemOpts = oo; }
      }
      var h = blockHeightNeed(occ, w, itemOpts);
      if (h > max) { max = h; }
    }
    return max;
  }

  /** 一组事项所需的最大宽度（**不含备注**，用于周视图类别列宽）。 */
  function maxBlockWidthNeed(items, options) {
    var src = items || [];
    var max = 0;
    for (var i = 0; i < src.length; i += 1) {
      var occ = src[i] && src[i].occ ? src[i].occ : src[i];
      if (isTooNarrowItem(occ, options)) { continue; }
      var w = blockWidthNeed(occ, options);
      if (w > max) { max = w; }
    }
    return max;
  }

  return {
    MAX_LANE_HEIGHT_DEFAULT: MAX_LANE_HEIGHT_DEFAULT,    GROUP_GAP: GROUP_GAP,
    COMPRESS_HEIGHT_DEFAULT: COMPRESS_HEIGHT_DEFAULT,
    CAT_LABEL_WIDTH: CAT_LABEL_WIDTH,
    GROUP_LABEL_GAP: GROUP_LABEL_GAP,
    /* DM-21 常量 */
    BLOCK_GAP: BLOCK_GAP,
    LABEL_CHAR_PX: LABEL_CHAR_PX,
    LABEL_PAD_PX: LABEL_PAD_PX,
    BLOCK_HEIGHT_MIN: BLOCK_HEIGHT_MIN,
    DEFAULT_PX_PER_HOUR: DEFAULT_PX_PER_HOUR,
    DEFAULT_LANES_MAX: DEFAULT_LANES_MAX,
    DEFAULT_LANE_HEIGHT: DEFAULT_LANE_HEIGHT,
    DEFAULT_MIN_BLOCK_WIDTH: DEFAULT_MIN_BLOCK_WIDTH,
    DEFAULT_GROUP_GAP: DEFAULT_GROUP_GAP,
    OVERFLOW_OFFSET_STEP: OVERFLOW_OFFSET_STEP,
    TOTAL_MINUTES: TOTAL_MINUTES,
    minutesOfTime: minutesOfTime,
    layoutDayGroups: layoutDayGroups,
    assignGroupedLanes: assignGroupedLanes,
    computeAxisGeometry: computeAxisGeometry,
    axisTicks: axisTicks,
    axisIdleBands: axisIdleBands,
    categoryLabelMetrics: categoryLabelMetrics,
    /* 迭代 8（F-52）：块尺寸的内容度量 */
    TEXT_UNIT_PX: TEXT_UNIT_PX,
    BLOCK_LINE_PX: BLOCK_LINE_PX,
    BLOCK_PAD_X: BLOCK_PAD_X,
    BLOCK_PAD_Y: BLOCK_PAD_Y,
    WEEK_MIN_ITEM_WIDTH: WEEK_MIN_ITEM_WIDTH,
    WEEK_CATEGORY_MAX_WIDTH: WEEK_CATEGORY_MAX_WIDTH,
    CHIP_PAD_X: CHIP_PAD_X,
    CHIP_GAP: CHIP_GAP,
    chipWidthFor: chipWidthFor,
    /* 2026-10-20：按宽度档位取文字度量（窄档 11px/8px/让位14，普通档 13px/14px/22） */
    blockMetricOpts: blockMetricOpts,
    /* 2026-10-20：标题行给胶囊让位的真实宽度（与 CSS 的 padding-right 同源） */
    titleChipReserve: titleChipReserve,
    NARROW_BLOCK_PX: NARROW_BLOCK_PX,
    TITLE_RESERVE: TITLE_RESERVE,
    TITLE_RESERVE_NARROW: TITLE_RESERVE_NARROW,
    textMetrics: textMetrics,
    itemTimeText: itemTimeText,
    blockWidthNeed: blockWidthNeed,
    blockHeightNeed: blockHeightNeed,
    /* 2026-10-20：时间行在窄块里会换行，行数口径与块高需求必须同源 */
    timeLineCount: timeLineCount,
    /* 2026-10-20：窄块是否显示时间行（按剩余高度判定，不再按宽度一刀切） */
    dayBlockShowsTime: dayBlockShowsTime,
    maxBlockHeightNeed: maxBlockHeightNeed,
    maxBlockWidthNeed: maxBlockWidthNeed,
    /* 迭代 8（F-53）：窄到「不显示内容、改为点击后显示」的判定 */
    isBlockTooNarrow: isBlockTooNarrow,
    isDayBlockTooNarrow: isDayBlockTooNarrow,
    isWeekBlockTooNarrow: isWeekBlockTooNarrow,
    /* 2026-10-20：三级可见度 —— 「省略态下限」与「真·微块」判定 */
    BLOCK_OMIT_MIN_W: BLOCK_OMIT_MIN_W,
    BLOCK_SMALL_MIN_W: BLOCK_SMALL_MIN_W,
    isDayBlockTooSmall: isDayBlockTooSmall,
    isWeekBlockTooSmall: isWeekBlockTooSmall
  };
});
