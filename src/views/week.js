/**
 * DayPlan · 周视图（F-18 周视图 / F-20 周计划）
 *
 * 契约：docs/spec/07-iteration-4-delta.md F-29 / F-30、DM-22（week-layout v2）、DM-25（overlay）、
 *       DM-26 R-4/R-5/R-6/R-7（冻结裁定）、US-22.2 / US-24 / US-26 / US-28 / US-29、
 *       ADR-20（**单一几何源**）、ADR-12（**不做空闲压缩**）。
 * 依赖（全部运行时探测 + 优雅降级，不修改其它模块）：
 *   core/datetime.js、core/recurrence.js、core/lunar.js、data/holidays.js、
 *   views/week-layout.js（T44 v2）、ui/itemcard.js（T49）、ui/form.js（T32）、ui/modal.js、
 *   ui/overlay.js（T45）
 *
 * 单一几何源（ADR-20 / BR-36，用户条目 8；迭代 6 / F-38 扩展）：
 *   时间尺（刻度/小时线）与事项块的 top/height **全部**取自同一个纵向映射
 *   `geom.getY(minute)`（= core/layout.js::computeAxisGeometry 的折叠轴；见 §「空闲折叠轴」），
 *   并把它作为 `projectY`/`axisLength` 传给 layoutWeek() 算块坐标；渲染层不再按 settings
 *   重算 rate/height，也不自行分道 —— 分道与列宽权重见 DM-22。
 *   这是「轴被压缩而块没同步」的根因修复。
 *
 * 冻结签名：
 *   createWeekView({store, container, onSelectDate, onOpenDay, onDataChanged}) ->
 *     {element, render(), refresh(), setDate(iso, opts), shiftWeek(delta),
 *      openNewWeekPlan(), getWeekStart(), flushNotes()}
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var D = root.DayPlan.datetime;
  var Recurrence = root.DayPlan.recurrence;
  var WeekLayout = root.DayPlan.weekLayout;
  var Layout = root.DayPlan.layout;      /* 迭代 6（F-38）：复用日视图的折叠轴纯函数 */
  var M = root.DayPlan.modal;
  var el = M.el;

  var DOW_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var NOTES_DEBOUNCE_MS = 300;
  var DEFAULT_WEEK_PX_PER_HOUR = 56;   /* F-18.1：settings.weekPxPerHour 默认 56 */
  var DEFAULT_COMPRESS_HEIGHT = 26;    /* F-38：settings.idleCompressHeight 兜底（DM-21） */
  var DEFAULT_LANES_MAX = 3;           /* DM-19.2：周视图仅作列宽权重下限 */
  var WEEK_LANE_HARD_CAP = 6;          /* DM-19.4 / DM-22：道数硬上限 */
  var WEEK_GRID_AXIS_WIDTH = 52;       /* .week-grid 第一列（时间轴）像素宽（US-29） */
  var WEEK_MIN_DAY_WIDTH_PX = 84;      /* 迭代 8（F-52）：无内容时单天列宽的兜底（与静态 CSS 的 84px 一致） */
  var HOURS_PER_DAY = 24;
  var MINUTES_PER_DAY = 1440;
  var MS_PER_DAY = 86400000;
  var DEFAULT_CAT_COLOR = '#94a3b8';

  function numOr(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback;
  }

  function clampInt(value, lo, hi, fallback) {
    var n = Math.round(numOr(value, fallback));
    if (!isFinite(n)) n = fallback;
    return Math.max(lo, Math.min(hi, n));
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** 周视图胶囊只显示类别首字（与 ui/itemcard.js::firstChar 同口径，按码点取） */
  function chipLabelOf(name) {
    var s = (name === null || name === undefined) ? '' : String(name);
    if (!s) return '';
    return String.fromCodePoint(s.codePointAt(0));
  }

  function errText(e) {
    return (e && e.message) ? e.message : String(e);
  }

  /**
   * DM-18.2：紧急类别 id —— 优先取 schema.URGENT_CATEGORY_ID，缺失时回落字面量。
   * 迭代 4 起「紧急」一律由 `categoryId === 紧急 id` 表达（DM-18.4：starred 仅作迁移输入保留）。
   */
  function urgentCategoryId() {
    var S = root.DayPlan ? root.DayPlan.schema : null;
    if (S && typeof S.URGENT_CATEGORY_ID === 'string' && S.URGENT_CATEGORY_ID) return S.URGENT_CATEGORY_ID;
    return 'urgent';
  }

  function isUrgentCategoryId(value) {
    return value === urgentCategoryId();
  }

  /** 紧急类别的当前显示名（设置里改名后，toast / 范围弹窗跟随）。 */
  function urgentName() {
    var list = docOf().categories || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === urgentCategoryId()) return list[i].name || '紧急';
    }
    return '紧急';
  }

  /* ------------------------------------------------------------------ *
   * 单一几何源（ADR-20 / BR-36 / US-26）
   * ------------------------------------------------------------------ */

  /**
   * 归一化 layoutWeek() 的返回值为渲染层**唯一**几何来源。
   *
   * - `pxPerHour`/`height` 一律取返回值；**缺省（不传 projectY/axisLength）时**恒有
   *   `height === 1440 × pxPerHour/60`；迭代 6 起周视图传入折叠轴，此时 `height = axisLength`
   *   （= lead + real + trail，可远小于整日 1:1），两者仍同源（渲染层只用 weights/columns，
   *   不再依赖 height/pxPerHour 的整日等式）。
   *   绝不回读 `settings.weekPxPerHour` 重算（那正是用户条目 8 的根因）。
   *   兼容：week-layout 仍是迭代 3 旧版（无 pxPerHour 字段）时，由返回的 `height` 反推
   *   `pxPerHour = height/1440×60` —— 该路径只在旧版（无折叠）下出现，故仍成立。
   * - `widthWeight` 取 `columns[i].widthWeight`（DM-22 / DM-26 R-6：空天 = maxLanes）；
   *   旧版无该字段时退化为 maxLanes（等宽，即迭代 3 行为）。
   *
   * @returns {{pxPerHour:number, rate:number, height:number, columns:Array, weights:number[]}}
   */
  function normalizeLayoutResult(layout, days, requestedPxPerHour, lanesMax) {
    var src = (layout && typeof layout === 'object') ? layout : {};
    var pxPerHour = numOr(src.pxPerHour, NaN);
    var height = numOr(src.height, NaN);
    if (!isFinite(pxPerHour) || pxPerHour <= 0) {
      pxPerHour = (isFinite(height) && height > 0)
        ? (height / MINUTES_PER_DAY) * 60
        : requestedPxPerHour;
    }
    if (!isFinite(height) || height <= 0) height = MINUTES_PER_DAY * (pxPerHour / 60);
    var rate = pxPerHour / 60;

    var srcColumns = (src.columns && src.columns.length) ? src.columns : [];
    var byIso = {};
    srcColumns.forEach(function (col) {
      if (col && typeof col.iso === 'string' && col.iso && byIso[col.iso] === undefined) byIso[col.iso] = col;
    });

    var weights = [];
    var widths = [];
    var columns = days.map(function (iso, i) {
      var col = byIso[iso] || srcColumns[i] || null;
      var weight = (col && isFinite(numOr(col.widthWeight, NaN)))
        ? clampInt(col.widthWeight, 1, WEEK_LANE_HARD_CAP, lanesMax)
        : clampInt(lanesMax, 1, WEEK_LANE_HARD_CAP, DEFAULT_LANES_MAX);
      weights.push(weight);
      /* 迭代 8（F-52）：内容驱动的列宽（像素）；缺省 0 = 由渲染层回落到等分 */
      var wpx = col ? numOr(col.widthPx, 0) : 0;
      widths.push(isFinite(wpx) && wpx > 0 ? wpx : 0);
      return col || { iso: iso, laneCount: 0, widthWeight: weight, widthPx: 0, overflowCount: 0, items: [] };
    });

    return {
      pxPerHour: pxPerHour, rate: rate, height: height, columns: columns,
      weights: weights, widths: widths
    };
  }

  /**
   * 事项块定位：**直接使用** week-layout 的 left/width/top/height（ADR-20，渲染层不重算几何）。
   *
   * DM-26 R-7（冻结）：v2 的 `left` **不含**溢出偏移（`left = lane/laneCount×100` 纯净百分比），
   * `overflowOffsetX`（= 序号 × 6 个百分点，仅全局道数 > laneCap=6 时出现）**由渲染层相加**。
   * 这里的自检仅用于兼容被 DM-22 取代的 v1 口径（v1 已把偏移折进 left，此时不再重复相加）。
   */
  function itemPlacement(item) {
    var left = numOr(item.left, 0);
    var width = numOr(item.width, 100);
    var offset = numOr(item.overflowOffsetX, 0);
    if (offset) {
      var lane = numOr(item.lane, NaN);
      var folded = isFinite(lane) && Math.abs(left - lane * width) >= 0.01; /* v1 已折入 → 不重复加 */
      if (!folded) left += offset;                                          /* R-7：渲染层相加 */
    }
    return {
      left: left,
      width: width,
      top: numOr(item.top, 0),
      height: numOr(item.height, 0)
    };
  }

  /**
   * 降级几何（layoutWeek 缺失或抛错时）：用**同一对** rate/height 做线性定位，
   * 保证时间尺与事项块仍然同源（要求 1）。此路径不分道，仅保证不崩且坐标一致。
   * 迭代 6（F-38）：给了 projectY 时与主路径共用同一折叠映射。
   */
  function fallbackLayout(byDate, days, rate, height, lanesMax, projectY) {
    var project = (typeof projectY === 'function') ? projectY : null;
    function topOf(minute) {
      if (project) {
        var v = project(minute);
        if (typeof v === 'number' && isFinite(v)) return v;
      }
      return minute * rate;
    }
    var columns = days.map(function (iso) {
      var items = [];
      (byDate[iso] || []).forEach(function (occ) {
        if (!occ || !occ.time || typeof D.minutesOf !== 'function') return;
        var start = D.minutesOf(occ.time.start);
        var end = D.minutesOf(occ.time.end);
        if (!isFinite(start) || !isFinite(end) || end <= start) return;
        var top = topOf(start);
        items.push({
          occ: occ, categoryId: occ.categoryId, lane: 0, left: 0, width: 100,
          top: top,
          height: Math.max(topOf(end) - top - 2, 22)
        });
      });
      return {
        iso: iso, laneCount: items.length ? 1 : 0,
        widthWeight: clampInt(lanesMax, 1, WEEK_LANE_HARD_CAP, DEFAULT_LANES_MAX),
        overflowCount: 0, items: items
      };
    });
    return { pxPerHour: rate * 60, height: height, columns: columns };
  }

  /**
   * ISO 周序号（周一为一周之始；周四所在年决定周数）。
   * 例：2026-10-12 → 第 42 周。
   */
  function isoWeekNumber(iso) {
    var ymd = D.parseYearMonth(iso);
    if (!ymd) return 0;
    var d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
    var dow = (d.getUTCDay() + 6) % 7;                 /* 周一 = 0 */
    d.setUTCDate(d.getUTCDate() - dow + 3);            /* 该周周四 */
    var firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    var fDow = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - fDow + 3);
    return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  }

  /**
   * 标题：2026 年 10 月 12 日 – 10 月 18 日
   * 迭代 6（F-41 / R-19）：不再输出「（第 N 周）」——界面与 Excel 两处口径一致；
   * isoWeekNumber 仍保留导出（供工具/单元格口径复用）。
   */
  function weekTitle(monday) {
    var sunday = D.addDays(monday, 6);
    var a = D.parseYearMonth(monday);
    var b = D.parseYearMonth(sunday);
    if (!a || !b) return String(monday || '');
    var right;
    if (b.year !== a.year) right = b.year + ' 年 ' + b.month + ' 月 ' + b.day + ' 日';
    else if (b.month !== a.month) right = b.month + ' 月 ' + b.day + ' 日';
    else right = b.month + ' 月 ' + b.day + ' 日';
    return a.year + ' 年 ' + a.month + ' 月 ' + a.day + ' 日 – ' + right;
  }

  function createWeekView(opts) {
    opts = opts || {};
    var store = opts.store;
    var container = opts.container || null;

    var state = { monday: null, hideDone: false };
    var notesTimer = null;
    var lastRenderStamp = null;   /* 最近一次渲染时的文档指纹（见 setWeekStart 的过期判断） */

    /* ------------------------------------------------------------------ *
     * 1. 静态骨架（只建一次：记录栏不能在重渲染时被重建，否则会丢焦点）
     * ------------------------------------------------------------------ */

    var titleEl = el('h1', { class: 'week-title', id: 'week-title', text: '—' });

    var btnPrev = el('button', {
      class: 'date-nav-btn date-nav-arrow', type: 'button', id: 'btn-week-prev',
      title: '上一周（Alt+←）', 'aria-label': '上一周',
      text: '‹', onclick: function () { shiftWeek(-1); }
    });
    var btnThis = el('button', {
      class: 'date-nav-btn is-current', type: 'button', id: 'btn-week-current', title: '回到本周',
      text: '本周', onclick: function () { setWeekStart(D.startOfWeek(D.todayISO()), { notify: true }); }
    });
    var btnNext = el('button', {
      class: 'date-nav-btn date-nav-arrow', type: 'button', id: 'btn-week-next',
      title: '下一周（Alt+→）', 'aria-label': '下一周',
      text: '›', onclick: function () { shiftWeek(1); }
    });
    var btnNew = el('button', {
      class: 'btn-add-round', type: 'button', id: 'btn-new-week-plan',
      title: '新建周计划（Shift+W）', 'aria-label': '新建周计划', text: '+',
      onclick: function () { openNewWeekPlan(); }
    });

    var gridEl = el('div', { class: 'week-grid', id: 'week-grid' });
    /* 迭代 8（F-52）：列宽由内容决定 → 整周总宽可能超过容器，故加一层横向滚动 */
    var gridScrollEl = el('div', { class: 'week-grid-scroll', id: 'week-grid-scroll' }, [gridEl]);
    var notesStatus = el('span', { class: 'muted', id: 'week-notes-status' });
    var notesInput = el('textarea', {
      class: 'notes-input', id: 'week-notes-input', rows: '4',
      'aria-label': '当周记录'
    });

    /* 迭代 10 批次 4（条8）：white-card = .panel-day —— 与日视图同一张白卡、同样的圆角/投影 */
    var rootEl = el('div', { class: 'week-view panel-day', id: 'week-view' });
    rootEl.appendChild(el('div', { class: 'week-head' }, [
      titleEl,
      el('div', { class: 'head-actions' }, [
        el('div', { class: 'date-nav', role: 'group', 'aria-label': '周导航' }, [btnPrev, btnThis, btnNext]),
        btnNew
      ])
    ]));
    /* 迭代 10 批次 4（条8）：左侧周表 + 右侧「当周记录」（独立白底、与周表等高相对静止） */
    var railEl = el('aside', { class: 'side-rail', id: 'week-rail', 'aria-label': '当周记录' }, [
      el('section', { class: 'notes-section', 'aria-label': '当周记录' }, [
        el('div', { class: 'section-head' }, [
          el('h2', { text: '当周记录' }),
          notesStatus
        ]),
        notesInput
      ])
    ]);
    /* 悬停预览的边界参照（.week-scroll 会横向滚动，展开后需按它的视口让位） */
    var scrollEl = el('div', { class: 'week-scroll', id: 'week-scroll' }, [gridScrollEl]);
    rootEl.appendChild(el('div', { class: 'view-body', id: 'week-view-body' }, [
      el('div', { class: 'view-main' }, [scrollEl]),
      railEl
    ]));
    if (container) container.appendChild(rootEl);

    /* ------------------------------------------------------------------ *
     * 2. 事件接线
     * ------------------------------------------------------------------ */

    notesInput.addEventListener('input', function () {
      updateNotesStatus(true);
      if (notesTimer) clearTimeout(notesTimer);
      notesTimer = setTimeout(function () { notesTimer = null; flushNotes(); }, NOTES_DEBOUNCE_MS);
    });
    notesInput.addEventListener('blur', function () { flushNotes(); });
    notesInput.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
        e.preventDefault();
        flushNotes();
        M.toast('当周记录已保存');
      }
    });

    /* ------------------------------------------------------------------ *
     * 2.5 导航出口 + 展开浮层（US-22.2 / US-24）
     * ------------------------------------------------------------------ */

    /** S26 / US-22.2：单击某一天（列头或列空白）→ 进入日视图（app 的 onOpenDay → goDay）。 */
    function openDay(iso) {
      if (!D.isValidDate(iso)) return;
      if (typeof opts.onOpenDay === 'function') opts.onOpenDay(iso);
    }

    /* US-24 / DM-25：展开卡临时脱层；模块缺失或无 getBoundingClientRect 时 pin() 返回 false，
     * 此时保持「原位展开」（CSS .wk-item.is-expanded）。 */
    var pinner = (function () {
      var O = root.DayPlan ? root.DayPlan.overlay : null;
      if (!O || typeof O.createExpandPinner !== 'function') return null;
      try {
        /* 迭代 10 批次 3（条7）：展开后与原块同宽（周视图按钮竖排，不再强制 220px） */
        return O.createExpandPinner({ zIndex: 60, minWidth: 0 });
      } catch (e) { return null; }
    })();

    /* ------------------------------------------------------------------ *
     * 3. 当周记录（F-18.3 / DM-8.1：键 = 该周周一）
     * ------------------------------------------------------------------ */

    function updateNotesStatus(saving) {
      notesStatus.textContent = (saving ? '保存中… ' : '') + notesInput.value.length + ' 字';
    }

    /** 从 store 载入当前周的记录；有未落盘的输入时不覆盖。 */
    function loadNotes() {
      if (notesTimer) { updateNotesStatus(true); return; }
      var rec = null;
      if (state.monday && typeof store.getWeekNote === 'function') {
        try { rec = store.getWeekNote(state.monday); } catch (e) { rec = null; }
      }
      var text = (rec && typeof rec.text === 'string') ? rec.text : '';
      var focused = root.document ? root.document.activeElement : null;
      if (focused !== notesInput) notesInput.value = text;   /* 正在输入时不覆盖 */
      updateNotesStatus(false);
    }

    /** 立即落盘（防抖到期 / blur / Ctrl+S / 页面隐藏时由 app 调用）。 */
    function flushNotes() {
      if (notesTimer) { clearTimeout(notesTimer); notesTimer = null; }
      if (!state.monday || typeof store.setWeekNote !== 'function') { updateNotesStatus(false); return; }
      try {
        store.setWeekNote(state.monday, notesInput.value);
        updateNotesStatus(false);
      } catch (e) {
        M.toast('当周记录保存失败：' + errText(e));
      }
    }

    /* ------------------------------------------------------------------ *
     * 4. 数据 / 时间轴
     * ------------------------------------------------------------------ */

    function docOf() {
      try { return (store.getState && store.getState()) || {}; } catch (e) { return {}; }
    }

    function settingsOf(doc) { return (doc && doc.settings) || {}; }

    function weekDays(monday) {
      var out = [];
      for (var i = 0; i < 7; i += 1) out.push(D.addDays(monday, i));
      return out;
    }

    /**
     * 取 [from, to) 内的发生（F-18.1）。
     * 优先 recurrence.occurrencesInRange（T32），缺失时逐日 occurrencesForDate（结果一致）。
     */
    function occurrencesBetween(doc, from, to) {
      if (!Recurrence) return [];
      if (typeof Recurrence.occurrencesInRange === 'function') {
        try { return Recurrence.occurrencesInRange(doc, from, to) || []; } catch (e) { /* 降级 */ }
      }
      var out = [];
      if (typeof Recurrence.occurrencesForDate !== 'function') return out;
      for (var d = from; d && D.diffDays(d, to) > 0; d = D.addDays(d, 1)) {
        try {
          var list = Recurrence.occurrencesForDate(doc, d) || [];
          for (var i = 0; i < list.length; i += 1) out.push(list[i]);
        } catch (e) { /* 跳过该日 */ }
      }
      return out;
    }

    /* ---------------- 节假日 / 农历（F-21.2，全部容错） ---------------- */

    function holidayOf(iso) {
      var H = root.DayPlan ? root.DayPlan.holidays : null;
      if (!H || typeof H.holidayOf !== 'function') return null;
      try { return H.holidayOf(iso); } catch (e) { return null; }
    }

    /** 假期名称只在窗口首日显示（上一日不是同类标注即视为首日）。 */
    function isHolidayRunStart(iso, type) {
      var prev = D.addDays(iso, -1);
      if (!prev) return true;
      var ph = holidayOf(prev);
      return !(ph && ph.type === type);
    }

    function lunarOf(iso) {
      var Lunar = root.DayPlan ? root.DayPlan.lunar : null;
      if (!Lunar || typeof Lunar.solarToLunar !== 'function') return null;
      var l;
      try { l = Lunar.solarToLunar(iso); } catch (e) { return null; }
      if (!l) return null;
      var monthName = Lunar.lunarMonthName
        ? Lunar.lunarMonthName(l.month, l.isLeap)
        : ((l.isLeap ? '闰' : '') + l.month + '月');
      var dayName = Lunar.lunarDayName ? Lunar.lunarDayName(l.day) : String(l.day);
      return { monthName: monthName, dayName: dayName, raw: l };
    }

    /* ---------------- 列头 / 时间轴 / 列 ---------------- */

    /* ------------------------------------------------------------------ *
     * 空闲折叠轴（迭代 6 / F-38 / R-16）
     *   与日视图**同一实现**：core/layout.js::computeAxisGeometry / axisTicks / axisIdleBands。
     *   折叠对象 = 整周可见时段事项的 [00:00, 全周首个 start) 与 (全周末个 end, 24:00]，
     *   全周首个与末个之间严格 1:1（两事项之间不压缩）；7 天列与左侧轴共用同一 getY。
     * ------------------------------------------------------------------ */

    /** 该周可见的时段事项（折叠几何的唯一输入；非时段/非法时段由纯函数自行跳过）。 */
    function weekTimedOccurrences(byDate, days) {
      var out = [];
      days.forEach(function (iso) {
        (byDate[iso] || []).forEach(function (occ) { if (occ && occ.time) out.push(occ); });
      });
      return out;
    }

    /**
     * 归一化刻度：{minute, hour, top, outside}。
     * 优先 axisTicks（带压缩区标记）；缺 Layout.axisTicks 时退化为整日整点 1:1。
     */
    function tickList(geom) {
      var out = [];
      if (geom.ticks && geom.ticks.length) {
        geom.ticks.forEach(function (t) {
          if (!t || !isFinite(t.minute) || t.minute >= MINUTES_PER_DAY) return;
          var top = numOr(t.pos, NaN);
          if (!isFinite(top)) top = numOr(t.y, NaN);
          if (!isFinite(top)) top = geom.getY(t.minute);
          out.push({ minute: t.minute, hour: Math.floor(t.minute / 60), top: top, outside: !!t.outside });
        });
        return out;
      }
      for (var m = 0; m < MINUTES_PER_DAY; m += 60) {
        out.push({ minute: m, hour: m / 60, top: geom.getY(m), outside: false });
      }
      return out;
    }

    /**
     * 周视图纵向几何（单一几何源，ADR-20 / BR-36 / F-38）：
     *   - 有时段事项且 computeAxisGeometry 可用 → 折叠轴（height = lead + real + trail）；
     *   - 否则 → 整日 1:1（height = 1440 × pxPerHour/60，无折叠带）。
     */
    function axisGeometry(doc, days, byDate, pxPerHour) {
      var settings = settingsOf(doc);
      var full = MINUTES_PER_DAY * (pxPerHour / 60);
      var compressible = settings.idleCompressEnabled !== false;
      var compressHeight = clampInt(settings.idleCompressHeight, 16, 48, DEFAULT_COMPRESS_HEIGHT);
      var axis = (Layout && typeof Layout.computeAxisGeometry === 'function')
        ? Layout.computeAxisGeometry(weekTimedOccurrences(byDate, days), {
          pxPerHour: pxPerHour, compressHeight: compressHeight, compressible: compressible
        })
        : null;
      if (!axis) {
        return {
          pxPerHour: pxPerHour, height: full, bands: [], ticks: null, raw: null,
          getY: function (minute) { return minute * (pxPerHour / 60); }
        };
      }
      var height = numOr(axis.axisLength, numOr(axis.totalHeight, full));
      return {
        pxPerHour: pxPerHour,
        height: height,
        bands: (Layout && typeof Layout.axisIdleBands === 'function') ? Layout.axisIdleBands(axis) : [],
        ticks: (Layout && typeof Layout.axisTicks === 'function') ? Layout.axisTicks(axis, { stepMinutes: 60 }) : null,
        raw: axis,
        getY: function (minute) { return axis.getY(minute); }
      };
    }

    /**
     * 首末空闲折叠窄带（F-38）：纵向轴上的「横向窄带」，
     * top / height 直接取 geometry 的 band.start / band.length（与块同一映射，渲染层不重算）。
     */
    function idleBandNode(band, withLabel) {
      var from = D.formatMinutes(band.fromMinute);
      var to = (band.toMinute >= MINUTES_PER_DAY) ? '24:00' : D.formatMinutes(band.toMinute);
      var text = from + '–' + to + ' 无安排（已折叠）';
      var node = el('div', { class: 'wk-idle is-' + band.kind, title: text, 'aria-hidden': 'true' });
      node.style.top = Math.round(numOr(band.start, 0)) + 'px';
      node.style.height = Math.round(Math.max(0, numOr(band.length, 0))) + 'px';
      /* 轴列窄带不显示文字（美化迭代：去掉「折叠」竖排小字，只留底纹与悬停提示）；日列窄带同样只留底纹 */
      return node;
    }

    function headerCell(iso, idx, today, showHoliday) {
      var hd = showHoliday ? holidayOf(iso) : null;
      var bits = [D.formatDateCN(iso)];
      if (hd) bits.push((hd.type === 'workday' ? '班 ' : '休 ') + hd.name);

      var cell = el('div', {
        class: 'wk-head' + (iso === today ? ' is-today' : ''),
        'data-date': iso,
        title: bits.join(' · '),
        'aria-label': bits.join('，')
      });
      cell.appendChild(el('span', { class: 'wk-dow', text: DOW_LABELS[idx] }));
      /* 迭代 10 批次 2（条3）：表头只显示星期 —— 日期与农历不再渲染；
         完整日期、农历与节假日信息保留在 title / aria-label 里（可读性与悬停提示不丢） */
      if (hd) {
        var flag = hd.type === 'workday' ? '班' : '休';
        cell.appendChild(el('span', {
          class: 'hd-tag ' + (hd.type === 'workday' ? 'is-workday' : 'is-holiday'),
          text: isHolidayRunStart(iso, hd.type) ? (flag + ' ' + hd.name) : flag,
          title: flag + ' ' + hd.name
        }));
      }
      /* S26 / US-22.2：单击列头 → 日视图 */
      cell.addEventListener('click', function () { openDay(iso); });
      return cell;
    }

    /**
     * 纵向时间轴（00:00 在上、24:00 在下）：高度 = 折叠轴总高（F-38）。
     *
     * 刻度/小时线的 `top` 与事项块共享同一映射（ADR-20 / BR-36 / F-38）：
     * 迭代 4 为 `top = h × pxPerHour`；迭代 6 起改为 `geom.getY(minute)`（= 折叠轴），
     * **折叠区内（outside）不绘制刻度与小时线**（与日视图同一口径）。
     */
    function axisNode(geom) {
      var axis = el('div', {
        class: 'wk-axis', id: 'week-axis',
        'aria-label': '时间轴 00:00 至 24:00'
      });
      axis.style.height = geom.height + 'px';
      tickList(geom).forEach(function (t) {
        if (t.outside) return;
        var tick = el('span', { class: 'wk-axis-tick', text: pad2(t.hour) + ':00' });
        tick.style.top = t.top + 'px';
        axis.appendChild(tick);
        var line = el('div', { class: 'wk-hourline' });
        line.style.top = t.top + 'px';
        axis.appendChild(line);
      });
      geom.bands.forEach(function (band) { axis.appendChild(idleBandNode(band, true)); });
      return axis;
    }

    function fallbackCard(occ, cats) {
      var cat = (cats && cats[occ.categoryId]) || { name: '未分类', color: DEFAULT_CAT_COLOR };
      var card = el('div', {
        class: 'wk-item' + (occ.done ? ' is-done' : ''),
        role: 'button', tabindex: '0',
        style: '--cat:' + cat.color + ';',
        title: (occ.time ? occ.time.start + '–' + occ.time.end + ' ' : '') + (occ.title || '')
      });
      card.appendChild(el('div', { class: 'wk-time', text: occ.time ? occ.time.start + '–' + occ.time.end : '' }));
      card.appendChild(el('div', { class: 'wk-title', text: occ.title || '' }));
      /* 迭代 4（S31.4 / AC-27.5）：星标 UI 下线，降级卡也不渲染 ★ */
      card.addEventListener('click', function () { setExpanded(occ, !isExpanded(occ)); });
      return card;
    }

    /**
     * 周内事项卡（F-18.5）：优先 ui/itemcard.js（variant="week"），缺失时最简降级。
     * @param {object} occ 发生
     * @param {object} geo item 几何（left/width/top/height 百分比与像素）
     * @param {object} cats 类别表
     * @param {boolean} [tooNarrow] 迭代 8（F-53）：由 week-layout 用**真实像素宽**判定的窄块标记
     * @param {boolean} [omit] 2026-10-20：放不下标题但放得下「…」+首字 → 省略态
     */
    function weekCard(occ, geo, cats, tooNarrow, omit) {
      var ItemCard = root.DayPlan ? root.DayPlan.itemcard : null;
      var card = null;
      if (ItemCard && typeof ItemCard.createItemCard === 'function') {
        try {
          card = ItemCard.createItemCard(occ, {
            variant: 'week',
            cats: cats,
            expanded: isExpanded(occ),
            /* 2026-10-21：展开卡按原块真实像素宽高挑按钮排布（非省略块不再放大）。
               缺 pxWidth 的降级几何走默认竖排。 */
            origWidth: numOr(geo.pxWidth, 0),
            origHeight: numOr(geo.height, 0),
            /* 迭代 8（F-53）：窄到不显示内容的块 —— 由 week-layout 用真实像素宽判定后传入；
               卡片**不再**自行按「时长 × pxPerHour」估算（那个估算在周视图里没有像素依据） */
            tooNarrow: !!tooNarrow,
            /* 2026-10-20：省略态（「…」+ 类别首字），同样由 week-layout 判定 */
            omit: !!omit,
            onToggleExpand: function (o, next) { setExpanded(o, next); },
            onToggleDone: function (o) { toggleDone(o); },
            /* 迭代 4（S31 / AC-27.5）：itemcard 的按钮为「紧急 / 取消紧急」 */
            onToggleUrgent: function (o) { toggleUrgent(o); },
            onEdit: function (o) { openEdit(o); },
            onRemove: function (o) { removeOccurrence(o); },
            onRestoreDefault: function (o) { restoreDefault(o); },
            /* 迭代 7（F-45 第 6 条 / R-23）：只设紧急未做其他改动 → 不渲染「恢复默认」 */
            hasNonUrgentOverride: function (o) {
              return (typeof store.hasNonUrgentOverride === 'function') ? store.hasNonUrgentOverride(o) : false;
            },
            /* 悬停预览贴右边界时左移让位，需要周表滚动容器作为参照 */
            peekContainer: function () { return scrollEl; }
          });
        } catch (e) { card = null; }
      }
      if (!card) card = fallbackCard(occ, cats);
      /* 几何全部来自 week-layout 的返回值（ADR-20）：top/height 为像素，left/width 为列内百分比 */
      var place = itemPlacement(geo);
      card.style.left = place.left + '%';
      card.style.width = place.width + '%';
      card.style.top = place.top + 'px';
      card.style.height = place.height + 'px';
      /* 迭代 10 批次 3（条7）：展开后先保持原块高度，内容放不下时才向下加长 */
      card.style.setProperty('--block-h', place.height + 'px');
      /* US-22.2：事项块的点击=折叠/展开，不得冒泡到 .wk-col 触发「进入日视图」 */
      card.addEventListener('click', function (e) {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      });
      return card;
    }

    function columnNode(iso, col, geom, today, cats) {
      var node = el('div', {
        class: 'wk-col' + (iso === today ? ' is-today' : ''),
        'data-date': iso
      });
      node.style.height = geom.height + 'px';
      /* 小时线：与轴刻度同一映射，折叠区内不绘制（F-38） */
      tickList(geom).forEach(function (t) {
        if (t.outside) return;
        var line = el('div', { class: 'wk-hourline' });
        line.style.top = t.top + 'px';
        node.appendChild(line);
      });
      /* 首末空闲折叠窄带：与轴列同位同高 → 8 格横向拼成连续窄带 */
      geom.bands.forEach(function (band) { node.appendChild(idleBandNode(band, false)); });
      var items = (col && col.items) || [];
      items.forEach(function (item) {
        if (!item || !item.occ) return;
        var card = weekCard(item.occ, item, cats, item.tooNarrow, item.omit);
        node.appendChild(card);
        /* US-24 / DM-25：展开卡 pin 到本列；pin 返回 false（无 rect 能力）→ 保持原位展开 */
        if (pinner && isExpanded(item.occ)) {
          try { pinner.pin(card, node); } catch (e) { /* 降级：原位展开 */ }
        }
      });
      /* S26 / US-22.2：单击列空白（不含事项块）→ 日视图 */
      node.addEventListener('click', function (e) {
        var t = e && e.target;
        if (t && t !== node) {
          if (typeof t.closest === 'function' && (t.closest('.wk-item') || t.closest('.item-detail'))) return;
          if (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'A') return;
        }
        openDay(iso);
      });
      return node;
    }

    /* ---------------- 渲染 ---------------- */

    function renderGrid(doc, monday) {
      var settings = settingsOf(doc);
      var pxPerHourSetting = numOr(settings.weekPxPerHour, DEFAULT_WEEK_PX_PER_HOUR);
      var lanesMax = clampInt(settings.maxLanes, 1, WEEK_LANE_HARD_CAP, DEFAULT_LANES_MAX);
      var showHoliday = settings.showHolidayMarker !== false;
      var today = D.todayISO();

      var cats = {};
      (doc.categories || []).forEach(function (c) { cats[c.id] = c; });

      /* 类别次序（DM-3 / BR-29）：作为 week-layout 的分桶序（紧急由 pinFirst 提到最前） */
      var categoryOrder = (doc.categories || []).slice().sort(function (a, b) {
        var ao = numOr(a && a.order, 0);
        var bo = numOr(b && b.order, 0);
        if (ao !== bo) return ao - bo;
        var ac = String((a && a.createdAt) || '');
        var bc = String((b && b.createdAt) || '');
        if (ac !== bc) return ac < bc ? -1 : 1;
        return String(a && a.id) < String(b && b.id) ? -1 : 1;
      }).map(function (c) { return c.id; });

      var days = weekDays(monday);
      var byDate = {};
      days.forEach(function (iso) { byDate[iso] = []; });
      occurrencesBetween(doc, monday, D.addDays(monday, 7)).forEach(function (occ) {
        if (!occ || !occ.date || !byDate[occ.date]) return;
        if (state.hideDone && occ.done) return;      /* F-18.4 / item 8 */
        byDate[occ.date].push(occ);
      });

      /* ---------------- 唯一几何源：折叠轴 + layoutWeek（ADR-20 / BR-36 / F-38） ---------------- */
      var geom = axisGeometry(doc, days, byDate, pxPerHourSetting);
      var rawLayout = null;
      if (WeekLayout && typeof WeekLayout.layoutWeek === 'function') {
        try {
          rawLayout = WeekLayout.layoutWeek(days.map(function (iso) {
            return { iso: iso, occurrences: byDate[iso] };
          }), {
            pxPerHour: pxPerHourSetting,
            lanesMax: lanesMax,
            laneCap: WEEK_LANE_HARD_CAP,
            categoryOrder: categoryOrder,
            pinFirst: 'urgent',
            /* F-38：块 top/height 与轴共用折叠映射；axisLength 保证「轴高 = 内容区高」 */
            projectY: geom.getY,
            axisLength: geom.height,
            /* 迭代 8（F-52）：列宽由内容决定 —— 每个类别列宽 = 该类别事项所需宽度的最大值
               （下限保证时间不换行、上限封顶）；某天列宽 = 其构成类别列宽之和 */
            measureWidth: function (occ, cellItems) {
              if (!Layout || typeof Layout.maxBlockWidthNeed !== 'function') {
                if (root.console) console.warn('[DayPlan] measureWidth 降级：Layout.maxBlockWidthNeed 缺失');
                return 0;
              }
              try {
                /* 美化迭代 10：类别胶囊占宽参与列宽度量（周视图胶囊 padding 2×6 + gap 6）。
                   迭代 10 反馈修复：week-layout 的列宽投票以 measureWidth(null, bucket) 调用
                   （occ 恒为 null），此前 occ 为空时胶囊宽被跳过 → 列宽从不包含胶囊，
                   而 weekCard 的显示判定又要求「标题+胶囊」放得下 → 胶囊几乎恒被隐藏。
                   同一 bucket 内事项共享类别 → 从 occ 或 bucket 首个事项取 categoryId。 */
                var chipW = 0;
                var chipSrc = occ || (cellItems && cellItems[0]) || null;
                if (typeof Layout.chipWidthFor === 'function' && chipSrc) {
                  var cat = (doc.categories || []).filter(function (c) { return c && c.id === chipSrc.categoryId; })[0];
                  /* 迭代 10 批次 1 二轮反馈：胶囊只显示类别首字 → 列宽度量也只按首字占宽 */
                  chipW = Layout.chipWidthFor(chipLabelOf(cat ? cat.name : ''), { padX: 12, gap: 6 });
                }
                return Layout.maxBlockWidthNeed(cellItems || [], { chipWidth: chipW });
              } catch (e) { return 0; }
            },
            minItemWidth: Number(Layout && Layout.WEEK_MIN_ITEM_WIDTH) || 74,
            maxCategoryWidth: Number(Layout && Layout.WEEK_CATEGORY_MAX_WIDTH) || 320,
            /* 2026-10-20 两级：tooNarrow（连「…」+首字都放不下）→ 微块；
               omit（放不下标题/时间行，但放得下「…」+首字）→ 省略态。
               两者都必须用本模块算出的**真实像素宽高**（不是百分比） */
            tooNarrow: function (occ, laneWidthPx, laneHeightPx) {
              if (!Layout || typeof Layout.isWeekBlockTooSmall !== 'function') return false;
              try { return Layout.isWeekBlockTooSmall(occ, laneWidthPx, laneHeightPx); } catch (e) { return false; }
            },
            omit: function (occ, laneWidthPx, laneHeightPx) {
              if (!Layout || typeof Layout.isWeekBlockTooNarrow !== 'function') return false;
              try { return Layout.isWeekBlockTooNarrow(occ, laneWidthPx, laneHeightPx); } catch (e) { return false; }
            }
          });
        } catch (e) {
          rawLayout = null;
          if (root.console) console.error('[DayPlan] 周布局计算失败：', e);
        }
      }
      var geo;
      if (rawLayout) {
        geo = normalizeLayoutResult(rawLayout, days, pxPerHourSetting, lanesMax);
      } else {
        /* 降级：轴与块共用同一 rate/height 与同一折叠映射（要求 1），坐标仍同源 */
        var fbRate = pxPerHourSetting / 60;
        geo = normalizeLayoutResult(fallbackLayout(byDate, days, fbRate, geom.height, lanesMax, geom.getY),
          days, pxPerHourSetting, lanesMax);
        if (root.console) console.error('[DayPlan] 周布局不可用，已降级为线性同源布局');
      }
      var columns = geo.columns;

      /* 迭代 8（F-52）：列宽由内容决定 —— 52px 轴列 + 每天「各构成类别列宽之和」像素；
       * 未取到内容宽度时退回迭代 4 的 widthWeight 份 fr（保持既有断言口径可用）。 */
      var tracks;
      var hasWidths = geo.widths && geo.widths.length && geo.widths.some(function (w) { return w > 0; });
      if (hasWidths) {
        tracks = WEEK_GRID_AXIS_WIDTH + 'px ' +
          geo.widths.map(function (w) { return Math.round(w > 0 ? w : WEEK_MIN_DAY_WIDTH_PX) + 'px'; }).join(' ');
        var totalPx = WEEK_GRID_AXIS_WIDTH + geo.widths.reduce(function (a, w) {
          return a + (w > 0 ? w : WEEK_MIN_DAY_WIDTH_PX);
        }, 0);
        gridEl.style.minWidth = Math.round(totalPx) + 'px';
        gridEl.setAttribute('data-week-total-width', String(Math.round(totalPx)));
        gridEl.setAttribute('data-week-widths', geo.widths.map(function (w) {
          return Math.round(w > 0 ? w : WEEK_MIN_DAY_WIDTH_PX);
        }).join(','));
        gridEl.setAttribute('data-week-raw-widths', geo.columns.map(function (c) {
          return Math.round(Number(c && c.widthPx) || 0);
        }).join(','));
        /* 迭代 8（F-53）诊断：布局判定的「窄块」个数（用户实测 bug 的回归观测点） */
        gridEl.setAttribute('data-week-too-narrow', String(geo.columns.reduce(function (acc, c) {
          return acc + (c && c.items ? c.items.filter(function (it) { return it.tooNarrow === true; }).length : 0);
        }, 0)));
      } else {
        tracks = WEEK_GRID_AXIS_WIDTH + 'px ' + geo.weights.map(function (w) { return w + 'fr'; }).join(' ');
        gridEl.style.minWidth = '';
      }
      gridEl.style.setProperty('grid-template-columns', tracks);      gridEl.style.gridTemplateColumns = tracks;   /* 兼容直接读 style.gridTemplateColumns 的断言 */
      gridEl.setAttribute('data-week-column-weights', geo.weights.join(','));

      /* 重渲染前先释放所有已 pin 的展开卡（旧节点即将被丢弃） */
      if (pinner) { try { pinner.releaseAll(); } catch (e) { /* 忽略 */ } }

      /* 8 列 × 2 行：表头行 + 轴/列行 */
      gridEl.innerHTML = '';
      /* 左上角：与 .wk-head 同款粘性表头外观（不共用 wk-head 类，便于「7 列表头」计数） */
      gridEl.appendChild(el('div', {
        class: 'wk-corner', 'aria-hidden': 'true',
        style: 'position:sticky;top:0;z-index:6;background:var(--surface-2);' +
          'border-bottom:1px solid var(--border-strong);'
      }));
      days.forEach(function (iso, idx) {
        gridEl.appendChild(headerCell(iso, idx, today, showHoliday));
      });
      gridEl.appendChild(axisNode(geom));
      days.forEach(function (iso) {
        var col = null;
        for (var i = 0; i < columns.length; i += 1) {
          if (columns[i] && columns[i].iso === iso) { col = columns[i]; break; }
        }
        gridEl.appendChild(columnNode(iso, col || { iso: iso, items: [] }, geom, today, cats));
      });

      /* 迭代 5（F-34 / D2 修复）：列与卡片**此刻**才挂载完成。
         columnNode 内的 pin 发生在节点脱离文档时（矩形全 0），overlay 会先登记为 pending；
         这里补一次 sync()，让展开卡立即在「事项块所在位置」定位，而不是页面左上角。 */
      if (pinner) { try { pinner.sync(); } catch (e) { /* 忽略 */ } }
    }

    function render() {
      var doc = docOf();
      var monday = state.monday || D.startOfWeek(D.todayISO()) || D.todayISO();
      state.monday = monday;
      titleEl.textContent = weekTitle(monday);
      renderGrid(doc, monday);
      loadNotes();
      lastRenderStamp = dataStamp(doc);
    }

    /** 轻量数据指纹：meta.updatedAt + 事项数（外部写入后据此判断视图是否过期） */
    function dataStamp(doc) {
      var meta = (doc && doc.meta) || {};
      var items = (doc && doc.items) || [];
      return String(meta.updatedAt || '') + '#' + items.length;
    }

    /** app 的 onDataChanged → 各视图 refresh()：重读共享 UI 状态后重渲染。 */
    function refresh() {
      state.hideDone = readHideDone();
      render();
    }

    function readHideDone() {
      try {
        var ui = (store.loadUIState && store.loadUIState()) || null;
        return !!(ui && ui.hideDone);
      } catch (e) { return false; }
    }

    /* ------------------------------------------------------------------ *
     * 5. 导航（F-18.2 / item 9）
     * ------------------------------------------------------------------ */

    /**
     * 定位到某周（内部：切换前先落盘旧周记录）。
     * @param {string} monday 该周任意日期（内部归一到周一）
     * @param {{notify?:boolean, force?:boolean}} [o] notify===false 时不回调 onSelectDate
     */
    function setWeekStart(monday, o) {
      o = o || {};
      if (!D.isValidDate(monday)) return;
      var next = D.startOfWeek(monday);
      if (!next) return;
      if (notesTimer) flushNotes();
      var changed = next !== state.monday;
      state.monday = next;
      /* 除「周变化」外，文档在最近一次渲染之后被外部改写时也要重渲染：应用层没有 store.subscribe，
       * 直接调用 store.addItem / 导入 / 迁移不会通知视图，而 app.setViewMode('week') 每次都按同一周
       * 调 setDate —— 只看 changed 会留下过期 DOM（引导冒烟 SC-27 正是该调用序）。
       * 用 meta.updatedAt + items.length 作为轻量指纹，避免无数据变化时的无谓重排。 */
      var doc = docOf();
      var stale = dataStamp(doc) !== lastRenderStamp;
      if (changed || o.force || stale) render();
      if (changed && o.slide) {
        var motion = root.DayPlan.motion;
        if (motion && typeof motion.slidePanel === 'function') motion.slidePanel(rootEl, o.slide);
      }
      if (o.notify !== false && opts.onSelectDate) opts.onSelectDate(next);
    }

    function setDate(iso, o) {
      o = o || {};
      if (!D.isValidDate(iso)) return;
      setWeekStart(D.startOfWeek(iso), { notify: o.notify, force: o.force });
    }

    function shiftWeek(delta) {
      var base = state.monday || D.startOfWeek(D.todayISO());
      var weeks = numOr(delta, 0);
      if (!weeks) return;
      /* app 传 days/7：±1 天与 ±7 天都按「相邻一周」处理（周视图不按天移动） */
      var steps = weeks > 0 ? Math.max(1, Math.round(weeks)) : Math.min(-1, Math.round(weeks));
      setWeekStart(D.addDays(base, steps * 7), { notify: true, slide: steps > 0 ? 1 : -1 });
    }

    function getWeekStart() { return state.monday; }

    /* ------------------------------------------------------------------ *
     * 6. 事项交互（折叠/展开、完成、重要、修改、删除 —— 语义与日视图一致）
     * ------------------------------------------------------------------ */

    function occKey(occ) {
      if (!occ) return '';
      return occ.key || ((occ.seriesId || occ.id || '') + '@' + (occ.date || ''));
    }

    function isExpanded(occ) {
      var key = occKey(occ);
      if (!key || typeof store.isExpanded !== 'function') return false;
      try { return !!store.isExpanded(key); } catch (e) { return false; }
    }

    /** F-14.3 / BR-16：折叠状态存 dayplan.ui.v1.expanded[key]（纯视图状态）。 */
    function setExpanded(occ, on) {
      var key = occKey(occ);
      if (key && typeof store.setExpanded === 'function') {
        try { store.setExpanded(key, !!on); } catch (e) { /* 忽略 */ }
      }
      render();
    }

    function findItemFor(occ) {
      var doc = docOf();
      var id = occ && (occ.seriesId || occ.id);
      if (!id) return null;
      var items = doc.items || [];
      for (var i = 0; i < items.length; i += 1) {
        if (items[i] && items[i].id === id) return items[i];
      }
      return null;
    }

    function afterWrite(meta) {
      render();
      if (opts.onDataChanged) opts.onDataChanged(meta || {});
    }

    /** 重复事项的范围选择（仅此次 / 此次及以后），与 views/day.js 同文案。 */
    function askScope(title, occ, onPick) {
      var onlyRadio = el('input', { type: 'radio', name: 'wk-scope', value: 'only', checked: true });
      var allRadio = el('input', { type: 'radio', name: 'wk-scope', value: 'all' });
      var body = el('div', {}, [
        el('p', { style: 'margin:0 0 8px', text: '「' + occ.title + '」是重复事项，本次发生在 ' + occ.date + '。请选择作用范围：' }),
        el('div', { class: 'inline' }, [
          el('label', { class: 'switch' }, [onlyRadio, el('span', { text: '仅此次' })]),
          el('label', { class: 'switch' }, [allRadio, el('span', { text: '此次及以后' })])
        ]),
        el('p', { class: 'hint', text: '「此次及以后」会把该序列从这天起拆分：之前的不变，之后成为新序列。' })
      ]);
      M.open({
        title: title,
        body: body,
        submitLabel: '确定',
        onSubmit: function () { onPick(allRadio.checked ? 'all' : 'only'); }
      });
    }

    function toggleDone(occ) {
      var item = findItemFor(occ);
      if (!item) return;
      if (item.kind === 'single') {
        var before = !!item.done;
        store.toggleDone(item.id, null, 'only');
        afterWrite();
        M.toast(before ? '已标记为未完成' : '已标记完成', {
          actionLabel: '撤销',
          onAction: function () { store.toggleDone(item.id, null, 'only'); afterWrite(); }
        });
        return;
      }
      askScope('标记完成状态', occ, function (scope) {
        store.toggleDone(item.id, occ.date, scope);
        afterWrite();
        M.toast(scope === 'all' ? '该序列的完成状态已更新' : '仅此次的完成状态已更新');
      });
    }

    /**
     * S31 / US-27 / AC-27.3：周视图的「紧急 / 取消紧急」。
     * 一律走冻结契约 store.toggleUrgent(id, date, scope)（DM-18 / R-12：例外继承、
     * 序列拆分、meta.previousCategoryId 由 store 统一保证）。接口缺失时如实报错，
     * 不再回落 toggleStarred（starred 已降级为纯迁移输入，DM-18.4）。
     */
    function toggleUrgent(occ) {
      var item = findItemFor(occ);
      if (!item) return;
      var uName = urgentName();
      if (typeof store.toggleUrgent !== 'function') {
        M.toast(uName + '功能未就绪：store.toggleUrgent 不可用');
        return;
      }
      var current = (occ && occ.categoryId) || item.categoryId;
      var willUrgent = !isUrgentCategoryId(current);
      var msg = willUrgent ? '已标为' + uName : '已取消' + uName;
      if (item.kind === 'single') {
        try {
          store.toggleUrgent(item.id, null, 'only');
        } catch (e) {
          M.toast('切换' + uName + '失败：' + errText(e));
          return;
        }
        afterWrite();
        M.toast(msg);
        return;
      }
      askScope(willUrgent ? '标为' + uName : '取消' + uName, occ, function (scope) {
        try {
          store.toggleUrgent(item.id, occ.date, scope);
        } catch (e) {
          M.toast('切换' + uName + '失败：' + errText(e));
          return;
        }
        afterWrite();
        M.toast(scope === 'all' ? '该序列的「' + uName + '」状态已更新' : '仅此次的「' + uName + '」状态已更新');
      });
    }

    function restoreDefault(occ) {
      try {
        store.removeSeriesException(occ.seriesId, occ.date);
      } catch (e) {
        M.toast('恢复失败：' + errText(e));
        return;
      }
      afterWrite();
      M.toast('已恢复为规则默认');
    }

    function removeOccurrence(occ) {
      var item = findItemFor(occ);
      if (!item) return;
      var snapshot = null;
      if (item.kind === 'single') {
        M.confirm({
          title: '删除事项',
          message: '确定删除「' + occ.title + '」？',
          confirmLabel: '删除', danger: true
        }).then(function (ok) {
          if (!ok) return;
          snapshot = JSON.stringify(item);
          store.removeItem(item.id);
          afterWrite();
          M.toast('已删除', {
            actionLabel: '撤销',
            onAction: function () { store.addItem(JSON.parse(snapshot)); afterWrite(); }
          });
        });
        return;
      }
      askScope('删除重复事项', occ, function (scope) {
        if (scope === 'only') {
          store.addSeriesException(item.id, occ.date, { deleted: true });
          afterWrite();
          M.toast('已删除此次', {
            actionLabel: '撤销',
            onAction: function () { store.removeSeriesException(item.id, occ.date); afterWrite(); }
          });
          return;
        }
        M.confirm({
          title: '删除此次及以后',
          message: '将把该序列截止到 ' + D.addDays(occ.date, -1) + '，之后的重复不再出现。',
          confirmLabel: '删除', danger: true
        }).then(function (ok) {
          if (!ok) return;
          store.splitSeriesAt(item.id, occ.date, 'delete');
          afterWrite();
          M.toast('已删除此次及以后的重复');
        });
      });
    }

    /* ---------------- 编辑（F-03 的周内入口） ---------------- */

    function openEdit(occ) {
      var Form = root.DayPlan ? root.DayPlan.form : null;
      var item = findItemFor(occ);
      if (!item) return;
      if (!Form || typeof Form.createItemForm !== 'function') {
        M.toast('编辑表单尚未就绪');
        return;
      }
      var doc = docOf();
      var isSeriesOccurrence = !!(item.kind === 'series' && occ);
      var form;
      try {
        form = Form.createItemForm({
          mode: isSeriesOccurrence ? 'occurrence' : 'edit',
          date: occ.date || state.monday,
          item: item,
          occurrence: isSeriesOccurrence ? occ : null,
          categories: doc.categories || [],
          defaultCategoryId: settingsOf(doc).defaultCategoryId || 'cat_short_task',
          allowScope: isSeriesOccurrence
        });
      } catch (e) {
        M.toast('编辑表单尚未就绪');
        return;
      }
      if (!form || !form.element) { M.toast('编辑表单尚未就绪'); return; }

      M.open({
        title: '编辑事项',
        body: form.element,
        submitLabel: '保存',
        wide: true,
        onSubmit: function (ctx) {
          var check = form.validate();
          if (!check.ok) { ctx.setError(check.message); return false; }
          var v = check.values;
          try {
            if (isSeriesOccurrence) {
              applyOccurrenceEdit(item, occ, v, typeof form.scope === 'function' ? form.scope() : 'only');
            } else {
              updateSingle(item, v);
            }
          } catch (e) {
            ctx.setError(errText(e));
            return false;
          }
          afterWrite();
        }
      });
      if (typeof form.focus === 'function') form.focus();
    }

    function applyOccurrenceEdit(item, occ, v, scope) {
      if (scope === 'only') {
        store.addSeriesException(item.id, occ.date, {
          time: v.time, title: v.title, categoryId: v.categoryId, note: v.note, done: v.done
        });
        M.toast('已修改此次（仅此次）', {
          actionLabel: '撤销',
          onAction: function () { store.removeSeriesException(item.id, occ.date); afterWrite(); }
        });
        return;
      }
      var changes = {
        title: v.title, categoryId: v.categoryId, time: v.time, note: v.note, done: v.done
      };
      if (v.kind === 'series' && v.repeat) changes.repeat = v.repeat;
      var res = store.splitSeriesAt(item.id, occ.date, 'edit', changes);
      M.toast(res && res.split ? '已拆分：之后成为一个新序列' : '已更新整条序列');
    }

    function updateSingle(item, v) {
      /* DM-18.4：starred 不再由视图读写（紧急状态由 categoryId 表达）。
       * updateItem 只带显式补丁键 → 不传 starred 即保留原值。 */
      if (v.kind === 'single' && item.kind === 'single') {
        store.updateItem(item.id, {
          title: v.title, categoryId: v.categoryId, date: v.date,
          time: v.time, note: v.note, done: v.done
        });
        return;
      }
      var next = {
        id: item.id,
        kind: v.kind,
        title: v.title,
        categoryId: v.categoryId,
        time: v.time,
        note: v.note,
        done: v.done,
        order: item.order,
        createdAt: item.createdAt,
        updatedAt: new Date().toISOString()
      };
      if (v.kind === 'single') {
        next.date = v.date;
      } else {
        next.repeat = v.repeat;
        next.exceptions = {};
      }
      store.removeItem(item.id);
      store.addItem(next);
    }

    /* ------------------------------------------------------------------ *
     * 7. 周计划（F-20）
     * ------------------------------------------------------------------ */

    function openNewWeekPlan() {
      var Form = root.DayPlan ? root.DayPlan.form : null;
      var monday = state.monday || D.startOfWeek(D.todayISO());
      if (!Form || typeof Form.createWeekPlanForm !== 'function') {
        M.toast('周计划表单尚未就绪');
        return;
      }
      var doc = docOf();
      var form = null;
      try {
        form = Form.createWeekPlanForm({
          weekStart: monday,
          date: monday,
          categories: doc.categories || [],
          defaultCategoryId: settingsOf(doc).defaultCategoryId || 'cat_short_task'
        });
      } catch (e) { form = null; }
      if (!form || !form.element) { M.toast('周计划表单尚未就绪'); return; }

      M.open({
        title: '新建周计划',
        body: form.element,
        submitLabel: '创建',
        wide: true,
        onSubmit: function (ctx) {
          var check = form.validate();
          if (!check.ok) { ctx.setError(check.message); return false; }
          var v = check.values || (typeof form.getValues === 'function' ? form.getValues() : null);
          if (!v) { ctx.setError('表单取值失败'); return false; }
          try {
            saveWeekPlan(v, monday);
          } catch (e) {
            ctx.setError(errText(e));
            return false;
          }
          afterWrite();
        }
      });
      if (typeof form.focus === 'function') form.focus();
    }

    /** F-20.2 / BR-21：一条 daily interval=1、[周一, 周一+7) 的序列 + meta.origin。 */
    function saveWeekPlan(v, monday) {
      var repeat = v.repeat;
      if (!repeat || !repeat.startDate) {
        repeat = { type: 'daily', interval: 1, startDate: monday, endDate: D.addDays(monday, 7) };
      }
      store.addItem({
        kind: 'series',
        title: v.title,
        categoryId: v.categoryId,
        time: v.time || null,
        note: v.note || '',
        /* DM-18.4：不写 starred —— 紧急状态由 categoryId（表单的类别下拉/紧急勾选）表达 */
        repeat: repeat,
        exceptions: {},
        meta: { origin: 'weekPlan', weekStart: monday }
      });
      M.toast('已创建周计划（本周 7 天）');
    }

    /* ------------------------------------------------------------------ *
     * 8. 初始化
     * ------------------------------------------------------------------ */

    state.monday = D.startOfWeek(D.todayISO()) || D.todayISO();
    state.hideDone = readHideDone();
    render();

    return {
      element: rootEl,
      render: render,
      refresh: refresh,
      setDate: setDate,
      shiftWeek: shiftWeek,
      openNewWeekPlan: openNewWeekPlan,
      getWeekStart: getWeekStart,
      flushNotes: flushNotes,
      /* 便利出口（非契约，供联调 / 边界测试） */
      setWeekStart: setWeekStart
    };
  }

  root.DayPlan.weekView = {
    createWeekView: createWeekView,
    isoWeekNumber: isoWeekNumber,
    weekTitle: weekTitle
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
