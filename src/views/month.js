/**
 * DayPlan · src/views/month.js —— 月视图（迭代 4 / T48）
 *
 * 契约：docs/spec/07-iteration-4-delta.md
 *   S27 / US-23（连续多月列表）、US-22.3（点击下钻）、BR-32/BR-33、ADR-23、DM-26 裁定
 *
 * 职责：
 *   1. **单一纵向滚动区**（`.month-scroll`）+ 网格容器 `.month-list`，
 *      CSS 用 `repeat(auto-fill, minmax(240px, 1fr))` 做响应式多月排布（每行 3–6 个月）；
 *      旧设计「可视区恒 3 列 + 居中缓冲列 + 滚动中性点回弹」已整体删除。
 *   2. 初始窗口 = 选定月所在年份 ±2 年（60 个月，BR-32），升序连续排列。
 *   3. 滚动到距顶端/底端 ≤200px 时向该方向追加 1 年（12 个月）；
 *      向上追加时用「内容高度增量」补偿 `scrollTop`，保证可视锚点不跳变（AC-23.4）。
 *   4. 每处年份变化插入 `.month-year-sep` 年份分隔标题（跨整行，AC-23.5）。
 *   5. **无「选中」态**（AC-23.1）：不输出 `选中` 文案 / `is-center` / `is-selected` / `.ym-badge`。
 *      保留今日高亮、农历小字、节假日与调休标注、整周悬停、
 *      数据集边界（1900-01 / 2100-12）与缺年份提示。
 *      迭代 6（F-40 / R-19）：
 *        - **删除上下边界虚化**（mask-image 下线，见 styles/month.css）；
 *        - 今日格新增可见标记 `.mc-today-tag`（文案「今天」）；
 *        - 新增 `scrollToToday()`：每次由 app 切到月视图时回到「今天」的位置。
 *   6. 点击下钻（迭代 6 / F-42 取代 07 AC-22.3 + R-20）：
 *      **整周行任意位置（含日期格）** → `opts.onOpenWeek(该行周一)`；
 *      本视图**不再**回调 `onOpenDay`（下钻到某一天由周视图承担）。
 *
 * 依赖（全部容错，缺任一可选模块都能降级渲染）：
 *   core/datetime.js、core/calendar-grid.js、core/recurrence.js、core/lunar.js、
 *   data/holidays.js、ui/modal.js（只借用 el）。
 *
 * 冻结签名（src/app.js 按此调用；迭代 6 变更：移除 onOpenDay、追加 scrollToToday）：
 *   createMonthView({store, container, onSelectDate, onOpenWeek, onDataChanged})
 *     -> {element, render, refresh, setDate(iso, opts), navigate(delta), getMonth(),
 *         scrollToToday()[, destroy()]}
 *   - 本函数自行把渲染根挂进 container；**不改写 container.hidden**（由 app 控制显隐）。
 *   - setDate(iso, {notify:false}) 不回调 onSelectDate；仍以该月为中心重置窗口。
 *
 * 注：`calendarGrid.monthWindow` / `visibleMonths` 自迭代 4 起不再被本视图调用（DM-26 R-1），
 *     本视图统一走 `initialMonthWindow` / `extendRange`。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var D = root.DayPlan.datetime;
  var CG = root.DayPlan.calendarGrid;
  var Recurrence = root.DayPlan.recurrence;
  var Lunar = root.DayPlan.lunar;
  var M = root.DayPlan.modal;
  var Schema = root.DayPlan.schema;
  var Form = root.DayPlan.form;

  var MIN_YM = (CG && CG.MIN_YM) || '1900-01';
  var MAX_YM = (CG && CG.MAX_YM) || '2100-12';
  var DOW_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

  var MARKER_CACHE_LIMIT = 24;   /* 04 §3.5：离开窗口的月份结果缓存上限 24 */
  var SCROLL_THROTTLE_MS = 60;   /* 滚动监听节流 */
  var APPEND_TRIGGER_PX = 200;   /* 距顶端/底端 ≤200px 时追加（AC-23.4） */
  var WHEEL_STEP_PX = 48;        /* 无原生滚动行程时的滚轮兜底步长 */
  var ANCHOR_ADJUST_GUARD = 64;  /* 锚点补偿上限（宽松），防止异常测量导致跳变 */
  var MONTH_COL_ESTIMATE_PX = 200; /* F-40：无布局引擎时按月列行高的估计值（垫片/测试用） */
  var LIST_GAP_PX = 12;          /* .month-list 的 grid gap（styles/month.css） */
  /* 手机单列口径：与 styles/month.css 的 ≤640 断点同值（改一处必须同步另一处） */
  var MOBILE_MAX_PX = 640;
  /* 年视图（三十六轮命名；此前称「缩略」）：一年 12 个月 3 列 × 4 行，可纵向滚到相邻年份。
     三十七轮（用户口径）：入口只剩手机端分段控件的「年」，不再识别双指捏合，桌面也没有入口。 */
  var YEAR_COLS = 3;
  /* 月 ↔ 年 FLIP 过渡（参考 Apple 日历）：700ms 更缓，锚点月保持空间连续。
     只对 .month-list 做 transform，不加整层 opacity —— 半透明会透出页面底色，像闪一下。 */
  var FLIP_MS = 700;
  var FLIP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
  var FLIP_FADE_MS = 260;       /* 其他月份辅助淡入（两个方向都从 0 淡入，避免重排跳变） */
  var FLIP_FADE_STEP_MS = 16;   /* 错峰步长（同排 12 个月最多 128ms） */
  var YEAR_EXTEND_TRIGGER_PX = 320; /* 年视图滚到距顶 / 底该距离时续载 1 年 */
  var YEAR_EXTEND_THROTTLE_MS = 240;

  /** 默认落点颜色（无类别色时）。 */
  var DEFAULT_DOT_COLOR = '#94a3b8';

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** 借用 ui/modal 的 el（index.html 先加载 modal.js）；缺省时用等价本地实现。 */
  function el(tag, attrs, children) {
    if (M && typeof M.el === 'function') return M.el(tag, attrs, children);
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  /** "YYYY-MM" -> {year, month(1-12)} | null */
  function parseYM(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    if (!m) return null;
    var month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { year: Number(m[1]), month: month };
  }

  /** 月份偏移（不依赖 datetime，保证降级可用）。 */
  function addMonthsYM(ym, n) {
    var p = parseYM(ym);
    if (!p) return null;
    var total = p.year * 12 + (p.month - 1) + n;
    var y = Math.floor(total / 12);
    return y + '-' + pad2(total - y * 12 + 1);
  }

  function clampYM(ym) {
    if (CG && typeof CG.clampYM === 'function') {
      var c = CG.clampYM(ym);
      if (c) return c;
    }
    if (!parseYM(ym)) return MIN_YM;
    if (ym < MIN_YM) return MIN_YM;
    if (ym > MAX_YM) return MAX_YM;
    return ym;
  }

  /** 农历小字：初一显示月名，其余显示日名（与迭代 3 同口径）。 */
  function lunarLabel(iso) {
    if (!Lunar || typeof Lunar.solarToLunar !== 'function') return '';
    var l;
    try { l = Lunar.solarToLunar(iso); } catch (e) { return ''; }
    if (!l) return '';
    try {
      if (l.day === 1) {
        var name = Lunar.lunarMonthName ? Lunar.lunarMonthName(l.month, l.isLeap) : null;
        if (name) return name;
        return (l.isLeap ? '闰' : '') + l.month + '月';
      }
      if (Lunar.lunarDayName) return Lunar.lunarDayName(l.day);
    } catch (e2) { /* 降级为数字 */ }
    return l.day === 1 ? l.month + '月' : String(l.day);
  }

  /** 数值选项（供列数口径复用）。 */
  function numOption(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback;
  }

  /* ------------------------------------------------------------------ *
   * 视图工厂
   * ------------------------------------------------------------------ */

  /**
   * @param {object} opts
   *   - store                   有 getState() / subscribe()
   *   - container               挂载点（#view-month-root）
   *   - onSelectDate(iso)       选中日期变化（setDate 且 opts.notify !== false）
   *   - onOpenWeek(iso)         单击整周行（含日期格）→ 进入该周周视图
   *   - onDataChanged()         本视图不产生数据变更，保留以匹配 app 契约
   *   （迭代 6 / R-20：`onOpenDay` 已移除，月视图不再下钻到日视图）
   * @returns {{element, render, refresh, setDate, navigate, getMonth, scrollToToday, destroy}}
   */
  function createMonthView(opts) {
    opts = opts || {};
    var store = opts.store || null;
    var container = opts.container || null;

    var today0 = D.todayISO();
    var state = {
      centerYM: clampYM(today0.slice(0, 7)), /* 窗口锚点月（= 选定月） */
      selected: today0,                      /* 选定日期（内部保留：周导航破平 + 回退） */
      range: null,                           /* {startYM, endYM} */
      months: [],                            /* 当前列表里的月份数据（升序） */
      appendCount: 0                         /* 追加次数（ST-58：DOM 月数 = 60 + 12n） */
    };

    var suppressScroll = false;    /* 自身写 scrollTop 时忽略 scroll 事件回环 */
    var lastScrollTop = 0;
    var wheelAcc = 0;
    var throttleTimer = 0;
    var lastRunAt = 0;
    var destroyed = false;
    var unsubscribe = null;

    /* 年视图（三十七轮起只由手机端分段控件的「年」进入；捏合手势已移除） */
    var yearMode = false;
    var yearCenterYM = null;
    var flipAnim = null;          /* 进行中的月 ↔ 年 FLIP 动画 */
    var flipFades = [];           /* 其他月份的错峰淡入动画 */
    var yearExtendAt = 0;

    /* 标记点缓存：ym -> {version, map}，LRU ≤ MARKER_CACHE_LIMIT */
    var markerCache = Object.create(null);
    var cacheOrder = [];
    var lastVersion = null;

    /* ---------------- DOM 骨架（单一纵向滚动区 + 网格列表） ---------------- */

    var element = el('div', { class: 'month-view', 'data-view': 'month' });
    var scrollEl = el('div', { class: 'month-scroll' });
    var listEl = el('div', { class: 'month-list' });
    var boundaryEl = el('div', { class: 'month-boundary', hidden: true, role: 'status' });
    scrollEl.appendChild(listEl);
    element.appendChild(scrollEl);
    element.appendChild(boundaryEl);

    /* 自行挂载（app 不再 append element）；不触碰 container.hidden */
    if (container && container.appendChild) {
      var kids = container.childNodes ? Array.prototype.slice.call(container.childNodes) : [];
      kids.forEach(function (n) {
        if (n && n.nodeType === 1 && n.classList && n.classList.contains('month-view')) {
          container.removeChild(n);
        }
      });
      container.appendChild(element);
    }

    /* ---------------- 数据 / 缓存 ---------------- */

    function safeDoc() {
      if (store && typeof store.getState === 'function') {
        try { return store.getState() || {}; } catch (e) { return {}; }
      }
      return {};
    }

    /** 文档版本指纹：数据**或**设置真变化就重绘（与 app 的 onDataChanged 去重）。
     *  迭代 7 / F-51：加入设置签名 —— 此前只改设置不改数据时指纹不变 → render() 被跳过，
     *  「取消月历标注有记录的日子」等开关看起来不生效（用户条目 5）。 */
    function settingsSignature(doc) {
      var s = (doc && doc.settings) || {};
      return [s.showLunarInCalendar !== false ? 1 : 0,
        s.showNoteMarker !== false ? 1 : 0,
        s.showHolidayMarker !== false ? 1 : 0].join('');
    }

    function docVersion(doc) {
      if (!doc) return 'none';
      var items = doc.items || [];
      var noteCount = doc.notes ? Object.keys(doc.notes).length : 0;
      var weekCount = doc.weekNotes ? Object.keys(doc.weekNotes).length : 0;
      var meta = doc.meta || {};
      return String(meta.updatedAt || '') + '|' + items.length + '|' + noteCount + '|' + weekCount +
        '|s' + settingsSignature(doc);
    }

    function invalidateMarkers() {
      markerCache = Object.create(null);
      cacheOrder = [];
    }

    /** 只对「新进入窗口」的月份计算标记；命中缓存则复用（04 §3.5 / NFR-3）。 */
    function markersFor(doc, ym) {
      var hit = markerCache[ym];
      if (hit && hit.version === lastVersion) return hit.map;

      var map = {};
      if (Recurrence && typeof Recurrence.monthMarkers === 'function') {
        try { map = Recurrence.monthMarkers(doc, ym) || {}; }
        catch (e) {
          map = {};
          if (root.console) console.warn('[DayPlan] 月视图标记计算失败：', e);
        }
      }

      markerCache[ym] = { version: lastVersion, map: map };
      var existing = cacheOrder.indexOf(ym);
      if (existing >= 0) cacheOrder.splice(existing, 1);
      cacheOrder.push(ym);
      while (cacheOrder.length > MARKER_CACHE_LIMIT) {
        var oldest = cacheOrder.shift();
        if (oldest !== ym) delete markerCache[oldest];
      }
      return map;
    }

    /* ---------------- 节假日（BR-23：全部容错） ---------------- */

    function holidays() { return root.DayPlan ? root.DayPlan.holidays : null; }

    function holidayOf(iso) {
      var H = holidays();
      if (!H || typeof H.holidayOf !== 'function') return null;
      try { return H.holidayOf(iso); } catch (e) { return null; }
    }

    /* ---------------- 月网格 ---------------- */

    /** 该月的周列表（周一起始）：优先用 calendarGrid.monthGridMon。 */
    function monthWeeks(ym) {
      var p = parseYM(ym);
      if (!p) return [];
      if (CG && typeof CG.monthGridMon === 'function') {
        var g = CG.monthGridMon(p.year, p.month);
        if (g && g.weeks && g.weeks.length) {
          return g.weeks.map(function (w) { return w.dates.slice(0, 7); });
        }
      }
      /* 降级：datetime.monthGrid 的 42 天按 7 天切行 */
      var flat = (D && typeof D.monthGrid === 'function') ? D.monthGrid(ym) : [];
      var out = [];
      for (var i = 0; i + 7 <= flat.length; i += 7) out.push(flat.slice(i, i + 7));
      return out;
    }

    /* ---------------- 单元格 ---------------- */

    /** 双节同日（如「国庆节、中秋节」）在格内只显示「双节」，完整名保留在 title / aria-label。 */
    function holidayLabel(name) {
      return name && name.indexOf('、') >= 0 ? '双节' : name;
    }

    function buildCell(iso, ym, markerMap, ctx) {
      var cls = 'month-cell';
      if (iso.slice(0, 7) !== ym) cls += ' is-outside';
      /* AC-23.1：无选中态 —— 不再输出 is-selected；今日高亮沿用 is-today（R-3） */
      if (iso === ctx.today) cls += ' is-today';

      var mark = markerMap ? markerMap[iso] : null;
      var bits = [D.formatDateCN ? D.formatDateCN(iso) : iso];
      var hd = ctx.showHoliday ? holidayOf(iso) : null;
      if (hd) bits.push((hd.type === 'workday' ? '班 ' : '休 ') + hd.name);
      if (mark && mark.count) bits.push(mark.count + ' 个事项');
      if (mark && mark.hasNote) bits.push('有记录');
      var hint = '单击进入该周周视图';   /* 迭代 6 / F-42：下钻目标是「周」 */

      var cell = el('button', {
        class: cls, type: 'button', tabindex: '-1', 'data-date': iso,
        title: bits.join(' · ') + ' · ' + hint, 'aria-label': bits.join('，') + '，' + hint
      });

      /* 迭代 7（F-46 / R-27）：今日只留整格底色，不再渲染「今天」文本；
         无障碍信息仍保留（aria-current + aria-label 追加「今天」）。 */
      if (iso === ctx.today) {
        cell.setAttribute('aria-current', 'date');
        cell.setAttribute('aria-label', bits.join('，') + '，今天，' + hint);
      }
      /* 美化迭代 6+10（用户裁定）：日期行 = 数字 + 旁侧内联小字「休/班」（不遮数字）；
         第二行 = 有节假日标注时显示节日名（占农历位），否则照旧显示农历。 */
      var dayRow = el('span', { class: 'mc-dayrow' });
      dayRow.appendChild(el('span', { class: 'mc-day', text: String(Number(iso.slice(8, 10))) }));
      if (hd) {
        dayRow.appendChild(el('span', {
          class: 'mc-flag ' + (hd.type === 'workday' ? 'is-workday' : 'is-holiday'),
          text: hd.type === 'workday' ? '班' : '休',
          title: (hd.type === 'workday' ? '班 ' : '休 ') + hd.name
        }));
      }
      cell.appendChild(dayRow);
      if (hd) {
        cell.appendChild(el('span', {
          class: 'mc-lunar' + (hd.type === 'workday' ? '' : ' is-festival'),
          text: holidayLabel(hd.name),
          title: (hd.type === 'workday' ? '班 ' : '休 ') + hd.name
        }));
      } else if (ctx.showLunar) {
        var lunar = lunarLabel(iso);
        if (lunar) cell.appendChild(el('span', { class: 'mc-lunar', text: lunar }));
      }

      /* 迭代 7（F-51）：关闭「月历标注有记录的日子」后整块标记（颜色点 + 横线）都不渲染 */
      var marks = el('span', { class: 'mc-marks' });
      if (ctx.showNote && mark && mark.count > 0) {
        var color = ctx.catColor[mark.categoryId] || DEFAULT_DOT_COLOR;
        var dots = mark.count === 1 ? 1 : 2; /* 0 / 1 / ≥2 */
        for (var d = 0; d < dots; d += 1) {
          marks.appendChild(el('span', { class: 'mc-dot', style: 'background:' + color }));
        }
      }
      if (ctx.showNote && mark && mark.hasNote) marks.appendChild(el('span', { class: 'mc-noteline' }));
      if (marks.childNodes.length) cell.appendChild(marks);

      /* 美化迭代 6：节日名已上移到农历位（mc-lunar），格底部的 .hd-name 行不再渲染。 */

      /* 迭代 6（F-42，取代 07 AC-22.3）：日期格不再进入日视图、也不再 stopPropagation，
         点击一律冒泡到 .month-week-row → 进入该行（该周）的周视图。 */

      return cell;
    }

    /* ---------------- 月份列 ---------------- */

    /** 年份分隔标题（跨整行，AC-23.5）。 */
    function buildYearSep(year) {
      var sep = el('div', { class: 'month-year-sep', 'data-year': String(year) });
      sep.appendChild(el('span', { class: 'sep-year', text: year + ' 年' }));
      sep.appendChild(el('span', { class: 'sep-note', text: '1 月 – 12 月' }));
      return sep;
    }

    function buildColumn(ym, ctx) {
      var p = parseYM(ym);
      /* AC-23.1：无「选中」态 —— 不再有 is-center / .ym-badge / 「选中」文案。
         三十九轮（用户口径）：年视图也不再描边标出选中月，落点靠滚到中央表达。 */
      var col = el('div', { class: 'month-col', 'data-ym': ym });

      /* 2026-10-20 六轮（用户需求）：月份卡片的「非日期部分」= 列头。点它进入「本月计划」；
         日期格 / 周行仍是进周视图，两者互不干扰。用 button 承载，键盘 Enter/Space 原生可用。 */
      var head = el('button', {
        class: 'month-col-head', type: 'button', 'aria-expanded': 'false',
        title: '打开本月计划（与每日事项互不干扰）'
      });
      head.appendChild(el('span', { class: 'mch-date', text: p.year + ' 年' }));
      head.appendChild(el('span', { class: 'ym-m', text: p.month + ' 月' }));
      var planCount = planItemsOf(ym).length;
      /* 2026-10-21（用户反馈）：没有计划的月份**不显示「本月计划」**；
         只有 N>0 时才渲染徽标。updatePlanBadge 负责之后增删。 */
      if (planCount) {
        head.appendChild(el('span', {
          class: 'mch-plan has-items',
          text: planCount + ' 条计划'
        }));
      }
      if (planCount) head.setAttribute('aria-label',
        p.year + ' 年 ' + p.month + ' 月，本月计划 ' + planCount + ' 条，打开本月计划');
      head.addEventListener('click', function () {
        togglePlan(ym, col);
      });
      col.appendChild(head);

      var grid = el('div', { class: 'month-grid' });
      var dow = el('div', { class: 'month-dow-row' });
      DOW_LABELS.forEach(function (label, i) {
        dow.appendChild(el('div', { class: 'month-dow' + (i >= 5 ? ' is-weekend' : ''), text: label }));
      });
      grid.appendChild(dow);

      var markerMap = ctx.markers[ym];
      monthWeeks(ym).forEach(function (dates) {
        var row = el('div', {
          class: 'month-week-row', tabindex: '0', role: 'button',
          'data-week-start': dates[0],
          'aria-label': (D.formatDateCN ? D.formatDateCN(dates[0]) : dates[0]) + ' 起的一周，回车进入周视图'
        });
        dates.forEach(function (iso) { row.appendChild(buildCell(iso, ym, markerMap, ctx)); });
        /* 迭代 6（F-42）：整周行任意位置（行本体 / 空白 / 日期格）→ 该周周视图；
           日期格已在迭代 6 移除自身 click，故这里不再需要 .month-cell 判定。
           四十六轮：年视图里整张月卡都是「放大该月」的入口，交给列处理器按卡自己的
           ym 收口——首行常跨上月（如 9/28–10/4），按行首日期退出会跳错月份。 */
        row.addEventListener('click', function () {
          if (yearMode) return;
          openWeek(dates[0]);
        });
        row.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            if (yearMode) { setYearView(false, ym); return; }
            openWeek(dates[0]);
          }
        });
        grid.appendChild(row);
      });
      col.appendChild(grid);

      /* 2026-10-21（用户需求）：**点击该月份任意空白处**进入计划界面，
         不再只认顶部列头。日期格 / 整周行仍进周视图（它们有自己的 click），
         列头与已展开的计划面板各自处理，避免一次点击来回开关。 */
      col.addEventListener('click', function (e) {
        /* 年视图里整张卡都是「放大进入该月」的入口：日期数字没有自己的点击行为，
           不能再按 .month-cell 放行，否则点数字没反应（真机探针抓到）。
           周行 / 列头已在上方先处理并退出年视图，此处再落到原来的分支。 */
        if (yearMode) { togglePlan(ym, col); return; }
        var t = e && e.target;
        if (t && t !== col) {
          if (closestBy(t, '.month-week-row') || closestBy(t, '.month-cell')) return;
          if (closestBy(t, '.month-col-head') || closestBy(t, '.month-plan')) return;
        }
        togglePlan(ym, col);
      });
      return col;
    }

    /* ---------------- 今天的位置（迭代 6 / F-40） ---------------- */

    /** 今天所在的日期格；窗口里没有今天（用户翻到别的年份）时返回 null。 */
    function todayCell() {
      var today = D.todayISO();
      var cells = listEl.querySelectorAll('.month-cell.is-today');
      for (var i = 0; i < cells.length; i += 1) {
        if (cells[i].getAttribute('data-date') === today) return cells[i];
      }
      return null;
    }

    /** 日期格所属月份列（垫片无 closest 时回退为逐级向上找类名）。 */
    function columnOfCell(cell) {
      if (!cell) return null;
      if (typeof cell.closest === 'function') {
        var hit = cell.closest('.month-col');
        if (hit) return hit;
      }
      var n = cell.parentNode;
      while (n && n !== listEl) {
        if (n.classList && n.classList.contains('month-col')) return n;
        n = n.parentNode;
      }
      return null;
    }

    /**
     * 「今天」在滚动区里的目标偏移。
     *   1) 真实布局：今天所在 `.month-col` 的 `offsetTop`（`offsetParent` = `.month-scroll`，
     *      后者是 position:relative 的定位祖先）；
     *   2) 无布局引擎（Node DOM 垫片）或测不到偏移：按「列序 → 行序 × 估计行高」等效换算，
     *      保证仍落到今天所在行的位置（而非顶端 0）。
     */
    function todayScrollTarget(cell) {
      var col = columnOfCell(cell);
      var measured = col ? numOption(col.offsetTop, 0) : 0;
      if (measured > 0) return Math.max(0, measured - 12);

      var cols = listEl.querySelectorAll('.month-col');
      var ym = col ? col.getAttribute('data-ym') : '';
      var idx = -1;
      for (var i = 0; i < cols.length; i += 1) {
        if (cols[i] === col || (ym && cols[i].getAttribute('data-ym') === ym)) { idx = i; break; }
      }
      if (idx < 0) return 0;
      var perRow = Math.max(1, monthColumns(viewportWidth()));
      var colH = numOption(cols[0] && cols[0].offsetHeight, 0);
      if (!(colH > 0)) colH = MONTH_COL_ESTIMATE_PX;
      return Math.max(0, Math.floor(idx / perRow) * (colH + LIST_GAP_PX));
    }

    /* ---------------- 手机滚动 ---------------- */

    /** 当前生效的是 .month-scroll 自身滚动，还是整页滚动。 */
    function internalScrolls() {
      return (scrollEl.scrollHeight || 0) > (scrollEl.clientHeight || 0) + 4;
    }

    function pageScrollTop() {
      if (typeof window === 'undefined') return 0;
      return window.pageYOffset || (document.documentElement && document.documentElement.scrollTop) || 0;
    }

    function headerOffset() {
      if (typeof document === 'undefined' || !document.querySelector) return 8;
      var header = document.querySelector('.app-header');
      if (!header || typeof header.getBoundingClientRect !== 'function') return 8;
      var r = header.getBoundingClientRect();
      return (r && r.height > 0 ? r.height : 0) + 8;
    }

    /**
     * 把某个月份列滚到顶（给「今天」定位与退出缩略用）。
     * 手机档 .month-scroll 没有固定高度、滚动的是页面，此时必须走 window.scrollTo；
     * 否则 scrollTop 写不进去，会停在 2024 年第一列（用户反馈的「没回到今天」）。
     */
    function scrollColumnToTop(col) {
      if (!col) return;
      /* 视图隐藏时 offsetTop 全为 0：此时滚动会把整页拉到顶部（切到周 / 日视图时跳动）。 */
      if (container && container.hidden) return;
      if (internalScrolls()) {
        setScrollTop(Math.max(0, numOption(col.offsetTop, 0) - 12));
        return;
      }
      if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
      /* offsetTop 链不依赖当前滚动位置：月 ↔ 年重排后 pageYOffset 可能仍是旧值，
         旧算法（pageScrollTop + rect.top）会越界并被夹到列表底部。 */
      window.scrollTo(0, clampPageScroll(documentTopOf(col) - headerOffset()));
    }

    /**
     * 把某个月份列滚到可视区中央（三十八轮：年 → 月放大的落点）。
     * 用户口径：选中的月份要出现在页面中央，而不是贴着页头顶部。
     * 手机档 .month-scroll 不自滚，滚的是页面；桌面滚 .month-scroll。
     */
    function scrollColumnToCenter(col) {
      if (!col) return;
      if (container && container.hidden) return;
      if (internalScrolls()) {
        var top = numOption(col.offsetTop, 0);
        var h = numOption(col.offsetHeight, 0);
        var viewH = numOption(container.clientHeight, 0);
        setScrollTop(Math.max(0, top - Math.max(0, (viewH - h) / 2)));
        return;
      }
      if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
      var rect = typeof col.getBoundingClientRect === 'function' ? col.getBoundingClientRect() : null;
      var height = rect && rect.height ? rect.height : numOption(col.offsetHeight, 0);
      var vh = numOption(window.innerHeight, 0);
      /* 页头下方才是可见区；用「页头底 → 视口底」的中线作为卡片中心。 */
      var topEdge = headerOffset() - 8;
      var centerY = topEdge + Math.max(0, (vh - topEdge - height) / 2);
      var place = function () {
        scrollPageTo(clampPageScroll(documentTopOf(col) - centerY));
      };
      place();
      /* 重排后的首帧高度可能还没稳定（字体 / 滚动条），下一帧再夹取一次。 */
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(function () {
          if (container && !container.hidden) place();
        });
      }
    }

    /**
     * 月视图里「居于可视区中央」的月份（三十九轮）。
     * 用户口径：月 → 年时选中的应是屏幕上正中间那个月，而不是顶部那个。
     * 桌面滚 .month-scroll，取它的可视框；手机滚页面，取「页头底 → 视口底」。
     */
    function centeredMonthYM() {
      var cols = listEl.querySelectorAll ? listEl.querySelectorAll('.month-col') : [];
      if (!cols.length) return state.centerYM;
      var top = null;
      var bottom = null;
      if (internalScrolls() && typeof scrollEl.getBoundingClientRect === 'function') {
        var box = scrollEl.getBoundingClientRect();
        if (box && box.height > 0) { top = box.top; bottom = box.bottom; }
      }
      if (typeof top !== 'number') {
        top = headerOffset();
        var vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
        bottom = vh > top ? vh : top;
      }
      var mid = (top + bottom) / 2;
      var best = null;
      var bestDist = Infinity;
      for (var i = 0; i < cols.length; i += 1) {
        if (typeof cols[i].getBoundingClientRect !== 'function') continue;
        var r = cols[i].getBoundingClientRect();
        if (!r || (!r.width && !r.height)) continue;
        if (r.bottom <= top || r.top >= bottom) continue;
        var d = Math.abs((r.top + r.bottom) / 2 - mid);
        if (d < bestDist) { bestDist = d; best = cols[i]; }
      }
      return (best && best.getAttribute('data-ym')) || state.centerYM;
    }

    /* ---------------- 缩放过渡（参考 Apple 日历） ---------------- */

    function prefersReducedMotion() {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
      try { return !!window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
    }

    function scrollPageTo(y) {
      if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
      window.scrollTo(0, Math.max(0, y));
    }

    /** 节点在文档中的纵向位置（offsetTop 链，不依赖当前滚动位置）。 */
    function documentTopOf(node) {
      var y = 0;
      var n = node;
      while (n && n !== document.body && n !== document.documentElement) {
        y += numOption(n.offsetTop, 0);
        n = n.offsetParent;
      }
      return y;
    }

    function maxPageScroll() {
      var root = (typeof document !== 'undefined')
        ? (document.scrollingElement || document.documentElement) : null;
      var h = (root && root.scrollHeight) || 0;
      var vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
      return Math.max(0, h - vh);
    }

    function clampPageScroll(y) {
      return Math.max(0, Math.min(maxPageScroll(), numOption(y, 0)));
    }

    /** 元素视口矩形；无布局引擎（DOM 垫片）时返回 null。 */
    function rectOf(node) {
      if (!node || typeof node.getBoundingClientRect !== 'function') return null;
      var r = node.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return null;
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    /**
     * 翻转期间关掉页头的 backdrop-filter：半透明玻璃要实时采样下方被 transform 的
     * 巨大列表，Chromium 在滚动 + 缩放同时发生时会闪。换纯色底只持续这次过渡。
     */
    function setFlipChrome(on) {
      if (typeof document === 'undefined' || !document.body || !document.body.classList) return;
      document.body.classList.toggle('is-year-flipping', !!on);
    }

    function clearListFlip() {
      if (listEl.style) {
        listEl.style.transform = '';
        listEl.style.transformOrigin = '';
        listEl.style.opacity = '';
        listEl.style.transition = '';
      }
      if (element.classList) element.classList.remove('is-flipping');
      setFlipChrome(false);
    }

    function cancelFades() {
      for (var i = 0; i < flipFades.length; i += 1) {
        try { flipFades[i].cancel(); } catch (e) { /* 已结束 */ }
      }
      flipFades = [];
    }

    /**
     * 其他月份错峰淡入：只动 opacity，不逐格做布局动画。
     * 两个方向都从 0 淡入 —— 退出年视图时列表已重排成单列，若让其他月份「淡出」，
     * 结束后取消动画会把它们瞬间弹回 opacity:1（用户看到的「非选中月闪烁」）。
     */
    function playFades(anchorYM) {
      cancelFades();
      if (prefersReducedMotion() || typeof listEl.animate !== 'function') return;
      var cols = listEl.querySelectorAll('.month-col');
      for (var i = 0; i < cols.length; i += 1) {
        var col = cols[i];
        if (col.getAttribute('data-ym') === anchorYM) continue;
        if (typeof col.animate !== 'function') continue;
        var delay = Math.min(8, i % 12) * FLIP_FADE_STEP_MS;
        try {
          flipFades.push(col.animate(
            [{ opacity: 0 }, { opacity: 1 }],
            { duration: FLIP_FADE_MS, delay: delay, easing: 'ease-out', fill: 'both' }
          ));
        } catch (e) { /* 个别元素不支持 WAAPI：跳过即可 */ }
      }
    }

    function endFlip(anim) {
      if (flipAnim !== anim) return;
      flipAnim = null;
      cancelFades();
      clearListFlip();
      /* fill:'both' 的动画结束后仍挂在元素上（getAnimations 可见、identity 变换也算计算样式），
         这里主动 cancel 清掉；内联样式已清空，取消不会造成视觉跳变。 */
      if (anim) {
        try { anim.cancel(); } catch (e) { /* 已取消 */ }
      }
    }

    /**
     * FLIP：锚点月在切换前后的视口矩形不同。先把整个列表按反向 transform 摆回
     * 切换前的视觉位置（锚点月精确重合），再在 700ms 内归位 —— 用户看到的是
     * 同一个月连续缩放，其余月份随容器一起就位。只对 .month-list 做一次变换；
     * 不给列表加 opacity（半透明会透出页面底色，视觉上像闪一下）。
     */
    function runFlip(first, last, anchorYM) {
      clearListFlip();
      if (!first || !last) return;
      if (prefersReducedMotion() || typeof listEl.animate !== 'function') return;
      var listRect = rectOf(listEl);
      if (!listRect) return;
      var scale = first.width / last.width;
      if (!(scale > 0.05) || !(scale < 20)) scale = 1;
      /* origin 取锚点月在「目标布局」里的列表坐标：此点经 translate 后精确落到 first */
      var ox = last.left - listRect.left;
      var oy = last.top - listRect.top;
      var dx = first.left - last.left;
      var dy = first.top - last.top;
      listEl.style.transformOrigin = ox + 'px ' + oy + 'px';
      if (element.classList) element.classList.add('is-flipping');
      setFlipChrome(true);
      var anim = listEl.animate([
        { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(' + scale + ')' },
        { transform: 'translate(0px, 0px) scale(1)' }
      ], { duration: FLIP_MS, easing: FLIP_EASING, fill: 'both' });
      flipAnim = anim;
      playFades(anchorYM);
      if (anim.finished && typeof anim.finished.then === 'function') {
        anim.finished.then(function () { endFlip(anim); }, function () { /* 被后续切换取消 */ });
      } else if ('onfinish' in anim) {
        anim.onfinish = function () { endFlip(anim); };
      } else {
        endFlip(anim);
      }
    }

    /** 取消进行中的过渡并恢复静止布局：快速连续切换不累积冲突动画。 */
    function cancelFlip() {
      var anim = flipAnim;
      flipAnim = null;
      if (anim) {
        try { anim.cancel(); } catch (e) { /* 已完成 */ }
      }
      cancelFades();
      clearListFlip();
    }

    /** 把某年的年份分隔条带到页头下方（年视图进入 / 切换年份时落位）。 */
    function scrollYearToTop(year) {
      var sep = null;
      var seps = listEl.querySelectorAll('.month-year-sep');
      for (var i = 0; i < seps.length; i += 1) {
        if (seps[i].getAttribute('data-year') === String(year)) { sep = seps[i]; break; }
      }
      if (!sep) {
        scrollColumnToTop(findPlanColumn(String(year) + '-01'));
        return;
      }
      if (internalScrolls()) {
        setScrollTop(Math.max(0, numOption(sep.offsetTop, 0) - 12));
        return;
      }
      scrollPageTo(clampPageScroll(documentTopOf(sep) - headerOffset()));
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(function () {
          if (yearMode) scrollPageTo(clampPageScroll(documentTopOf(sep) - headerOffset()));
        });
      }
    }

    function notifyYearMode(on) {
      if (typeof opts.onYearModeChange !== 'function') return;
      try { opts.onYearModeChange(on); } catch (e) { /* 通知失败不影响视图 */ }
    }

    /**
     * 进入年视图：一年 12 个月 3 列 × 4 行，选中月滚到可视区中央。
     * 三十九轮（用户口径）：原来落在年份分隔条（顶部），进入后看到的是「上面的月份」；
     * 改为把即将放大的目标月卡居中，FLIP 的起点与终点也就对齐在同一视觉中心。
     */
    function enterYearView(target, instant) {
      cancelFlip();
      var first = instant ? null : rectOf(findPlanColumn(target));
      closePlan(true);
      yearMode = true;
      yearCenterYM = target;
      state.centerYM = target;
      if (element.classList) element.classList.add('is-year-view');
      /* 先关页头毛玻璃再重排：否则重排那一帧会带着半透明页头画出来，用户看到闪一下。 */
      if (!instant) setFlipChrome(true);
      render();
      scrollColumnToCenter(findPlanColumn(target));
      if (instant) { notifyYearMode(true); return; }
      var last = rectOf(findPlanColumn(target));
      runFlip(first, last, target);
      notifyYearMode(true);
    }

    /** 退出年视图并放大到某个月（缺省回到进入时的锚点月）。instant=true 时不做 FLIP（切走时视图已隐藏）。 */
    function exitYearView(centerYM, instant) {
      cancelFlip();
      var target = (centerYM && parseYM(centerYM)) ? clampYM(centerYM)
        : (yearCenterYM || state.centerYM);
      var first = instant ? null : rectOf(findPlanColumn(target));
      yearMode = false;
      yearCenterYM = null;
      state.centerYM = target;
      if (element.classList) element.classList.remove('is-year-view');
      if (!instant) setFlipChrome(true);
      resetWindow();
      render();
      /* 三十八轮（用户口径）：年 → 月放大后，选中月落在页面中央而不是页头下方。 */
      scrollColumnToCenter(findPlanColumn(target));
      if (instant) { notifyYearMode(false); return; }
      var last = rectOf(findPlanColumn(target));
      runFlip(first, last, target);
      notifyYearMode(false);
    }

    /**
     * 进入 / 退出年视图（3 列 × 一年 12 个月，可纵向滚到相邻年份）。
     * @param {boolean} on
     * @param {string} [centerYM] 进入时以该月所在年为落点；退出时放大到该月
     * @param {{instant?: boolean}} [o] instant：跳过过渡（视图已不可见 / 直接滑入年视图时）
     * @returns {boolean} 状态是否改变
     */
    function setYearView(on, centerYM, o) {
      on = !!on;
      if (on === yearMode) return false;
      var instant = !!(o && o.instant);
      if (on) {
        enterYearView((centerYM && parseYM(centerYM)) ? clampYM(centerYM)
          : (centeredMonthYM() || state.centerYM), instant);
      } else {
        exitYearView(centerYM || null, instant);
      }
      return true;
    }

    /**
     * 回到「今天」的位置（每次切到月视图时由 app 调用）：
     * 窗口里没有今天则先把窗口重置到今天所在月；手机档改为滚页面（.month-scroll 不自滚），
     * 并退出年视图，保证「切到月视图 = 今天所在月的单列视图」。
     * @returns {boolean} 是否找到今天的日期格
     */
    function scrollToToday() {
      var mark = (container && typeof container.setAttribute === 'function') ? container : element;
      var today = D.todayISO();
      /* 三十九轮（用户口径）：在年视图里点「月」= 回到今天所在月，不再回到进入年的那个月。 */
      if (yearMode) setYearView(false, today.slice(0, 7));
      var cell = todayCell();
      if (!cell) {
        state.selected = today;
        state.centerYM = clampYM(today.slice(0, 7));
        resetWindow();
        render();
        /* 复核 D7：窗口被重置到「今天」时同步共享视图日期，否则 app.state.viewDate 会与
           月视图窗口分叉（此后切回周 / 日视图仍停在旧日期，方向键还会把月份弹回去）。 */
        if (typeof opts.onSelectDate === 'function') {
          try { opts.onSelectDate(today); } catch (e) { /* 通知失败不影响定位 */ }
        }
        cell = todayCell();
      }
      if (!cell) {
        setScrollTop(0);
        mark.removeAttribute('data-today-scroll');
        return false;
      }
      var todayYM = today.slice(0, 7);
      if (state.centerYM !== todayYM) state.centerYM = todayYM;
      var col = columnOfCell(cell);
      if (internalScrolls()) {
        var target = todayScrollTarget(cell);
        setScrollTop(target);
        mark.setAttribute('data-today-scroll', String(Math.round(target)));
      } else {
        scrollColumnToTop(col);
        mark.setAttribute('data-today-scroll', String(Math.round(pageScrollTop())));
      }
      return true;
    }

    /**
     * 年视图 → 今天的月份（三十九轮：分段「月」的直接落点）。
     * 先把今天的月卡在年列表里滚到中央，再放大——否则锚点矩形可能在屏外，
     * FLIP 会从很远的坐标起跳。已在月视图时等价于 scrollToToday。
     */
    function exitToToday() {
      var ym = D.todayISO().slice(0, 7);
      if (!yearMode) { scrollToToday(); return; }
      scrollColumnToCenter(findPlanColumn(ym));
      setYearView(false, ym);
    }

    /* ---------------- 交互 ---------------- */

    function openWeek(iso) {
      if (!D.isValidDate(iso)) iso = state.selected;
      /* 年视图里整周行（含日期格）不可下钻：点任意位置都是放大进入该月。 */
      if (yearMode) { setYearView(false, iso.slice(0, 7)); return; }
      if (typeof opts.onOpenWeek === 'function') opts.onOpenWeek(iso);
    }

    /* ------------------------------------------------------------------ *
     * 本月计划（2026-10-20 六轮）
     *
     * 用户需求：「点击该月份任意空白处进入计划界面；计划界面与事项块同理，
     * 以原尺寸覆盖原月份；创建的月计划不同步到每天」。
     * 因此这里**不是**新页面 / 视口浮层，而是就地覆盖该月：
     *   · 面板是 .month-col 的绝对定位子节点（inset:0），宽高与原月份卡完全一致，
     *     随月列表一起滚动，不被裁切；
     *   · 入口 = 列头或列内任意空白处；日期格 / 整周行仍进周视图；
     *   · 点面板外、按 Esc、再点列头/空白都收起（与事项块展开一致）；
     *   · 三十四轮起新建月计划是整月 daily 序列（按天同步）；旧版 monthPlans
     *     纯文本清单只读改写、不再新增。
     * ------------------------------------------------------------------ */

    var PLAN_TEXT_MAX = (Schema && Schema.MONTH_PLAN_TEXT_MAX) || 80;
    var planPanel = null;    /* 面板 DOM（就地挂在 .month-col 内） */
    var planYM = null;       /* 当前展开的月份 */
    var planColumn = null;   /* 锚点（月份列；面板以原尺寸覆盖它） */
    var planBound = false;

    /**
     * 三十四轮：本月计划改为「整月 daily 序列 + meta.origin=monthPlan」，按天同步到日视图。
     * 旧版 monthPlans（纯文本清单）继续可读可编辑，避免历史数据消失。
     */
    function monthPlanSeriesOf(ym) {
      var doc = safeDoc();
      var items = Array.isArray(doc.items) ? doc.items : [];
      return items.filter(function (it) {
        return it && it.kind === 'series' && it.meta
          && it.meta.origin === 'monthPlan' && it.meta.month === ym;
      }).sort(function (a, b) {
        var ao = typeof a.order === 'number' ? a.order : 0;
        var bo = typeof b.order === 'number' ? b.order : 0;
        if (ao !== bo) return ao - bo;
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      });
    }

    /** 序列在当月的完成进度（按 occurrences; 被删除的例外不计入总数）。 */
    function seriesProgress(series, ym) {
      if (!Recurrence || typeof Recurrence.expandSeries !== 'function') return { done: 0, total: 0 };
      try {
        var res = Recurrence.expandSeries(series, {
          from: ym + '-01', to: D.addMonths(ym + '-01', 1), max: 31
        });
        var done = 0;
        res.occurrences.forEach(function (o) { if (o.done) done += 1; });
        return { done: done, total: res.occurrences.length };
      } catch (e) {
        return { done: 0, total: 0 };
      }
    }

    function planItemsOf(ym) {
      var out = monthPlanSeriesOf(ym).map(function (it) {
        var progress = seriesProgress(it, ym);
        return {
          type: 'series', id: it.id, text: it.title,
          done: progress.total > 0 && progress.done === progress.total,
          series: it, progress: progress
        };
      });
      if (store && typeof store.getMonthPlan === 'function') {
        try {
          (store.getMonthPlan(ym) || []).forEach(function (entry) {
            out.push(Object.assign({ type: 'legacy' }, entry));
          });
        } catch (e) { /* 旧数据异常时只显示序列 */ }
      }
      return out;
    }

    function monthLabel(ym) {
      var p = parseYM(ym);
      return p ? (p.year + ' 年 ' + p.month + ' 月') : ym;
    }

    function buildPlanRow(entry, index, ym) {
      var isSeries = entry.type === 'series';
      var progress = entry.progress || null;
      var row = el('div', {
        class: 'mp-item' + (entry.done ? ' is-done' : '') + (isSeries ? ' is-series' : ''),
        'data-plan-id': entry.id, 'data-plan-type': entry.type,
        'data-done': entry.done ? 'true' : 'false',
        tabindex: '0', role: 'button',
        title: isSeries
          ? '点击编辑「' + entry.text + '」；完成情况按天记录'
          : (entry.done
            ? '已完成：' + entry.text + '（右键取消完成）'
            : '点击修改「' + entry.text + '」；右键标记完成')
      });
      row.appendChild(el('span', { class: 'mp-seq', text: String(index + 1) }));
      row.appendChild(el('span', { class: 'mp-text', text: entry.text }));
      if (isSeries && progress && progress.total > 0) {
        row.appendChild(el('span', {
          class: 'mp-progress',
          text: progress.done + '/' + progress.total,
          title: '已完成 ' + progress.done + ' 天，共 ' + progress.total + ' 天',
          'aria-label': '已完成 ' + progress.done + ' 天，共 ' + progress.total + ' 天'
        }));
      }
      row.appendChild(el('button', {
        class: 'mp-del', type: 'button', text: '✕',
        title: '删除「' + entry.text + '」', 'aria-label': '删除计划：' + entry.text,
        onclick: function (e) {
          /* 2026-10-21（用户反馈）：行内 ✕ 直接删除，不再弹确认。 */
          if (e && e.stopPropagation) e.stopPropagation();
          removePlanNow(ym, entry);
        }
      }));
      row.addEventListener('click', function () { editPlan(ym, entry); });
      if (!isSeries) {
        row.addEventListener('contextmenu', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          /* 右键 ✕ 不切换完成，交给按钮自身（浏览器菜单已屏蔽） */
          if (e && e.target && closestBy(e.target, '.mp-del')) return;
          togglePlanDone(ym, entry);
        });
      }
      row.addEventListener('keydown', function (e) {
        /* 焦点在行内 ✕ 上时，键盘事件会冒泡到行；交给按钮自身（删除 / 空格），
           否则 Enter 会同时触发删除与编辑弹窗。 */
        if (e && e.target && e.target !== row) return;
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          editPlan(ym, entry);
          return;
        }
        /* 键盘等价于右键：标准「菜单键」/ Shift+F10（仅旧版清单条目） */
        if (!isSeries && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
          e.preventDefault();
          togglePlanDone(ym, entry);
        }
      });
      return row;
    }

    /** 填列表（数据变更后只重填内容，不重建卡片，避免闪烁与丢焦点） */
    function fillPlanPanel() {
      if (!planPanel || !planYM) return;
      var list = planPanel.querySelector('.mp-list');
      if (!list) return;
      while (list.firstChild) list.removeChild(list.firstChild);
      var items = planItemsOf(planYM);
      items.forEach(function (entry, i) { list.appendChild(buildPlanRow(entry, i, planYM)); });
      planPanel.setAttribute('data-count', String(items.length));
    }

    function buildPlanPanel(ym) {
      var panel = el('div', {
        class: 'month-plan', role: 'dialog', 'aria-modal': 'false',
        'aria-label': monthLabel(ym) + ' 本月计划', 'data-ym': ym
      });
      panel.appendChild(el('div', { class: 'mp-head' }, [
        el('h3', { class: 'mp-title', text: '本月计划' }),
        el('span', { class: 'mp-sub', text: monthLabel(ym) })
      ]));
      panel.appendChild(el('div', { class: 'mp-list' }));
      panel.appendChild(el('div', { class: 'mp-foot' }, [
        el('button', {
          class: 'btn mp-add', type: 'button', text: '＋ 创建',
          onclick: function () { createPlan(ym); }
        })
      ]));
      /* 2026-10-21（用户反馈）：进入月计划界面后，点面板内部**空白**也关闭；
         条目（编辑 / ✕ 删除）与「＋ 创建」仍各自处理，不在这里收起。 */
      panel.addEventListener('click', function (e) {
        var t = e && e.target;
        if (t && t !== panel && (closestBy(t, '.mp-item') || closestBy(t, '.mp-add'))) return;
        if (e && e.stopPropagation) e.stopPropagation();
        closePlan();
      });
      return panel;
    }

    /** 某月对应的列（面板的宿主；重绘后重新锚定用）。 */
    function findPlanColumn(ym) {
      var cols = listEl.querySelectorAll ? listEl.querySelectorAll('.month-col') : [];
      for (var i = 0; i < cols.length; i += 1) {
        if (cols[i].getAttribute('data-ym') === ym) return cols[i];
      }
      return null;
    }

    /** 列头按钮（aria-expanded / is-plan-open 落在它身上，与旧入口保持同一套无障碍语义）。 */
    function planHeadOf(col) {
      return (col && col.querySelector) ? col.querySelector('.month-col-head') : null;
    }

    /** 焦点移入 / 移出面板时不改动月列表滚动位置（点击被裁切的月份也不跳）。 */
    function focusNoScroll(node) {
      if (!node || typeof node.focus !== 'function') return;
      try { node.focus({ preventScroll: true }); } catch (e) { /* 元素可能已移除 */ }
    }

    function closePlan(silent) {
      var head = planHeadOf(planColumn) || findPlanHead(planYM);
      if (planPanel && planPanel.parentNode) planPanel.parentNode.removeChild(planPanel);
      if (head && head.classList) head.classList.remove('is-plan-open');
      if (head && head.setAttribute) head.setAttribute('aria-expanded', 'false');
      if (planColumn && planColumn.classList) planColumn.classList.remove('is-plan-open');
      planPanel = null;
      planYM = null;
      planColumn = null;
      if (!silent) unbindPlanGlobal();
    }

    function onPlanDocDown(e) {
      var t = e && e.target;
      if (!t) return;
      /* 点面板内部 / 点该月列内任意处（列自己的 click 会 toggle）/ 弹窗遮罩 → 都不收起 */
      if (planPanel && planPanel.contains && planPanel.contains(t)) return;
      if (planColumn && planColumn.contains && planColumn.contains(t)) return;
      if (closestBy(t, '.modal-backdrop')) return;
      closePlan();
    }

    function onPlanKeydown(e) {
      if (!e) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (planPanel) {
          var head = planHeadOf(planColumn) || findPlanHead(planYM);
          closePlan();
          focusNoScroll(head);
        }
      }
    }

    /** 向上找最近的匹配祖先（不依赖 Element.closest）。用 classList 判定元素，
        因为测试垫片的元素节点没有 nodeType（早期版本会直接跳出循环）。 */
    function closestBy(node, selector) {
      var n = node;
      while (n && n.classList) {
        if (matchesSel(n, selector)) return n;
        n = n.parentNode;
      }
      return null;
    }

    function matchesSel(node, selector) {
      if (node && typeof node.matches === 'function') {
        try { return node.matches(selector); } catch (e) { return false; }
      }
      /* DOM shim（tools/boot_shim_smoke.js）没有 Element.matches：
         这里只用于「点击穿透判定」，支持单类选择器即可。 */
      if (node && node.classList && selector.charAt(0) === '.' && selector.indexOf(' ') < 0) {
        return node.classList.contains(selector.slice(1));
      }
      return false;
    }

    function bindPlanGlobal() {
      if (planBound) return;
      planBound = true;
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('mousedown', onPlanDocDown, true);
        document.addEventListener('keydown', onPlanKeydown, true);
      }
    }

    function unbindPlanGlobal() {
      if (!planBound) return;
      planBound = false;
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('mousedown', onPlanDocDown, true);
        document.removeEventListener('keydown', onPlanKeydown, true);
      }
    }

    /**
     * 打开某月计划：面板直接挂进该月列（绝对定位、inset:0）——
     * 与事项块展开同一心智：**就以原月份卡的尺寸覆盖它**，不另开浮层。
     * @param {string} ym
     * @param {HTMLElement} [col] 月份列（缺省按 ym 查）
     */
    function openPlan(ym, col) {
      closePlan(true);
      var target = col || findPlanColumn(ym);
      if (!target) return;
      planYM = ym;
      planColumn = target;
      planPanel = buildPlanPanel(ym);
      target.appendChild(planPanel);
      if (target.classList) target.classList.add('is-plan-open');
      var head = planHeadOf(target);
      if (head && head.classList) head.classList.add('is-plan-open');
      if (head && head.setAttribute) head.setAttribute('aria-expanded', 'true');
      fillPlanPanel();
      bindPlanGlobal();
      var first = planPanel.querySelector ? planPanel.querySelector('.mp-add') : null;
      focusNoScroll(first);
    }

    function togglePlan(ym, col) {
      /* 三十四轮：缩略态点击某月 = 退出缩略并回到该月的单列视图（面板太窄，不在此开启）。 */
      if (yearMode) { setYearView(false, ym); return; }
      if (planPanel && planYM === ym) { closePlan(); return; }
      openPlan(ym, col);
    }

    /** 数据变更后：只重填面板与列头徽标（monthPlans 不参与 docVersion，无需重绘）。 */
    function afterPlanChange() {
      fillPlanPanel();
      updatePlanBadge(planYM);
    }

    /** 列头徽标「N 条计划」跟数据同步；零条时**移除徽标**（2026-10-21 用户反馈）。 */
    function updatePlanBadge(ym) {
      if (!ym) return;
      var col = findPlanColumn(ym);
      var head = planHeadOf(col);
      if (!head || !head.querySelector) return;
      var count = planItemsOf(ym).length;
      var badge = head.querySelector('.mch-plan');
      if (!count) {
        if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
      } else if (badge) {
        badge.textContent = count + ' 条计划';
        if (badge.classList) badge.classList.add('has-items');
      } else {
        head.appendChild(el('span', {
          class: 'mch-plan has-items',
          text: count + ' 条计划'
        }));
      }
      var p = parseYM(ym);
      if (head.setAttribute) {
        if (p && count) {
          head.setAttribute('aria-label', p.year + ' 年 ' + p.month + ' 月，本月计划 ' + count + ' 条，打开本月计划');
        } else if (p) {
          head.setAttribute('aria-label', p.year + ' 年 ' + p.month + ' 月，打开本月计划');
        }
      }
    }

    function defaultCategoryIdOf(doc) {
      var cats = (doc && doc.categories) || [];
      var preferred = doc && doc.settings && doc.settings.defaultCategoryId;
      for (var i = 0; i < cats.length; i += 1) {
        if (cats[i] && cats[i].id === preferred) return preferred;
      }
      return cats[0] ? cats[0].id : null;
    }

    function createPlan(ym) {
      if (!store || typeof store.addItem !== 'function') return;
      if (!Form || typeof Form.createMonthPlanForm !== 'function') {
        M.toast('月计划表单尚未就绪');
        return;
      }
      var doc = safeDoc();
      var form = null;
      try {
        form = Form.createMonthPlanForm({
          ym: ym,
          categories: doc.categories || [],
          defaultCategoryId: defaultCategoryIdOf(doc)
        });
      } catch (e) { form = null; }
      if (!form || !form.element) { M.toast('月计划表单尚未就绪'); return; }

      M.open({
        title: '创建本月计划',
        body: form.element,
        submitLabel: '创建',
        wide: true,
        onSubmit: function (ctx) {
          var check = form.validate();
          if (!check.ok) { ctx.setError(check.message); return false; }
          var v = check.values || (typeof form.getValues === 'function' ? form.getValues() : null);
          if (!v) { ctx.setError('表单取值失败'); return false; }
          try {
            store.addItem({
              kind: 'series',
              title: v.title,
              categoryId: v.categoryId,
              time: v.time || null,
              note: v.note || '',
              repeat: v.repeat,
              exceptions: {},
              meta: v.meta
            });
          } catch (e) {
            ctx.setError(e.message || '创建失败');
            return false;
          }
          afterPlanChange();
          M.toast('已创建本月计划（按天同步）');
          return true;
        }
      });
      if (typeof form.focus === 'function') form.focus();
    }

    function editPlan(ym, entry) {
      if (entry && entry.type === 'series') { editSeriesPlan(ym, entry); return; }
      if (!store || typeof store.updateMonthPlanItem !== 'function') return;
      var input = el('input', { type: 'text', maxlength: String(PLAN_TEXT_MAX) });
      input.value = entry.text;
      var delBtn = el('button', {
        class: 'btn btn-sm btn-danger', type: 'button', text: '删除这条计划',
        onclick: function () {
          handle.close();
          deletePlan(ym, entry);
        }
      });
      var handle = M.open({
        title: '编辑计划',
        body: el('div', {}, [
          el('div', { class: 'field' }, [
            el('label', { class: 'field-label', text: '计划内容' }), input
          ]),
          el('div', { class: 'plan-edit-foot' }, [delBtn])
        ]),
        submitLabel: '保存',
        onSubmit: function (ctx) {
          try {
            store.updateMonthPlanItem(ym, entry.id, input.value);
          } catch (e) {
            ctx.setError(e.message);
            return false;
          }
          handle.close();
          afterPlanChange();
          return true;
        }
      });
      if (input && input.focus) { try { input.focus(); input.select(); } catch (e) {} }
    }

    /** 三十四轮：编辑整月序列；改动会同步到该月每一天。 */
    function editSeriesPlan(ym, entry) {
      if (!store || typeof store.updateItem !== 'function') return;
      if (!Form || typeof Form.createMonthPlanForm !== 'function') {
        M.toast('月计划表单尚未就绪');
        return;
      }
      var series = (typeof store.getItem === 'function') ? store.getItem(entry.id) : entry.series;
      if (!series) return;
      var doc = safeDoc();
      var form = null;
      try {
        form = Form.createMonthPlanForm({
          ym: ym,
          item: series,
          categories: doc.categories || [],
          defaultCategoryId: defaultCategoryIdOf(doc)
        });
      } catch (e) { form = null; }
      if (!form || !form.element) { M.toast('月计划表单尚未就绪'); return; }

      M.open({
        title: '编辑本月计划',
        body: form.element,
        submitLabel: '保存',
        wide: true,
        onSubmit: function (ctx) {
          var check = form.validate();
          if (!check.ok) { ctx.setError(check.message); return false; }
          var v = check.values || (typeof form.getValues === 'function' ? form.getValues() : null);
          if (!v) { ctx.setError('表单取值失败'); return false; }
          try {
            store.updateItem(entry.id, {
              title: v.title,
              categoryId: v.categoryId,
              time: v.time || null,
              note: v.note || '',
              repeat: v.repeat,
              meta: v.meta
            });
          } catch (e) {
            ctx.setError(e.message || '保存失败');
            return false;
          }
          afterPlanChange();
          M.toast('已保存');
          return true;
        }
      });
      if (typeof form.focus === 'function') form.focus();
    }

    /** 切换完成态（右键 / 菜单键）；仅旧版清单条目。序列的完成按天记录在日视图。 */
    function togglePlanDone(ym, entry) {
      if (entry && entry.type === 'series') return;
      if (!store || typeof store.toggleMonthPlanItemDone !== 'function') return;
      var done;
      try {
        done = store.toggleMonthPlanItemDone(ym, entry.id);
      } catch (e) {
        M.toast(e.message);
        return;
      }
      afterPlanChange();
      M.toast(done ? '已标记完成' : '已取消完成');
    }

    /** 直接删除（行内 ✕）：不弹确认。 */
    function removePlanNow(ym, entry) {
      try {
        if (entry && entry.type === 'series') {
          if (!store || typeof store.removeItem !== 'function') return;
          store.removeItem(entry.id);
        } else {
          if (!store || typeof store.removeMonthPlanItem !== 'function') return;
          store.removeMonthPlanItem(ym, entry.id);
        }
      } catch (e) {
        M.toast(e.message);
        return;
      }
      afterPlanChange();
      M.toast('已删除');
    }

    /** 编辑弹窗里的「删除这条计划」仍走确认，避免误删。 */
    function deletePlan(ym, entry) {
      var isSeries = entry && entry.type === 'series';
      M.confirm({
        title: '删除计划',
        message: isSeries
          ? '确定删除「' + entry.text + '」？该月已同步到每天的事项会一并移除。'
          : '确定删除「' + entry.text + '」？',
        confirmLabel: '删除', danger: true
      }).then(function (ok) {
        if (ok) removePlanNow(ym, entry);
      });
    }

    /* ---------------- 渲染 ---------------- */

    /**
     * 依据当前 state.months 全量重绘列表（含年分隔）。
     * 三十五轮：缩略视图与单列视图共用同一份 DOM，只由 .is-year-view 改样式与列数，
     * 因此缩略里是**窗口内全部月份**（可上下滚动），不再只画中心月 ±1。
     */
    function renderList() {
      var context = renderContext();
      listEl.innerHTML = '';
      renderAppended(context, 0);
    }

    /**
     * 渲染 fromIndex 起的月份（含年分隔），返回最后一个渲染到的下标 + 1。
     * 追加分支复用它 → 只创建新月份的 DOM（不重绘已有列）。
     */
    function renderAppended(context, fromIndex) {
      var i = fromIndex;
      for (; i < state.months.length; i += 1) {
        var m = state.months[i];
        if (m.isYearStart) listEl.appendChild(buildYearSep(m.year));
        listEl.appendChild(buildColumn(m.ym, context));
      }
      return i;
    }

    function render() {
      if (destroyed) return;
      if (yearMode && planPanel) closePlan(true);
      renderList();
      updateStatus();
      syncDiagnostics();
      /* 重绘会重建月份列：把打开中的计划面板**原节点**搬进新列，
         尺寸仍由新列决定（不重建面板 → 列表滚动位置与焦点不丢）。 */
      if (planPanel && planYM) {
        var freshCol = findPlanColumn(planYM);
        if (freshCol) {
          planColumn = freshCol;
          if (planPanel.parentNode) planPanel.parentNode.removeChild(planPanel);
          freshCol.appendChild(planPanel);
          if (freshCol.classList) freshCol.classList.add('is-plan-open');
          var head = planHeadOf(freshCol);
          if (head && head.classList) head.classList.add('is-plan-open');
          if (head && head.setAttribute) head.setAttribute('aria-expanded', 'true');
          fillPlanPanel();
        } else {
          closePlan(true);
        }
      }
    }

    /** 找到某月的列头按钮（收起面板时恢复 aria / 焦点用） */
    function findPlanHead(ym) {
      return planHeadOf(findPlanColumn(ym));
    }

    /** 边界提示与缺年份提示（AC-23.5 / 数据集边界）；缩略态不显示滚动边界提示。 */
    function updateStatus() {
      if (yearMode) {
        state.boundaryMsg = '';
        boundaryEl.hidden = true;
        boundaryEl.textContent = '';
        return;
      }
      var range = state.range || { startYM: MIN_YM, endYM: MAX_YM };
      var msg = '';
      if (range.startYM <= MIN_YM && range.endYM >= MAX_YM) {
        msg = '已到可显示范围（1900-01 – 2100-12）';
      } else if (range.startYM <= MIN_YM) {
        msg = '已到可显示范围起点（1900-01），不再向前加载';
      } else if (range.endYM >= MAX_YM) {
        msg = '已到可显示范围终点（2100-12），不再向后加载';
      }
      state.boundaryMsg = msg;
      boundaryEl.hidden = !msg;
      boundaryEl.textContent = msg;
    }

    /** 供测试/诊断读取的 DOM 事实（ST-58）。 */
    function syncDiagnostics() {
      element.setAttribute('data-month-count', String(listEl.querySelectorAll('.month-col').length));
      element.setAttribute('data-append-count', String(state.appendCount));
      element.setAttribute('data-range-start', state.range ? state.range.startYM : '');
      element.setAttribute('data-range-end', state.range ? state.range.endYM : '');
      element.setAttribute('data-month-year', yearMode ? 'true' : 'false');
      if (yearMode) element.setAttribute('data-year-center', yearCenterYM || '');
      else element.removeAttribute('data-year-center');
      if (typeof window !== 'undefined' && window.innerWidth) {
        element.setAttribute('data-month-cols',
          String(yearMode ? YEAR_COLS : monthColumns(viewportWidth())));
      }
    }

    /** 列数口径用的宽度：视口宽（BR-33 的「视口宽 − 32」；缺 window 时退化为容器宽）。 */
    function viewportWidth() {
      var w = numOption((typeof window !== 'undefined') ? window.innerWidth : 0, 0);
      if (w > 0) return w;
      return numOption(scrollEl.clientWidth, 0);
    }

    function renderContext() {
      var doc = safeDoc();
      lastVersion = docVersion(doc);
      var settings = doc.settings || {};
      var context = {
        today: D.todayISO(),
        showLunar: settings.showLunarInCalendar !== false,
        showNote: settings.showNoteMarker !== false,
        showHoliday: settings.showHolidayMarker !== false,
        catColor: {},
        markers: {}
      };
      var cats = doc.categories || [];
      /* 2026-10-30：类别标记点走 20 色色板（旧高饱和色由 categoryTone 就近归一） */
      var P = root.DayPlan && root.DayPlan.palette;
      for (var c = 0; c < cats.length; c += 1) {
        if (cats[c] && cats[c].id) {
          context.catColor[cats[c].id] = (P && typeof P.categoryTone === 'function')
            ? P.categoryTone(cats[c].color).accent
            : cats[c].color;
        }
      }
      state.months.forEach(function (m) { context.markers[m.ym] = markersFor(doc, m.ym); });
      return context;
    }

    /* ---------------- 窗口 ---------------- */

    /** 列数口径（BR-33）：手机（≤640px）固定单列，其余按容器宽 3–6 列。 */
    function monthColumns(widthPx) {
      var wide = numOption(widthPx, 0) > MOBILE_MAX_PX;
      if (CG && typeof CG.monthColumnsFor === 'function') {
        return CG.monthColumnsFor(widthPx, {
          min: wide ? CG.MONTH_COL_MIN : 1,
          max: wide ? CG.MONTH_COL_MAX : 1,
          colPx: CG.MONTH_COL_PX
        });
      }
      return wide ? 3 : 1;
    }

    /** 以 centerYM 为中心重置窗口（BR-32）；appendCount 归零。 */
    function resetWindow() {
      var built = (CG && typeof CG.initialMonthWindow === 'function')
        ? CG.initialMonthWindow(state.centerYM, {
          backYears: CG.MONTH_WINDOW_YEARS, aheadYears: CG.MONTH_WINDOW_YEARS
        })
        : null;
      if (built && built.months && built.months.length) {
        state.range = { startYM: built.startYM, endYM: built.endYM };
        state.months = built.months;
      } else {
        /* 降级：自建 60 个月窗口 */
        var list = [];
        var startYM = clampYM((parseYM(state.centerYM).year - 2) + '-01');
        var endYM = clampYM((parseYM(state.centerYM).year + 2) + '-12');
        var cursor = startYM;
        while (cursor && cursor <= endYM) {
          var p = parseYM(cursor);
          list.push({ ym: cursor, year: p.year, month: p.month, isYearStart: p.month === 1 });
          cursor = addMonthsYM(cursor, 1);
        }
        state.range = { startYM: startYM, endYM: endYM };
        state.months = list;
      }
      state.appendCount = 0;
    }

    /** 滚动相关实测值（统一在此读取，便于替代实现/垫片环境复用）。 */
    function scrollMetrics() {
      return {
        scrollTop: scrollEl.scrollTop || 0,
        scrollHeight: scrollEl.scrollHeight || 0,
        clientHeight: scrollEl.clientHeight || 0
      };
    }

    /**
     * 向指定方向追加 1 年（BR-32），并补偿 scrollTop 使可视锚点不跳变（AC-23.4）。
     * @param {"back"|"ahead"} direction
     * @returns {boolean} 是否真的追加了月份
     */
    function extend(direction) {
      if (yearMode) return false;
      if (!state.range || !CG || typeof CG.extendRange !== 'function') return false;
      var beforeCount = state.months.length;
      var next = CG.extendRange(state.range, direction, { years: CG.MONTH_EXTEND_YEARS });
      if (!next || !next.months || next.months.length <= beforeCount) return false;
      var addedCount = next.months.length - beforeCount;

      var oldScrollHeight = scrollEl.scrollHeight || 0;
      var card = listEl.querySelector('.month-col');
      var cardH = (card && card.offsetHeight) ? card.offsetHeight : 0;
      var anchorYm = (direction === 'back') ? currentAnchorMonth() : null;

      /* 先提交状态，再只渲染新增部分 */
      state.range = { startYM: next.startYM, endYM: next.endYM };
      state.months = next.months;
      state.appendCount += 1;

      var context = renderContext();
      if (direction === 'back') {
        /* 头部追加：新月份插到列表前面 → 用「内容高度增量」补偿 scrollTop，锚点不动 */
        listEl.innerHTML = '';
        renderAppended(context, 0);
        var prependHeight = (scrollEl.scrollHeight || 0) - oldScrollHeight;
        if (!(prependHeight > 0) && cardH > 0) {
          /* 环境不刷新 scrollHeight（无布局引擎的垫片）：按 新增月数 × 列高 估算 */
          prependHeight = addedCount * cardH;
        }
        if (prependHeight > 0) setScrollTop((scrollEl.scrollTop || 0) + prependHeight);
        restoreAnchor(anchorYm);
      } else {
        /* 尾部追加：已有节点不动，直接续渲染 */
        renderAppended(context, beforeCount);
      }

      updateStatus();
      syncDiagnostics();
      return true;
    }

    /** 当前视口顶部附近对应的月份（用于补偿后校正）。 */
    function currentAnchorMonth() {
      var top = scrollEl.scrollTop || 0;
      var cols = listEl.querySelectorAll('.month-col');
      var acc = 0;
      for (var i = 0; i < cols.length; i += 1) {
        var h = (cols[i].offsetHeight || 0) + 12;
        if (acc + h > top) return cols[i].getAttribute('data-ym');
        acc += h;
      }
      return cols.length ? cols[cols.length - 1].getAttribute('data-ym') : null;
    }

    /** 补偿后再校正一次，避免取整误差导致锚点漂移。 */
    function restoreAnchor(anchorYm) {
      if (!anchorYm) return;
      var cols = listEl.querySelectorAll('.month-col');
      var acc = 0;
      for (var i = 0; i < cols.length; i += 1) {
        if (cols[i].getAttribute('data-ym') === anchorYm) {
          if (acc > 0 && Math.abs(acc - (scrollEl.scrollTop || 0)) <= ANCHOR_ADJUST_GUARD) {
            setScrollTop(acc);
          }
          return;
        }
        acc += (cols[i].offsetHeight || 0) + 12;
      }
    }

    /** 设置 scrollTop（抑制自身 scroll 事件回环）。 */
    function setScrollTop(value) {
      suppressScroll = true;
      scrollEl.scrollTop = value;
      lastScrollTop = scrollEl.scrollTop;
      suppressScroll = false;
    }

    /* ---------------- 滚动追加 ---------------- */

    function handleScroll() {
      if (suppressScroll || destroyed) return;
      /* 年视图也按滚动续年：桌面滚的是 .month-scroll，手机滚的是页面（见 onWindowScroll）。 */
      if (yearMode) { maybeExtendYearView(); return; }
      var m = scrollMetrics();
      var top = m.scrollTop;
      var previous = lastScrollTop;
      lastScrollTop = top;

      var clientH = m.clientHeight || scrollEl.clientHeight || 1;
      var distBottom = (m.scrollHeight || 0) - top - clientH;
      var nearTop = top <= APPEND_TRIGGER_PX;
      var nearBottom = distBottom <= APPEND_TRIGGER_PX;

      var direction = 0;
      if (nearTop && !nearBottom) direction = -1;
      else if (nearBottom && !nearTop) direction = 1;
      else if (nearTop && nearBottom) direction = (top < previous) ? -1 : 1;
      if (!direction) return;

      /* 单次滚动事件只追加 1 年（BR-32）：追加后由后续滚动事件继续触发，
         避免一次事件在贴边状态下级联追加到数据集边界。 */
      extend(direction === -1 ? 'back' : 'ahead');
    }

    /** 节流（首帧立即执行，保证单次 scroll 事件也能追加）。 */
    function onScroll() {
      if (suppressScroll || destroyed) return;
      var now = Date.now();
      var wait = SCROLL_THROTTLE_MS - (now - lastRunAt);
      if (wait <= 0) { lastRunAt = now; handleScroll(); return; }
      if (throttleTimer) clearTimeout(throttleTimer);
      throttleTimer = setTimeout(function () {
        throttleTimer = 0;
        lastRunAt = Date.now();
        handleScroll();
      }, wait);
    }

    /** 页面自身是否有纵向滚动行程（窄屏档月视图高度 auto，滚动的是页面）。 */
    function pageHasScrollRange() {
      var root = document.scrollingElement || document.documentElement;
      if (!root) return false;
      var viewH = window.innerHeight || root.clientHeight || 0;
      return root.scrollHeight > viewH + 4;
    }

    /** 无原生滚动行程（视口极高）时的滚轮兜底。 */
    function onWheel(e) {
      if (destroyed || yearMode) return;
      if (scrollEl.scrollHeight > scrollEl.clientHeight + 4) return; /* 有原生行程 → 交给 scroll */
      /* 窄屏档（浏览器缩放到 200% 时常见）由页面的滚动条负责滚动；此时若仍
         preventDefault 去追加年份，滚轮会被吞掉、页面完全滚不动。 */
      if (pageHasScrollRange()) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      wheelAcc += (e.deltaY || 0);
      if (Math.abs(wheelAcc) < WHEEL_STEP_PX) return;
      var direction = wheelAcc > 0 ? 1 : -1;
      wheelAcc = 0;
      extend(direction === 1 ? 'ahead' : 'back');
    }

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    try { scrollEl.addEventListener('wheel', onWheel, { passive: false }); }
    catch (e) { scrollEl.addEventListener('wheel', onWheel); }

    /* ---------------- 年视图：滚动续年（双口径） ---------------- */

    /** 页面自身可滚高度（手机年视图滚的是页面）。 */
    function documentScrollHeight() {
      var root = (typeof document !== 'undefined') ? (document.scrollingElement || document.documentElement) : null;
      return (root && root.scrollHeight) || 0;
    }

    /** 当前年视图滚的是 .month-scroll（桌面）还是整页（手机）。 */
    function yearScrollMetrics() {
      if (internalScrolls()) {
        return {
          internal: true,
          top: scrollEl.scrollTop || 0,
          height: scrollEl.scrollHeight || 0,
          max: (scrollEl.scrollHeight || 0) - (scrollEl.clientHeight || 0)
        };
      }
      var viewH = (typeof window !== 'undefined' && window.innerHeight) || 0;
      return {
        internal: false,
        top: pageScrollTop(),
        height: documentScrollHeight(),
        max: documentScrollHeight() - viewH
      };
    }

    /** 向指定方向续 1 年；前插后按内容高度增量补偿滚动位置（锚点不跳）。 */
    function extendYearView(direction) {
      if (!yearMode || !state.range || !CG || typeof CG.extendRange !== 'function') return false;
      var beforeCount = state.months.length;
      var next = CG.extendRange(state.range, direction, { years: CG.MONTH_EXTEND_YEARS });
      if (!next || !next.months || next.months.length <= beforeCount) return false;

      var scroller = yearScrollMetrics();
      var oldHeight = scroller.height;
      var oldTop = scroller.top;
      state.range = { startYM: next.startYM, endYM: next.endYM };
      state.months = next.months;
      state.appendCount += 1;

      var context = renderContext();
      if (direction === 'ahead') {
        renderAppended(context, beforeCount);
      } else {
        listEl.innerHTML = '';
        renderAppended(context, 0);
        var delta = yearScrollMetrics().height - oldHeight;
        if (delta > 0) {
          if (scroller.internal) setScrollTop(oldTop + delta);
          else scrollPageTo(oldTop + delta);
        }
      }
      updateStatus();
      syncDiagnostics();
      return true;
    }

    /** 年视图滚动到接近顶部 / 底部时续 1 年，保证相邻年份可一路翻。 */
    function maybeExtendYearView() {
      if (!yearMode || destroyed || flipAnim) return;
      var now = Date.now();
      if (now - yearExtendAt < YEAR_EXTEND_THROTTLE_MS) return;
      var m = yearScrollMetrics();
      if (!(m.max > 0)) return;
      if (m.top >= m.max - YEAR_EXTEND_TRIGGER_PX) {
        if (extendYearView('ahead')) yearExtendAt = now;
      } else if (m.top <= 8) {
        if (extendYearView('back')) yearExtendAt = now;
      }
    }

    /** 手机年视图滚页面：滚的是 window，不是 .month-scroll。 */
    function onWindowScroll() {
      if (!yearMode || destroyed || flipAnim) return;
      if (internalScrolls()) return;
      maybeExtendYearView();
    }

    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('scroll', onWindowScroll, { passive: true });
    }

    /* ---------------- 对外 API（冻结签名） ---------------- */

    /** 重绘（数据或设置变化时由 app 调用）：窗口与滚动位置不变。 */
    function refresh() {
      invalidateMarkers();
      render();
    }

    /**
     * 设置选定日期，并以该月为中心重置窗口。
     * @param {string} iso
     * @param {object} [o] {notify:false} 时不回调 onSelectDate
     */
    function setDate(iso, o) {
      o = o || {};
      if (!D.isValidDate(iso)) return;
      state.selected = iso;
      var ym = clampYM(iso.slice(0, 7));
      var changed = ym !== state.centerYM;
      state.centerYM = ym;
      if (yearMode) yearCenterYM = ym;
      resetWindow();
      if (yearMode) {
        /* 年视图里改日期 = 换到该月所在年，落位到年份分隔条，不跳回列表顶部。 */
        render();
        scrollYearToTop(ym.slice(0, 4));
      } else {
        if (changed) setScrollTop(0);
        render();
      }
      if (o.notify !== false && typeof opts.onSelectDate === 'function') opts.onSelectDate(iso);
    }

    /** 上/下一个月（PageUp/PageDown/←→）：按「同日」推进并通知 app 同步视图日期。 */
    function navigate(delta) {
      var d = delta < 0 ? -1 : (delta > 0 ? 1 : 0);
      if (!d) return false;
      if (yearMode) setYearView(false);
      var target = addMonthsYM(state.centerYM, d);
      if (!target) return false;
      if (target < MIN_YM) { state.centerYM = MIN_YM; resetWindow(); render(); return false; }
      if (target > MAX_YM) { state.centerYM = MAX_YM; resetWindow(); render(); return false; }

      var ymd = D.parseYearMonth(state.selected);
      var day = ymd ? ymd.day : 1;
      var dim = (D.daysInMonth ? D.daysInMonth(Number(target.slice(0, 4)), Number(target.slice(5, 7))) : 0) || 28;
      if (day > dim) day = dim;
      var nextIso = target + '-' + pad2(day);
      setDate(nextIso);
      setScrollTop(0);
      return true;
    }

    /** 当前居中月 "YYYY-MM"。 */
    function getMonth() { return state.centerYM; }

    /** 释放监听（app 未使用，供测试/热重载兜底）。 */
    function destroy() {
      destroyed = true;
      if (planPanel) closePlan();
      if (throttleTimer) clearTimeout(throttleTimer);
      throttleTimer = 0;
      cancelFlip();
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('scroll', onWindowScroll);
      }
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
      scrollEl.removeEventListener('scroll', onScroll);
      scrollEl.removeEventListener('wheel', onWheel);
      if (element.parentNode) element.parentNode.removeChild(element);
    }

    /* store 订阅（与 app 的 onDataChanged→refresh 用版本指纹去重，避免重复渲染） */
    if (store && typeof store.subscribe === 'function') {
      unsubscribe = store.subscribe(function () {
        if (docVersion(safeDoc()) !== lastVersion) refresh();
      });
    }

    resetWindow();
    render();

    return {
      element: element,
      render: render,
      refresh: refresh,
      setDate: setDate,
      navigate: navigate,
      getMonth: getMonth,
      /* 迭代 6（F-40）：切到月视图时回到「今天」的位置（app 调用） */
      scrollToToday: scrollToToday,
      /* 三十六轮：年视图（三十七轮起由手机端分段控件「年」调用；测试可直接调用） */
      setYearView: setYearView,
      /* 三十九轮：分段「月」= 回到今天所在月（年视图里先滚到目标月再放大） */
      exitToToday: exitToToday,
      isYearView: function () { return yearMode; },
      getYearCenter: function () { return yearCenterYM; },
      getCenter: function () { return state.centerYM; },
      destroy: destroy,
      /* 诊断用（ST-58 / SC-24）：不改变冻结签名，仅追加只读访问器 */
      getRange: function () { return state.range ? { startYM: state.range.startYM, endYM: state.range.endYM } : null; },
      getAppendCount: function () { return state.appendCount; }
    };
  }

  root.DayPlan.monthView = {
    createMonthView: createMonthView,
    APPEND_TRIGGER_PX: APPEND_TRIGGER_PX,
    MIN_YM: MIN_YM,
    MAX_YM: MAX_YM,
    /* 月 ↔ 年 FLIP 过渡参数（冒烟断言 / 后续调参的唯一事实源） */
    YEAR_FLIP_MS: FLIP_MS,
    YEAR_FLIP_EASING: FLIP_EASING
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
