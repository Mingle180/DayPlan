/**
 * DayPlan · src/core/picker.js
 * 迭代 7（docs/spec/11-iteration-7-delta.md §2 F-48 / §3 R-30）：
 * 建事项表单的日期「日历簿」与时间「密码锁」控件 —— 零依赖、纯逻辑 + 轻量 DOM。
 *
 * 功能来源：F-48.1（纯函数 + createWheel/createCalendar）、F-48.2（时间：时/分两列滚轮，
 *   分钟刻度 5 分钟）、F-48.3（日期：文案 YYYY年M月D日 + 浮层写回隐藏输入）、
 *   F-48.5（无 document 环境不崩）、F-48.6（tabindex / aria-label / Esc 还原焦点）。
 * 用例来源：11-iteration-7-delta §4 SC-52 / SC-53（核心层纯函数在 Node 直接断言）。
 *
 * 导出（UMD：Node → module.exports，浏览器 → root.DayPlan.picker）：
 *   picker.minuteOptions(step)   -> ["00","05",…,"55"]（刻度，默认 5 分钟）
 *   picker.hourOptions()         -> ["00"…"23"]
 *   picker.snapMinutes(v, step)  -> 最近的分钟刻度（number；非数入参 → null）
 *   picker.clampTime(hhmm)       -> "HH:mm"（非法 → null）
 *   picker.timeParts(hhmm)       -> {hour:"HH", minute:"MM"}（非法 → null）
 *   picker.formatDateCN(iso)     -> "2026年7月26日"（非法 → ""）
 *   picker.formatMonthCN(ym)     -> "2026年7月"（非法 → ""）
 *   picker.wheelIndexFor(scrollTop, itemHeight, count) -> 「滚动落点 → 最近条目」下标
 *   picker.wheelSpan(rows, itemHeight)  -> 滚动窗口高度（rows × 条目高）
 *   picker.wheelPad(rows, itemHeight)   -> 上下留白（(rows-1)/2 × 条目高）→ 首末项也能居中
 *   picker.wrapIndex(index, count)      -> 逻辑下标（对 count 取模回绕；count<=0 → -1）
 *   picker.wheelWrapShift(globalIndex, count) -> 循环缓冲的静默平移量（±count 或 0）
 *   picker.createWheel(options)    -> {element, value(), setValue(v), index(), step, itemHeight,
 *                                      visibleRows, cyclic, copies, base, total, values,
 *                                      focus(), scrollToIndex(i), syncScroll(), destroy()}
 *   picker.createTimeLock(options) -> {element, value(), setValue(hhmm), hour(), minute(), syncScroll(), destroy()}
 *   picker.createCalendar(options) -> {element, value(), setValue(iso), month(), shiftMonth(n), open(), close(), isOpen(), focus(), cells(), destroy()}
 *   picker.createOutsideCloser(options) -> {bind(), unbind(), isBound(), handle(ev)}（document 捕获期「点外部关闭」）
 *   picker.MONTH_CN / picker.WEEKDAY_CN / picker.DEFAULT_MINUTE_STEP / picker.DEFAULT_ITEM_HEIGHT
 *   picker.DEFAULT_VISIBLE_ROWS / picker.WHEEL_COPIES / picker.DRAG_THRESHOLD_PX
 *
 * 冻结口径（实现与断言共用，改动即视为破坏契约）：
 *   1) snapMinutes：四舍五入到最近刻度，然后**只向下夹取、不回绕**。
 *      57.5 → round(57.5/5)=12 → 60 → 夹到 55（不是 00），避免分钟列改动小时；
 *      58 → 55；7 → 5；59 → 55；越界值夹到首/末刻度；非数入参 → null。
 *   2) clampTime：接受 "H:mm" / "HH:mm"，一律补零输出 "HH:mm"，允许首尾空白；
 *      范围 00:00…23:59（**24:00 非法**，与 core/datetime.js::minutesOf 同口径）；其余 → null。
 *      已知边界：表单里「结束时间 = 24:00」由原生 input 承载，滚轮不表示该值（见交付说明）。
 *   3) wheelIndexFor：index = round(scrollTop / itemHeight)（0.5 的中点归**下一项**），
 *      结果夹到 [0, count-1]；count <= 0 → -1；itemHeight <= 0 / 非数 → 0；scrollTop 非数或 <= 0 → 0。
 *   4) 降级：无 document（或显式传 document: null）时，三个 DOM 工厂返回**降级控制器** ——
 *      element === null、degraded === true，value()/setValue()/month()/shiftMonth() 等纯状态 API 照常可用，
 *      绝不抛错、绝不在顶层求值里触碰 window/document。
 *   5) **本模块不碰 element.hidden**（开合状态只有 `.is-open` 类与 isOpen()）。
 *      宿主容器（src/ui/form.js 的 `div.dp-pop`）用 `pop.hidden` 控制浮层显隐；
 *      因此若要在宿主里真正隐藏浮层，需在 button 的 click 里调 `cal.open()/cal.close()`，
 *      或给 createCalendar 传 `onClose` 回调。close() 会还原焦点（options.returnFocus → 打开前的 activeElement）。
 *   6) createWheel.setValue(v)：解析不到刻度时**保持原值**（不静默跳到首项）；scrollToIndex(i) 越界夹到 [0, len-1]。
 *   7) shiftMonth(n)：按整数月序号上下夹取到 1900-01…2100-12；焦点「日」号在短月夹到月末。
 *   8) **滚轮（迭代 8 / D25 修订）**：单列是**循环轮**（`options.cyclic === false` 才退回有限列）。
 *      读取位 = **中间行**：`visibleRows`（默认 5，偶数上取奇数）→ 滚动窗口高 `rows × itemHeight`、
 *      上下留白 `(rows-1)/2 × itemHeight`；因此对**每个**全局下标 i 都有 `wheelIndexFor(i×h, h, total) === i`，
 *      即「落点 = 正在中间行的那一项」。列内是 `WHEEL_COPIES`(3) 份**同值拷贝**，
 *      起始落在**中间那份**（全局下标 = `count + 逻辑下标`）；落点跑出中间那份时按 `wheelWrapShift`
 *      静默平移一份（前后逐字相同 → 视觉等价）→ **没有上下边界**。`index()/value()` 一律是**逻辑**口径。
 *      元素上写 data-item-height / data-visible-rows / data-wheel-span / data-wheel-pad / data-cyclic /
 *      data-copies / data-active-value / data-active-index，供断言与 CSS 交叉核对几何。
 *      浮层从 hidden 变可见时**必须**调 `syncScroll()`：隐藏期赋值 scrollTop 不生效。
 *   9) createOutsideCloser：`handle(ev)` 是**纯判定**（不开合状态、不碰 DOM）——
 *      目标落在 options.ignore（元素或数组：元素自身或其子树）→ 不回调；`isOpen()` 为假 → 不回调；
 *      否则恰一次 onOutside()。`bind()` 把 handle 绑到 **document 的捕获期**（幂等，重复 bind 只绑一次），
 *      `unbind()` 解绑（幂等）。宿主必须把**自己的触发按钮**放进 ignore，否则真实浏览器里
 *      捕获期先关、按钮处理器再开会把它重新打开（迭代 7 复核 V7 的教训）。
 *   10) **手感（迭代 10 反馈 / 条11、条12、条13）**：滚轮不允许出现可见跳动 ——
 *      ① 平移一份拷贝时用**相对位移** `scrollTop += shift × itemHeight`（保留亚像素偏移）；
 *         写成绝对位置 `idx × itemHeight` 会把「半点取整」的误差暴露成半格跳动。
 *      ② **滚轮/触控板一律由 JS 按整格消化**（条13）：`wheel` 事件 `preventDefault` 掉原生滚动，
 *         把 delta 攒进累加器，攒满一格才 `applyGlobal` 一格。真机实测（tools/_cdp_wheel.js）：
 *         交给浏览器自由滚时一次 wheel(deltaY=100) 会滚 100px ≈ 3.1 格，落点停在半格（mod 4/7/11…），
 *         再由 JS 拽到整格 —— 每一步都是「跳」，跨 min/max 交界时更明显。
 *         现在 scrollTop 全程是 `itemHeight` 的整数倍，跨副本归一化也是整数位移 → 零跳动。
 *      ③ **只有按住拖动**才关 `scroll-snap`（拖拽必须连续、必然落在半格）：
 *         内联写 `none` + 挂 `.is-drag-scroll`，mouseup 后 `settleWheel()` 先对齐整格再写回
 *         `y mandatory`。**只切类名是空转**（build() 的内联样式优先），条12 的探针证实过。
 *      ④ paint 只改「上一格 / 新一格」两个条目，不再整列刷（3×N 项时的掉帧同样被感知为卡顿）。
 *      ⑤ **拖拽基线自愈**：handleMouseMove 用 `drag.top − dy` 这个绝对基准；一旦跨了一份拷贝
 *         （±count × itemHeight），基准就落后一整份 —— 在 scrollTop 被浏览器夹到 0/max 的
 *         两端，回绕与旧基准互相拉锯，表现为「滑过最大/最小交界时跳一下」。故 applyGlobal
 *         把自己造成的位移同步进 drag.top（探针 B/C 项：越界回绕帧误差 0px）。
 *
 * DOM 类名契约（styles/*.css 由接线方编写）：
 *   .dp-wheel（滚动列：overflow-y:auto + scroll-snap-type:y mandatory；**隐藏滚动条**；
 *             按住拖动期间 .is-drag-scroll 临时把 scroll-snap-type 置 none）
 *     .dp-wheel-item[data-value][data-index][role=option]（.is-active = 中间行的当前值）
 *   .dp-lock > .dp-lock-col > .dp-wheel，两列之间 .dp-lock-sep
 *   .dp-wheels / .dp-lock：`::before` 画**一条**横跨两列的浅灰高亮带（读取位 = 中间行）
 *   .dp-calendar > .dp-cal-head > (.dp-cal-prev / .dp-cal-title / .dp-cal-next / .dp-cal-today)
 *                > .dp-cal-weekdays > .dp-cal-wd ×7（**周一起始**）
 *                > .dp-cal-grid[role=grid] > button.dp-cal-day[data-iso]
 *                  （.is-outside / .is-today / .is-active / .is-focus）
 *   浮层开合：.dp-calendar.is-open
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.DayPlan = root.DayPlan || {}; root.DayPlan.picker = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DEFAULT_MINUTE_STEP = 5;   /* R-30：时间滚轮刻度 5 分钟 */
  var DEFAULT_ITEM_HEIGHT = 32;  /* 单条滚轮项高度（px），与 form.js 传值一致 */
  var DEFAULT_VISIBLE_ROWS = 5;  /* D25/F-56：可见行数（**奇数**才有唯一的「中间行」= 读取位） */
  var WHEEL_COPIES = 3;          /* D25/F-56：循环缓冲份数（首/中/末三份同值拷贝） */
  var DRAG_THRESHOLD_PX = 4;     /* 拖拽判定阈值：超过即视为拖动，抑制随后的 click 点选 */
  var WHEEL_SETTLE_MS = 160;     /* 拖拽松手后的收尾窗口（与滚轮无关：滚轮走整格，不需要静默判停） */
  var MINUTES_PER_HOUR = 60;
  var HOURS_PER_DAY = 24;
  var GRID_CELLS = 42;           /* 月历固定 6 行 × 7 列，周一开头 */
  var MIN_YM = '1900-01';
  var MAX_YM = '2100-12';
  /* 与 core/calendar-grid.js 的 MIN_YM/MAX_YM 同口径的月序号边界（极值上下夹取用） */
  var MIN_MONTH_INDEX = 1900 * 12;
  var MAX_MONTH_INDEX = 2100 * 12 + 11;

  var MONTH_CN = ['1月', '2月', '3月', '4月', '5月', '6月',
    '7月', '8月', '9月', '10月', '11月', '12月'];
  /* 周一起始（与 core/datetime.js::startOfWeek / calendar-grid.js 同口径） */
  var WEEKDAY_CN = ['一', '二', '三', '四', '五', '六', '日'];

  /* ===================== 依赖解析（懒加载，不依赖脚本顺序） ===================== */

  function depRequire(spec) {
    if (typeof require === 'function') {
      try { return require(spec); } catch (e) { return null; }
    }
    return null;
  }

  function requireDatetime() {
    if (root && root.DayPlan && root.DayPlan.datetime) return root.DayPlan.datetime;
    return depRequire('./datetime.js');
  }

  function requireCalendarGrid() {
    if (root && root.DayPlan && root.DayPlan.calendarGrid) return root.DayPlan.calendarGrid;
    return depRequire('./calendar-grid.js');
  }

  /* ===================== 基础工具 ===================== */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }
  function isFn(v) { return typeof v === 'function'; }
  function trim(s) { return String(s).replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''); }
  function prevent(ev) { if (ev && isFn(ev.preventDefault)) ev.preventDefault(); }

  function normalizeStep(step) {
    if (!isFiniteNum(step) || step <= 0) return DEFAULT_MINUTE_STEP;
    var s = Math.floor(step);
    return s > 0 ? s : DEFAULT_MINUTE_STEP;
  }

  function normalizeItemHeight(h) {
    return (isFiniteNum(h) && h > 0) ? h : DEFAULT_ITEM_HEIGHT;
  }

  /** 可见行数：非数/<1 → 5；**偶数上取奇数**（读取位必须是唯一的「中间行」）。 */
  function normalizeVisibleRows(rows) {
    if (!isFiniteNum(rows) || rows < 1) return DEFAULT_VISIBLE_ROWS;
    var n = Math.floor(rows);
    return (n % 2 === 0) ? n + 1 : n;
  }

  /* ===================== 纯函数 ===================== */

  /** 分钟刻度列表（默认 5 分钟；step <= 0 / 非数回落 5）。 */
  function minuteOptions(step) {
    var s = normalizeStep(step);
    var out = [];
    for (var m = 0; m < MINUTES_PER_HOUR; m += s) out.push(pad2(m));
    return out;
  }

  /** 小时列取值（"00"…"23"）。 */
  function hourOptions() {
    var out = [];
    for (var h = 0; h < HOURS_PER_DAY; h += 1) out.push(pad2(h));
    return out;
  }

  /** 最近刻度（口径见文件头第 1 条）；非数入参 → null。 */
  function snapMinutes(value, step) {
    if (!isFiniteNum(value)) return null;
    var s = normalizeStep(step);
    var maxTick = Math.floor((MINUTES_PER_HOUR - 1) / s) * s;
    if (value <= 0) return 0;
    var snapped = Math.round(value / s) * s;
    if (snapped > maxTick) snapped = maxTick;
    if (snapped < 0) snapped = 0;
    return snapped;
  }

  /** 归一为 "HH:mm"；非法 → null（口径见文件头第 2 条）。 */
  function clampTime(hhmm) {
    if (typeof hhmm !== 'string') return null;
    var m = /^(\d{1,2}):(\d{1,2})$/.exec(trim(hhmm));
    if (!m) return null;
    var h = Number(m[1]);
    var mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return pad2(h) + ':' + pad2(mi);
  }

  function timeParts(hhmm) {
    var c = clampTime(hhmm);
    if (!c) return null;
    return { hour: c.slice(0, 2), minute: c.slice(3, 5) };
  }

  /** 日期文案（不含星期）：2026-07-26 → "2026年7月26日"；非法 → ""。 */
  function formatDateCN(iso) {
    var DT = requireDatetime();
    if (!DT || !isFn(DT.formatDateCN)) return '';
    var full = DT.formatDateCN(iso);
    if (typeof full !== 'string' || !full) return '';
    return full.split(' ')[0];
  }

  /** 月份文案："2026-07" → "2026年7月"；非法 → ""。 */
  function formatMonthCN(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(typeof ym === 'string' ? ym : '');
    if (!m) return '';
    var mo = Number(m[2]);
    if (mo < 1 || mo > 12) return '';
    return m[1] + '年' + MONTH_CN[mo - 1];
  }

  /** 「滚动落点 → 最近条目」（口径见文件头第 3 条）。 */
  function wheelIndexFor(scrollTop, itemHeight, count) {
    if (!isFiniteNum(count) || count <= 0) return -1;
    if (!isFiniteNum(itemHeight) || itemHeight <= 0) return 0;
    if (!isFiniteNum(scrollTop) || scrollTop <= 0) return 0;
    var idx = Math.round(scrollTop / itemHeight);
    if (idx < 0) return 0;
    if (idx > count - 1) return count - 1;
    return idx;
  }

  /** 滚动窗口高度 = 可见行数 × 条目高（与 CSS `.dp-wheel` 的 height 同口径）。 */
  function wheelSpan(rows, itemHeight) {
    return normalizeVisibleRows(rows) * normalizeItemHeight(itemHeight);
  }

  /** 上下留白 = (可见行数 − 1) / 2 × 条目高：让**首/末项也能滚到正中间**（与 CSS padding 同口径）。 */
  function wheelPad(rows, itemHeight) {
    return ((normalizeVisibleRows(rows) - 1) / 2) * normalizeItemHeight(itemHeight);
  }

  /** 逻辑下标（0…count−1）：对 count 取模回绕；count <= 0 / 非数 → -1。 */
  function wrapIndex(index, count) {
    if (!isFiniteNum(count) || count <= 0) return -1;
    if (!isFiniteNum(index)) return -1;
    return ((Math.floor(index) % count) + count) % count;
  }

  /**
   * 循环缓冲的**静默平移量**：把全局下标平移到「中间那份」的代表元（视觉完全等价）。
   * 闭式：`count + (g mod count) − g` —— 在可达区间 `[0, 3×count)` 内等价于
   * 「`<count → +count`、`≥2×count → −count`、否则 0」；对任意整数（含负）都成立。
   * count <= 1 / 非数 → 0。
   */
  function wheelWrapShift(globalIndex, count) {
    if (!isFiniteNum(count) || count <= 1) return 0;
    if (!isFiniteNum(globalIndex)) return 0;
    var g = Math.floor(globalIndex);
    var logical = ((g % count) + count) % count;
    return (count + logical) - g;
  }

  /* ===================== 日期工具（依赖注入式，缺失时回落纯算术） ===================== */

  function isValidIso(iso) {
    if (typeof iso !== 'string') return false;
    var DT = requireDatetime();
    if (DT && isFn(DT.isValidDate)) return DT.isValidDate(iso) === true;
    return /^\d{4}-\d{2}-\d{2}$/.test(iso);
  }

  function todayIso() {
    var DT = requireDatetime();
    if (DT && isFn(DT.todayISO)) {
      var t = DT.todayISO();
      if (isValidIso(t)) return t;
    }
    return null;
  }

  function ymOf(iso) { return (typeof iso === 'string' && iso.length >= 7) ? iso.slice(0, 7) : ''; }

  function clampYm(ym) {
    var CG = requireCalendarGrid();
    if (CG && isFn(CG.clampYM)) {
      var c = CG.clampYM(ym);
      if (typeof c === 'string' && c) return c;
    }
    /* 垫片/异常输入（如 5 位数年份）走同口径的整数运算，避免退化成 MIN_YM */
    var m = /^(-?\d+)-(\d{2})$/.exec(typeof ym === 'string' ? ym : '');
    if (!m) return MIN_YM;
    var mo = Number(m[2]);
    if (!(mo >= 1 && mo <= 12)) return MIN_YM;
    var idx = Number(m[1]) * 12 + (mo - 1);
    if (idx < MIN_MONTH_INDEX) idx = MIN_MONTH_INDEX;
    if (idx > MAX_MONTH_INDEX) idx = MAX_MONTH_INDEX;
    var y = Math.floor(idx / 12);
    return y + '-' + pad2(idx - y * 12 + 1);
  }

  function shiftYm(ym, n) {
    var m = /^(\d{4})-(\d{2})$/.exec(typeof ym === 'string' ? ym : '');
    if (!m) return MIN_YM;
    var idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
    if (idx < MIN_MONTH_INDEX) idx = MIN_MONTH_INDEX;
    if (idx > MAX_MONTH_INDEX) idx = MAX_MONTH_INDEX;
    var y = Math.floor(idx / 12);
    return clampYm(y + '-' + pad2(idx - y * 12 + 1));
  }

  function addDaysIso(iso, n) {
    var DT = requireDatetime();
    if (DT && isFn(DT.addDays)) {
      var r = DT.addDays(iso, n);
      if (isValidIso(r)) return r;
    }
    return iso;
  }

  /** 月历 42 格（周一起始）；优先复用 core/calendar-grid.js，其次 datetime.monthGrid。 */
  function monthCells(ym) {
    var list = [];
    var CG = requireCalendarGrid();
    var m = /^(\d{4})-(\d{2})$/.exec(typeof ym === 'string' ? ym : '');
    if (CG && isFn(CG.monthGridMon) && m) {
      var g = CG.monthGridMon(Number(m[1]), Number(m[2]));
      if (g && g.weeks) {
        for (var w = 0; w < g.weeks.length; w += 1) {
          var dates = g.weeks[w].dates || [];
          for (var d = 0; d < dates.length; d += 1) list.push(dates[d]);
        }
      }
    }
    if (!list.length) {
      var DT = requireDatetime();
      if (DT && isFn(DT.monthGrid)) {
        var grid = DT.monthGrid(ym);
        if (grid && grid.length) list = grid.slice();
      }
    }
    /* 固定 6 行：5 行月（如 2026-02）向前补足，保证 CSS 网格行数稳定 */
    while (list.length > 0 && list.length < GRID_CELLS) {
      list.push(addDaysIso(list[list.length - 1], 1));
    }
    return list.slice(0, GRID_CELLS);
  }

  /* ===================== DOM 工具 ===================== */

  /** document 解析：显式传 document（含 null）优先，否则用全局 document。 */
  function resolveDoc(options) {
    if (options && Object.prototype.hasOwnProperty.call(options, 'document')) {
      return options.document || null;
    }
    return (typeof document !== 'undefined' && document) ? document : null;
  }

  function createEl(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function setStyle(node, key, value) {
    if (node && node.style) node.style[key] = value;
  }

  function setAttr(node, key, value) {
    if (node && isFn(node.setAttribute)) node.setAttribute(key, value);
  }

  function addListener(node, type, fn, opts) {
    if (node && isFn(node.addEventListener)) {
      /* opts 用于 wheel 的 {passive:false}：默认 passive 的 wheel 监听里 preventDefault 不生效 */
      try { node.addEventListener(type, fn, opts); } catch (e) {
        try { node.addEventListener(type, fn); } catch (e2) { /* 垫片无事件系统时忽略 */ }
      }
    }
  }

  function removeListener(node, type, fn) {
    if (node && isFn(node.removeEventListener)) {
      try { node.removeEventListener(type, fn); } catch (e) { /* 忽略 */ }
    }
  }

  function safeFocus(node) {
    if (node && isFn(node.focus)) {
      try { node.focus(); } catch (e) { /* 垫片忽略 */ }
    }
  }

  /** values 里找 value 的下标；找不到时按 step 取最近刻度；仍找不到 → -1。 */
  function indexOfValue(values, value, step) {
    var raw = value;
    if (typeof raw !== 'string') {
      if (isFiniteNum(raw)) raw = pad2(raw);
      else return -1;
    }
    var i = values.indexOf(raw);
    if (i >= 0) return i;
    var t = trim(raw);
    i = values.indexOf(t);
    if (i >= 0) return i;
    var num = Number(t);
    if (t !== '' && isFiniteNum(num)) {
      var snapped = snapMinutes(num, step);
      if (snapped !== null) {
        i = values.indexOf(pad2(snapped));
        if (i >= 0) return i;
      }
    }
    return -1;
  }

  /* ===================== createWheel：单列滚轮 ===================== */

  /**
   * 滚动列（"密码锁"的一列）—— 迭代 8（D25 / F-56）改为**循环无限轮**。
   *
   * 读取位 = **中间行**（见文件头第 8 条）：
   *   - 可见行数 `visibleRows`（默认 5，偶数上取奇数）→ 窗口高 `rows × itemHeight`；
   *   - 上下留白 `(rows-1)/2 × itemHeight` → **首/末项也能滚到正中间**，
   *     于是「落点 → 条目」严格是 `wheelIndexFor(scrollTop, itemHeight, total)`；
   *   - **循环**：列内 `WHEEL_COPIES`(3) 份同值拷贝，起始落在**中间那份**；
   *     落点跑出中间那份就静默平移一份（前后逐字相同 → 视觉等价）→ **没有上下边界**；
   *   - 交互：鼠标滚轮 / 方向键 / **按住上下拖拽** / **点条目 = 选中**（拖完那一次 click 被阈值抑制）。
   *
   * @param {object} options
   *   - values: string[]（缺省 = minuteOptions(step)）
   *   - value:  string（初始值，命中刻度；否则按 step 取最近刻度）
   *   - step:   number（默认 5）
   *   - itemHeight: number（默认 32）
   *   - visibleRows: number（默认 5；偶数上取奇数）
   *   - cyclic: boolean（默认 true；false = 有限列：落点夹取到首/末项、不回绕）
   *   - ariaLabel: string
   *   - document: Document（显式 null = 强制降级）
   *   - onChange(v) / onCommit(v) / onCancel(v)
   * @returns {{element:HTMLElement|null, degraded:boolean, step:number, itemHeight:number,
   *   visibleRows:number, cyclic:boolean, copies:number, base:number, total:number,
   *   values:string[], value:function, index:function, setValue:function,
   *   scrollToIndex:function, syncScroll:function, focus:function, destroy:function}}
   */
  function createWheel(options) {
    options = options || {};
    var doc = resolveDoc(options);
    var step = normalizeStep(options.step);
    var values = (options.values && options.values.length)
      ? Array.prototype.slice.call(options.values) : minuteOptions(step);
    var itemHeight = normalizeItemHeight(options.itemHeight);
    var visibleRows = normalizeVisibleRows(options.visibleRows);
    var cyclic = options.cyclic !== false && values.length > 1;
    var copies = cyclic ? WHEEL_COPIES : 1;
    var total = values.length * copies;
    var base = cyclic ? values.length : 0;   /* 「中间那份」的起始全局下标 */
    var ariaLabel = options.ariaLabel || '滚动选择';
    var onChange = isFn(options.onChange) ? options.onChange : null;
    var onCommit = isFn(options.onCommit) ? options.onCommit : null;
    var onCancel = isFn(options.onCancel) ? options.onCancel : null;

    var seed = indexOfValue(values, options.value, step);
    var logical = seed >= 0 ? seed : 0;      /* 逻辑下标：0…values.length-1（对外口径） */
    var activeIndex = base + logical;        /* 全局下标：0…total-1（含拷贝份） */
    var element = null;
    var items = [];
    var destroyed = false;
    var suppressClick = false;
    var drag = null;
    var paintAt = -1;        /* 上一次画成「选中」的全局下标（只改变化的两格 → 滚动不掉帧） */
    var snapTimer = null;    /* 拖拽松手后的收尾定时器 */
    var wheelAcc = 0;        /* 滚轮 delta 累加器：攒够一格才走一格（永不落在半格） */

    function currentValue() { return values[logical]; }

    function paint() {
      if (!element) return;
      /* 只改「上一格」与「新一格」：列里有 3×N 个条目（倒计时分钟列 180 个），
         每次 scroll 整列刷 className 会明显掉帧，手感上同样是「一顿一顿」。 */
      if (paintAt >= 0 && paintAt !== activeIndex && items[paintAt]) {
        items[paintAt].className = 'dp-wheel-item';
        setAttr(items[paintAt], 'aria-selected', 'false');
      }
      var act = items[activeIndex];
      if (act) {
        if (act.className !== 'dp-wheel-item is-active') act.className = 'dp-wheel-item is-active';
        setAttr(act, 'aria-selected', 'true');
      }
      paintAt = activeIndex;
      setAttr(element, 'aria-label', ariaLabel + ' ' + currentValue());
      setAttr(element, 'data-active-value', currentValue());
      setAttr(element, 'data-active-index', String(activeIndex));
    }

    function setScrollTop(v) { if (element) element.scrollTop = v; }

    /**
     * 落到**全局下标** idx：越出中间那份时静默平移一份（视觉等价 → 无边界）。
     * fire = 值真的变了才回调 onChange；syncScroll = 同时把滚动位置对齐到该下标。
     */
    function applyGlobal(idx, fire, syncScroll) {
      if (!isFiniteNum(idx)) return;
      if (idx < 0) idx = 0;
      if (idx > total - 1) idx = total - 1;
      var beforeTop = element ? element.scrollTop : 0;
      if (cyclic) {
        var from = idx;
        var shift = wheelWrapShift(idx, values.length);
        if (shift) {
          idx += shift;
          /* 平移**整份拷贝**（三份逐字相同 → 视觉等价）。
             必须用相对位移：落点是「四舍五入到最近条目」，直接写 idx×条目高会把
             那半格误差暴露成一次可见跳动（用户反馈的「突然跳一下」）。
             例外：落点被夹取过（列外的大数，偏差超过半格）时退回整格，避免把越界位置一起搬走。
             带 syncScroll 的调用随后会写绝对位置，这里跳过。 */
          if (!syncScroll) {
            var off = element.scrollTop - from * itemHeight;
            if (off > itemHeight / 2 || off < -itemHeight / 2) setScrollTop(idx * itemHeight);
            else setScrollTop(element.scrollTop + shift * itemHeight);
          }
        }
      }
      var next = cyclic ? wrapIndex(idx, values.length) : idx;
      if (next < 0) return;
      var changed = next !== logical;
      activeIndex = idx;
      logical = next;
      paint();
      if (syncScroll) setScrollTop(activeIndex * itemHeight);
      /* 拖拽基线自愈（迭代 10 反馈 / 条12）：handleMouseMove 用的是
         `drag.top − dy` 这个**绝对**基准；上一轮若跨了一份拷贝（±count×条目高），
         基准就落后一整份，下一次 mousemove 会把位置写回去 —— 表现为在
         「最大 ↔ 最小」交界处来回闪一下。这里把本函数造成的位移同步进基线。 */
      if (drag && element) drag.top += element.scrollTop - beforeTop;
      if (changed && fire && onChange) onChange(currentValue());
    }

    function handleScroll() {
      if (destroyed || !element) return;
      var g = wheelIndexFor(element.scrollTop, itemHeight, total);
      if (g < 0) return;
      applyGlobal(g, true, false);
    }

    /* ---- scroll-snap 的手势期开关 ----------------------------------------
       `.dp-wheel` 常态是 `scroll-snap-type: y mandatory`（静止时严格停在条目上）。
       但「mandatory + 程序化 scrollTop」在真实浏览器里会在每一帧之后回吸到最近条目：
       拖动 / 触控板滑动时就是「走一格被拽回来」——观感为跳动。故手势期间临时关掉，
       手势结束后（松手 / 滚轮静默 160ms）先对齐到整格，再把 snap 装回去。 */

    function setSnapOff(off) {
      if (!element) return;
      /* **必须写内联样式**：`scroll-snap-type` 在 build() 里是内联 'y mandatory'，
         内联优先级高于 `.dp-wheel.is-drag-scroll { scroll-snap-type: none }` ——
         只切类名是空转（迭代 10 反馈 / 条12：真机探针里挂上类后 computed 仍是
         'y mandatory'，于是每次程序化 scrollTop 都被强制吸到整格，拖动表现为
         「一跳一跳」）。类名保留：CSS 里由它决定 cursor，也作为可观测标记。 */
      if (element.style) element.style.scrollSnapType = off ? 'none' : 'y mandatory';
      if (element.classList && isFn(element.classList.toggle)) element.classList.toggle('is-drag-scroll', !!off);
    }

    /** 收尾：对齐到最近条目（此时 snap 仍关着 → 写完不会被回吸），再装回 snap。 */
    function settleWheel() {
      settleClear();
      if (destroyed || !element) return;
      var g = wheelIndexFor(element.scrollTop, itemHeight, total);
      if (g >= 0) applyGlobal(g, true, true);
      setSnapOff(false);
    }

    function settleClear() {
      if (!snapTimer) return;
      if (root && isFn(root.clearTimeout)) root.clearTimeout(snapTimer);
      snapTimer = null;
    }

    /* ---- 拖拽滚动（侧边滚动条已隐藏，桌面端靠它改值）+ 点选 ---- */

    function handleMouseDown(ev) {
      if (destroyed || !element) return;
      suppressClick = false;
      wheelAcc = 0;           /* 换手势：滚轮累加器作废，避免上一手势的余量带进来 */
      drag = {
        y: (ev && isFiniteNum(ev.clientY)) ? ev.clientY : 0,
        top: element.scrollTop
      };
      settleClear();          /* 手动接管：撤掉滚轮手势可能挂着的收尾定时器 */
      setSnapOff(true);       /* 拖拽期间关 snap，否则每帧回吸 → 抖动 */
      addListener(doc, 'mousemove', handleMouseMove);
      addListener(doc, 'mouseup', handleMouseUp);
      prevent(ev);
    }

    function handleMouseMove(ev) {
      if (!drag || !element) return;
      var y = (ev && isFiniteNum(ev.clientY)) ? ev.clientY : drag.y;
      var dy = y - drag.y;
      if (Math.abs(dy) > DRAG_THRESHOLD_PX) suppressClick = true;
      setScrollTop(drag.top - dy);
      if (suppressClick) prevent(ev);
    }

    function handleMouseUp() {
      removeListener(doc, 'mousemove', handleMouseMove);
      removeListener(doc, 'mouseup', handleMouseUp);
      var dragged = suppressClick;
      drag = null;
      /* 真拖动过：落点对齐到整格再装回 snap（一次到位，没有二次弹跳）；
         只是点了一下：位置没变，直接按当前落点取一次值即可。 */
      if (dragged) settleWheel();
      else { setSnapOff(false); handleScroll(); }
    }

    /**
     * 滚轮 / 触控板：**自己按整格消化**，不让浏览器自由滚。
     *
     * 迭代 10 条13 用 CDP 真机探针（tools/_cdp_wheel.js）量到的旧行为：
     *   一次 wheel（deltaY=100）关掉 snap 后浏览器直接滚 100px ≈ 3.1 格，
     *   落点停在半格（mod 4/7/11…），160ms 后再被 JS 拽到整格 —— 每一步都是「跳」，
     *   跨 min/max 交界时还会叠加一份拷贝的归一化位移，观感就是「突然跳一下」。
     *
     * 现在：preventDefault 掉原生滚动，把 delta 累加成**整数格**直接 applyGlobal。
     *   → scrollTop 全程都是 itemHeight 的整数倍，跨副本归一化也是整数位移，零跳变；
     *   → 一次滚轮仍然是「约 3 格」（与原生的 100px 一致），但每格精确对齐；
     *   → 触控板的细碎 delta 会被累加器自然合并，手感细腻且不会卡在半格。
     */
    function handleWheel(ev) {
      if (destroyed || !element) return;
      prevent(ev);
      var d = (ev && isFiniteNum(ev.deltaY)) ? ev.deltaY : 0;
      if (!d) return;
      var mode = (ev && isFiniteNum(ev.deltaMode)) ? ev.deltaMode : 0;
      if (mode === 1) d *= itemHeight;                   /* 按「行」计 */
      else if (mode === 2) d *= itemHeight * visibleRows; /* 按「页」计 */
      wheelAcc += d;
      var steps = wheelAcc > 0 ? Math.floor(wheelAcc / itemHeight) : Math.ceil(wheelAcc / itemHeight);
      if (!steps) return;
      wheelAcc -= steps * itemHeight;
      applyGlobal(activeIndex + steps, true, true);
    }

    function bindItem(node, gidx) {
      addListener(node, 'click', function (ev) {
        if (suppressClick) { suppressClick = false; return; }
        prevent(ev);
        applyGlobal(gidx, true, true);
      });
    }

    function handleKeyDown(ev) {
      if (destroyed) return;
      var key = ev && ev.key;
      var code = ev && ev.keyCode;
      if (key === 'ArrowDown' || code === 40) { applyGlobal(activeIndex + 1, true, true); }
      else if (key === 'ArrowUp' || code === 38) { applyGlobal(activeIndex - 1, true, true); }
      else if (key === 'Home' || code === 36) { applyGlobal(base, true, true); }
      else if (key === 'End' || code === 35) { applyGlobal(base + values.length - 1, true, true); }
      else if (key === 'Enter' || code === 13) { if (onCommit) onCommit(currentValue()); }
      else if (key === 'Escape' || key === 'Esc' || code === 27) {
        if (onCancel) onCancel(currentValue());
        else if (element && isFn(element.blur)) { try { element.blur(); } catch (e) { /* 忽略 */ } }
      } else { return; }
      prevent(ev);
    }

    function build() {
      if (!doc) return;
      element = createEl(doc, 'div', 'dp-wheel');
      setAttr(element, 'role', 'listbox');
      setAttr(element, 'tabindex', '0');
      /* 诊断（迭代 8 / F-56）：CSS 的 --wheel-item-height / --wheel-visible-rows 必须与本处几何一致 */
      setAttr(element, 'data-item-height', String(itemHeight));
      setAttr(element, 'data-visible-rows', String(visibleRows));
      setAttr(element, 'data-wheel-span', String(wheelSpan(visibleRows, itemHeight)));
      setAttr(element, 'data-wheel-pad', String(wheelPad(visibleRows, itemHeight)));
      setAttr(element, 'data-cyclic', cyclic ? '1' : '0');
      setAttr(element, 'data-copies', String(copies));
      setStyle(element, 'overflowY', 'auto');
      setStyle(element, 'scrollSnapType', 'y mandatory');
      for (var c = 0; c < copies; c += 1) {
        for (var i = 0; i < values.length; i += 1) {
          var gidx = c * values.length + i;
          var item = createEl(doc, 'div', 'dp-wheel-item', values[i]);
          setAttr(item, 'role', 'option');
          setAttr(item, 'data-value', values[i]);
          setAttr(item, 'data-index', String(gidx));
          setStyle(item, 'height', itemHeight + 'px');
          setStyle(item, 'scrollSnapAlign', 'center');
          bindItem(item, gidx);
          items.push(item);
          element.appendChild(item);
        }
      }
      paint();
      setScrollTop(activeIndex * itemHeight);
      addListener(element, 'scroll', handleScroll);
      addListener(element, 'keydown', handleKeyDown);
      addListener(element, 'mousedown', handleMouseDown);
      /* wheel 必须非 passive：默认 passive 监听里 preventDefault 无效，浏览器会照旧自由滚 */
      addListener(element, 'wheel', handleWheel, { passive: false });
    }

    if (doc) build();

    return {
      element: element,
      degraded: !element,
      step: step,
      itemHeight: itemHeight,
      visibleRows: visibleRows,
      cyclic: cyclic,
      copies: copies,
      base: base,
      total: total,
      values: values.slice(),
      value: currentValue,
      index: function () { return logical; },
      setValue: function (v) {
        var i = indexOfValue(values, v, step);
        if (i >= 0) applyGlobal(base + i, false, true);
        return currentValue();
      },
      scrollToIndex: function (i) {
        if (!isFiniteNum(i) || i < 0) return logical;
        var idx = i > values.length - 1 ? values.length - 1 : i;
        applyGlobal(base + idx, false, true);
        return logical;
      },
      /** 浮层从 hidden 变可见后必须调用：隐藏期赋值 scrollTop 不生效（中间行会读错）。 */
      syncScroll: function () { setScrollTop(activeIndex * itemHeight); return activeIndex; },
      focus: function () { safeFocus(element); },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        settleClear();
        removeListener(element, 'scroll', handleScroll);
        removeListener(element, 'keydown', handleKeyDown);
        removeListener(element, 'mousedown', handleMouseDown);
        removeListener(element, 'wheel', handleWheel);
        removeListener(doc, 'mousemove', handleMouseMove);
        removeListener(doc, 'mouseup', handleMouseUp);
        drag = null;
      }
    };
  }

  /* ===================== createTimeLock：时 + 分两列 ===================== */

  /**
   * 时间「密码锁」：小时列 + 分钟列（分钟刻度 5 分钟）。
   * 迭代 8（F-56）：两列都是**循环轮**（读取位 = 中间行、无上下边界）。
   * @param {object} options {value, step, itemHeight, visibleRows, cyclic, document, ariaLabel, onChange}
   * @returns {{element, degraded, value(), setValue(hhmm), hour(), minute(), syncScroll(), destroy()}}
   */
  function createTimeLock(options) {
    options = options || {};
    var doc = resolveDoc(options);
    var step = normalizeStep(options.step);
    var itemHeight = normalizeItemHeight(options.itemHeight);
    var onChange = isFn(options.onChange) ? options.onChange : null;
    var parts = timeParts(options.value) || { hour: '09', minute: '00' };

    function emit() { if (onChange) onChange(value()); }

    var hourWheel = createWheel({
      document: doc, values: hourOptions(), value: parts.hour,
      itemHeight: itemHeight, visibleRows: options.visibleRows, cyclic: options.cyclic,
      ariaLabel: '小时', onChange: emit
    });
    var minuteWheel = createWheel({
      document: doc, values: minuteOptions(step), value: parts.minute,
      step: step, itemHeight: itemHeight, visibleRows: options.visibleRows, cyclic: options.cyclic,
      ariaLabel: '分钟', onChange: emit
    });

    function value() { return hourWheel.value() + ':' + minuteWheel.value(); }

    var element = null;
    if (doc) {
      element = createEl(doc, 'div', 'dp-lock');
      setAttr(element, 'role', 'group');
      setAttr(element, 'aria-label', options.ariaLabel || '时间选择');
      var hCol = createEl(doc, 'div', 'dp-lock-col');
      var sep = createEl(doc, 'span', 'dp-lock-sep', ':');
      var mCol = createEl(doc, 'div', 'dp-lock-col');
      hCol.appendChild(hourWheel.element);
      mCol.appendChild(minuteWheel.element);
      element.appendChild(hCol);
      element.appendChild(sep);
      element.appendChild(mCol);
    }

    return {
      element: element,
      degraded: !element,
      step: step,
      hour: function () { return hourWheel.value(); },
      minute: function () { return minuteWheel.value(); },
      value: value,
      setValue: function (hhmm) {
        var c = clampTime(hhmm);
        if (!c) return value();
        var p = timeParts(c);
        hourWheel.setValue(p.hour);
        minuteWheel.setValue(p.minute);
        return value();
      },
      /** 浮层从 hidden 变可见后必须调用（两列一起对齐到中间行）。 */
      syncScroll: function () {
        hourWheel.syncScroll();
        minuteWheel.syncScroll();
        return value();
      },
      destroy: function () { hourWheel.destroy(); minuteWheel.destroy(); }
    };
  }

  /* ===================== createCalendar：月历浮层 ===================== */

  /**
   * 周一起始的月历（42 格）。
   * @param {object} options
   *   - value:   'YYYY-MM-DD' 初始选中值
   *   - today:   'YYYY-MM-DD'（可注入；缺省用 datetime.todayISO()）
   *   - ariaLabel / document / returnFocus
   *   - ignoreOutside：元素（或元素数组）——点它不算「外部点击」，不触发 close()
   *     （迭代 7 复核修复：宿主自己的触发按钮必须传进来，否则真实浏览器里按钮关不掉浮层）
   *   - onSelect(iso)：选中日期（含「今天」按钮）；onClose()：close() 被真正触发时
   * 注意：**不设置 element.hidden**（浮层显隐由宿主容器的 pop.hidden 负责，见文件头第 5 条）。
   * @returns {{element, degraded, value(), setValue(iso), month(), shiftMonth(n),
   *   open(), close(), isOpen(), focus(), cells(), destroy()}}
   */
  function createCalendar(options) {
    options = options || {};
    var doc = resolveDoc(options);
    var onSelect = isFn(options.onSelect) ? options.onSelect : null;
    var onClose = isFn(options.onClose) ? options.onClose : null;
    var ariaLabel = options.ariaLabel || '日期选择';

    var injectedToday = isValidIso(options.today) ? options.today : null;
    var monthSeed = (typeof options.month === 'string' && isValidIso(options.month + '-01'))
      ? options.month + '-01' : null;
    var initial = isValidIso(options.value) ? options.value
      : (injectedToday || monthSeed || todayIso() || '1970-01-01');

    var currentValue = initial;
    var focusIso = initial;
    var currentMonth = clampYm(ymOf(initial));
    var today = injectedToday || todayIso();
    var openState = false;
    var destroyed = false;
    var lastFocus = null;
    var docClickBound = false;

    var element = null;
    var gridEl = null;
    var titleEl = null;
    var dayNodes = [];

    function dayLabel(iso) {
      var DT = requireDatetime();
      if (DT && isFn(DT.formatDateCN)) {
        var full = DT.formatDateCN(iso);
        if (typeof full === 'string' && full) return full;
      }
      return iso;
    }

    function handleDocClick(ev) {
      if (!openState || !element) return;
      var target = ev && ev.target;
      if (target && isFn(element.contains) && element.contains(target)) return;
      /* 迭代 7 复核修复：触发按钮（及其容器）不算「外部」。
         否则真实浏览器里 document 的**捕获**阶段会先 close()（onClose 把外层浮层隐藏），
         随后按钮自身的 click 处理器又读不到「已关闭」状态而把它重新打开 → 按钮关不掉。 */
      if (isIgnoredTarget(target)) return;
      close();
    }

    function isIgnoredTarget(target) {
      var list = options.ignoreOutside;
      if (!target || !list) return false;
      var arr = (typeof list.length === 'number' && !isFn(list)) ? list : [list];
      for (var i = 0; i < arr.length; i += 1) {
        var node = arr[i];
        if (!node) continue;
        if (node === target) return true;
        if (isFn(node.contains) && node.contains(target)) return true;
      }
      return false;
    }

    function bindDocClick() {
      if (docClickBound || !doc || !isFn(doc.addEventListener)) return;
      try {
        doc.addEventListener('click', handleDocClick, true);
        docClickBound = true;
      } catch (e) { /* 垫片忽略 */ }
    }

    function unbindDocClick() {
      if (!docClickBound || !doc) return;
      if (isFn(doc.removeEventListener)) {
        try { doc.removeEventListener('click', handleDocClick, true); } catch (e) { /* 忽略 */ }
      }
      docClickBound = false;
    }

    function focusCell() {
      var node = null;
      for (var i = 0; i < dayNodes.length; i += 1) {
        if (dayNodes[i].getAttribute && dayNodes[i].getAttribute('data-iso') === focusIso) {
          node = dayNodes[i];
          break;
        }
      }
      safeFocus(node || gridEl);
    }

    function render() {
      if (!element || !gridEl) return;
      if (titleEl) titleEl.textContent = formatMonthCN(currentMonth) || currentMonth;
      gridEl.textContent = '';
      dayNodes = [];
      var list = monthCells(currentMonth);
      /* 诊断（迭代 8 / F-55）：把首格日期写在外层，便于断言「星期表头与日期列对齐」 */
      setAttr(element, 'data-first-iso', list.length ? list[0] : '');
      setAttr(element, 'data-month', currentMonth);
      for (var i = 0; i < list.length; i += 1) {
        var iso = list[i];
        var day = createEl(doc, 'button', null, String(Number(iso.slice(8, 10))));
        setAttr(day, 'type', 'button');
        setAttr(day, 'data-iso', iso);
        setAttr(day, 'aria-label', dayLabel(iso));
        setAttr(day, 'tabindex', iso === focusIso ? '0' : '-1');
        var cls = ['dp-cal-day'];
        if (iso.slice(0, 7) !== currentMonth) cls.push('is-outside');
        if (today && iso === today) cls.push('is-today');
        if (iso === currentValue) { cls.push('is-active'); setAttr(day, 'aria-selected', 'true'); }
        if (iso === focusIso) cls.push('is-focus');
        day.className = cls.join(' ');
        (function (isoVal) {
          addListener(day, 'click', function (ev) { prevent(ev); commit(isoVal); });
        })(iso);
        dayNodes.push(day);
        gridEl.appendChild(day);
      }
    }

    function commit(iso) {
      if (!isValidIso(iso)) return;
      currentValue = iso;
      focusIso = iso;
      currentMonth = clampYm(ymOf(iso));
      render();
      if (onSelect) onSelect(iso);
      close();
    }

    function moveFocus(delta) {
      var next = addDaysIso(focusIso, delta);
      if (!isValidIso(next)) return;
      focusIso = next;
      var ym = ymOf(next);
      if (ym !== currentMonth) currentMonth = clampYm(ym);
      render();
      focusCell();
    }

    function handleGridKeyDown(ev) {
      if (destroyed) return;
      var key = ev && ev.key;
      var code = ev && ev.keyCode;
      if (key === 'Enter' || code === 13 || key === ' ') { prevent(ev); commit(focusIso); return; }
      if (key === 'Escape' || key === 'Esc' || code === 27) { prevent(ev); close(); return; }
      var delta = 0;
      if (key === 'ArrowLeft' || code === 37) delta = -1;
      else if (key === 'ArrowRight' || code === 39) delta = 1;
      else if (key === 'ArrowUp' || code === 38) delta = -7;
      else if (key === 'ArrowDown' || code === 40) delta = 7;
      else return;
      if (!delta) return;
      prevent(ev);
      moveFocus(delta);
    }

    function build() {
      if (!doc) return;
      element = createEl(doc, 'div', 'dp-calendar');
      setAttr(element, 'role', 'dialog');
      setAttr(element, 'aria-label', ariaLabel);

      var head = createEl(doc, 'div', 'dp-cal-head');
      var prev = createEl(doc, 'button', 'dp-cal-prev', '\u2039');
      setAttr(prev, 'type', 'button');
      setAttr(prev, 'aria-label', '上一月');
      addListener(prev, 'click', function (ev) { prevent(ev); shiftMonth(-1); });

      titleEl = createEl(doc, 'span', 'dp-cal-title');

      var next = createEl(doc, 'button', 'dp-cal-next', '\u203a');
      setAttr(next, 'type', 'button');
      setAttr(next, 'aria-label', '下一月');
      addListener(next, 'click', function (ev) { prevent(ev); shiftMonth(1); });

      var todayBtn = createEl(doc, 'button', 'dp-cal-today', '今天');
      setAttr(todayBtn, 'type', 'button');
      setAttr(todayBtn, 'aria-label', '今天');
      addListener(todayBtn, 'click', function (ev) { prevent(ev); goToday(); });

      head.appendChild(prev);
      head.appendChild(titleEl);
      head.appendChild(next);
      head.appendChild(todayBtn);

      var weekdays = createEl(doc, 'div', 'dp-cal-weekdays');
      for (var i = 0; i < WEEKDAY_CN.length; i += 1) {
        weekdays.appendChild(createEl(doc, 'span', 'dp-cal-wd', WEEKDAY_CN[i]));
      }

      gridEl = createEl(doc, 'div', 'dp-cal-grid');
      setAttr(gridEl, 'role', 'grid');
      setAttr(gridEl, 'tabindex', '0');
      addListener(gridEl, 'keydown', handleGridKeyDown);

      element.appendChild(head);
      element.appendChild(weekdays);
      element.appendChild(gridEl);
      render();
    }

    function shiftMonth(n) {
      if (!isFiniteNum(n)) return currentMonth;
      currentMonth = shiftYm(currentMonth, n);
      var dom = Number(focusIso.slice(8, 10));
      var candidate = null;
      for (var d = dom; d >= 1; d -= 1) {
        var c = currentMonth + '-' + pad2(d);
        if (isValidIso(c)) { candidate = c; break; }
      }
      focusIso = candidate || (currentMonth + '-01');
      render();
      return currentMonth;
    }

    function goToday() {
      var t = today || todayIso();
      if (!t) return currentValue;
      commit(t);
      return currentValue;
    }

    function open() {
      if (destroyed) return;
      openState = true;
      lastFocus = (doc && doc.activeElement) ? doc.activeElement : null;
      if (element) element.className = 'dp-calendar is-open';
      bindDocClick();
      render();
    }

    function close() {
      var was = openState;
      openState = false;
      unbindDocClick();
      if (element) element.className = 'dp-calendar';
      if (was) {
        var ret = options.returnFocus || lastFocus;
        safeFocus(ret);
        if (onClose) onClose();
      }
      return was;
    }

    if (doc) build();

    return {
      element: element,
      degraded: !element,
      value: function () { return currentValue; },
      setValue: function (iso) {
        if (!isValidIso(iso)) return currentValue;
        currentValue = iso;
        focusIso = iso;
        currentMonth = clampYm(ymOf(iso));
        render();
        return currentValue;
      },
      month: function () { return currentMonth; },
      shiftMonth: shiftMonth,
      today: function () { return today; },
      open: open,
      close: close,
      isOpen: function () { return openState; },
      focus: function () {
        if (!element) return;
        if (ymOf(focusIso) !== currentMonth) {
          currentMonth = clampYm(ymOf(focusIso));
          render();
        }
        focusCell();
      },
      cells: function () { return dayNodes.slice(); },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        openState = false;
        unbindDocClick();
        removeListener(gridEl, 'keydown', handleGridKeyDown);
      }
    };
  }

  /* ===================== createOutsideCloser：「点外部关闭」 ===================== */

  /**
   * document **捕获期**的「点外部关闭」判定（迭代 8 / F-58）。
   *
   * 为什么单独抽出来：宿主的浮层显隐由宿主自己拥有（`pop.hidden`），picker 不该碰；
   * 但「点外部关闭」的**时序陷阱**与 createCalendar 里的那份完全相同 ——
   * 真实浏览器中 document 的捕获监听先于目标自身的 click 处理器，判定写错就会出现
   * 「捕获期先关、按钮处理器再开 → 按钮关不掉」（迭代 7 复核 V7）。故把判定做成
   * **纯函数 + 幂等绑定**，宿主只需把**自己的容器**（含触发按钮）放进 ignore。
   *
   * @param {object} options
   *   - document: Document（显式 null = 强制降级；缺省用全局 document）
   *   - ignore: 元素或元素数组（命中其自身或子树 → 不算「外部」）
   *   - isOpen(): boolean（为假时不判定、不回调）
   *   - onOutside(ev): 命中外部时回调（宿主在这里隐藏浮层并 unbind()）
   * @returns {{bind:function, unbind:function, isBound:function, isIgnored:function, handle:function}}
   */
  function createOutsideCloser(options) {
    options = options || {};
    var doc = resolveDoc(options);
    var onOutside = isFn(options.onOutside) ? options.onOutside : null;
    var isOpen = isFn(options.isOpen) ? options.isOpen : function () { return true; };
    var bound = false;

    function isIgnored(target) {
      var list = options.ignore;
      if (!target || !list) return false;
      var arr = (typeof list.length === 'number' && !isFn(list)) ? list : [list];
      for (var i = 0; i < arr.length; i += 1) {
        var node = arr[i];
        if (!node) continue;
        if (node === target) return true;
        if (isFn(node.contains) && node.contains(target)) return true;
      }
      return false;
    }

    /** 纯判定：命中外部 → 回调并返回 true；否则返回 false（绝不改 DOM、不改开合状态）。 */
    function handle(ev) {
      if (!isOpen()) return false;
      if (isIgnored(ev && ev.target)) return false;
      if (onOutside) onOutside(ev);
      return true;
    }

    function bind() {
      if (bound || !doc || !isFn(doc.addEventListener)) return bound;
      try { doc.addEventListener('click', handle, true); bound = true; } catch (e) { /* 垫片忽略 */ }
      return bound;
    }

    function unbind() {
      if (!bound || !doc) { bound = false; return false; }
      if (isFn(doc.removeEventListener)) {
        try { doc.removeEventListener('click', handle, true); } catch (e) { /* 忽略 */ }
      }
      bound = false;
      return true;
    }

    return {
      bind: bind,
      unbind: unbind,
      isBound: function () { return bound; },
      isIgnored: isIgnored,
      handle: handle
    };
  }

  return {
    DEFAULT_MINUTE_STEP: DEFAULT_MINUTE_STEP,
    DEFAULT_ITEM_HEIGHT: DEFAULT_ITEM_HEIGHT,
    DEFAULT_VISIBLE_ROWS: DEFAULT_VISIBLE_ROWS,
    WHEEL_COPIES: WHEEL_COPIES,
    DRAG_THRESHOLD_PX: DRAG_THRESHOLD_PX,
    GRID_CELLS: GRID_CELLS,
    MIN_YM: MIN_YM,
    MAX_YM: MAX_YM,
    MONTH_CN: MONTH_CN,
    WEEKDAY_CN: WEEKDAY_CN,
    minuteOptions: minuteOptions,
    hourOptions: hourOptions,
    snapMinutes: snapMinutes,
    clampTime: clampTime,
    timeParts: timeParts,
    formatDateCN: formatDateCN,
    formatMonthCN: formatMonthCN,
    wheelIndexFor: wheelIndexFor,
    wheelSpan: wheelSpan,
    wheelPad: wheelPad,
    wrapIndex: wrapIndex,
    wheelWrapShift: wheelWrapShift,
    createWheel: createWheel,
    createTimeLock: createTimeLock,
    createCalendar: createCalendar,
    createOutsideCloser: createOutsideCloser
  };
});
