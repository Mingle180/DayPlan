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
  /* 2026-11-01：右栏图片（按周一存，随文档同步） */
  var RailCover = root.DayPlan.railCover;
  /* 2026-10-30：类别色统一走色板（20 色）；旧高饱和色由 categoryTone 就近归一 */
  var Palette = root.DayPlan.palette;
  var toneOf = (Palette && Palette.categoryTone) ? Palette.categoryTone : null;
  var catAccent = function (hex) {
    var tone = toneOf ? toneOf(hex) : null;
    return tone ? tone.accent : hex;
  };

  var DOW_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var NOTES_DEBOUNCE_MS = 300;
  var DEFAULT_WEEK_PX_PER_HOUR = 72;   /* F-18.1：settings.weekPxPerHour 默认 72（2026-11-03） */
  var DEFAULT_COMPRESS_HEIGHT = 26;    /* F-38：settings.idleCompressHeight 兜底（DM-21） */
  var DEFAULT_LANES_MAX = 3;           /* DM-19.2：周视图仅作列宽权重下限 */
  var WEEK_LANE_HARD_CAP = 6;          /* DM-19.4 / DM-22：道数硬上限 */
  var WEEK_GRID_AXIS_WIDTH = 38;       /* .week-grid 第一列（时间轴）像素宽；四十九轮由 52 收到 38（只够 10px 的 HH:mm） */
  var WEEK_MIN_DAY_WIDTH_PX = 84;      /* 迭代 8（F-52）：无内容时单天列宽的兜底（与静态 CSS 的 84px 一致） */
  /* 2026-11-02：事项块上下拉边。预览几何与 layoutWeek 同一口径（gapY=2 / blockHeightMin=22），
     拖进折叠区时临时把整条轴展开成 1:1（收尾时再折回去）。 */
  var WEEK_BLOCK_GAP = 2;
  var WEEK_BLOCK_MIN_HEIGHT = 22;
  var WEEK_RESIZE_EDGE = 36;
  var WEEK_RESIZE_SHORT_H = 28;        /* 块高低于此值 → 两个手柄各占一半，避免重叠 */
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

  /** 周视图胶囊显示类别前两个字（与日视图、完成台同口径，按码点取）。 */
  function chipLabelOf(name) {
    var s = (name === null || name === undefined) ? '' : String(name);
    if (!s) return '';
    var out = '';
    var i = 0;
    while (out.length < 2 && i < s.length) {
      var cp = s.codePointAt(i);
      out += String.fromCodePoint(cp);
      i += cp > 0xffff ? 2 : 1;
    }
    return out;
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
   * 标题：2026年10月26日–11月1日
   * 迭代 6（F-41 / R-19）：不再输出「（第 N 周）」——界面与 Excel 两处口径一致；
   * isoWeekNumber 仍保留导出（供工具/单元格口径复用）。
   * 2026-10-30 用户口径：去掉数字与「年月日」之间的空格（与日标题同日式），
   * 手机 20px 下才能单行排完。
   */
  function weekTitle(monday) {
    var sunday = D.addDays(monday, 6);
    var a = D.parseYearMonth(monday);
    var b = D.parseYearMonth(sunday);
    if (!a || !b) return String(monday || '');
    var right;
    if (b.year !== a.year) right = b.year + '年' + b.month + '月' + b.day + '日';
    else right = b.month + '月' + b.day + '日';
    return a.year + '年' + a.month + '月' + a.day + '日–' + right;
  }

  function createWeekView(opts) {
    opts = opts || {};
    var store = opts.store;
    var container = opts.container || null;

    var state = { monday: null, hideDone: false };
    var notesTimer = null;
    var lastRenderStamp = null;   /* 最近一次渲染时的文档指纹（见 setWeekStart 的过期判断） */
    var lastGeom = null;          /* 最近一次 renderGrid 的折叠轴（拉边换算用） */
    var axisResizeExpanded = false; /* 拉边进入折叠区：临时关掉空闲折叠 */
    var resizeState = null;
    /* 2026-11-02（用户口径）：手机端拉上下边同样要先点一下边、再拖动 */
    var armedResize = null;
    var armedResizeTimer = 0;
    var armCandidate = null;
    var ARMED_RESIZE_MS = 4000;
    var weekPill = null;
    var dragSuppressUntil = 0;
    var weekScrollRaf = 0;

    /* ------------------------------------------------------------------ *
     * 1. 静态骨架（只建一次：记录栏不能在重渲染时被重建，否则会丢焦点）
     * ------------------------------------------------------------------ */

    var titleEl = el('h1', { class: 'week-title', id: 'week-title', text: '—' });

    var btnThis = el('button', {
      class: 'date-nav-btn is-current', type: 'button', id: 'btn-week-current', title: '回到本周',
      text: '本周', onclick: function () { setWeekStart(D.startOfWeek(D.todayISO()), { notify: true }); }
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
    /* 2026-10-31：字数从标题行挪到纸面右下角，与日视图同一位置（记录栏一体化） */
    var notesCount = el('span', { class: 'notes-count', id: 'week-notes-count', text: '0字' });
    var notesInput = el('textarea', {
      class: 'notes-input', id: 'week-notes-input', rows: '4',
      'aria-label': '当周记录'
    });

    /* 迭代 10 批次 4（条8）：white-card = .panel-day —— 与日视图同一张白卡、同样的圆角/投影 */
    var rootEl = el('div', { class: 'week-view panel-day', id: 'week-view' });
    /* 2026-11-01：右栏顶部图片（按周一保存；模块缺失时只剩记录区） */
    var railCover = (RailCover && typeof RailCover.create === 'function')
      ? RailCover.create({
        store: store,
        scope: 'week',
        label: '本周',
        getKey: function () { return state.monday; }
      })
      : null;
    /* 迭代 10 批次 4（条8）：左侧周表 + 右侧「当周记录」（独立白底、与周表等高相对静止） */
    /* 三十九轮（F-87）：图片区与当周记录之间插入「本周计划」显示区 */
    var plansListEl = el('ul', { class: 'week-plans-list', id: 'week-plans-list' });
    var plansEmptyEl = el('p', { class: 'empty-hint', id: 'week-plans-empty', text: '本周还没有计划', hidden: true });
    var plansSectionEl = el('section', { class: 'week-plans-section', 'aria-label': '本周计划' }, [
      el('div', { class: 'section-head' }, [
        el('h2', { text: '本周计划' }),
        el('span', { class: 'finish-dock-tools' }, [
          el('button', {
            class: 'btn btn-ghost btn-icon', type: 'button', id: 'btn-new-week-plan-rail',
            title: '新建周计划', 'aria-label': '新建周计划', text: '+',
            onclick: function () { openNewWeekPlan(); }
          })
        ])
      ]),
      plansListEl,
      plansEmptyEl
    ]);
    var railEl = el('aside', { class: 'side-rail', id: 'week-rail', 'aria-label': '本周计划与当周记录' }, [
      railCover ? railCover.element : null,
      plansSectionEl,
      el('section', { class: 'notes-section', 'aria-label': '当周记录' }, [
        el('div', { class: 'section-head' }, [
          el('h2', { text: '当周记录' }),
          notesStatus
        ]),
        notesInput,
        el('div', { class: 'notes-foot' }, [notesCount])
      ])
    ]);
    /* 悬停预览的边界参照（.week-scroll 会横向滚动，展开后需按它的视口让位） */
    var scrollEl = el('div', { class: 'week-scroll', id: 'week-scroll' }, [gridScrollEl]);
    /* 2026-10-30 用户口径：标题 +「本周」「+」收进左侧周表卡片里（与日视图的日期行同构），
       卡片本身不再是滚动容器，滚动只发生在下面的 .week-scroll。 */
    var cardEl = el('section', { class: 'week-card', 'aria-label': '周计划' }, [
      el('div', { class: 'week-head' }, [
        titleEl,
        el('div', { class: 'head-actions' }, [
          el('div', { class: 'date-nav', role: 'group', 'aria-label': '周导航' }, [btnThis]),
          btnNew
        ])
      ]),
      scrollEl
    ]);
    rootEl.appendChild(el('div', { class: 'view-body', id: 'week-view-body' }, [
      el('div', { class: 'view-main' }, [cardEl]),
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
      notesStatus.textContent = saving ? '保存中…' : '';
      if (notesCount) notesCount.textContent = notesInput.value.length + '字';
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

    /* 默认类别可能已被删除（四十八轮起）：兜底必须落在仍然存在的类别上。 */
    function defaultCategoryIdOf(doc) {
      var cats = (doc && doc.categories) || [];
      var preferred = settingsOf(doc).defaultCategoryId;
      for (var i = 0; i < cats.length; i += 1) {
        if (cats[i] && cats[i].id === preferred) return preferred;
      }
      return cats[0] ? cats[0].id : null;
    }

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
     * @param {boolean} [expand] 拉边进入折叠区时为 true：关闭空闲折叠、整条轴 1:1
     */
    function axisGeometry(doc, days, byDate, pxPerHour, expand) {
      var settings = settingsOf(doc);
      var full = MINUTES_PER_DAY * (pxPerHour / 60);
      var compressible = !expand && settings.idleCompressEnabled !== false;
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
     *
     * 四十九轮（用户口径）：「横向的灰色线不要伸到时间数字这一列来和数字发生重叠，仅留在事项区」
     * → 轴列只放刻度文字与折叠窄带，整点横线由 7 个日列各自绘制（横线从事项区左缘开始）。
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
      });
      geom.bands.forEach(function (band) { axis.appendChild(idleBandNode(band, true)); });
      return axis;
    }

    function fallbackCard(occ, cats) {
      var cat = (cats && cats[occ.categoryId]) || { name: '未分类', color: DEFAULT_CAT_COLOR };
      var card = el('div', {
        class: 'wk-item' + (occ.done ? ' is-done' : ''),
        role: 'button', tabindex: '0',
        style: '--cat:' + catAccent(cat.color) + ';',
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
     * @param {object} [geom] 折叠轴（拉边换算与截图/测试定位用）
     * @param {object} [col] 所在日列（拉边手柄的坐标参照）
     */
    function weekCard(occ, geo, cats, tooNarrow, omit, geom, col) {
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
            /* 迭代 7（F-45 第 6 条 / R-23）：只设紧急未做其他改动 → 不渲染「复原」 */
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
      card.setAttribute('data-occ-key', occKey(occ));
      card.style.left = place.left + '%';
      card.style.width = place.width + '%';
      card.style.top = place.top + 'px';
      card.style.height = place.height + 'px';
      /* 迭代 10 批次 3（条7）：展开后先保持原块高度，内容放不下时才向下加长 */
      card.style.setProperty('--block-h', place.height + 'px');
      /* 2026-11-02：矮块的两个拉边手柄各占一半（否则上下手柄会在块中间重叠） */
      if (place.height < WEEK_RESIZE_SHORT_H && card.classList) card.classList.add('is-wk-short');
      /* 2026-10-30（用户口径）：矮块里右上角类别胶囊和居中的「…」抢同一行，
         半透明胶囊会盖掉省略号右半 —— 看起来「省略号总是偏左」。
         矮块标记放这里（高度只有渲染层知道），CSS 在折叠态收起胶囊。 */
      if (place.height < 34 && card.classList && card.classList.contains('is-omitted')) {
        card.classList.add('is-short');
      }
      /* 2026-11-02（用户口径）：上下边拖动调整时间（与日视图左右拉边同一套纯函数） */
      attachWeekResize(card, occ, geom, col);
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
        var card = weekCard(item.occ, item, cats, item.tooNarrow, item.omit, geom, node);
        node.appendChild(card);
        /* US-24 / DM-25：展开卡 pin 到本列；pin 返回 false（无 rect 能力）→ 保持原位展开。
           2026-10-31：把外层滚动容器交给浮层 —— iOS 会把 fixed 后代连同容器裁掉，
           浮层据此在「真被裁」时把卡片收进可视区。 */
        if (pinner && isExpanded(item.occ)) {
          try { pinner.pin(card, node, { clip: gridScrollEl }); } catch (e) { /* 降级：原位展开 */ }
        }
      });
      /* S26 / US-22.2：单击列空白（不含事项块）→ 日视图 */
      node.addEventListener('click', function (e) {
        if (dragSuppressUntil && Date.now() < dragSuppressUntil) return;
        var t = e && e.target;
        if (t && t !== node) {
          if (typeof t.closest === 'function' && (t.closest('.wk-item') || t.closest('.item-detail'))) return;
          if (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'A') return;
        }
        openDay(iso);
      });
      return node;
    }

    /* ------------------------------------------------------------------ *
     * 7.5 事项块上下拉边（2026-11-02，用户口径：与日视图同样的拖边改时间）
     *   纵向映射直接复用折叠轴的反函数 Layout.axisMinuteAt（ADR-20，
     *   指针落在哪个时刻，块边就跟到哪个时刻）；吸附 / 最短时长与日视图同源。
     * ------------------------------------------------------------------ */

    function coarsePointer() {
      try {
        if (root && typeof root.matchMedia === 'function') {
          return !!root.matchMedia('(pointer: coarse)').matches;
        }
      } catch (e) { /* 老引擎：当作细指针 */ }
      return false;
    }

    function needsResizeArm(e) {
      var type = e && e.pointerType;
      if (type === 'touch' || type === 'pen') return true;
      return coarsePointer();
    }

    function weekDragStep() {
      var s = Number(Layout && Layout.SNAP_STEP_DEFAULT);
      return (isFinite(s) && s > 0) ? Math.floor(s) : 5;
    }

    function weekDragMinDuration() {
      var m = Number(Layout && Layout.MIN_DURATION_DEFAULT);
      return (isFinite(m) && m > 0) ? Math.floor(m) : 15;
    }

    function weekColumnNode(iso) {
      if (!gridEl || typeof gridEl.querySelectorAll !== 'function') return null;
      var cols = gridEl.querySelectorAll('.wk-col');
      for (var i = 0; i < cols.length; i += 1) {
        if (cols[i] && cols[i].getAttribute('data-date') === iso) return cols[i];
      }
      return null;
    }

    function weekCardByKey(col, key) {
      if (!col || !key || typeof col.querySelectorAll !== 'function') return null;
      var cards = col.querySelectorAll('.wk-item');
      for (var i = 0; i < cards.length; i += 1) {
        if (cards[i] && cards[i].getAttribute('data-occ-key') === key) return cards[i];
      }
      return null;
    }

    function weekMinuteAtClientY(st, clientY) {
      if (!st || !st.col) return 0;
      var rect = (typeof st.col.getBoundingClientRect === 'function')
        ? st.col.getBoundingClientRect() : { top: 0 };
      var y = clientY - (Number(rect.top) || 0);
      var pxPerHour = (st.geom && isFinite(st.geom.pxPerHour)) ? st.geom.pxPerHour : DEFAULT_WEEK_PX_PER_HOUR;
      if (Layout && typeof Layout.axisMinuteAt === 'function') {
        return Layout.axisMinuteAt(st.geom ? st.geom.raw : null, y, { pxPerHour: pxPerHour });
      }
      var rate = pxPerHour / 60;
      return Math.max(0, Math.min(MINUTES_PER_DAY, y / (rate > 0 ? rate : 1)));
    }

    /** 指针是否进了首 / 末折叠带；返回该带的边界时刻与边界线的屏幕 Y。 */
    function weekResizeBoundary(st, clientY) {
      var raw = st && st.geom ? st.geom.raw : null;
      if (!raw || !st.col) return null;
      var rect = (typeof st.col.getBoundingClientRect === 'function')
        ? st.col.getBoundingClientRect() : { top: 0 };
      var top = Number(rect.top) || 0;
      var y = clientY - top;
      var lead = numOr(raw.leadHeight, 0);
      var real = numOr(raw.realHeight, 0);
      var trail = numOr(raw.trailHeight, 0);
      if (trail > 0 && y > lead + real) {
        return { minute: numOr(raw.lastEnd, MINUTES_PER_DAY), screenY: top + lead + real };
      }
      if (lead > 0 && y < lead) {
        return { minute: numOr(raw.firstStart, 0), screenY: top + lead };
      }
      return null;
    }

    /** 进入折叠带时临时关掉折叠：整条轴变 1:1，指针下面的精度才够用。 */
    function expandWeekResizeAxis(st, boundary) {
      if (!st || axisResizeExpanded || !boundary) return;
      var key = occKey(st.occ);
      var r = expandWeekAxisCore(boundary, st.occ.date, render);
      st.col = r.col;
      st.geom = r.geom;
      st.card = r.col ? weekCardByKey(r.col, key) : null;
      if (st.card) {
        if (st.card.classList) st.card.classList.add('is-resizing');
        applyWeekResizeVisual(st.card, st.geom, st);
      }
    }

    /**
     * 折叠带临时展开的核心（四十轮 / F-90 / F-92）：置展开旗标 → 重渲染 → 按边界线屏幕 Y
     * 补偿 scrollTop，使实区事项块屏幕位置不变。rerender 由调用方给：拉边用整视图 render()，
     * 计划拖拽用 renderGrid()（右栏拖拽源行不被摘除，HTML5 拖拽不中断）。
     */
    function expandWeekAxisCore(boundary, dateISO, rerender) {
      axisResizeExpanded = true;
      rerender();
      var col = weekColumnNode(dateISO);
      var geom = lastGeom;
      if (col && geom && boundary) {
        var screenY = (Number(col.getBoundingClientRect().top) || 0) + geom.getY(boundary.minute);
        var delta = screenY - boundary.screenY;
        if (isFinite(delta) && Math.abs(delta) >= 0.5) {
          scrollEl.scrollTop = Math.max(0, (Number(scrollEl.scrollTop) || 0) + delta);
        }
      }
      return { col: col, geom: geom };
    }

    /** 计划拖拽预览块（四十轮 / F-90）：未排→时间轴同款绿色幽灵。 */
    function showPlanGhost(col, t) {
      if (!col || !lastGeom || !t) return;
      if (!planDropGhost) planDropGhost = el('div', { class: 'wk-drop-ghost', 'aria-hidden': 'true' });
      if (planDropGhost.parentNode !== col) col.appendChild(planDropGhost);
      var top = lastGeom.getY(t.startMinute);
      var bottom = lastGeom.getY(t.endMinute);
      planDropGhost.style.top = Math.round(top) + 'px';
      planDropGhost.style.height = Math.max(2, Math.round(bottom - top) - WEEK_BLOCK_GAP) + 'px';
      planDropGhost.hidden = false;
    }

    function clearPlanPreview() {
      if (planDropGhost && planDropGhost.parentNode) planDropGhost.parentNode.removeChild(planDropGhost);
      hideWeekPill();
      clearPlanDropTarget();
    }

    /** 指针 Y → 该列分钟（与拉边 weekMinuteAtClientY 同源几何）。 */
    function planMinuteAt(col, clientY) {
      var rect = (col && typeof col.getBoundingClientRect === 'function')
        ? col.getBoundingClientRect() : { top: 0 };
      var pxPerHour = (lastGeom && isFinite(lastGeom.pxPerHour)) ? lastGeom.pxPerHour : DEFAULT_WEEK_PX_PER_HOUR;
      return Layout.axisMinuteAt(lastGeom ? lastGeom.raw : null, clientY - (Number(rect.top) || 0),
        { pxPerHour: pxPerHour });
    }

    /** 拖拽期间折回临时展开的轴（只重渲染网格）。 */
    function foldPlanAxis() {
      if (!axisResizeExpanded) return;
      axisResizeExpanded = false;
      renderGrid(docOf(), state.monday);
    }

    function applyWeekResizeVisual(card, geom, st) {
      if (!card || !card.style || !geom) return;
      var top = geom.getY(st.startMinute);
      var bottom = geom.getY(st.endMinute);
      card.style.top = Math.round(top) + 'px';
      card.style.height = Math.max(WEEK_BLOCK_MIN_HEIGHT,
        Math.round(bottom - top) - WEEK_BLOCK_GAP) + 'px';
      var te = (typeof card.querySelector === 'function') ? card.querySelector('.wk-time') : null;
      if (te) te.textContent = st.current.start + '–' + st.current.end;
    }

    function ensureWeekPill() {
      var doc = root.document;
      if (!doc) return null;
      if (!weekPill) weekPill = el('div', { class: 'tl-drag-pill', 'aria-hidden': 'true' });
      if (doc.body && weekPill.parentNode !== doc.body) doc.body.appendChild(weekPill);
      return weekPill;
    }

    function showWeekPill(clientX, clientY, text) {
      var pill = ensureWeekPill();
      if (!pill) return;
      if (pill.textContent !== text) pill.textContent = text;
      pill.hidden = false;
      var vw = Number(root.innerWidth) || 0;
      var x = clientX;
      if (vw > 0) x = Math.max(30, Math.min(vw - 30, clientX));
      var gap = coarsePointer() ? 46 : 12;
      pill.style.left = Math.round(x) + 'px';
      pill.style.top = Math.max(26, Math.round(clientY - gap)) + 'px';
    }

    function hideWeekPill() {
      if (weekPill) weekPill.hidden = true;
    }

    function weekRaf(fn) {
      return (typeof root.requestAnimationFrame === 'function')
        ? root.requestAnimationFrame(fn) : setTimeout(fn, 16);
    }

    function weekRafCancel(id) {
      if (!id) return;
      if (typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(id);
      else clearTimeout(id);
    }

    function startWeekAutoScroll() {
      if (weekScrollRaf) return;
      weekScrollRaf = weekRaf(weekAutoScrollTick);
    }

    function stopWeekAutoScroll() {
      if (weekScrollRaf) weekRafCancel(weekScrollRaf);
      weekScrollRaf = 0;
    }

    function weekAutoScrollTick() {
      weekScrollRaf = 0;
      var st = resizeState;
      if (!st) return;
      /* 四十一轮 / F-93：拉边期间指针贴边才自动滚动（够到被挡住的时段）；
         中部 speed=0 → 不滚，维持四十轮「严格静止」。 */
      var r = scrollEl.getBoundingClientRect();
      var edge = WEEK_RESIZE_EDGE;
      var speed = 0;
      if (st.lastY < r.top + edge) {
        speed = -Math.max(1, Math.ceil((r.top + edge - st.lastY) / edge * 4));
      } else if (st.lastY > r.bottom - edge) {
        speed = Math.max(1, Math.ceil((st.lastY - (r.bottom - edge)) / edge * 4));
      }
      if (speed && scrollEl.scrollHeight > scrollEl.clientHeight + 1) {
        var before = scrollEl.scrollTop;
        scrollEl.scrollTop = before + speed;
        if (scrollEl.scrollTop !== before) updateWeekResizeAt(st.lastX, st.lastY);
      }
      if (resizeState) weekScrollRaf = weekRaf(weekAutoScrollTick);
    }

    function suppressWeekClick() {
      var doc = root.document;
      if (!doc || typeof doc.addEventListener !== 'function') return;
      dragSuppressUntil = Date.now() + 800;
      function block(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        if (e && e.preventDefault) e.preventDefault();
        doc.removeEventListener('click', block, true);
      }
      doc.addEventListener('click', block, true);
      setTimeout(function () { doc.removeEventListener('click', block, true); }, 700);
    }

    function attachWeekResize(card, occ, geom, col) {
      if (!card || !occ || !occ.time) return;
      if (isExpanded(occ)) return;   /* 展开卡是固定浮层，不参与拉边 */
      if (!Layout || typeof Layout.resizeTime !== 'function' ||
        typeof Layout.axisMinuteAt !== 'function') return;
      var top = el('span', { class: 'wk-resize wk-resize-start', 'aria-hidden': 'true' });
      var bottom = el('span', { class: 'wk-resize wk-resize-end', 'aria-hidden': 'true' });
      top.addEventListener('pointerdown', function (e) {
        requestWeekResizeStart(e, occ, 'start', top, card, geom, col);
      });
      bottom.addEventListener('pointerdown', function (e) {
        requestWeekResizeStart(e, occ, 'end', bottom, card, geom, col);
      });
      top.addEventListener('dragstart', function (e) { if (e.preventDefault) e.preventDefault(); });
      bottom.addEventListener('dragstart', function (e) { if (e.preventDefault) e.preventDefault(); });
      card.appendChild(top);
      card.appendChild(bottom);
    }

    function clearArmedWeekResize() {
      if (armedResizeTimer) { clearTimeout(armedResizeTimer); armedResizeTimer = 0; }
      if (armedResize && armedResize.card && armedResize.card.classList) {
        armedResize.card.classList.remove('is-resize-armed', 'is-resize-armed-start', 'is-resize-armed-end');
      }
      armedResize = null;
    }

    function armWeekResize(card, edge) {
      clearArmedWeekResize();
      if (!card || !card.classList) return;
      armedResize = { card: card, edge: edge };
      card.classList.add('is-resize-armed', 'is-resize-armed-' + edge);
      armedResizeTimer = setTimeout(clearArmedWeekResize, ARMED_RESIZE_MS);
    }

    function requestWeekResizeStart(e, occ, edge, handle, card, geom, col) {
      if (e.button !== undefined && e.button !== 0) return;
      if (!needsResizeArm(e)) {
        onWeekResizeStart(e, occ, edge, handle, card, geom, col);
        return;
      }
      if (armedResize && armedResize.card === card && armedResize.edge === edge) {
        clearArmedWeekResize();
        onWeekResizeStart(e, occ, edge, handle, card, geom, col);
        return;
      }
      if (armCandidate) return;
      var cand = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      armCandidate = cand;
      function finish(arm) {
        if (armCandidate !== cand) return;
        armCandidate = null;
        docRemove();
        if (arm) {
          armWeekResize(card, edge);
          suppressWeekClick();
        }
      }
      function docRemove() {
        var doc = root.document;
        if (!doc) return;
        doc.removeEventListener('pointermove', onMove, true);
        doc.removeEventListener('pointerup', onUp, true);
        doc.removeEventListener('pointercancel', onCancel, true);
      }
      function onMove(ev) {
        if (cand.pointerId !== undefined && ev.pointerId !== undefined && ev.pointerId !== cand.pointerId) return;
        if (Math.abs(ev.clientX - cand.x) > 6 || Math.abs(ev.clientY - cand.y) > 6) finish(false);
      }
      function onUp(ev) {
        if (cand.pointerId !== undefined && ev.pointerId !== undefined && ev.pointerId !== cand.pointerId) return;
        finish(Math.abs(ev.clientX - cand.x) <= 6 && Math.abs(ev.clientY - cand.y) <= 6);
      }
      function onCancel() { finish(false); }
      var doc = root.document;
      if (doc) {
        doc.addEventListener('pointermove', onMove, true);
        doc.addEventListener('pointerup', onUp, true);
        doc.addEventListener('pointercancel', onCancel, true);
      }
    }

    function onWeekResizeStart(e, occ, edge, handle, card, geom, col) {
      if (e.button !== undefined && e.button !== 0) return;
      if (!occ.time || !card || !col || resizeState) return;
      clearArmedWeekResize();
      var startMin = D.minutesOf(occ.time.start);
      var endMin = D.minutesOf(occ.time.end);
      if (startMin === null || endMin === null) return;
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      resizeState = {
        occ: occ, edge: edge, card: card, handle: handle,
        col: col, geom: geom,
        pointerId: e.pointerId,
        orig: { start: occ.time.start, end: occ.time.end },
        origStart: startMin,
        origEnd: endMin,
        current: { start: occ.time.start, end: occ.time.end, startMinute: startMin, endMinute: endMin },
        startMinute: startMin,
        endMinute: endMin,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false
      };
      if (card.classList) card.classList.add('is-resizing');
      if (root.document && root.document.documentElement && root.document.documentElement.classList) {
        root.document.documentElement.classList.add('is-week-resizing');
      }
      suppressWeekClick();
      showWeekPill(e.clientX, e.clientY, D.formatMinutes(edge === 'start' ? startMin : endMin));
      /* 四十轮 F-92 + 四十一轮 F-93：打锁标记拉边中；边缘自动滚动仅指针贴边时生效 */
      if (scrollEl && scrollEl.setAttribute) scrollEl.setAttribute('data-scroll-lock', '1');
      var doc = root.document;
      if (doc) {
        doc.addEventListener('pointermove', onWeekResizeMove, true);
        doc.addEventListener('pointerup', onWeekResizeEnd, true);
        doc.addEventListener('pointercancel', onWeekResizeCancel, true);
      }
      try { if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }

    function onWeekResizeMove(e) {
      if (!resizeState) return;
      if (resizeState.pointerId !== undefined && e.pointerId !== undefined &&
        e.pointerId !== resizeState.pointerId) return;
      if (e.preventDefault) e.preventDefault();
      updateWeekResizeAt(e.clientX, e.clientY);
      startWeekAutoScroll();
    }

    function updateWeekResizeAt(clientX, clientY) {
      var st = resizeState;
      if (!st) return;
      st.lastX = clientX;
      st.lastY = clientY;
      var boundary = weekResizeBoundary(st, clientY);
      if (boundary) expandWeekResizeAxis(st, boundary);
      var minute = weekMinuteAtClientY(st, clientY);
      var step = weekDragStep();
      var t = Layout.resizeTime(st.orig, st.edge, minute, {
        step: step, minDuration: weekDragMinDuration()
      });
      if (!t) return;
      showWeekPill(clientX, clientY, D.formatMinutes(Layout.snapMinute(minute, step)));
      if (t.startMinute === st.startMinute && t.endMinute === st.endMinute) return;
      st.current = t;
      st.startMinute = t.startMinute;
      st.endMinute = t.endMinute;
      st.moved = (t.startMinute !== st.origStart || t.endMinute !== st.origEnd);
      applyWeekResizeVisual(st.card, st.geom, st);
    }

    function stopWeekResize(commit) {
      var st = resizeState;
      if (!st) return;
      resizeState = null;
      /* 四十轮 / F-92：解锁 */
      if (scrollEl && scrollEl.removeAttribute) scrollEl.removeAttribute('data-scroll-lock');
      var doc = root.document;
      if (doc) {
        doc.removeEventListener('pointermove', onWeekResizeMove, true);
        doc.removeEventListener('pointerup', onWeekResizeEnd, true);
        doc.removeEventListener('pointercancel', onWeekResizeCancel, true);
      }
      stopWeekAutoScroll();
      hideWeekPill();
      var wasExpanded = axisResizeExpanded;
      axisResizeExpanded = false;
      if (doc && doc.documentElement && doc.documentElement.classList) {
        doc.documentElement.classList.remove('is-week-resizing');
      }
      if (st.card && st.card.classList) st.card.classList.remove('is-resizing');
      if (!commit || !st.moved) {
        if (wasExpanded) render();
        return;
      }
      var item = findItemFor(st.occ);
      if (!item) {
        if (wasExpanded) render();
        return;
      }
      var time = { start: st.current.start, end: st.current.end };
      try {
        if (item.kind === 'series') {
          store.addSeriesException(item.id, st.occ.date, { time: time });
        } else {
          store.updateItem(item.id, { time: time });
        }
      } catch (e) {
        M.toast('调整时间失败：' + errText(e));
        if (wasExpanded) render();
        return;
      }
      afterWrite();   /* 重渲染时 axisResizeExpanded 已复位 → 轴折回去 */
      M.toast('时间已改为 ' + time.start + '–' + time.end);
    }

    function onWeekResizeEnd(e) {
      if (!resizeState) return;
      if (resizeState.pointerId !== undefined && e.pointerId !== undefined &&
        e.pointerId !== resizeState.pointerId) return;
      stopWeekResize(true);
    }

    function onWeekResizeCancel(e) {
      if (!resizeState) return;
      if (resizeState.pointerId !== undefined && e && e.pointerId !== undefined &&
        e.pointerId !== resizeState.pointerId) return;
      stopWeekResize(false);
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
      var geom = axisGeometry(doc, days, byDate, pxPerHourSetting, axisResizeExpanded);
      lastGeom = geom;
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
            /* 迭代 8（F-52）：列宽由内容决定 —— 每条道列宽 = 该道事项所需宽度的最大值
               （下限保证时间不换行、上限封顶）；某天列宽 = 其各道列宽之和。
               2026-11-02：一条道可能混着不同类别的事项，故逐项按**自己的**类别胶囊
               认真宽度，再取最大值（不能沿用「整桶共享一个类别」的旧口径）。 */
            measureWidth: function (occ, laneItems) {
              if (!Layout || typeof Layout.blockWidthNeed !== 'function') {
                if (root.console) console.warn('[DayPlan] measureWidth 降级：Layout.blockWidthNeed 缺失');
                return 0;
              }
              var max = 0;
              (laneItems || []).forEach(function (it) {
                var o = (it && it.occ) ? it.occ : it;
                if (!o) return;
                var chipW = 0;
                if (typeof Layout.chipWidthFor === 'function') {
                  var cat = (doc.categories || []).filter(function (c) { return c && c.id === o.categoryId; })[0];
                  /* 胶囊显示类别前两个字 → 列宽度量也按两个字占宽 */
                  chipW = Layout.chipWidthFor(chipLabelOf(cat ? cat.name : ''), { padX: 12, gap: 6 });
                }
                var w = 0;
                try { w = Layout.blockWidthNeed(o, { chipWidth: chipW }); } catch (e) { w = 0; }
                if (isFinite(w) && w > max) max = w;
              });
              return max;
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

      /* 迭代 8（F-52）：列宽由内容决定 —— 38px 轴列（四十九轮由 52 收窄）+ 每天「各构成类别列宽之和」像素；
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
      /* 拉边进入折叠区时会临时展开整条轴（收尾自动折回），供诊断与冒烟断言 */
      gridEl.setAttribute('data-week-axis-expanded', axisResizeExpanded ? '1' : '0');

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

    /** 横向真正溢出的容器：内层 grid-scroll 负责横滚，周表外层只负责纵滚 */
    function weekHScroller() {
      var list = [gridScrollEl, scrollEl];
      for (var i = 0; i < list.length; i += 1) {
        var n = list[i];
        if (!n) continue;
        if (!(Number(n.clientWidth) > 0)) continue;
        if (Number(n.scrollWidth) > Number(n.clientWidth) + 1) return n;
      }
      return null;
    }

    /** 把「今天」那一列滚到可视区中间（本周且窄到需要横滚时才生效）。
        只由导航（进周视图 / 切到本周）当次调用：视图隐藏或不需要横滚时静默不滚，
        绝不挂起等后续重绘 —— 否则展开事项触发的 render() 会把页面甩到今天列。 */
    function scrollToTodayColumn() {
      var today = D.todayISO();
      if (!today) return;
      var sc = weekHScroller();
      if (!sc) return;
      var head = gridEl && typeof gridEl.querySelector === 'function'
        ? gridEl.querySelector('.wk-head[data-date="' + today + '"]')
        : null;
      if (!head || typeof head.getBoundingClientRect !== 'function') return;
      var hr = head.getBoundingClientRect();
      var sr = sc.getBoundingClientRect();
      if (!(hr.width > 0)) return;
      var center = (hr.left - sr.left) + (Number(sc.scrollLeft) || 0) + hr.width / 2;
      sc.scrollLeft = Math.max(0, Math.round(center - Number(sc.clientWidth) / 2));
    }

    function render() {
      var doc = docOf();
      var monday = state.monday || D.startOfWeek(D.todayISO()) || D.todayISO();
      state.monday = monday;
      titleEl.textContent = weekTitle(monday);
      /* 看的就是本周时不再给「本周」按钮（点了也没有变化） */
      var thisMonday = D.startOfWeek(D.todayISO());
      if (btnThis) btnThis.hidden = !!(thisMonday && monday === thisMonday);
      renderGrid(doc, monday);
      renderPlans(doc, monday);
      if (railCover) railCover.render();
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
      var thisMonday = D.startOfWeek(D.todayISO());
      var enterThisWeek = !!(thisMonday && next === thisMonday);
      /* 除「周变化」外，文档在最近一次渲染之后被外部改写时也要重渲染：应用层没有 store.subscribe，
       * 直接调用 store.addItem / 导入 / 迁移不会通知视图，而 app.setViewMode('week') 每次都按同一周
       * 调 setDate —— 只看 changed 会留下过期 DOM（引导冒烟 SC-27 正是该调用序）。
       * 用 meta.updatedAt + items.length 作为轻量指纹，避免无数据变化时的无谓重排。 */
      var doc = docOf();
      var stale = dataStamp(doc) !== lastRenderStamp;
      if (changed || o.force || stale) render();
      /* 切到本周时把今天列划进可视区（窄屏才需要）。只在这次导航里做，
         视图隐藏或无需横滚就当次放弃 —— 不留下待办，避免展开事项的重绘再触发。 */
      if (enterThisWeek) scrollToTodayColumn();
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

    /* 四十七轮（用户口径）：手机端在周表以外左右滑动切换周，取代「‹ / 本周 / ›」
       两侧箭头；键盘 Alt+←/→ 仍走 shiftWeek。 */
    if (root.DayPlan.motion && typeof root.DayPlan.motion.enableSwipe === 'function') {
      root.DayPlan.motion.enableSwipe(rootEl, {
        exclude: function (target) {
          return !!(target && target.closest && target.closest('#week-grid-scroll'));
        },
        onCommit: function (dir) {
          var base = state.monday || D.startOfWeek(D.todayISO());
          setWeekStart(D.addDays(base, dir * 7), { notify: true });
        }
      });
    }

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
          defaultCategoryId: defaultCategoryIdOf(doc),
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
      /* D34：提醒挂在整条序列上，两种范围都写回序列。 */
      var seriesReminder = v.reminder || null;
      if (JSON.stringify(seriesReminder) !== JSON.stringify(item.reminder || null)) {
        store.updateItem(item.id, { reminder: seriesReminder });
        item.reminder = seriesReminder || undefined;
      }
      if (scope === 'only') {
        var patch = {
          time: v.time, title: v.title, categoryId: v.categoryId, note: v.note, done: v.done
        };
        store.addSeriesException(item.id, occ.date, patch);
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
        var patch = {
          title: v.title, categoryId: v.categoryId, date: v.date,
          time: v.time, note: v.note, done: v.done,
          reminder: v.reminder || null
        };
        store.updateItem(item.id, patch);
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
      if (v.reminder) next.reminder = v.reminder;
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
          defaultCategoryId: defaultCategoryIdOf(doc)
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
      /* 三十九轮：合并表单 meta（addToDays / previousCategoryId 不再被整包覆盖），origin/weekStart 以本视图为准 */
      var meta = {};
      Object.keys(v.meta || {}).forEach(function (k) { meta[k] = v.meta[k]; });
      meta.origin = 'weekPlan';
      meta.weekStart = monday;
      store.addItem({
        kind: 'series',
        title: v.title,
        categoryId: v.categoryId,
        time: v.time || null,
        note: v.note || '',
        /* DM-18.4：不写 starred —— 紧急状态由 categoryId（表单的类别下拉/紧急勾选）表达 */
        repeat: repeat,
        exceptions: {},
        meta: meta
      });
      M.toast(meta.addToDays === false ? '已创建周计划（在右侧计划区，拖到某天生效）' : '已创建周计划（本周 7 天）');
    }

    /* ------------------------------------------------------------------ *
     * 7.6 本周计划显示区（三十九轮 / F-87）
     *   右栏图片区与当周记录之间；本周周计划 + 相交月份的月计划逐条列出。
     *   行可点开编辑弹窗；HTML5 拖到左侧某天生成独立单次副本（源不消失、允许重复）。
     * ------------------------------------------------------------------ */

    /** 本周计划清单：周计划（weekStart=本周一）在前、月计划（月份与本周相交）在后，组内按 order / createdAt。 */
    function weekPlansOf(doc, monday) {
      var items = (doc && doc.items) || [];
      var months = {};
      weekDays(monday).forEach(function (iso) { months[iso.slice(0, 7)] = true; });
      var week = [];
      var month = [];
      items.forEach(function (it) {
        if (!it || it.kind !== 'series' || !it.meta) return;
        if (it.meta.origin === 'weekPlan' && it.meta.weekStart === monday) week.push(it);
        else if (it.meta.origin === 'monthPlan' && months[it.meta.month]) month.push(it);
      });
      function byOrder(a, b) {
        var ao = numOr(a.order, 0);
        var bo = numOr(b.order, 0);
        if (ao !== bo) return ao - bo;
        var ac = String(a.createdAt || '');
        var bc = String(b.createdAt || '');
        if (ac !== bc) return ac < bc ? -1 : 1;
        return String(a.id) < String(b.id) ? -1 : 1;
      }
      week.sort(byOrder);
      month.sort(byOrder);
      return week.concat(month);
    }

    function planTimeText(time) {
      if (!time || !time.start) return '';
      return time.start + (time.end ? '–' + time.end : '');
    }

    function planRowNode(plan, cats) {
      var cat = (cats && cats[plan.categoryId]) || { name: '未分类', color: DEFAULT_CAT_COLOR };
      var isMonth = plan.meta.origin === 'monthPlan';
      var tone = toneOf ? toneOf(cat.color) : null;
      var row = el('li', {
        class: 'wp-item', role: 'button', tabindex: '0', draggable: 'true',
        'data-plan-id': plan.id,
        'data-plan-kind': isMonth ? 'monthPlan' : 'weekPlan',
        style: '--cat:' + catAccent(cat.color) + (tone ? ';--cat-bg:' + tone.background : ''),
        'aria-label': (isMonth ? '月计划：' : '周计划：') + plan.title
      });
      var main = el('div', { class: 'wp-main' }, [
        el('span', { class: 'wp-cat', 'aria-hidden': 'true' }),
        el('span', { class: 'wp-title', text: plan.title })
      ]);
      var timeText = planTimeText(plan.time);
      if (timeText) main.appendChild(el('span', { class: 'wp-time', text: timeText }));
      main.appendChild(el('span', { class: 'wp-chip', text: isMonth ? '月计划' : '周计划' }));
      row.appendChild(main);
      if (plan.note) row.appendChild(el('div', { class: 'wp-note', text: plan.note }));
      row.addEventListener('click', function () {
        if (dragSuppressUntil && Date.now() < dragSuppressUntil) return;
        editWeekPlan(plan.id);
      });
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          editWeekPlan(plan.id);
        }
      });
      return row;
    }

    function renderPlans(doc, monday) {
      if (!plansListEl) return;
      var cats = {};
      ((doc && doc.categories) || []).forEach(function (c) { cats[c.id] = c; });
      var plans = weekPlansOf(doc, monday);
      plansListEl.innerHTML = '';
      plans.forEach(function (plan) { plansListEl.appendChild(planRowNode(plan, cats)); });
      if (plansEmptyEl) plansEmptyEl.hidden = plans.length > 0;
    }

    /** 点行 → 编辑弹窗（周 / 月表单按 origin 分流）；页脚「删除」走二次确认。 */
    function editWeekPlan(planId) {
      var Form = root.DayPlan ? root.DayPlan.form : null;
      var doc = docOf();
      var plan = findItemFor({ seriesId: planId });
      if (!plan || !Form) return;
      var isMonth = plan.meta && plan.meta.origin === 'monthPlan';
      var form = null;
      try {
        form = isMonth
          ? Form.createMonthPlanForm({
            ym: plan.meta.month, item: plan,
            categories: doc.categories || [], defaultCategoryId: defaultCategoryIdOf(doc)
          })
          : Form.createWeekPlanForm({
            weekStart: (plan.meta && plan.meta.weekStart) || state.monday, item: plan,
            categories: doc.categories || [], defaultCategoryId: defaultCategoryIdOf(doc)
          });
      } catch (e) { form = null; }
      if (!form || !form.element) { M.toast('计划表单尚未就绪'); return; }

      var handle = null;
      var delBtn = el('button', {
        class: 'btn btn-danger', type: 'button', text: '删除',
        onclick: function () {
          M.confirm({
            title: isMonth ? '删除月计划' : '删除周计划',
            message: '确定删除「' + plan.title + '」？' +
              (plan.meta && plan.meta.addToDays === false
                ? '已拖到各天的副本会保留。'
                : '该计划已同步到每天的事项会一并移除，已拖出的副本保留。'),
            confirmLabel: '删除', danger: true
          }).then(function (ok) {
            if (!ok) return;
            try { store.removeItem(plan.id); } catch (e) { M.toast(e.message); return; }
            if (handle) handle.close('delete');
            afterWrite();
            M.toast('已删除');
          });
        }
      });
      handle = M.open({
        title: isMonth ? '编辑本月计划' : '编辑周计划',
        body: form.element,
        footer: [delBtn],
        submitLabel: '保存',
        wide: true,
        onSubmit: function (ctx) {
          var check = form.validate();
          if (!check.ok) { ctx.setError(check.message); return false; }
          var v = check.values || (typeof form.getValues === 'function' ? form.getValues() : null);
          if (!v) { ctx.setError('表单取值失败'); return false; }
          try {
            store.updateItem(plan.id, {
              title: v.title,
              categoryId: v.categoryId,
              time: v.time || null,
              note: v.note || '',
              repeat: v.repeat,
              meta: v.meta
            });
          } catch (e) {
            ctx.setError(errText(e));
            return false;
          }
          afterWrite();
          M.toast('已保存');
        }
      });
      if (typeof form.focus === 'function') form.focus();
    }

    /* ---- 显示区 → 左网格的拖拽（独立副本，源不消失、允许重复） ---- */

    var dragPlanId = null;
    var planDropGhost = null;   /* 四十轮 / F-90：拖拽落点预览块 */

    function clearPlanDropTarget() {
      if (!gridEl || typeof gridEl.querySelectorAll !== 'function') return;
      var marked = gridEl.querySelectorAll('.wk-col.is-drop-target');
      for (var i = 0; i < marked.length; i += 1) marked[i].classList.remove('is-drop-target');
    }

    function planColOf(target) {
      var n = target;
      while (n && n !== gridEl) {
        if (n.classList && n.classList.contains('wk-col')) return n;
        n = n.parentNode;
      }
      return null;
    }

    function setupPlanDrag() {
      if (!plansListEl || !gridEl) return;

      plansListEl.addEventListener('dragstart', function (e) {
        var row = e.target && e.target.closest ? e.target.closest('.wp-item') : null;
        if (!row) return;
        dragPlanId = row.getAttribute('data-plan-id');
        dragSuppressUntil = Date.now() + 500;
        row.classList.add('is-dragging');
        try {
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('application/x-dayplan-weekplan', dragPlanId);
            e.dataTransfer.setData('text/plain', dragPlanId);
          }
        } catch (err) { /* 忽略 */ }
      });

      plansListEl.addEventListener('dragend', function (e) {
        var row = e.target && e.target.closest ? e.target.closest('.wp-item') : null;
        if (row) row.classList.remove('is-dragging');
        clearPlanPreview();
        foldPlanAxis();
        dragPlanId = null;
      });

      gridEl.addEventListener('dragover', function (e) {
        if (!dragPlanId) return;
        var col = planColOf(e.target);
        if (!col) return;
        e.preventDefault();
        try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } catch (err) { /* 忽略 */ }
        if (!col.classList.contains('is-drop-target')) {
          clearPlanDropTarget();
          col.classList.add('is-drop-target');
        }
        var y = e.clientY;
        if (typeof y !== 'number' || !isFinite(y) || !lastGeom) { hideWeekPill(); return; }
        var iso = col.getAttribute('data-date');
        /* 指针进折叠带 → 临时展开整轴（只重渲染网格，右栏源行不摘除 → 拖拽不中断） */
        var boundary = weekResizeBoundary({ geom: lastGeom, col: col }, y);
        if (boundary && !axisResizeExpanded) {
          expandWeekAxisCore(boundary, iso, function () { renderGrid(docOf(), state.monday); });
          col = weekColumnNode(iso) || col;
        }
        var t = Layout.scheduleTime(planMinuteAt(col, y), 60, { step: weekDragStep() });
        showPlanGhost(col, t);
        showWeekPill(e.clientX, y, t.start + '–' + t.end);
      });

      gridEl.addEventListener('dragleave', function (e) {
        if (!dragPlanId) return;
        var to = e.relatedTarget;
        if (to && gridEl.contains && gridEl.contains(to)) return;
        clearPlanPreview();
        foldPlanAxis();
      });

      gridEl.addEventListener('drop', function (e) {
        if (!dragPlanId) return;
        var col = planColOf(e.target);
        if (!col) return;
        e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        var planId = dragPlanId;
        var iso = col.getAttribute('data-date');
        var y = e.clientY;
        dragPlanId = null;
        clearPlanPreview();
        dragSuppressUntil = Date.now() + 500;
        var plan = findItemFor({ seriesId: planId });
        if (!plan || !iso) { foldPlanAxis(); return; }
        /* 落点 = 指针居中、默认 1h（与未排→时间轴同口径）；坐标缺失回落源时段 */
        var time = plan.time || null;
        if (typeof y === 'number' && isFinite(y) && lastGeom) {
          var t = Layout.scheduleTime(planMinuteAt(col, y), 60, { step: weekDragStep() });
          time = { start: t.start, end: t.end };
        }
        axisResizeExpanded = false;   /* 写入后整轴折回 */
        try {
          /* 独立副本：不带 origin / addToDays，与源计划无联动；order 由 store 自动分配 */
          store.addItem({
            kind: 'single',
            date: iso,
            title: plan.title,
            categoryId: plan.categoryId,
            time: time,
            note: plan.note || '',
            done: false,
            meta: { sourcePlanId: plan.id }
          });
        } catch (err) {
          M.toast('添加失败：' + errText(err));
          return;
        }
        afterWrite();
        M.toast('已添加到 ' + Number(iso.slice(5, 7)) + '月' + Number(iso.slice(8, 10)) + '日');
      });
    }

    /* ------------------------------------------------------------------ *
     * 7.7 时间表空白鼠标拖拽平移（三十九轮 / F-88，斜向）
     * ------------------------------------------------------------------ */

    function setupPan() {
      var BP = root.DayPlan ? root.DayPlan.blankPan : null;
      if (!BP || typeof BP.attach !== 'function' || !scrollEl) return;
      /* 横向跟随内层 .week-grid-scroll，纵向跟随外层 .week-scroll → 斜向同帧移动；
         事项块 / 拉边手柄 / 展开卡 / 列头 / 控件上按下不启动。 */
      BP.attach({
        container: scrollEl,
        scrollX: gridScrollEl,
        scrollY: scrollEl,
        exclude: '.wk-item, .wk-resize, .item-detail, .wk-head, button, input, select, textarea, a',
        onSuppress: function (ms) { dragSuppressUntil = Date.now() + ms; }
      });
    }

    /* ------------------------------------------------------------------ *
     * 8. 初始化
     * ------------------------------------------------------------------ */

    state.monday = D.startOfWeek(D.todayISO()) || D.todayISO();
    state.hideDone = readHideDone();
    setupPlanDrag();
    setupPan();
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
