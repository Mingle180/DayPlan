/**
 * DayPlan · 单日视图（F-02 / F-03 / F-04 / F-08 / F-11 / F-14 / F-16 / F-19 / F-24 / F-26）
 *
 * 结构：日期标题 + 日期导航 → 时间轴（横向时间轴 + 纵向类别行组 + 两端空闲竖窄带）
 *       → 无时事项列表 → 今日记录。
 *
 * 迭代 4（07-delta US-19…US-25 / ADR-19 / ADR-20 / BR-35）：
 *   - 时间轴恒为**横向**：x = computeAxisGeometry().getX(minute)；刻度 / 网格线 / 空闲窄带 /
 *     事项块 / 当前时间线**全部**使用同一坐标映射（不再混用纵向压缩坐标）。
 *   - 纵向只表达类别行组与道号：行组 top 依次堆叠，块 top = 组 top + 该道道顶。
 *   - 行组内**逐道定高**（2026-10-31）：道高 = max(48, 该道内最高块的内容需求 + BLOCK_GAP)，
 *     道数 = 并发峰值（settings.maxLanes 只作下限，绝不把多条事项叠进同一道）。
 *   - 展开卡用 ui/overlay.js 临时 position:fixed 脱离裁切（US-24），失败则原位展开。
 *   - 时间轴区内不再出现任何「没有排定时间的事项」文案（BR-28 / AC-20.1）。
 *
 * 兼容：Layout 的 v2 接口（DM-21）以运行时探测为准；未提供时用同规则同一数值的本地补偿，
 * 保证 layout.js v1/v2 两代接口下几何一致（见 axisX / labelMetrics / idleBands 注释）。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var D = root.DayPlan.datetime;
  var Order = root.DayPlan.order;
  var R = root.DayPlan.recurrence;
  var Layout = root.DayPlan.layout;
  var Form = root.DayPlan.form;
  var Overlay = root.DayPlan.overlay;
  var M = root.DayPlan.modal;
  var el = M.el;
  /* 2026-10-30：类别色统一走色板（20 色）；旧高饱和色由 categoryTone 就近归一 */
  var Palette = root.DayPlan.palette;
  var toneOf = (Palette && Palette.categoryTone) ? Palette.categoryTone : null;
  var catAccent = function (hex) {
    var tone = toneOf ? toneOf(hex) : null;
    return tone ? tone.accent : hex;
  };

  var FALLBACK_PX_PER_HOUR = 96;
  var MIN_PX_PER_HOUR = 60;
  var MAX_PX_PER_HOUR = 160;

  /* DM-21 常量（Layout 未提供时的兜底值，与规格同值） */
  var CAT_LABEL_WIDTH_FALLBACK = 34;
  var LANE_HEIGHT_MIN = 48;
  var BLOCK_HEIGHT_MIN = 22;
  var BLOCK_GAP = 6;
  /* 美化迭代 12：块高在「内容需求高度」之上再加一点余量——
     字体实际渲染略高于纯函数估算时，最高那排（通常是最下一排）的文字底部会被裁掉几像素 */
  var BLOCK_HEIGHT_SLACK = 4;
  var LABEL_CHAR_PX = 14;
  var LABEL_PAD_PX = 8;
  var OVERFLOW_OFFSET_STEP = 8;
  /* 刻度文字下移：vintage.css 把刻度带加高 24px，上沿留给当前时间胶囊与尾巴。
     刻度绝对定位 + 内联 top，CSS 改不动它，只能由这里改。 */
  var RULER_TICK_TOP = 28;
  /* 刻度贴边阈值：半个「00:00」标签约 15px；小于它就把标签改为贴边对齐 */
  var RULER_TICK_EDGE_PAD = 16;
  var URGENT_CATEGORY_ID = 'urgent';

  /**
   * 2026-10-20（用户裁定）：类别胶囊在块内只显示**首字**（按码点取，避免切坏代理对）。
   * 胶囊占宽也按首字计算（见 groupLaneHeightFor 的 chipWidth），否则度量与实际渲染不符。
   */
  function chipLabelOf(name) {
    var s = (name === null || name === undefined) ? '' : String(name);
    if (!s) return '';
    var cp = s.codePointAt(0);
    return String.fromCodePoint(cp);
  }

  /**
   * @param {object} opts
   *   - store
   *   - onSelectDate(iso)
   *   - onDataChanged(meta)  写操作后通知 app 刷新其它视图
   *   - isExpanded(key) -> boolean          （可选：由 app 统一持久化）
   *   - setExpanded(key, on)                （可选）
   */
  function createDayView(opts) {
    opts = opts || {};
    var store = opts.store;

    var els = {
      panel: document.getElementById('day-panel'),
      title: document.getElementById('day-title'),
      sub: document.getElementById('day-sub'),
      today: document.getElementById('btn-today'),
      newItem: document.getElementById('btn-new-item'),
      scroll: document.getElementById('timeline-scroll'),
      inner: document.getElementById('timeline-inner'),
      ruler: document.getElementById('timeline-ruler'),
      body: document.getElementById('timeline-body'),
      /* 美化迭代 10：类别名列下线；容器可能已被删（旧 DOM），防御式获取 */
      labels: document.getElementById('timeline-labels') || document.createElement('div'),
      track: document.getElementById('timeline-track'),
      nowLine: document.getElementById('timeline-now'),
      nowLabel: document.getElementById('timeline-now-label'),
      untimedTitle: document.getElementById('untimed-title'),
      untimedList: document.getElementById('untimed-list'),
      untimedEmpty: document.getElementById('untimed-empty'),
      countdownList: document.getElementById('countdown-list'),
      countdownEmpty: document.getElementById('countdown-empty'),
      countdownAdd: document.getElementById('btn-new-countdown'),
      railCover: document.getElementById('day-rail-cover'),
      notesInput: document.getElementById('notes-input'),
      notesStatus: document.getElementById('notes-status'),
      notesCount: document.getElementById('notes-count')
    };

    var state = {
      date: D.todayISO(),
      hideDone: false,
      occurrences: [],
      truncated: false,
      expanded: {}      // 兜底：app 未注入扩展状态时本地保存
    };
    var notesTimer = null;
    var nowTimer = null;
    var axis = null;    // 当前渲染所用的轴线几何（单一几何源：computeAxisGeometry）
    /* BR-35 首屏定位：只在「进入日视图 / 换日期」的那一次渲染里把横轴滚到最早时段附近。
       标记由 setDate 播种、并在 setDate 收尾时无条件清掉 —— 当次量不到宽度就作废。
       互动引起的重绘（展开/收起、隐藏已完成、写入后刷新）**必须保留**用户当前的
       横向位置；否则轴较长时点右侧的事项，时间轴会立刻弹回最早时段，根本没法操作。 */
    var pendingFirstScroll = false;
    /* 2026-10-30 用户口径：切到今天时，横轴要划到能看见「现在」指针的位置。
       同样只在 setDate 的那一次渲染里生效；每分钟刷新指针不打扰用户已滚到的位置。 */
    var pendingNowScroll = false;

    /* 迭代 10 批次 5（条9）：拖放结束后浏览器可能补发一次 click，
       用短时间窗抑制，避免「拖进完成台」又顺手把卡片展开 */
    var dragSuppressUntil = 0;
    /** 完成台实例（finishdock 模块缺失时为 null → 右侧栏保持空台） */
    var dock = null;
    /** 五十一轮：倒计时实例（模块缺失时为 null → 右栏只留记录区） */
    var countdown = null;
    /** 2026-11-01：右栏图片实例（模块缺失时为 null → 保留静态明信片） */
    var railCover = null;

    /* 2026-11-01：拖放排时 / 拉边调整。idleDragExpanded 只在拖动期间为 true ——
       指针进入首尾折叠带时整条轴临时展开为真实比例，结束即收拢。 */
    var idleDragExpanded = false;
    /** 展开时记住「被折叠那半段的中心时刻」：收拢时以它为轴反向卷回，视线不漂 */
    var idleBandAnchor = null;
    /* 展开 / 收拢的 FLIP 期间冻结自动滚动：滚动位移已由视口坐标的 FLIP 补齐，
       此时再改 scrollLeft 会让动画终点持续漂移 */
    var axisAnimatingUntil = 0;
    /* 2026-11-01 用户反馈：卷轴展开再慢一点；刻度文字自带的 translateX(-50%) 居中
       必须与 FLIP 的位移叠加，动画只能改独立的 translate 属性，不能覆盖 transform。 */
    var AXIS_FLIP_MS = 480;
    var AXIS_FADE_MS = 320;
    var AXIS_FLIP_EASING = 'cubic-bezier(.22,.61,.36,1)';
    var dragGhost = null;         // 时间轴上的 1 小时落位幽灵块
    var dragPill = null;          // 跟随指针的鼠尾草时间胶囊
    var dragPointer = null;       // {x, y, mode:'drag'|'resize'}，自动滚动用
    var autoScrollRaf = 0;
    var resizeState = null;
    /* 2026-11-01：两端手柄各占 10px；过窄的块（省略态 / 微块）不放，免得整块都成拉边区、点不开 */
    var RESIZE_HANDLE_MIN_W = 40;
    var touchDrag = null;
    var touchGhost = null;

    /* US-24 / DM-25：展开卡临时脱离裁切上下文（模块缺失或无 rect 时降级为原位展开） */
    var pinner = (Overlay && typeof Overlay.createExpandPinner === 'function')
      /* 迭代 10 批次 3（条7）：展开后与原块同宽 —— 不再强制 220px 最小宽度 */
      ? Overlay.createExpandPinner({ zIndex: 60, minWidth: 0 })
      : null;

    /* BR-35：当前时间线用 inner 坐标系（left = CAT_LABEL_WIDTH + getX(now)），
       故把静态 DOM 里的 #timeline-now 从 #timeline-track 移到 #timeline-inner。 */
    if (els.nowLine && els.inner && els.nowLine.parentNode !== els.inner) {
      els.inner.appendChild(els.nowLine);
    }

    /* ---------------- 展开状态 ---------------- */

    function isExpanded(key) {
      if (typeof opts.isExpanded === 'function') return !!opts.isExpanded(key);
      return !!state.expanded[key];
    }

    function setExpanded(key, on) {
      if (typeof opts.setExpanded === 'function') { opts.setExpanded(key, on); return; }
      if (on) state.expanded[key] = true; else delete state.expanded[key];
    }

    /* ---------------- 数据 ---------------- */

    function currentDoc() { return store.getState(); }

    function categoryMap() {
      var map = {};
      (currentDoc().categories || []).forEach(function (c) { map[c.id] = c; });
      return map;
    }

    /** 类别次序（DM-3）：order 升序 → createdAt → id */
    function categoryOrder() {
      return (currentDoc().categories || []).slice().sort(function (a, b) {
        var oa = Number(a.order) || 0;
        var ob = Number(b.order) || 0;
        if (oa !== ob) return oa - ob;
        var ca = String(a.createdAt || '');
        var cb = String(b.createdAt || '');
        if (ca !== cb) return ca < cb ? -1 : 1;
        return String(a.id) < String(b.id) ? -1 : 1;
      }).map(function (c) { return c.id; });
    }

    function compute() {
      var doc = currentDoc();
      state.truncated = false;
      var list;
      try {
        list = R.occurrencesForDate(doc, state.date);
      } catch (e) {
        if (root.console) console.error('[DayPlan] 展开失败：', e);
        list = [];
        banner('danger', '展开重复事项失败：' + e.message);
      }
      state.occurrences = list;
    }

    function visible(occ) {
      /* 迭代 10 批次 5（条9）：已拖入完成台的事项原位置空出（仅界面隐藏，不改数据） */
      if (dock && occ && typeof dock.has === 'function' && dock.has(occ.key)) return false;
      if (state.hideDone && occ.done) return false;
      return true;
    }

    /* ---------------- 提示条 ---------------- */

    function banner(type, text, actions) {
      var box = document.getElementById('banners');
      if (!box) return null;
      var node = el('div', { class: 'banner banner-' + (type || 'info') });
      node.appendChild(el('div', { class: 'banner-body', text: text }));
      if (actions && actions.length) {
        var acts = el('div', { class: 'banner-actions' });
        actions.forEach(function (a) {
          acts.appendChild(el('button', {
            class: 'btn', type: 'button', text: a.label,
            onclick: function () { a.onClick(); node.remove(); }
          }));
        });
        node.appendChild(acts);
      }
      node.appendChild(el('button', {
        class: 'btn btn-ghost btn-icon', type: 'button', text: '✕', 'aria-label': '关闭提示',
        onclick: function () { node.remove(); }
      }));
      box.appendChild(node);
      return node;
    }

    /* ---------------- 渲染：标题 ---------------- */

    function renderHead() {
      /* 2026-10-30 用户口径：标题 = 日期 + 星期（+ 前天/昨天/今天/明天/后天），
         副标题只留农历日期（有节假日才附带），事项计数不再进副标题。 */
      var today = D.todayISO();
      var diff = D.diffDays(today, state.date); // 正值 = 未来
      var rel = diff === 0 ? '今天' : diff === -1 ? '昨天' : diff === -2 ? '前天'
        : diff === 1 ? '明天' : diff === 2 ? '后天' : '';
      els.title.textContent = D.formatDateCN(state.date) + (rel ? ' · ' + rel : '');
      var parts = [];
      var lunar = root.DayPlan.lunar && root.DayPlan.lunar.solarToLunar ? root.DayPlan.lunar.solarToLunar(state.date) : null;
      if (lunar) {
        var mName = root.DayPlan.lunar.lunarMonthName
          ? root.DayPlan.lunar.lunarMonthName(lunar.month, lunar.isLeap)
          : (lunar.isLeap ? '闰' : '') + lunar.month + '月';
        var dName = root.DayPlan.lunar.lunarDayName ? root.DayPlan.lunar.lunarDayName(lunar.day) : String(lunar.day);
        parts.push('农历' + mName + dName);
      }
      // 节假日标注（F-21.2）
      var holiday = null;
      var H = root.DayPlan.holidays;
      if (H && H.holidayOf) {
        try { holiday = H.holidayOf(state.date); } catch (e) { holiday = null; }
      }
      if (holiday && holiday.name) {
        parts.push((holiday.type === 'workday' ? '班 ' : '休 ') + holiday.name);
      }
      els.sub.textContent = parts.join(' · ');
      els.sub.hidden = parts.length === 0;
      /* 今天的页面不再给一个「今天」按钮（点了也没有变化） */
      if (els.today) els.today.hidden = (state.date === today);
      if (els.panel) {
        els.panel.dataset.holiday = holiday ? holiday.type : '';
      }
    }

    /* ---------------- 渲染：时间轴（F-16 / F-19） ---------------- */

    function pxPerHour() {
      var s = currentDoc().settings || {};
      var v = Number(s.dayPxPerHour);
      if (!isFinite(v) || v <= 0) v = Number(s.pxPerHour);
      if (!isFinite(v) || v <= 0) v = FALLBACK_PX_PER_HOUR;
      return Math.min(MAX_PX_PER_HOUR, Math.max(MIN_PX_PER_HOUR, v));
    }

    function compressHeight() {
      var s = currentDoc().settings || {};
      var v = Number(s.idleCompressHeight);
      if (!isFinite(v) || v <= 0) v = Layout.COMPRESS_HEIGHT_DEFAULT;
      return v;
    }

    /* ---------------- 几何辅助（ADR-20 单一几何源 + layout.js v1/v2 兼容） ---------------- */

    /** 左侧竖排类别名列宽（美化迭代 10：类别表头列整体下线，恒为 0——轴从左缘起算）。 */
    function catLabelWidth() {
      return 0;
    }

    /**
     * 类别名文本度量（DM-21.4 / ADR-21）。
     * 优先 Layout.categoryLabelMetrics；缺失时用同公式本地实现（CJK/全角记 1，ASCII 记 0.5）。
     */
    function labelMetrics(name) {
      if (Layout && typeof Layout.categoryLabelMetrics === 'function') {
        try {
          var m = Layout.categoryLabelMetrics(name);
          if (m && typeof m.height === 'number') return m;
        } catch (e) { /* 落到本地实现 */ }
      }
      var s = String(name === null || name === undefined ? '' : name);
      var units = 0;
      for (var i = 0; i < s.length; i += 1) {
        var code = s.charCodeAt(i);
        units += (code >= 0x20 && code <= 0x7e) ? 0.5 : 1;
      }
      return { units: units, height: Math.max(LANE_HEIGHT_MIN, Math.ceil(units * LABEL_CHAR_PX) + LABEL_PAD_PX) };
    }

    /** 行组车道高度（BR-26）：类别表头下线后 = 车道高下限（48px）。 */
    function groupLaneHeight() {
      return LANE_HEIGHT_MIN;
    }

    /**
     * 迭代 8（F-52）：给定一批事项「内容完整显示」所需的道高。
     * 口径（用户裁定）：以**一条道**为单位，取这条道里最高的那个事项所需的块高
     * （含备注按当前块宽自然换行）；与车道高下限取最大值。
     * 2026-10-31：入参从「整个类别组」改成「该道内的事项」—— 逐道定高后，
     * 一条长备注块只抬高它自己那道，不再把同组的短块一起拉开（DM-21.7）。
     * 美化迭代 10：标题右侧的类别胶囊占宽 → chipWidthFor(name) 参与度量。
     * @param {string} name 类别名
     * @param {Array} items 该**道**内的事项（occurrence 或 {occ}）
     * @param {number} wrapWidth 该道事项中最宽的块宽（换行宽度；缺省回落到整天轴宽）
     */
    function groupLaneHeightFor(name, items, wrapWidth, geometry) {
      var base = groupLaneHeight();
      if (!Layout || typeof Layout.maxBlockHeightNeed !== 'function') return base;
      var need = 0;
      var minBlockW = Number(Layout.DEFAULT_MIN_BLOCK_WIDTH) || 12;
      try {
        /* 迭代 8（F-53）：窄到不显示内容的块不参与高度需求（tooNarrow 逐个块判定）。
           2026-10-20（用户反馈）：**逐块按自身宽度**算需求 —— 走 widthOf / optionsOf 两个回调，
           旧行为是整组共用一个 wrapWidth（最宽块宽），窄块的换行行数被低估、道高与块高对不上。
           标题让位宽度与时间行数也换成本视图口径（measureOptsOf / timeLineCount），
           与 blockHeightFor、dayBlockShowsTime 三处同源。
           ⚠️ 仍然走 Layout.maxBlockHeightNeed（不要在这里自己写循环）——注入 F-73 靠替换它来验证道高。 */
        need = Layout.maxBlockHeightNeed(collectTimes(items), wrapWidth, {
          tooNarrow: function (occ) {
            return Layout.isDayBlockTooNarrow(itemBlockWidth(geometry, occ, minBlockW));
          },
          widthOf: function (occ) {
            return itemBlockWidth(geometry, occ, minBlockW);
          },
          optionsOf: function (occ, w) {
            var opts = measureOptsOf(w);
            if (typeof Layout.timeLineCount === 'function') opts.timeLines = Layout.timeLineCount(occ, w, opts);
            return opts;
          }
        });
      } catch (e) { need = 0; }
      if (!isFinite(need) || need <= 0) return base;
      /* 块之间留出 BR-26 的 BLOCK_GAP，避免相邻道的块贴在一起；
         美化迭代 12：再叠加 BLOCK_HEIGHT_SLACK 防裁字（见常量注释） */
      var gap = Number(Layout.BLOCK_GAP);
      if (!isFinite(gap) || gap < 0) gap = 0;
      return Math.max(base, Math.ceil(need + gap + BLOCK_HEIGHT_SLACK));
    }

    /**
     * 迭代 8（F-53）：单个事项块的像素宽（时间轴映射，下限 minBlockWidth）。
     * 用于「这个块窄到不显示内容」的判定。
     */
    function itemBlockWidth(geometry, occ, minBlockWidth) {
      var time = occ ? occ.time : null;
      if (!time) return 0;
      var start = D.minutesOf(time.start);
      var end = D.minutesOf(time.end);
      if (!isFinite(start) || !isFinite(end) || end <= start) return 0;
      var w = axisX(geometry, end) - axisX(geometry, start);
      if (!isFinite(w) || w <= 0) return 0;
      return Math.max(w, minBlockWidth);
    }

    /**
     * 迭代 8（F-53）：把入参归一成 occurrence 数组，供 maxBlockHeightNeed 使用。
     */
    function collectTimes(items) {
      var out = [];
      (items || []).forEach(function (it) {
        var occ = it && it.occ ? it.occ : it;
        if (!occ || !occ.time) return;
        var start = D.minutesOf(occ.time.start);
        var end = D.minutesOf(occ.time.end);
        if (!isFinite(start) || !isFinite(end) || end <= start) return;
        out.push(occ);
      });
      return out;
    }

    /**
     * 迭代 8（F-52）：该组事项中最宽的块宽 —— 内容换行的真实可用宽度。
     * 块宽由时间轴映射决定（`projectX(end) − projectX(start)`，下限 minBlockWidth）。
     */
    function groupWrapWidth(geometry, items, minBlockWidth) {
      var max = 0;
      (items || []).forEach(function (it) {
        var occ = it && it.occ ? it.occ : it;
        var time = occ ? occ.time : null;
        if (!time) return;
        var start = D.minutesOf(time.start);
        var end = D.minutesOf(time.end);
        if (!isFinite(start) || !isFinite(end) || end <= start) return;
        var w = axisX(geometry, end) - axisX(geometry, start);
        if (!isFinite(w) || w <= 0) return;
        w = Math.max(w, minBlockWidth);
        if (w > max) max = w;
      });
      return max > 0 ? max : axisX(geometry, 1440);
    }

    /** 分钟 → 轴向像素（BR-35）：getX 优先，v1 用同函数别名 getY。 */
    function axisX(geometry, minute) {
      if (geometry) {
        if (typeof geometry.getX === 'function') return geometry.getX(minute);
        if (typeof geometry.getY === 'function') return geometry.getY(minute);
      }
      return minute * pxPerHour() / 60;
    }

    /**
     * 迭代 8（F-52）：单个事项块的可用宽度。
     * 日视图块宽由时间轴几何决定（时间 × pxPerHour），故这就是「内容要多高」的换行宽度。
     */
    function laneWidthFor(geometry) {
      return Math.max(0, axisX(geometry, 1440));
    }

    /** 压缩区长度（v2 的 leadLength/trailLength 优先，回退 leadHeight/trailHeight）。 */
    function bandLength(geometry, key) {
      if (!geometry) return 0;
      var v2 = Number(geometry[key + 'Length']);
      if (isFinite(v2)) return Math.max(0, v2);
      var v1 = Number(geometry[key + 'Height']);
      return isFinite(v1) ? Math.max(0, v1) : 0;
    }

    /** 该分钟是否落在压缩区（DM-21.2 axisTicks().outside 同口径）。 */
    function isOutsideAxis(geometry, minute) {
      if (!geometry) return false;
      if (minute < geometry.firstStart) return bandLength(geometry, 'lead') > 0;
      if (minute > geometry.lastEnd) return bandLength(geometry, 'trail') > 0;
      return false;
    }

    /** 首末空闲段（DM-21.3）：优先 Layout.axisIdleBands，缺失时用同规则本地实现。 */
    function idleBands(geometry) {
      if (!geometry) return [];
      if (Layout && typeof Layout.axisIdleBands === 'function') {
        try {
          var fromModule = Layout.axisIdleBands(geometry);
          if (fromModule && fromModule.length !== undefined) return fromModule;
        } catch (e) { /* 落到本地实现 */ }
      }
      var lead = bandLength(geometry, 'lead');
      var trail = bandLength(geometry, 'trail');
      var real = Number(geometry.realLength);
      if (!isFinite(real)) real = Number(geometry.realHeight) || 0;
      var out = [];
      if (lead > 0) {
        out.push({ kind: 'lead', start: 0, length: lead, fromMinute: 0, toMinute: geometry.firstStart });
      }
      if (trail > 0) {
        out.push({
          kind: 'trail', start: lead + real, length: trail,
          fromMinute: geometry.lastEnd, toMinute: 1440
        });
      }
      return out;
    }

    /**
     * 2026-10-30：时间轴的纵向拉伸。
     * 卡片按视口高度固定后，若轨道仍按内容高度排版，底部会空出一大片纸 ——
     * 参考图里时间轴是视觉中心，所以把富余高度先摊给组间距（≤22px），
     * 剩下的均摊进每条道。只在桌面分栏生效；窄屏保持内容高度。
     */
    function stretchTimeline(geometry, laid, groups, rate) {
      if (!els.scroll || !laid || !laid.groups || !laid.groups.length) return null;
      if (typeof root !== 'undefined' && root.innerWidth && root.innerWidth < 1024) return null;
      var rulerH = (els.ruler && els.ruler.offsetHeight) || 30;
      var avail = els.scroll.clientHeight - rulerH;
      var extra = avail - laid.height;
      if (!(extra > 10)) return null;
      var lanes = Math.max(1, Number(laid.laneCount) || 1);
      var laneExtra = extra / lanes;
      var next = layoutGroups(geometry, groups, rate, { laneExtra: laneExtra });
      return (next && next.height > laid.height + 1) ? next : null;
    }

    /**
     * 2026-11-02（用户口径）：**跨类别共享道**。
     * 有类别不同但时间不冲突的事项时，不再各占一行组 —— 所有类别的事项拼成一列，
     * 按时间做全局贪心分道：时间不冲突的（含不同类别）复用同一条道，
     * 只有真正重叠的事项才向下加道。类别不再决定纵向位置，改由块内胶囊标识。
     * 决策表与周视图 / core/layout.js::greedyAssignLanes 完全一致（start ↑ → end ↓ →
     * order ↑ → key ↑ → 输入序），类别序只通过输入序影响「完全同时段」时的先后。
     *
     * 每个类别仍保留一个 `.tl-typegroup` 容器（块内标签 / 拉边判定区挂在它上面），
     * 但容器的 [top, top+height) 现在只覆盖该类别实际用到的道，**允许与其他容器重叠**；
     * 容器的 pointer-events 已交给块自身（见 styles/views.css），不会挡住别组的事项。
     *
     * 道高逐道按**本道**内容定（跨类别取最高），富余高度由 stretch 均摊到各道。
     */
    function assignSharedLanes(blocks) {
      if (Layout && typeof Layout.greedyAssignLanes === 'function') {
        return Layout.greedyAssignLanes(blocks, Math.max(1, blocks.length));
      }
      /* 兜底：与 core/layout.js::greedyAssignLanes 同一张决策表（本视图不设上限） */
      var positions = blocks.map(function (b, i) { return { block: b, index: i }; });
      positions.sort(function (a, b) {
        var ba = a.block;
        var bb = b.block;
        if (ba.start !== bb.start) return ba.start - bb.start;
        if (ba.end !== bb.end) return bb.end - ba.end;
        var oa = Number(ba.occ && ba.occ.order) || 0;
        var ob = Number(bb.occ && bb.occ.order) || 0;
        if (oa !== ob) return oa - ob;
        var ka = (ba.occ && ba.occ.key) || '';
        var kb = (bb.occ && bb.occ.key) || '';
        if (ka !== kb) return ka < kb ? -1 : 1;
        return a.index - b.index;
      });
      var lastEnds = [];
      var lanes = [];
      for (var p = 0; p < positions.length; p += 1) {
        var entry = positions[p];
        var lane = -1;
        for (var L = 0; L < lastEnds.length; L += 1) {
          if (lastEnds[L] <= entry.block.start) { lane = L; break; }
        }
        if (lane === -1) {
          lane = lastEnds.length;
          lastEnds.push(entry.block.end);
        } else {
          lastEnds[lane] = entry.block.end;
        }
        lanes[entry.index] = lane;
      }
      return { lanes: lanes, count: lastEnds.length };
    }

    /** 跨类别分道 + 逐道定高 + 回填各类别容器（2026-11-02，取代按类别堆叠的行组排布）。 */
    function layoutGroups(geometry, groups, rate, stretch) {
      var ordered = groups.slice();
      var pin = urgentCategoryId();          /* v2 由 pinFirst 处理；v1 在此本地前置（幂等） */
      if (pin) {
        var head = [];
        var tail = [];
        ordered.forEach(function (g) { (String(g.categoryId) === pin ? head : tail).push(g); });
        ordered = head.concat(tail);
      }

      var minBlockWidth = Number(Layout.DEFAULT_MIN_BLOCK_WIDTH) || 12;
      var extra = stretch || {};
      var laneExtra = Math.max(0, Number(extra.laneExtra) || 0);

      /* 1) 所有类别的事项拼成一列（输入序 = 类别序，只影响完全同时段时的先后） */
      var blocks = [];
      ordered.forEach(function (g, gi) {
        (g.items || []).forEach(function (occ) {
          if (!occ || !occ.time) return;
          var start = D.minutesOf(occ.time.start);
          var end = D.minutesOf(occ.time.end);
          if (!isFinite(start) || !isFinite(end) || end <= start) return;
          blocks.push({ occ: occ, groupIndex: gi, start: start, end: end, index: blocks.length });
        });
      });

      /* 2) 全局贪心分道（不设上限：道数 = 并发峰值） */
      var assigned = assignSharedLanes(blocks);
      var laneCount = Math.max(1, Number(assigned.count) || 0);
      var laneItems = [];
      for (var L = 0; L < laneCount; L += 1) laneItems.push([]);
      blocks.forEach(function (b) {
        var raw = Number(assigned.lanes[b.index]);
        var lane = isFinite(raw) ? Math.max(0, Math.min(laneCount - 1, raw)) : 0;
        b.lane = lane;
        laneItems[lane].push(b.occ);
      });

      /* 3) 逐道定高：本道内跨类别取最高内容需求 */
      var laneTops = [];
      var laneHeights = [];
      var y = 0;
      for (var L2 = 0; L2 < laneCount; L2 += 1) {
        var laneH = groupLaneHeightFor('', laneItems[L2],
          groupWrapWidth(geometry, laneItems[L2], minBlockWidth), geometry);
        laneH = Math.max(LANE_HEIGHT_MIN, Number(laneH) || LANE_HEIGHT_MIN) + laneExtra;
        laneTops[L2] = y;
        laneHeights[L2] = laneH;
        y += laneH;
      }

      /* 4) 各类别容器：只覆盖本类别实际用到的道（允许互相重叠） */
      var out = ordered.map(function (g) {
        return {
          categoryId: g.categoryId, top: 0, height: 0,
          laneHeight: LANE_HEIGHT_MIN, laneCount: 0, items: []
        };
      });
      blocks.forEach(function (b) {
        var lane = b.lane;
        var item = {
          occ: b.occ,
          categoryId: ordered[b.groupIndex].categoryId,
          lane: lane,
          top: laneTops[lane],
          laneBlockH: Math.max(BLOCK_HEIGHT_MIN, laneHeights[lane] - BLOCK_GAP)
        };
        var start = D.minutesOf(b.occ.time.start);
        var end = D.minutesOf(b.occ.time.end);
        /* 横向坐标统一取自 computeAxisGeometry（ADR-20 / BR-35） */
        item.left = axisX(geometry, start);
        item.width = Math.max(axisX(geometry, end) - item.left, minBlockWidth);
        out[b.groupIndex].items.push(item);
      });

      out.forEach(function (g) {
        var minTop = Infinity;
        var maxBottom = -Infinity;
        var lanes = {};
        g.items.forEach(function (item) {
          var top = laneTops[item.lane];
          var bottom = top + laneHeights[item.lane];
          if (top < minTop) minTop = top;
          if (bottom > maxBottom) maxBottom = bottom;
          lanes[item.lane] = true;
        });
        g.top = isFinite(minTop) ? minTop : 0;
        g.height = isFinite(maxBottom) ? Math.max(0, maxBottom - minTop) : 0;
        g.laneCount = Object.keys(lanes).length;
        g.laneHeight = g.items.length ? laneHeights[g.items[0].lane] : LANE_HEIGHT_MIN;
        /* 块 top 回填为**容器内坐标**（渲染层按 group.top 绝对定位） */
        g.items.forEach(function (item) { item.top -= g.top; });
      });

      return { groups: out, height: Math.max(0, y), laneCount: laneCount };
    }

    /**
     * 2026-10-20（用户反馈）：**道高是上限，块高按自身内容收紧**。
     *
     * 旧口径（F-52）让一整条类别道等高：同类别里只要有一条长标题 / 长备注的块需要 200px，
     * 这条道上的其余短块也被撑成 200px —— 于是「门厅志愿服务」这种两行标题的块出现大片空白。
     * 现在逐块取 `min(道高, 自身需求 + 余量)`：
     *   - 内容多的块仍然完整（道高本身就是按它的需求算出来的，封顶后不会裁字）；
     *   - 内容少的块贴合自己的内容，不再陪跑。
     * 省略态 / 微块例外：折叠态只显示「…」+ 首字，沿用道高（否则会缩成不可点的小条）。
     * @param {object} item layout 给出的事项（含 occ、width）
     * @param {object} cat 类别（取胶囊首字的占位宽）
     * @param {number} laneBlockH 该道的块高（上限）
     * @returns {number} 像素高
     */
    function blockHeightFor(item, laneBlockH) {
      var w = Number(item && item.width);
      if (!isFinite(w) || w <= 0 || !(laneBlockH > 0)) return laneBlockH;
      if (!Layout) return laneBlockH;
      /* 省略态 / 微块：折叠态只有「…」+ 首字（一行），高度收到基线 42px ——
         旧口径沿用道高，长备注把道高撑到 100px+ 时，这个只写一个省略号的块也空着大半。
         基线 = 无长内容时的默认块高（LANE_HEIGHT_MIN − BLOCK_GAP），仍够点、够悬停。 */
      try {
        var omitLevel = (typeof Layout.isDayBlockTooSmall === 'function' && Layout.isDayBlockTooSmall(w))
          || (typeof Layout.isDayBlockTooNarrow === 'function' && Layout.isDayBlockTooNarrow(w));
        if (omitLevel) return Math.min(laneBlockH, Math.max(BLOCK_HEIGHT_MIN, LANE_HEIGHT_MIN - BLOCK_GAP));
      } catch (e) { return laneBlockH; }
      if (typeof Layout.blockHeightNeed !== 'function') return laneBlockH;
      var measureOpts = measureOptsOf(w);
      /* 2026-10-20：时间行在窄块里会换行 —— 需求高必须按真实行数算，与 dayBlockShowsTime 同源 */
      if (typeof Layout.timeLineCount === 'function') {
        measureOpts.timeLines = Layout.timeLineCount(item.occ, w, measureOpts);
      }
      var need = 0;
      try {
        need = Layout.blockHeightNeed(item.occ, w, measureOpts);
      } catch (e) { return laneBlockH; }
      if (!isFinite(need) || need <= 0) return laneBlockH;
      return Math.max(BLOCK_HEIGHT_MIN, Math.min(laneBlockH, Math.ceil(need + BLOCK_HEIGHT_SLACK)));
    }

    /**
     * 2026-10-20（用户反馈）：标题行给右上角胶囊让出的**真实**宽度。
     * 旧代码用的是 `chipWidthFor(首字)`（≈35px：胶囊自身宽 + 内边距 + 间隙），
     * 但胶囊已改为绝对定位，CSS 只用 padding-right 让位 22px（窄块 17px）——
     * 多扣的 13–18px 会让标题早换行 1–3 行，块高虚高。
     */
    /**
     * 2026-10-20（用户反馈）：某宽度档位的**整套**文字度量（字号 / 水平内边距 / 胶囊让位）。
     * 窄档在 CSS 里是 11px 字 + `padding:0 4px`，若沿用普通档（13px / 14px）度量，
     * 45px 宽、6 个字的标题会被算成 6 行 —— 块高一倍虚高，正是「一字一行」的另一半根因。
     * 块高、道高、时间行数、时间显隐四处统一走这里（真实来源是 layout.blockMetricOpts）。
     */
    function measureOptsOf(w) {
      if (Layout && typeof Layout.blockMetricOpts === 'function') {
        try {
          var o = Layout.blockMetricOpts(w);
          if (o && isFinite(o.unitPx) && isFinite(o.padX)) return o;
        } catch (e) { /* 落到默认值 */ }
      }
      var narrow = Number(w) < 72;
      return narrow
        ? { unitPx: 11, padX: 8, chipWidth: 22 }
        : { unitPx: 13, padX: 14, chipWidth: 36 };
    }

    /** 设置内联 px 值：真实浏览器与 DOM 垫片（含 getPropertyValue 回退）都能读到。 */
    function setPx(node, prop, value) {
      node.style[prop] = Math.round(value) + 'px';
    }

    /**
     * 本轮的轨道内容比滚动区高时（窄视口 / 页面放大后道高被挤高），把面板垫高到装得下：
     * 宁可整页滚动，也不让底部事项被 `.timeline-scroll` 的 overflow 裁掉。
     * 用**本轮刚算出的**内容高度而不是上一轮轨道的 scrollHeight，避免越垫越高。
     */
    function fitPanelToContent(contentH) {
      var panel = els.panel;
      var sc = els.scroll;
      if (!panel) return;
      /* 面板高度已随内容（vintage.css ≥1024 的 height:auto）：每轮先撤掉上一轮的垫高，
         再按本轮自然布局判断。否则底行变矮 / 事项变少后旧 floor 会把面板钉在高处，
         时间轴被空拉长、右栏在下面空一截，只有缩放视口才会恢复。 */
      panel.style.removeProperty('--day-floor');
      fitPadRounds = 0;
      if (!sc || !(contentH > 0)) return;
      /* 2026-10-31：不再按视口宽度一刀切（原来 <1024 直接放弃）。
         --day-floor 只在 ≥1024 的 .panel-day 上生效，宽屏外的写入是无害的；
         而「窗口正好卡在断点附近 / 页面缩放」时那一条守卫会让兜底完全失效。 */
      var rulerH = (els.ruler && els.ruler.offsetHeight) || 30;
      var avail = sc.clientHeight - rulerH;
      if (!(avail > 0)) return;
      var need = contentH - avail;
      /* 滚动区底部 padding（4px）+ 边框会固定吃掉几像素，留 2px 余量不算裁切 */
      if (!(need > 2)) return;
      var base = panel.getBoundingClientRect().height || 0;
      var floor = Math.ceil(base + need + 2);
      panel.style.setProperty('--day-floor', floor + 'px');
    }

    /**
     * 2026-10-31（用户反馈）：桌面端「并发事项被卡片下沿切掉」。
     * `.timeline-scroll` 是 `flex:1 1 0` 的**定高**滚动区，且 `overflow-y: hidden` ——
     * 只要轨道比可视区高一点（并发道数变多 / 块变高 / 视口变矮 / 页面缩放），
     * 底部整条道就会**静默消失**，列表里也滚不到。fitPanelToContent 只在面板能长高时有效，
     * 面板被别的规则钉住时它救不了。
     *
     * 这里渲染后做一次实测兜底（顺序不可颠倒）：
     *   ① 先按**量出来的**差值再垫高面板（真实差值，含舍入误差）；
     *   ② 仍然装不下（视口太矮 / 面板长不动）→ 给滚动区挂 .is-vscroll，
     *      时间轴改为纵向可滚动：宁可多一根滚动条，也不许事项凭空消失。
     * 能装下时立刻摘掉这个类，回到「不滚动、整卡铺满」的原样。
     */
    function timelineOverflow() {
      var sc = els.scroll;
      if (!sc || !els.track) return 0;
      var rulerH = (els.ruler && els.ruler.offsetHeight) || 0;
      var trackH = els.track.offsetHeight || 0;
      if (!(trackH > 0)) return 0;
      var over = (rulerH + trackH) - (sc.clientHeight || 0);
      /* 2026-10-31（用户反馈「刷新之后还是会被遮挡」）：
         事项块是 position:absolute，撑不动轨道高度 —— 块比所在道高时，
         轨道 offsetHeight 完全反映不出真实内容，只按它算会得到 over=0 的假安好。
         这里再按块的**实际矩形**兜一遍，取两者较大值。 */
      try {
        var sr = sc.getBoundingClientRect();
        var bottom = sr.top + rulerH + trackH;
        var nodes = els.track.querySelectorAll('.tl-block');
        for (var i = 0; i < nodes.length; i++) {
          var r = nodes[i].getBoundingClientRect();
          if (r.height > 0 && r.bottom > bottom) bottom = r.bottom;
        }
        var byBlock = bottom - sr.bottom;
        if (byBlock > over) over = byBlock;
      } catch (e) { /* 无布局能力 → 退回只按轨道高度 */ }
      return over;
    }

    /* 连续垫高次数。ResizeObserver 会在每次垫高后再回调一次，
       面板被外部规则钉死（长不动）时不能让这里无限叠加，超过 3 轮就只留纵向滚动。 */
    var fitPadRounds = 0;

    function ensureTimelineFits() {
      var sc = els.scroll;
      if (!sc || !sc.classList) return;
      var over = timelineOverflow();
      if (over <= 1) {
        fitPadRounds = 0;
        sc.classList.remove('is-vscroll');
        return;
      }
      if (fitPadRounds < 3 && els.panel) {
        fitPadRounds += 1;
        var cur = parseFloat(els.panel.style.getPropertyValue('--day-floor')) || 0;
        var base = els.panel.getBoundingClientRect().height || 0;
        els.panel.style.setProperty('--day-floor', Math.ceil(Math.max(base, cur) + over + 2) + 'px');
        over = timelineOverflow();
        if (over <= 1) {
          fitPadRounds = 0;
          sc.classList.remove('is-vscroll');
          return;
        }
      }
      /* 垫高也装不下（面板长不动 / 视口太矮）→ 让时间轴自己纵向滚动，绝不静默裁掉 */
      sc.classList.add('is-vscroll');
    }

    function renderTimeline() {
      var doc = currentDoc();
      var cats = categoryMap();
      var rate = pxPerHour();
      var compressible = (!doc.settings || doc.settings.idleCompressEnabled !== false) && !idleDragExpanded;
      var labelWidth = catLabelWidth();

      if (els.panel) {
        els.panel.style.setProperty('--px-per-hour', rate + 'px');
        els.panel.style.setProperty('--compress-height', compressHeight() + 'px');
        els.panel.style.setProperty('--cat-label-width', labelWidth + 'px');
      }

      /* 上一轮已固定的展开卡：整条轨道即将重建，先收回（手机档卡片被搬到了视图根，
        不收回就会留在页面上成为孤儿；真实滚动/缩放仍由 overlay 自行 sync）。 */
      if (pinner) pinner.releaseAll();

      /* 重建期间会先移除全部 .tl-block / .tl-typegroup，真实浏览器在这一刻可能把
         scrollLeft 夹取到 0（垫片只存值、不会夹取，所以冒烟测不到）。先把位置记下来，
         重新插入节点后、pin 之前还原 —— 否则展开卡会按被夹取后的视口矩形定位。 */
      var keepScrollLeft = els.scroll ? els.scroll.scrollLeft : 0;

      var p = Order.partition(state.occurrences);
      var timed = Order.sortTimed(p.timed).filter(visible);

      /* 唯一几何源（ADR-20 / BR-35）：x = getX(minute) */
      var geometry = Layout.computeAxisGeometry(timed, {
        pxPerHour: rate,
        compressHeight: compressHeight(),
        compressible: compressible
      });
      axis = geometry;

      var groups = Layout.layoutDayGroups(timed, categoryOrder(), { pinFirst: urgentCategoryId() });
      var laid = layoutGroups(geometry, groups, rate);
      /* 装不下就先长高面板（读 clientHeight 会顺带把新高度落到布局里），再分配富余 */
      fitPanelToContent(laid.height);
      /* 2026-10-30（用户口径）：时间轴是页面主体 —— 桌面端把卡片富余高度摊进道高 */
      var stretched = stretchTimeline(geometry, laid, groups, rate);
      if (stretched) laid = stretched;

      /* ADR-19：inner 宽 = 类别名列宽 + 轴长（美化迭代 10：labelWidth 恒 0）。
         空日程时 computeAxisGeometry 返回 null，Number(null) === 0 能骗过 isFinite，
         inner 会被写成 0px（只剩 min-width:100% 撑开），而刻度 / 当前时间仍按整日排版，
         胶囊的边界回推就按容器宽夹取，出现「胶囊在最左、竖线在最右」的分离（2026-10-30）。 */
      var axisLength = Number(geometry && geometry.axisLength);
      if (!isFinite(axisLength) || axisLength <= 0) axisLength = Number(geometry && geometry.totalHeight);
      if (!isFinite(axisLength) || axisLength <= 0) axisLength = Math.round(24 * rate);
      els.inner.style.width = Math.round(labelWidth + axisLength) + 'px';
      /* 轴元素自身宽 = axisLength（.timeline-body 内 flex 布局下与可用宽度一致） */
      setPx(els.track, 'width', axisLength);

      renderRuler(geometry, rate);

      Array.prototype.slice.call(els.track.querySelectorAll('.tl-gridline, .tl-block, .tl-typegroup')).forEach(function (n) { n.remove(); });
      Array.prototype.slice.call(els.inner.querySelectorAll('.tl-idle')).forEach(function (n) { n.remove(); });

      var hasTimed = timed.length > 0 && !!geometry;
      /* 迭代 4（S24 / AC-20.1）：时间轴区不再有任何"没有排定时间的事项"占位文案。 */

      var contentHeight = Math.max(laid.height, LANE_HEIGHT_MIN);

      if (!hasTimed) {
        /* 空态（BR-28 / AC-20.1）：时间轴区内不出现任何占位文案，只保留整日刻度与网格线。
           2026-11-01（用户反馈）：桌面档 .timeline-section / .timeline-scroll 由 flex 撑满，
           轨道若只按一行高排版，整点竖线与「现在」线会停在半空、卡片下半截只剩纸色。
           这里让空轨道铺满滚动区可视高度；窄屏滚动区由内容撑高，仍保持一行高
           （否则「量自身 → 写回自身」会一轮轮长高）。 */
        var emptyRulerH = (els.ruler && els.ruler.offsetHeight) || 0;
        var visibleH = (els.scroll && els.scroll.clientHeight) || 0;
        contentHeight = LANE_HEIGHT_MIN;
        if ((Number(root.innerWidth) || 0) >= 1024 && visibleH > emptyRulerH) {
          contentHeight = Math.max(contentHeight, visibleH - emptyRulerH);
        }
        els.track.style.height = contentHeight + 'px';
        renderGridlines(null, rate);
        ensureTimelineFits();
        updateNowLine();
        return;
      }

      els.track.style.height = contentHeight + 'px';

      /* 整点竖线（横向轴专用，逐条由 JS 放置） */
      renderGridlines(geometry, rate);

      /* 首末空闲段：竖直窄带，覆盖全部行组高度（US-25.3）；inner 坐标系 */
      idleBands(geometry).forEach(function (band) {
        els.inner.appendChild(idleBandNode(band, labelWidth));
      });

      var toPin = [];
      laid.groups.forEach(function (group) {
        var cat = cats[group.categoryId] || { name: '未分类', color: '#94a3b8' };
        var laneHeight = Math.max(LANE_HEIGHT_MIN, Number(group.laneHeight) || LANE_HEIGHT_MIN);
        var groupHeight = Math.max(Number(group.height) || laneHeight, laneHeight);
        /* 道内块高的**上限**；逐块再按自身内容收紧（见 blockHeightFor） */
        var laneBlockH = Math.max(BLOCK_HEIGHT_MIN, laneHeight - BLOCK_GAP);
        var groupTop = Math.round(Number(group.top) || 0);

        var box = el('div', {
          class: 'tl-typegroup',
          'data-category': group.categoryId,
          'data-category-name': cat.name
        });
        setPx(box, 'top', groupTop);
        setPx(box, 'height', groupHeight);

        group.items.forEach(function (item) {
          var occ = item.occ;
          var expanded = isExpanded(occ.key);
          /* 2026-10-20（用户反馈）：块高按自身内容走，道高只是上限；
             2026-10-31：上限改为**本道自己的**高度（逐道定高后每道不同）。 */
          var laneCap = Number(item.laneBlockH);
          if (!isFinite(laneCap) || laneCap <= 0) laneCap = laneBlockH;
          var blockHeight = blockHeightFor(item, laneCap);
          var node = buildCard(occ, {
            variant: 'block',
            cats: cats,
            expanded: expanded,
            width: item.width,
            /* 2026-10-21：展开卡按原块宽高挑按钮排布（非省略块不再放大） */
            origWidth: item.width,
            origHeight: blockHeight,
            pxPerHour: rate
          });
          /* 迭代 10 批次 5（条9）：完成台的拖拽源标识；展开中的块不可拖（会与 pin / 收起冲突） */
          node.setAttribute('data-occ-key', occ.key);
          if (!expanded) node.setAttribute('draggable', 'true');
          node.style.left = Math.round(item.left + (item.overflowOffsetX || 0)) + 'px';
          node.style.width = Math.max(1, Math.round(item.width)) + 'px';
          node.style.top = Math.round(item.top) + 'px';      /* 组内坐标；与开始时间无关 */
          node.style.height = blockHeight + 'px';
          /* 迭代 10 批次 3（条7）：展开后先保持原块高度，内容放不下时才向下加长 */
          node.style.setProperty('--block-h', blockHeight + 'px');
          /* 2026-10-20（用户反馈）：时间行按**剩余高度**决定显隐 ——
             旧口径按宽度一刀切（<72px 就藏），但块可能已被撑得够高，时间完全放得下。 */
          if (typeof Layout.dayBlockShowsTime === 'function') {
            var showsTime = true;
            try {
              showsTime = Layout.dayBlockShowsTime(occ, Number(item.width) || 0, blockHeight,
                measureOptsOf(item.width));
            } catch (e) { showsTime = true; }
            if (!showsTime) node.classList.add('is-time-hidden');
          }
          node.style.setProperty('--cat', catAccent(cat.color));
          node.style.setProperty('--cat-bg', hexToRgba(catAccent(cat.color), 0.10));
          node.style.setProperty('--cat-border', hexToRgba(catAccent(cat.color), 0.30));
          if (expanded) {
            /* 迭代 10 批次 3（条7）：展开后与原形状一致 —— 不再横向加宽、不再左移；
               仅抬高层级（pin 成功时由 overlay 覆盖为 fixed） */
            node.style.zIndex = '8';
            toPin.push(node);
          }
          box.appendChild(node);
          /* 2026-11-01：两端拉边改时间（展开卡收起后再出现，避免与 pin 冲突）。
             几何要等内联 left / top / width / height 写完再传，触屏加长判定区按它落位。 */
          if (!expanded && occ.time && Number(item.width) >= RESIZE_HANDLE_MIN_W) {
            attachResizeHandles(node, occ, {
              parent: box,
              left: Math.round(item.left + (item.overflowOffsetX || 0)),
              top: Math.round(item.top),
              width: Math.max(1, Math.round(item.width)),
              height: blockHeight
            });
          }
        });

        els.track.appendChild(box);
        /* 美化迭代 10：左侧竖排类别名列整体下线（类别信息移到块内标题右侧的胶囊） */
      });

      /* 重建后再还原横向位置：此时 DOM 已恢复完整宽度，写回才不会被夹取 */
      if (els.scroll && els.scroll.scrollLeft !== keepScrollLeft) {
        els.scroll.scrollLeft = keepScrollLeft;
      }

      /* US-24 / DM-25：展开卡脱离裁切上下文；pin 返回 false 时保持上面的原位展开。
         2026-10-31：把滚动容器一并交给浮层 —— iOS 会把 fixed 后代连同容器裁掉，
         浮层据此在「真被裁」时把卡片收进可视区（overlay.fitIntoClip）。 */
      if (pinner) {
        toPin.forEach(function (node) { pinner.pin(node, els.track, { clip: els.scroll }); });
      }

      // 首屏自动横向滚动到最早时段附近（BR-35：x 坐标）
      // 只做一次：日期切换 / 首次进入时定位；互动重绘保留用户当前横向位置（见 pendingFirstScroll）
      if (pendingFirstScroll && timed.length) {
        var minAll = Math.min.apply(null, timed.map(function (o) { return D.minutesOf(o.time.start); }));
        if (els.scroll) {
          els.scroll.scrollLeft = Math.max(0, Math.round(axisX(geometry, minAll)) - 60);
          pendingFirstScroll = false;
        }
      }

      /* 兜底：轨道比可视区高时先垫高面板，仍装不下就让时间轴纵向可滚 —— 不许裁掉底部事项 */
      ensureTimelineFits();
      updateNowLine();
      /* 垫面板 / 加滚动条都可能改写容器的矩形：收进容器的展开卡再量一次 */
      if (pinner) pinner.sync();
    }

    /**
     * 刻度行（US-25.1 / ADR-19）：left = CAT_LABEL_WIDTH + getX(minute)，top 固定在 4px；
     * 压缩区（outside）不绘制。无几何时退化为整日 24 个刻度（纯比例）。
     */
    function renderRuler(geometry, rate) {
      els.ruler.innerHTML = '';
      var labelWidth = catLabelWidth();
      var ticks = (geometry && Layout && typeof Layout.axisTicks === 'function')
        ? Layout.axisTicks(geometry, { stepMinutes: 60 })
        : [];
      if (!ticks || !ticks.length) ticks = wholeDayTicks(geometry);
      var axisLen = Number(geometry && geometry.axisLength);
      if (!isFinite(axisLen) || axisLen <= 0) axisLen = 1440 * rate / 60;
      ticks.forEach(function (t) {
        if (t.minute >= 1440) return;
        if (t.outside) return;                 // 压缩区不绘制刻度线
        var x = tickX(geometry, t);
        /* 2026-10-22：标签由 CSS 以 translateX(-50%) 居中到刻度线；
           贴着轴首尾的标签改贴边，避免滚出 / 被滚动容器裁掉。 */
        var cls = 'ruler-tick';
        if (x < RULER_TICK_EDGE_PAD) cls += ' is-edge-start';
        else if (axisLen - x < RULER_TICK_EDGE_PAD) cls += ' is-edge-end';
        els.ruler.appendChild((function () {
          var tick = el('span', {
            class: cls,
            text: (t.minute < 600 ? '0' : '') + Math.floor(t.minute / 60) + ':00'
          });
          tick.setAttribute('data-minute', String(t.minute));
          setPx(tick, 'left', labelWidth + x);
          setPx(tick, 'top', RULER_TICK_TOP);
          return tick;
        })());
      });
    }

    /** 刻度的轴向 x：优先 axisTicks v2 的 pos，其次 y，最后回落几何源。 */
    function tickX(geometry, tick) {
      if (typeof tick.pos === 'number' && isFinite(tick.pos)) return tick.pos;
      if (typeof tick.y === 'number' && isFinite(tick.y)) return tick.y;
      return axisX(geometry, tick.minute);
    }

    /** 无几何（当日没有时段事项）时的整日刻度（1:1 纯比例）。 */
    function wholeDayTicks(geometry) {
      var out = [];
      for (var m = 0; m < 1440; m += 60) {
        out.push({ minute: m, y: axisX(geometry, m), outside: false });
      }
      return out;
    }

    /** 整点竖线（.tl-gridline）：只画整点（2026-10-22 用户裁定删去半小时线）；
     *  data-minute 供探针 / 冒烟核对；压缩区内不画（US-25.1）。 */
    function renderGridlines(geometry) {
      for (var m = 0; m < 1440; m += 60) {
        if (isOutsideAxis(geometry, m)) continue;
        var line = el('div', {
          class: 'tl-gridline',
          'data-minute': String(m),
          'aria-hidden': 'true'
        });
        setPx(line, 'left', axisX(geometry, m));
        els.track.appendChild(line);
      }
    }

    /**
     * 首末空闲竖窄带（US-25.3 / DM-21.3）：inner 坐标系（left = 标签栏 + band.start），
     * 宽 = band.length，上下贯通全部行组高度；文字与 ⌵⌵ 仍由 CSS 提供。
     */
    function idleBandNode(band, labelWidth) {
      var text = D.formatMinutes(band.fromMinute) + '–' +
        (band.toMinute >= 1440 ? '24:00' : D.formatMinutes(band.toMinute)) + ' 无安排（已折叠）';
      var node = el('div', {
        class: 'tl-idle is-' + band.kind,
        title: text,
        'aria-hidden': 'true'
      });
      node.style.left = Math.round(labelWidth + band.start) + 'px';
      node.style.width = Math.max(0, Math.round(band.length)) + 'px';
      node.style.top = '0px';
      node.style.bottom = '0px';
      return node;
    }

    /* ---------------- 渲染：无时事项 ---------------- */

    function renderUntimed() {
      var cats = categoryMap();
      var p = Order.partition(state.occurrences);
      var list = Order.sortUntimed(p.untimed).filter(visible);

      els.untimedList.innerHTML = '';
      els.untimedTitle.textContent = '未排时段';

      var hiddenCount = p.untimed.filter(function (o) { return o.done; }).length;
      var showHiddenNotice = !!(state.hideDone && hiddenCount && list.length === 0);
      els.untimedEmpty.hidden = !showHiddenNotice;
      els.untimedEmpty.textContent = showHiddenNotice ? '已隐藏 ' + hiddenCount + ' 项已完成事项' : '';

      list.forEach(function (occ, idx) {
        var node = buildCard(occ, {
          variant: 'card',
          cats: cats,
          expanded: isExpanded(occ.key),
          index: idx
        });
        /* 迭代 10 批次 5（条9）：未排事项同样是完成台的拖拽源 */
        node.setAttribute('data-occ-key', occ.key);
        /* 迭代 10 条13：列表内拖动排序的锚点（seriesId 才是 store 的排序单位） */
        node.setAttribute('data-series-id', occ.seriesId);
        node.setAttribute('draggable', 'true');
        /* 2026-11-01：触屏长按后拖到时间轴（HTML5 DnD 在触屏不生效） */
        attachTouchDrag(node, occ);
        els.untimedList.appendChild(node);
      });
    }

    /* ---------------- 渲染：记录栏 ---------------- */

    function renderNotes() {
      var doc = currentDoc();
      var note = doc.notes[state.date];
      var text = note ? note.text : '';
      if (els.notesInput.value !== text) els.notesInput.value = text;
      updateNotesStatus();
    }

    /* 500 只是软目标：超出只把计数染成暖橙，不截断输入；计数只显示「n字」（2026-10-30 用户口径） */
    var NOTES_SOFT_LIMIT = 500;

    function updateNotesStatus(saving) {
      var len = els.notesInput.value.length;
      els.notesStatus.textContent = saving ? '保存中…' : '';
      if (els.notesCount) {
        els.notesCount.textContent = len + '字';
        els.notesCount.classList.toggle('is-over', len > NOTES_SOFT_LIMIT);
      }
    }

    function flushNotes() {
      if (notesTimer) { clearTimeout(notesTimer); notesTimer = null; }
      try {
        store.setNote(state.date, els.notesInput.value);
        updateNotesStatus(false);
      } catch (e) {
        banner('danger', '记录保存失败：' + e.message);
      }
    }

    els.notesInput.addEventListener('input', function () {
      updateNotesStatus(true);
      if (notesTimer) clearTimeout(notesTimer);
      notesTimer = setTimeout(flushNotes, 300);
    });
    els.notesInput.addEventListener('blur', flushNotes);
    els.notesInput.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        flushNotes();
        M.toast('记录已保存');
      }
    });

    /* ---------------- 当前时间线 ---------------- */

    /** US-25 / BR-35：竖直线，left = CAT_LABEL_WIDTH + getX(now)（inner 坐标系）。 */
    function updateNowLine() {
      if (!els.nowLine) return;
      var isToday = state.date === D.todayISO();
      els.nowLine.hidden = !isToday;
      if (!isToday) return;
      var now = D.nowMinutes();
      var x = Math.round(catLabelWidth() + axisX(axis, now));
      els.nowLine.style.left = x + 'px';
      els.nowLine.title = '当前时间 ' + D.formatMinutes(now);
      if (els.nowLabel) {
        var text = D.formatMinutes(now);
        if (els.nowLabel.textContent !== text) els.nowLabel.textContent = text;
        els.nowLabel.style.setProperty('--now-shift', nowLabelShift(x) + 'px');
      }
      if (pendingNowScroll && els.scroll) {
        var viewW = Number(els.scroll.clientWidth) || 0;
        if (viewW > 0) {
          /* 指针停在左侧 35% 处，前后时段都留出可读余量 */
          els.scroll.scrollLeft = Math.max(0, Math.round(x - viewW * 0.35));
          pendingNowScroll = false;
        }
      }
    }

    /** 时间胶囊以竖线为中心；靠近轴左/右边界时整体推回轴内（尾巴由 CSS 反向抵消）。
        量不到宽度（隐藏 / 垫片环境）时返回 0，不写内联样式。 */
    function nowLabelShift(centerX) {
      var labelW = (els.nowLabel && els.nowLabel.offsetWidth) || 0;
      var total = (els.inner && els.inner.clientWidth) || 0;
      if (!labelW || !total) return 0;
      var half = labelW / 2 + 2;
      if (centerX - half < 0) return Math.round(half - centerX);
      if (centerX + half > total) return -Math.round(centerX + half - total);
      return 0;
    }

    /* ================= 2026-11-01：拖放排时 / 拉边调整 ================= */

    function dragStep() {
      var s = Number(Layout.SNAP_STEP_DEFAULT);
      return (isFinite(s) && s > 0) ? Math.floor(s) : 5;
    }

    function dragMinDuration() {
      var m = Number(Layout.MIN_DURATION_DEFAULT);
      return (isFinite(m) && m > 0) ? Math.floor(m) : 15;
    }

    /** 指针 clientX → 时间轴内坐标（相对 .timeline-track 左缘，含滚动偏移）。 */
    function trackX(clientX) {
      if (!els.track) return 0;
      return clientX - els.track.getBoundingClientRect().left;
    }

    /** 指针 clientX → 当前轴上的分钟（压缩带按几何反算）。 */
    function minuteAtClientX(clientX) {
      return Layout.axisMinuteAt(axis, trackX(clientX), { pxPerHour: pxPerHour() });
    }

    /** 指针是否落在首 / 尾折叠窄带里（需要临时展开）。 */
    function inCompressedZone(clientX) {
      if (!axis || !els.track) return false;
      var x = trackX(clientX);
      var lead = Number(axis.leadLength) || 0;
      var real = Number(axis.realLength) || 0;
      var trail = Number(axis.trailLength) || 0;
      if (lead > 0 && x < lead) return true;
      if (trail > 0 && x > lead + real) return true;
      return false;
    }

    /** 指针所在折叠带：种类、该带中心时刻、展开前中心在视口里的 x（卷轴展开的轴心）。 */
    function compressedBandInfo(clientX) {
      if (!axis || !els.track || !els.scroll) return null;
      var x = trackX(clientX);
      var lead = Number(axis.leadLength) || 0;
      var real = Number(axis.realLength) || 0;
      var trail = Number(axis.trailLength) || 0;
      var trackLeft = els.track.getBoundingClientRect().left;
      if (lead > 0 && x < lead) {
        return {
          kind: 'lead',
          minute: Number(axis.firstStart) / 2,
          screenX: trackLeft + lead / 2
        };
      }
      if (trail > 0 && x > lead + real) {
        var lastEnd = Number(axis.lastEnd);
        return {
          kind: 'trail',
          minute: lastEnd + (1440 - lastEnd) / 2,
          screenX: trackLeft + lead + real + trail / 2
        };
      }
      return null;
    }

    /** 当前轴上某分钟在视口里的 x（含滚动偏移），用于展开 / 收拢前记录轴心位置。 */
    function screenXForMinute(minute) {
      if (!els.track || minute === null || minute === undefined) return null;
      return els.track.getBoundingClientRect().left + axisX(axis, minute);
    }

    function pointerOverScroll(clientX, clientY, pad) {
      if (!els.scroll) return false;
      var r = els.scroll.getBoundingClientRect();
      var p = Number(pad) || 0;
      return clientX >= r.left - p && clientX <= r.right + p &&
        clientY >= r.top - p && clientY <= r.bottom + p;
    }

    function blockNodeFor(key) {
      if (!els.track) return null;
      var nodes = els.track.querySelectorAll('.tl-block');
      for (var i = 0; i < nodes.length; i += 1) {
        if (nodes[i].getAttribute && nodes[i].getAttribute('data-occ-key') === key) return nodes[i];
      }
      return null;
    }

    /* ---- 跟随指针的时间胶囊（与「现在」胶囊同一套鼠尾草配色） ---- */

    function ensurePill() {
      if (!dragPill) {
        dragPill = el('div', { class: 'tl-drag-pill', 'aria-hidden': 'true' });
      }
      if (document && document.body && dragPill.parentNode !== document.body) {
        document.body.appendChild(dragPill);
      }
      return dragPill;
    }

    function showPill(clientX, clientY, text) {
      var pill = ensurePill();
      if (pill.textContent !== text) pill.textContent = text;
      pill.hidden = false;
      var vw = Number(root.innerWidth) || 0;
      var x = clientX;
      if (vw > 0) x = Math.max(30, Math.min(vw - 30, clientX));
      /* 2026-11-01（用户反馈）：触屏手指会盖住胶囊，抬高到指腹之上；
         细指针保持原来的 12px，贴近落点。 */
      var gap = coarsePointer() ? 46 : 12;
      pill.style.left = Math.round(x) + 'px';
      pill.style.top = Math.max(26, Math.round(clientY - gap)) + 'px';
    }

    function hidePill() {
      if (dragPill) dragPill.hidden = true;
    }

    /* ---- 时间轴上的 1 小时落位幽灵块 ---- */

    function showDropGhost(startMinute, endMinute) {
      if (!els.track) return;
      if (!dragGhost) {
        dragGhost = el('div', { class: 'tl-drop-ghost', 'aria-hidden': 'true' });
      }
      if (dragGhost.parentNode !== els.track) els.track.appendChild(dragGhost);
      var x0 = axisX(axis, startMinute);
      var x1 = axisX(axis, endMinute);
      dragGhost.style.left = Math.round(x0) + 'px';
      dragGhost.style.width = Math.max(2, Math.round(x1 - x0)) + 'px';
      dragGhost.style.top = '0px';
      dragGhost.style.bottom = '0px';
      dragGhost.hidden = false;
    }

    function hideDropGhost() {
      if (!dragGhost) return;
      if (dragGhost.parentNode) dragGhost.parentNode.removeChild(dragGhost);
    }

    /* ---- 横向自动滚动（近左右边缘才启动，速度 1–6px/帧） ---- */

    function rafCall(fn) {
      if (typeof root.requestAnimationFrame === 'function') return root.requestAnimationFrame(fn);
      return setTimeout(fn, 16);
    }

    function rafCancel(id) {
      if (!id) return;
      if (typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(id);
      else clearTimeout(id);
    }

    function startAutoScroll() {
      if (autoScrollRaf) return;
      autoScrollRaf = rafCall(autoScrollTick);
    }

    function stopAutoScroll() {
      if (autoScrollRaf) rafCancel(autoScrollRaf);
      autoScrollRaf = 0;
    }

    function autoScrollTick() {
      autoScrollRaf = 0;
      if (!dragPointer || !els.scroll) return;
      if (Date.now() < axisAnimatingUntil) {
        autoScrollRaf = rafCall(autoScrollTick);
        return;
      }
      var r = els.scroll.getBoundingClientRect();
      var edge = 36;
      /* 上限 4px/帧（60Hz ≈ 240px/s）：贴着边缘时不至于「一冲到底」 */
      var speed = 0;
      if (dragPointer.x < r.left + edge) {
        speed = -Math.max(1, Math.ceil((r.left + edge - dragPointer.x) / edge * 4));
      } else if (dragPointer.x > r.right - edge) {
        speed = Math.max(1, Math.ceil((dragPointer.x - (r.right - edge)) / edge * 4));
      }
      if (speed && els.scroll.scrollWidth > els.scroll.clientWidth + 1) {
        var before = els.scroll.scrollLeft;
        els.scroll.scrollLeft = before + speed;
        if (els.scroll.scrollLeft !== before) {
          if (resizeState) updateResizeAt(dragPointer.x, dragPointer.y);
          else updateDragAt(dragPointer.x, dragPointer.y);
        }
      }
      if (dragPointer) autoScrollRaf = rafCall(autoScrollTick);
    }

    /* ---- 折叠区临时展开 + FLIP 平滑位移 ---- */

    function axisSnapshot() {
      var snap = { nodes: {}, geometry: axis, trackLeft: 0 };
      if (!els.track) return snap;
      snap.trackLeft = els.track.getBoundingClientRect().left;
      /* 一律记**视口坐标**（track 的 rect 已含滚动位移）：展开时锚定会同步改滚动位置，
         只有把滚动位移一起算进 FLIP 起点，未折叠区域才不会瞬移。 */
      var map = snap.nodes;
      var i;
      var nodes = els.track.querySelectorAll('.tl-block');
      for (i = 0; i < nodes.length; i += 1) {
        var key = nodes[i].getAttribute('data-occ-key');
        if (key) map['b:' + key] = nodes[i].getBoundingClientRect().left;
      }
      nodes = els.track.querySelectorAll('.tl-gridline');
      for (i = 0; i < nodes.length; i += 1) {
        var minute = nodes[i].getAttribute('data-minute');
        if (minute !== null) map['g:' + minute] = nodes[i].getBoundingClientRect().left;
      }
      if (els.ruler) {
        nodes = els.ruler.querySelectorAll('.ruler-tick');
        for (i = 0; i < nodes.length; i += 1) {
          var tMinute = nodes[i].getAttribute('data-minute');
          if (tMinute !== null) map['t:' + tMinute] = nodes[i].getBoundingClientRect().left;
        }
      }
      var nowLine = els.inner ? els.inner.querySelector('.timeline-now') : null;
      if (nowLine && !nowLine.hidden) snap.nowLeft = nowLine.getBoundingClientRect().left;
      return snap;
    }

    function axisMotionAllowed() {
      if (typeof root.matchMedia !== 'function') return true;
      try {
        return !root.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (e) { return true; }
    }

    function canAnimateTranslate() {
      try {
        return !!(root.CSS && root.CSS.supports && root.CSS.supports('translate', '1px'));
      } catch (e) { return false; }
    }

    /** FLIP 位移帧：优先用独立 translate（与 CSS transform 叠加），老内核退回 transform。 */
    function slideFrames(dx, fresh, useTranslate) {
      var opacity = fresh ? 0 : 1;
      if (useTranslate) {
        return [
          { translate: dx + 'px 0px', opacity: opacity },
          { translate: '0px 0px', opacity: 1 }
        ];
      }
      return [
        { transform: 'translateX(' + dx + 'px)', opacity: opacity },
        { transform: 'translateX(0)', opacity: 1 }
      ];
    }

    function animateAxisFrom(snapshot) {
      if (!snapshot || !els.track || !axisMotionAllowed()) return;
      var old = snapshot.nodes || {};
      var oldGeometry = snapshot.geometry || null;
      var oldTrackLeft = Number(snapshot.trackLeft) || 0;
      var useTranslate = canAnimateTranslate();
      /** 旧节点取实测视口位置；折叠带里新出现的刻度按旧几何反推「本来会在哪」 */
      function oldLeftOf(key, minute) {
        if (typeof old[key] === 'number') return old[key];
        if (minute === null || minute === undefined || !oldGeometry) return null;
        return oldTrackLeft + axisX(oldGeometry, minute);
      }
      function move(node, key, minute) {
        if (typeof node.animate !== 'function') return;
        var oldLeft = oldLeftOf(key, minute);
        if (typeof oldLeft !== 'number') {
          try {
            node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: AXIS_FADE_MS, easing: 'ease-out' });
          } catch (e) { /* 无动画能力 */ }
          return;
        }
        var fresh = typeof old[key] !== 'number';
        var dx = oldLeft - node.getBoundingClientRect().left;
        if (!fresh && Math.abs(dx) < 0.5) return;
        try {
          node.animate(slideFrames(dx, fresh, useTranslate),
            { duration: AXIS_FLIP_MS, easing: AXIS_FLIP_EASING });
        } catch (e) { /* 无动画能力 */ }
      }
      var i;
      var nodes = els.track.querySelectorAll('.tl-block');
      for (i = 0; i < nodes.length; i += 1) {
        var key = nodes[i].getAttribute('data-occ-key');
        if (key) move(nodes[i], 'b:' + key, null);
      }
      nodes = els.track.querySelectorAll('.tl-gridline');
      for (i = 0; i < nodes.length; i += 1) {
        var m = nodes[i].getAttribute('data-minute');
        if (m !== null) move(nodes[i], 'g:' + m, Number(m));
      }
      if (els.ruler) {
        nodes = els.ruler.querySelectorAll('.ruler-tick');
        for (i = 0; i < nodes.length; i += 1) {
          var tm = nodes[i].getAttribute('data-minute');
          if (tm !== null) move(nodes[i], 't:' + tm, Number(tm));
        }
      }
      /* 当前时间线不随 renderTimeline 重建，也要吃掉滚动锚定的位移 */
      var nowLine = els.inner ? els.inner.querySelector('.timeline-now') : null;
      if (nowLine && !nowLine.hidden && typeof snapshot.nowLeft === 'number' &&
        typeof nowLine.animate === 'function') {
        var nowDx = snapshot.nowLeft - nowLine.getBoundingClientRect().left;
        if (Math.abs(nowDx) >= 0.5) {
          try {
            nowLine.animate(slideFrames(nowDx, false, useTranslate),
              { duration: AXIS_FLIP_MS, easing: AXIS_FLIP_EASING });
          } catch (e) { /* 无动画能力 */ }
        }
      }
      /* FLIP 期间暂停自动滚动：滚动位移已经在 dx 里补过一次，
         继续滚会让动画终点和真实布局错开 */
      axisAnimatingUntil = Date.now() + AXIS_FLIP_MS + 40;
    }

    /** 把某个分钟锚定在同一个视口 x 上（展开 / 提交后轴宽变化，但视线不跳）。 */
    function anchorScrollTo(minute, clientX) {
      if (!els.scroll || !els.track || minute === null || minute === undefined ||
        clientX === null || clientX === undefined) return;
      var sr = els.scroll.getBoundingClientRect();
      var tr = els.track.getBoundingClientRect();
      var contentStart = tr.left - sr.left + els.scroll.scrollLeft;
      var target = contentStart + axisX(axis, minute) - (clientX - sr.left);
      els.scroll.scrollLeft = Math.max(0, Math.round(target));
    }

    function rerenderAnchored(anchorMinute, clientX, render) {
      var snap = axisSnapshot();
      render();
      anchorScrollTo(anchorMinute, clientX);
      animateAxisFrom(snap);
    }

    /**
     * 临时展开 / 收拢整条轴。
     * mode='band'（拖放默认）：以被折叠那半段的中心为轴，像卷轴一样向两边展开；
     * mode='pointer'（拉边）：让指针下的时刻保持不动，手柄不能离开指针。
     */
    function setDragIdleExpanded(on, clientX, mode) {
      if (idleDragExpanded === on) return;
      var bandMode = mode !== 'pointer';
      var anchorMinute = null;
      var anchorX = null;
      if (on) {
        if (bandMode) {
          var info = compressedBandInfo(clientX);
          if (!info) return;
          idleBandAnchor = { minute: info.minute };
          anchorMinute = info.minute;
          anchorX = info.screenX;
        } else if (clientX !== null && clientX !== undefined) {
          anchorMinute = minuteAtClientX(clientX);
          anchorX = clientX;
        }
      } else if (bandMode && idleBandAnchor) {
        anchorMinute = idleBandAnchor.minute;
        anchorX = screenXForMinute(anchorMinute);
      } else if (clientX !== null && clientX !== undefined) {
        anchorMinute = minuteAtClientX(clientX);
        anchorX = clientX;
      }
      var snap = axisSnapshot();
      idleDragExpanded = on;
      renderTimeline();
      anchorScrollTo(anchorMinute, anchorX);
      animateAxisFrom(snap);
      if (!on) idleBandAnchor = null;
      if (resizeState) {
        var next = blockNodeFor(resizeState.occ.key);
        if (next) {
          resizeState.block = next;
          if (next.classList) next.classList.add('is-resizing');
          if (next.setAttribute) next.setAttribute('draggable', 'false');
          /* 重排后新节点带的是**已保存**的起止时间；把拖动中的时间立刻画回去 */
          applyResizeVisual(next, resizeState.startMinute, resizeState.endMinute);
        }
      }
    }

    /* ---- 未排事项拖到时间轴 ---- */

    function updateDragAt(clientX, clientY) {
      if (!els.scroll) return false;
      if (!pointerOverScroll(clientX, clientY, 12)) {
        hideDropGhost();
        hidePill();
        return false;
      }
      if (inCompressedZone(clientX)) setDragIdleExpanded(true, clientX, 'band');
      var minute = minuteAtClientX(clientX);
      var t = Layout.scheduleTime(minute, 60, { step: dragStep() });
      showDropGhost(t.startMinute, t.endMinute);
      showPill(clientX, clientY, D.formatMinutes(Layout.snapMinute(minute, dragStep())));
      return true;
    }

    function clearDropPreview() {
      hideDropGhost();
      hidePill();
      stopAutoScroll();
      dragPointer = null;
    }

    function scheduleOccurrence(key, minute, clientX) {
      var occ = null;
      (state.occurrences || []).forEach(function (o) { if (o.key === key) occ = o; });
      if (!occ) return;
      var doc = currentDoc();
      var item = doc.items.filter(function (i) { return i.id === occ.seriesId; })[0];
      if (!item) return;
      var t = Layout.scheduleTime(minute, 60, { step: dragStep() });
      var time = { start: t.start, end: t.end };
      try {
        if (item.kind === 'series') {
          store.addSeriesException(item.id, occ.date, { time: time });
        } else {
          store.updateItem(item.id, { time: time });
        }
      } catch (e) {
        banner('danger', '排定失败：' + e.message);
        return;
      }
      var anchor = Layout.snapMinute(minute, dragStep());
      rerenderAnchored(anchor, clientX, afterWrite);
      M.toast('已排到 ' + t.start + '–' + t.end);
    }

    function suppressNextClick() {
      dragSuppressUntil = Date.now() + 700;
      if (!document || typeof document.addEventListener !== 'function') return;
      function block(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        if (e && e.preventDefault) e.preventDefault();
        document.removeEventListener('click', block, true);
      }
      document.addEventListener('click', block, true);
      setTimeout(function () { document.removeEventListener('click', block, true); }, 600);
    }

    /* ---- 事项块两端拉边调整 ---- */

    /* 触屏（粗指针）：手柄只在拉动时点亮，判定区向上下各探出 RESIZE_PAD。 */
    var RESIZE_PAD = 8;
    var RESIZE_PAD_W = 16;

    function coarsePointer() {
      try {
        if (root && typeof root.matchMedia === 'function') {
          return !!root.matchMedia('(pointer: coarse)').matches;
        }
      } catch (e) { /* 老引擎：当作细指针 */ }
      return false;
    }

    function attachResizeHandles(node, occ, geom) {
      if (!node || !occ || !occ.time) return;
      var left = el('span', { class: 'tl-resize tl-resize-start', 'aria-hidden': 'true' });
      var right = el('span', { class: 'tl-resize tl-resize-end', 'aria-hidden': 'true' });
      left.addEventListener('pointerdown', function (e) { onResizeStart(e, occ, 'start', left, node); });
      right.addEventListener('pointerdown', function (e) { onResizeStart(e, occ, 'end', right, node); });
      /* 手柄在 draggable 块内：再挡一层 dragstart，确保拉边不会被当成拖去完成台 */
      left.addEventListener('dragstart', function (e) { if (e.preventDefault) e.preventDefault(); });
      right.addEventListener('dragstart', function (e) { if (e.preventDefault) e.preventDefault(); });
      node.appendChild(left);
      node.appendChild(right);
      if (!geom || !geom.parent || !coarsePointer()) return;
      /* 块的 overflow:hidden 把内层手柄框在块高里；触屏另发一层兄弟节点向上下探出，
         手指上下差几像素也按得到（只占左右各 16px 的竖条，不吃块中间的点击）。 */
      var padH = Math.max(1, Math.round(geom.height + RESIZE_PAD * 2));
      var padTop = Math.max(0, Math.round(geom.top - RESIZE_PAD)) + 'px';
      var padL = el('span', { class: 'tl-resize-pad tl-resize-pad-start', 'aria-hidden': 'true' });
      var padR = el('span', { class: 'tl-resize-pad tl-resize-pad-end', 'aria-hidden': 'true' });
      var startLeft = Math.round(geom.left);
      var endLeft = Math.round(geom.left + geom.width - RESIZE_PAD_W);
      padL.style.left = startLeft + 'px';
      padR.style.left = endLeft + 'px';
      padL.style.top = padTop;
      padR.style.top = padTop;
      padL.style.height = padH + 'px';
      padR.style.height = padH + 'px';
      padL.addEventListener('pointerdown', function (e) { onResizeStart(e, occ, 'start', padL, node); });
      padR.addEventListener('pointerdown', function (e) { onResizeStart(e, occ, 'end', padR, node); });
      geom.parent.appendChild(padL);
      geom.parent.appendChild(padR);
    }

    function onResizeStart(e, occ, edge, handle, block) {
      if (e.button !== undefined && e.button !== 0) return;
      if (!occ.time || !block || resizeState) return;
      var startMin = D.minutesOf(occ.time.start);
      var endMin = D.minutesOf(occ.time.end);
      if (startMin === null || endMin === null) return;
      e.preventDefault();
      e.stopPropagation();
      resizeState = {
        occ: occ, edge: edge, block: block, handle: handle,
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
      dragPointer = { x: e.clientX, y: e.clientY, mode: 'resize' };
      if (block.classList) block.classList.add('is-resizing');
      if (block.setAttribute) block.setAttribute('draggable', 'false');
      if (document.documentElement && document.documentElement.classList) {
        document.documentElement.classList.add('is-timeline-resizing');
      }
      dragSuppressUntil = Date.now() + 800;
      showPill(e.clientX, e.clientY,
        D.formatMinutes(edge === 'start' ? startMin : endMin));
      startAutoScroll();
      document.addEventListener('pointermove', onResizeMove, true);
      document.addEventListener('pointerup', onResizeEnd, true);
      document.addEventListener('pointercancel', onResizeCancel, true);
      try { if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }

    function onResizeMove(e) {
      if (!resizeState) return;
      if (resizeState.pointerId !== undefined && e.pointerId !== undefined &&
        e.pointerId !== resizeState.pointerId) return;
      e.preventDefault();
      dragPointer = { x: e.clientX, y: e.clientY, mode: 'resize' };
      updateResizeAt(e.clientX, e.clientY);
    }

    function applyResizeVisual(block, s, e) {
      if (!block || !block.style) return;
      var x0 = axisX(axis, s);
      var x1 = axisX(axis, e);
      block.style.left = Math.round(x0) + 'px';
      block.style.width = Math.max(1, Math.round(x1 - x0)) + 'px';
      var te = block.querySelector ? block.querySelector('.tl-time') : null;
      if (te) te.textContent = D.formatMinutes(s) + '–' + D.formatMinutes(e);
    }

    function updateResizeAt(clientX, clientY) {
      if (!resizeState || !els.scroll) return;
      resizeState.lastX = clientX;
      resizeState.lastY = clientY;
      var sr = els.scroll.getBoundingClientRect();
      var cx = Math.max(sr.left + 1, Math.min(sr.right - 1, clientX));
      if (inCompressedZone(cx)) setDragIdleExpanded(true, cx, 'pointer');
      var minute = minuteAtClientX(cx);
      var t = Layout.resizeTime(resizeState.orig, resizeState.edge, minute, {
        step: dragStep(), minDuration: dragMinDuration()
      });
      if (!t) return;
      showPill(clientX, clientY, D.formatMinutes(Layout.snapMinute(minute, dragStep())));
      if (t.startMinute === resizeState.startMinute && t.endMinute === resizeState.endMinute) return;
      resizeState.current = t;
      resizeState.startMinute = t.startMinute;
      resizeState.endMinute = t.endMinute;
      resizeState.moved = (t.startMinute !== resizeState.origStart || t.endMinute !== resizeState.origEnd);
      applyResizeVisual(resizeState.block, t.startMinute, t.endMinute);
    }

    function stopResize(commit) {
      var st = resizeState;
      if (!st) return;
      resizeState = null;
      document.removeEventListener('pointermove', onResizeMove, true);
      document.removeEventListener('pointerup', onResizeEnd, true);
      document.removeEventListener('pointercancel', onResizeCancel, true);
      stopAutoScroll();
      hidePill();
      dragPointer = null;
      if (document.documentElement && document.documentElement.classList) {
        document.documentElement.classList.remove('is-timeline-resizing');
      }
      if (st.block && st.block.classList) st.block.classList.remove('is-resizing');
      /* 手柄上的按下 / 松开不应被块的 click 当成「打开编辑」 */
      suppressNextClick();
      if (!commit || !st.moved) {
        if (st.block && st.block.setAttribute && !commit) st.block.setAttribute('draggable', 'true');
        if (idleDragExpanded) {
          idleDragExpanded = false;
          rerenderAnchored(st.edge === 'start' ? st.startMinute : st.endMinute, st.lastX, renderTimeline);
        }
        return;
      }
      var doc = currentDoc();
      var item = doc.items.filter(function (i) { return i.id === st.occ.seriesId; })[0];
      if (!item) {
        if (idleDragExpanded) {
          idleDragExpanded = false;
          rerenderAnchored(st.edge === 'start' ? st.startMinute : st.endMinute, st.lastX, renderTimeline);
        }
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
        banner('danger', '调整时间失败：' + e.message);
        if (idleDragExpanded) {
          idleDragExpanded = false;
          rerenderAnchored(st.edge === 'start' ? st.startMinute : st.endMinute, st.lastX, renderTimeline);
        }
        return;
      }
      idleDragExpanded = false;
      rerenderAnchored(st.edge === 'start' ? st.startMinute : st.endMinute, st.lastX, afterWrite);
      M.toast('时间已改为 ' + time.start + '–' + time.end);
    }

    function onResizeEnd(e) {
      if (!resizeState) return;
      if (resizeState.pointerId !== undefined && e.pointerId !== undefined &&
        e.pointerId !== resizeState.pointerId) return;
      stopResize(true);
    }

    function onResizeCancel(e) {
      if (!resizeState) return;
      if (resizeState.pointerId !== undefined && e && e.pointerId !== undefined &&
        e.pointerId !== resizeState.pointerId) return;
      stopResize(false);
    }

    /* ---- 触屏：长按未排卡片后拖动（HTML5 拖放在触屏不可用） ---- */

    function attachTouchDrag(node, occ) {
      if (!node || !occ) return;
      node.addEventListener('touchstart', function (e) {
        if (resizeState || touchDrag) return;
        if (!e.touches || e.touches.length !== 1) return;
        var t = e.touches[0];
        var td = {
          occ: occ, node: node,
          startX: t.clientX, startY: t.clientY,
          x: t.clientX, y: t.clientY,
          active: false, cancelled: false, timer: 0
        };
        touchDrag = td;
        td.timer = setTimeout(function () {
          if (!touchDrag || touchDrag !== td || td.cancelled) return;
          td.active = true;
          if (!touchGhost) touchGhost = el('div', { class: 'untimed-drag-ghost', 'aria-hidden': 'true' });
          touchGhost.textContent = String(occ.title || '未命名事项');
          if (document.body && touchGhost.parentNode !== document.body) document.body.appendChild(touchGhost);
          positionTouchGhost(td.x, td.y);
          if (document.documentElement && document.documentElement.classList) {
            document.documentElement.classList.add('is-touch-dragging');
          }
          dragSuppressUntil = Date.now() + 900;
        }, 280);
      }, { passive: true });

      node.addEventListener('touchmove', function (e) {
        if (!touchDrag || touchDrag.node !== node) return;
        var t = e.touches && e.touches[0];
        if (!t) return;
        if (!touchDrag.active) {
          if (Math.abs(t.clientX - touchDrag.startX) > 8 || Math.abs(t.clientY - touchDrag.startY) > 8) {
            touchDrag.cancelled = true;
            clearTimeout(touchDrag.timer);
            touchDrag = null;
          }
          return;
        }
        if (e.preventDefault) e.preventDefault();
        touchDrag.x = t.clientX;
        touchDrag.y = t.clientY;
        positionTouchGhost(t.clientX, t.clientY);
        dragPointer = { x: t.clientX, y: t.clientY, mode: 'drag' };
        if (updateDragAt(t.clientX, t.clientY)) startAutoScroll();
        else stopAutoScroll();
      }, { passive: false });

      function finishTouch(commit) {
        if (!touchDrag || touchDrag.node !== node) return;
        var td = touchDrag;
        touchDrag = null;
        clearTimeout(td.timer);
        if (touchGhost && touchGhost.parentNode) touchGhost.parentNode.removeChild(touchGhost);
        if (document.documentElement && document.documentElement.classList) {
          document.documentElement.classList.remove('is-touch-dragging');
        }
        if (!td.active) return;
        var x = td.x;
        var y = td.y;
        var minute = minuteAtClientX(x);
        var onTimeline = commit && pointerOverScroll(x, y, 24);
        clearDropPreview();
        if (onTimeline) {
          idleDragExpanded = false;
          scheduleOccurrence(td.occ.key, minute, x);
        } else if (idleDragExpanded) {
          setDragIdleExpanded(false, null, 'band');
        }
        suppressNextClick();
      }

      node.addEventListener('touchend', function () { finishTouch(true); });
      node.addEventListener('touchcancel', function () { finishTouch(false); });
    }

    function positionTouchGhost(x, y) {
      if (!touchGhost) return;
      var vw = Number(root.innerWidth) || 0;
      var cx = vw > 0 ? Math.max(70, Math.min(vw - 70, x)) : x;
      touchGhost.style.left = Math.round(cx) + 'px';
      touchGhost.style.top = Math.round(y - 16) + 'px';
      touchGhost.hidden = false;
    }

    /* ---------------- 折叠卡接线 ---------------- */

    function buildCard(occ, ctx) {
      var IC = root.DayPlan.itemcard;
      if (!IC || !IC.createItemCard) {
        return fallbackCard(occ, ctx);
      }
      var full = {
        variant: ctx.variant,
        cats: ctx.cats,
        expanded: !!ctx.expanded,
        width: ctx.width,
        origWidth: ctx.origWidth,
        origHeight: ctx.origHeight,
        pxPerHour: ctx.pxPerHour,
        index: (typeof ctx.index === 'number') ? ctx.index : undefined,
        onToggleExpand: function (o, next) {
          /* 拖拽刚结束时浏览器可能补发 click：忽略这一次，避免误展开 */
          if (dragSuppressUntil && Date.now() < dragSuppressUntil) return;
          /* 收起/展开都重排 DOM：先释放所有已固定节点，渲染后再按需重新 pin（US-24.3） */
          if (pinner) pinner.releaseAll();
          setExpanded(o.key, next);
          renderTimeline();
          renderUntimed();
        },
        onToggleDone: toggleDone,
        /* 迭代 4（US-27 / BR-40）：旧的「重要」回调与新的「紧急」回调指向同一处理 */
        onToggleStar: toggleUrgent,
        onToggleUrgent: toggleUrgent,
        onEdit: function (o) { openEdit(o); },
        onRemove: function (o) { removeOccurrence(o); },
        onRestoreDefault: function (o) { restoreDefault(o); },
        /* 迭代 7（F-45 第 6 条 / R-23）：只设紧急未做其他改动 → 不渲染「复原」 */
        hasNonUrgentOverride: function (o) {
          return (typeof store.hasNonUrgentOverride === 'function') ? store.hasNonUrgentOverride(o) : false;
        },
        onMoveUp: function (o) { moveOrder(o, -1); },
        onMoveDown: function (o) { moveOrder(o, 1); },
        /* 迭代 8（F-53）+ 2026-10-20 两级判定（用像素宽）：
           tooNarrow（连「…」+首字都放不下）→ 折叠态只留色块；
           omit（放不下标题，但放得下「…」+首字）→ 省略态（省略号 + 类别首字）。 */
        tooNarrow: function (width) {
          var L = root.DayPlan.layout;
          if (!L || typeof L.isDayBlockTooSmall !== 'function') return false;
          return L.isDayBlockTooSmall(width);
        },
        omit: function (width) {
          var L = root.DayPlan.layout;
          if (!L || typeof L.isDayBlockTooNarrow !== 'function') return false;
          return L.isDayBlockTooNarrow(width);
        },
        /* 悬停预览贴右边界时左移让位，需要滚动容器作为参照 */
        peekContainer: function () { return els.scroll; }
      };
      return IC.createItemCard(occ, full);
    }

    /** itemcard 未加载时的最小降级渲染（保证界面不空白）。 */
    function fallbackCard(occ, ctx) {
      var cat = (ctx.cats && ctx.cats[occ.categoryId]) || { name: '未分类', color: '#94a3b8' };
      var node = el(ctx.variant === 'card' ? 'li' : 'div', {
        class: ctx.variant === 'card' ? 'untimed-item' : 'tl-block',
        role: 'button', tabindex: '0',
        style: '--cat:' + catAccent(cat.color)
      });
      node.appendChild(el('span', { class: ctx.variant === 'card' ? 'ui-title' : 'tl-title', text: occ.title }));
      node.addEventListener('click', function () { openEdit(occ); });
      return node;
    }

    /* ---------------- 写操作 ---------------- */

    function afterWrite(meta) {
      compute();
      renderAll();
      if (opts.onDataChanged) opts.onDataChanged(meta || {});
    }

    function toggleDone(occ) {
      var doc = currentDoc();
      var item = doc.items.filter(function (i) { return i.id === occ.seriesId; })[0];
      if (!item) return;
      if (item.kind === 'single') {
        var before = !!item.done;
        store.toggleDone(item.id, null, 'only');
        M.toast(before ? '已标记为未完成' : '已标记完成', {
          actionLabel: '撤销',
          onAction: function () { store.toggleDone(item.id, null, 'only'); afterWrite(); }
        });
        afterWrite();
        return;
      }
      askScope('标记完成状态', occ, function (scope) {
        store.toggleDone(item.id, occ.date, scope);
        afterWrite();
        M.toast(scope === 'all' ? '该序列的完成状态已更新' : '仅此次的完成状态已更新');
      });
    }

    /* ---------------- 紧急（US-27 / DM-18 / BR-38 / BR-39） ---------------- */

    /** 内置紧急类别 id（schema 未提供常量时的兜底）。 */
    function urgentCategoryId() {
      var S = root.DayPlan.schema;
      if (S && typeof S.URGENT_CATEGORY_ID === 'string' && S.URGENT_CATEGORY_ID) return S.URGENT_CATEGORY_ID;
      return URGENT_CATEGORY_ID;
    }

    function isUrgentCat(id) { return String(id || '') === urgentCategoryId(); }

    /** 紧急类别的当前显示名（设置里改名后，toast / 范围弹窗跟随）。 */
    function urgentName() {
      var cat = categoryMap()[urgentCategoryId()];
      return (cat && cat.name) || '紧急';
    }

    /** 还原时的兜底类别：类别次序里第一个非紧急类别（BR-38）。 */
    function firstNonUrgentCategoryId() {
      var ids = categoryOrder();
      for (var i = 0; i < ids.length; i += 1) {
        if (!isUrgentCat(ids[i])) return ids[i];
      }
      return ids.length ? ids[0] : '';
    }

    /**
     * 类别切换的 meta 归一（BR-38）：
     *  - 转入紧急：meta.previousCategoryId = 原类别（重复保存时覆盖）；
     *  - 转出紧急：删除 meta.previousCategoryId（还原目标由调用方给出）。
     */
    function metaForCategoryChange(item, nextCategoryId) {
      var meta = {};
      Object.keys((item && item.meta) || {}).forEach(function (k) { meta[k] = item.meta[k]; });
      var next = nextCategoryId || (item && item.categoryId);
      if (isUrgentCat(next) && !isUrgentCat(item && item.categoryId)) {
        meta.previousCategoryId = item.categoryId;
      } else if (!isUrgentCat(next)) {
        delete meta.previousCategoryId;
      }
      return meta;
    }

    /** 转入 / 取消紧急的字段补丁。 */
    function urgentPatch(item) {
      if (!isUrgentCat(item.categoryId)) {
        return {
          categoryId: urgentCategoryId(),
          meta: metaForCategoryChange(item, urgentCategoryId())
        };
      }
      var prev = (item.meta && item.meta.previousCategoryId) || firstNonUrgentCategoryId();
      return {
        categoryId: prev || item.categoryId,
        meta: metaForCategoryChange(item, prev || item.categoryId)
      };
    }

    /**
     * 点「紧急 / 取消紧急」（AC-27.3）：
     *   single → 直接改；series → 按范围询问（仅此次 / 此次及以后）。
     * 与 toggleDone 的范围语义一致（BR-41）。
     * 优先走 store.toggleUrgent（T49：例外继承 / 序列拆分 / previousCategoryId 由 store 统一保证）；
     * store 未提供该接口时用下面的 updateItem/例外/拆分兜底。
     */
    function toggleUrgent(occ) {
      var doc = currentDoc();
      var item = doc.items.filter(function (i) { return i.id === occ.seriesId; })[0];
      if (!item) return;
      var willUrgent = !isUrgentCat(item.categoryId);
      var uName = urgentName();
      var msg = willUrgent ? '已标为' + uName : '已取消' + uName;

      if (typeof store.toggleUrgent === 'function') {
        if (item.kind === 'single') {
          try {
            store.toggleUrgent(item.id, null, 'only');
          } catch (e) {
            M.toast('切换' + uName + '失败：' + (e.message || e));
            return;
          }
          afterWrite();
          M.toast(msg, {
            actionLabel: '撤销',
            onAction: function () {
              try { store.toggleUrgent(item.id, null, 'only'); } catch (e2) { /* 忽略 */ }
              afterWrite();
            }
          });
          return;
        }
        askScope(willUrgent ? '标为' + uName : '取消' + uName, occ, function (scope) {
          try {
            store.toggleUrgent(item.id, occ.date, scope);
          } catch (e) {
            M.toast('切换' + uName + '失败：' + (e.message || e));
            return;
          }
          afterWrite();
          M.toast(scope === 'all'
            ? (willUrgent ? '该序列已标为' + uName : '该序列已取消' + uName)
            : (willUrgent ? '仅此次已标为' + uName : '仅此次已取消' + uName));
        });
        return;
      }

      var patch = urgentPatch(item);
      if (item.kind === 'single') {
        var back = { categoryId: item.categoryId, meta: item.meta };
        try {
          store.updateItem(item.id, { categoryId: patch.categoryId, meta: patch.meta });
        } catch (e) {
          M.toast('切换' + uName + '失败：' + (e.message || e));
          return;
        }
        afterWrite();
        M.toast(msg, {
          actionLabel: '撤销',
          onAction: function () {
            try { store.updateItem(item.id, back); } catch (e2) { /* 忽略 */ }
            afterWrite();
          }
        });
        return;
      }

      askScope(willUrgent ? '标为' + uName : '取消' + uName, occ, function (scope) {
        try {
          if (scope === 'only') {
            store.addSeriesException(item.id, occ.date, { categoryId: patch.categoryId, meta: patch.meta });
          } else {
            store.splitSeriesAt(item.id, occ.date, 'edit', {
              categoryId: patch.categoryId,
              meta: patch.meta
            });
          }
        } catch (e) {
          M.toast('切换' + uName + '失败：' + (e.message || e));
          return;
        }
        afterWrite();
        M.toast(scope === 'all'
          ? (willUrgent ? '该序列已标为' + uName : '该序列已取消' + uName)
          : (willUrgent ? '仅此次已标为' + uName : '仅此次已取消' + uName));
      });
    }

    function restoreDefault(occ) {
      try {
        store.removeSeriesException(occ.seriesId, occ.date);
        afterWrite();
        M.toast('已恢复为规则默认');
      } catch (e) {
        M.toast('恢复失败：' + e.message);
      }
    }

    function moveOrder(occ, delta) {
      try {
        store.moveItemOrder(state.date, occ.seriesId, delta);
        afterWrite();
      } catch (e) {
        M.toast('调整次序失败：' + e.message);
      }
    }

    /**
     * 迭代 10 条13：把无时事项拖到同列表的另一处（取代 ▲▼ 按钮）。
     * 以**全部**无时条目（含已完成/已被完成台占用的隐藏项）的当前次序为基准移动 ——
     * 只按可见项重排会把隐藏项挤到末尾，刷新后就乱了。
     * @param {string} fromSeriesId
     * @param {number} slot 在可见项（已剔除被拖项）中的插入位：0 = 最前，items.length = 最后
     * @param {string[]} visibleIds 可见项（已剔除被拖项）的 seriesId，按 DOM 顺序
     */
    function moveUntimedToSlot(fromSeriesId, slot, visibleIds) {
      if (!fromSeriesId || !Array.isArray(visibleIds)) return;
      var all = Order.sortUntimed(Order.partition(state.occurrences).untimed);
      var ids = [];
      all.forEach(function (o) {
        if (ids.indexOf(o.seriesId) < 0) ids.push(o.seriesId);
      });
      var from = ids.indexOf(fromSeriesId);
      if (from < 0) return;
      ids.splice(from, 1);
      var visible = visibleIds.filter(function (id) { return id && id !== fromSeriesId; });
      var insertAt;
      if (!visible.length) insertAt = 0;
      else if (slot >= visible.length) insertAt = ids.indexOf(visible[visible.length - 1]) + 1;
      else insertAt = ids.indexOf(visible[slot]);
      if (!(insertAt >= 0)) insertAt = ids.length;
      ids.splice(insertAt, 0, fromSeriesId);
      try {
        store.reorderUntimed(state.date, ids);
        afterWrite();
      } catch (e) {
        M.toast('调整次序失败：' + e.message);
      }
    }

    function removeOccurrence(occ) {
      var doc = currentDoc();
      var item = doc.items.filter(function (i) { return i.id === occ.seriesId; })[0];
      if (!item) return;
      if (item.kind === 'single') {
        M.confirm({
          title: '删除事项',
          message: '确定删除「' + occ.title + '」？',
          confirmLabel: '删除', danger: true
        }).then(function (ok) {
          if (!ok) return;
          var snapshot = JSON.stringify(doc.items.filter(function (i) { return i.id === item.id; })[0]);
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
        } else {
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
        }
      });
    }

    /** 弹范围选择（仅此次 / 此次及以后） */
    function askScope(title, occ, onPick) {
      var onlyRadio = el('input', { type: 'radio', name: 'scope-pick', value: 'only', checked: true });
      var allRadio = el('input', { type: 'radio', name: 'scope-pick', value: 'all' });
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
        onSubmit: function () {
          onPick(allRadio.checked ? 'all' : 'only');
        }
      });
    }

    /* ---------------- 编辑 / 新建 ---------------- */

    function openEdit(occ) {
      var doc = currentDoc();
      var item = null;
      if (occ) item = doc.items.filter(function (i) { return i.id === occ.seriesId; })[0] || null;
      var isSeriesOccurrence = !!(item && item.kind === 'series' && occ);

      var form = Form.createItemForm({
        mode: occ ? (isSeriesOccurrence ? 'occurrence' : 'edit') : 'new',
        date: state.date,
        item: item,
        occurrence: isSeriesOccurrence ? occ : null,
        categories: doc.categories,
        defaultCategoryId: doc.settings.defaultCategoryId || (doc.categories[0] && doc.categories[0].id),
        allowScope: isSeriesOccurrence
      });

      var handle = M.open({
        title: occ ? '编辑事项' : '新建事项',
        body: form.element,
        submitLabel: occ ? '保存' : '创建',
        wide: true,
        onSubmit: function (ctx) {
          var check = form.validate();
          if (!check.ok) { ctx.setError(check.message); return false; }
          var v = check.values;
          try {
            if (!occ) {
              createItem(v);
            } else if (isSeriesOccurrence) {
              applyOccurrenceEdit(item, occ, v, form.scope());
            } else {
              updateSingle(item, v);
            }
          } catch (e) {
            ctx.setError(e.message || String(e));
            return false;
          }
          afterWrite();
        }
      });
      form.focus();
    }

    function createItem(v) {
      /* 迭代 4：categoryId / meta 原样透传（DM-18 / BR-38）；starred 不再由 UI 写入（DM-18.4） */
      var meta = (v.meta && typeof v.meta === 'object') ? v.meta : undefined;
      if (v.kind === 'single') {
        var single = {
          kind: 'single',
          title: v.title,
          categoryId: v.categoryId,
          date: v.date,
          time: v.time,
          note: v.note,
          done: v.done
        };
        if (meta) single.meta = meta;
        store.addItem(single);
        M.toast('已创建');
      } else {
        var series = {
          kind: 'series',
          title: v.title,
          categoryId: v.categoryId,
          time: v.time,
          note: v.note,
          done: v.done,
          repeat: v.repeat,
          exceptions: {}
        };
        if (meta) series.meta = meta;
        store.addItem(series);
        M.toast('已创建重复事项');
      }
    }

    function updateSingle(item, v) {
      var meta = metaForCategoryChange(item, v.categoryId);
      if (v.kind === 'single' && item.kind === 'single') {
        /* starred 不再由表单写入（DM-18.4）；不带该键即保留原值 */
        var patch = {
          title: v.title, categoryId: v.categoryId, date: v.date,
          time: v.time, note: v.note, done: v.done, meta: meta
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
        meta: meta,
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

    /** 对重复实例应用编辑：仅此次 / 此次及以后 */
    function applyOccurrenceEdit(item, occ, v, scope) {
      var meta = metaForCategoryChange(item, v.categoryId);
      if (scope === 'only') {
        var patch = {
          time: v.time, title: v.title, categoryId: v.categoryId,
          note: v.note, done: v.done, meta: meta
        };
        store.addSeriesException(item.id, occ.date, patch);
        M.toast('已修改此次（仅此次）', {
          actionLabel: '撤销',
          onAction: function () { store.removeSeriesException(item.id, occ.date); afterWrite(); }
        });
        return;
      }
      var changes = {
        title: v.title,
        categoryId: v.categoryId,
        time: v.time,
        note: v.note,
        done: v.done,
        meta: meta
      };
      if (v.kind === 'series') changes.repeat = v.repeat;
      var res = store.splitSeriesAt(item.id, occ.date, 'edit', changes);
      M.toast(res && res.split ? '已拆分：之后成为一个新序列' : '已更新整条序列');
    }

    /* ---------------- 导航 ---------------- */

    function setDate(iso, opts2) {
      opts2 = opts2 || {};
      if (!D.isValidDate(iso)) return;
      if (notesTimer) flushNotes();
      state.date = iso;
      /* 换日期（或 app 切回日视图）→ 允许下一次渲染重新做首屏定位 */
      pendingFirstScroll = true;
      pendingNowScroll = (iso === D.todayISO());
      if (opts2.notify !== false && opts.onSelectDate) opts.onSelectDate(iso);
      compute();
      renderAll();
      /* 首屏定位只属于这一次导航：收尾即清，
         绝不让后续点击引起的重绘（展开 / 收起）把时间轴拽到最早时段或现在指针。 */
      pendingFirstScroll = false;
      pendingNowScroll = false;
      /* 三十九轮（用户口径）：前移 / 后移也要左右滑入，与切档同一套观感。 */
      if (opts2.slide) {
        var motion = root.DayPlan.motion;
        if (motion && typeof motion.slidePanel === 'function') motion.slidePanel(els.panel, opts2.slide);
      }
    }

    function shiftDate(days) {
      var dir = days < 0 ? -1 : (days > 0 ? 1 : 0);
      if (!dir) return;
      setDate(D.addDays(state.date, days), { slide: dir });
    }

    els.today.addEventListener('click', function () { setDate(D.todayISO()); });
    els.newItem.addEventListener('click', function () { openEdit(null); });

    /* 四十七轮（用户口径）：手机端在时间表以外左右滑动切换日期，取代「‹ / 今天 / ›」
       两侧箭头；键盘 [ / ] 仍走 shiftDate。 */
    if (root.DayPlan.motion && typeof root.DayPlan.motion.enableSwipe === 'function') {
      root.DayPlan.motion.enableSwipe(els.panel, {
        exclude: function (target) {
          return !!(target && target.closest && target.closest('.timeline-section'));
        },
        onCommit: function (dir) {
          setDate(D.addDays(state.date, dir), { notify: true });
        }
      });
    }

    /* 「隐藏已完成」开关已移入设置：每次 refresh（含设置变更回调）都重新读 UI 状态。 */
    function syncHideDone() {
      var ui = store.loadUIState();
      state.hideDone = !!(ui && ui.hideDone);
    }

    /* ---------------- 迭代 10 批次 5（条9）：事项完成台 ---------------- */

    /**
     * 完成一条发生：series 只作用这一次（完成台是「今天的执行台」语义）。
     * 调用前 finishdock 已把条目移出台，随后原位置以「已完成」样式重新出现。
     */
    function completeOccurrence(occ) {
      if (!occ) return;
      var doc = currentDoc();
      var item = (doc.items || []).filter(function (i) { return i.id === occ.seriesId; })[0];
      if (!item) return;
      try {
        if (item.kind === 'single') store.toggleDone(item.id, null, 'only');
        else store.toggleDone(item.id, occ.date, 'only');
      } catch (e) {
        banner('danger', '标记完成失败：' + e.message);
        return;
      }
      afterWrite();
      M.toast('已完成：' + (occ.title || '事项'));
    }

    function setupFinishDock() {
      var FD = root.DayPlan.finishdock;
      var body = document.getElementById('finish-dock-body');
      if (!FD || typeof FD.create !== 'function' || !body) return;
      var ui = {};
      try { ui = store.loadUIState() || {}; } catch (e) { ui = {}; }
      dock = FD.create({
        root: body,
        countEl: document.getElementById('finish-dock-count'),
        store: store,
        getCat: function (id) { return categoryMap()[id]; },
        onDockChange: function () { compute(); renderAll(); },
        onComplete: completeOccurrence,
        sound: ui.finishSound !== false
      });

      /* 刷新恢复（用户裁定 2026-10-19；D9 扩 2026-10-27）：完成台条目与计时状态
       * 从**文档字段** doc.finishDock 还原（随同步走）。来源优先级：
       *   ① doc.finishDock 有条目（v5 权威，包括其他设备同步来的）；
       *   ② 旧 UI 状态键（v4 时代只存 UI 状态）——恢复成功后**一次性搬进 doc**，
       *     此后 doc 里已有内容，① 恒优先，旧键自动作废。
       * 必须在首次渲染之前完成 —— visible() 依赖 dock.has(key) 判断「已空出」，
       * 否则刚恢复的条目会同时出现在台里和原位置。 */
      var dockSnap = null;
      try { dockSnap = (typeof store.getFinishDock === 'function') ? store.getFinishDock() : null; } catch (e2) { dockSnap = null; }
      var legacySnap = Array.isArray(ui.finishDock) ? ui.finishDock : null;
      var fromDoc = !!(dockSnap && dockSnap.length);
      var snap = fromDoc ? dockSnap : (legacySnap || []);
      if (dock && typeof dock.restore === 'function' && snap.length) {
        var restored = 0;
        try { restored = dock.restore(snap) || 0; } catch (e) { /* 快照损坏：降级为空台 */ }
        /* 一次性迁移：旧 UI 状态的条目第一次写进 doc（doc 从此是唯一权威），
           迁移成功后清掉旧键——否则用户清空台子后，旧键会把幽灵条目带回来。 */
        if (restored > 0 && !fromDoc && typeof store.setFinishDock === 'function') {
          try {
            store.setFinishDock(dock.snapshot());
            if (typeof store.saveUIState === 'function') store.saveUIState({ finishDock: [] });
          } catch (e3) { /* 迁移失败下次再试 */ }
        }
      }

    }

    /**
     * 拖放：未排卡片与折叠块 → 完成台。
     * HTML5 DnD（桌面与浏览器一致）；dataTransfer 不可用时用内存 dragKey 兜底。
     */
    function setupDrag() {
      var body = document.getElementById('finish-dock-body');
      var dockEl = document.getElementById('day-finish-dock');
      var dragKey = null;
      var dragFromList = false;   /* 源是否来自未排列表（只有它能参与列表内排序 / 落到时间轴） */
      if (!els.panel) return;

      function sourceOf(target) {
        var n = target;
        while (n && n !== els.panel) {
          if (n.getAttribute && n.getAttribute('data-occ-key')) return n;
          n = n.parentNode;
        }
        return null;
      }

      function clearTarget() {
        if (dockEl && dockEl.classList) dockEl.classList.remove('is-drop-target');
      }

      /* ---- 列表内排序（迭代 10 条13，四十七轮改为按指针几何取落点）---- */

      /* 单一落点线：列表内绝对定位，不再靠逐项 ::before/::after 切换（子元素间移动时
         dragleave 会把标记清掉，表现为蓝条闪烁）。 */
      var sortLine = null;

      function hideSortLine() {
        if (sortLine && sortLine.parentNode) sortLine.parentNode.removeChild(sortLine);
        sortLine = null;
      }

      /** 可见卡片（剔除被拖项与落点线），按 DOM 次序 */
      function sortCandidates() {
        var out = [];
        var list = els.untimedList;
        if (!list || !list.children) return out;
        for (var i = 0; i < list.children.length; i += 1) {
          var n = list.children[i];
          if (!n || n === sortLine) continue;
          if (!n.className || String(n.className).indexOf('untimed-item') < 0) continue;
          if (n.getAttribute && n.getAttribute('data-occ-key') === dragKey) continue;
          out.push(n);
        }
        return out;
      }

      /** 指针纵坐标 → 插入位（0..n）与落点线的 y（相对列表顶部） */
      function sortSlot(clientY) {
        var items = sortCandidates();
        var listRect = els.untimedList.getBoundingClientRect();
        var y = null;
        var index = items.length;
        for (var i = 0; i < items.length; i += 1) {
          var r = items[i].getBoundingClientRect();
          if (clientY < r.top + r.height / 2) {
            index = i;
            y = r.top;
            break;
          }
        }
        if (y === null && items.length) {
          y = items[items.length - 1].getBoundingClientRect().bottom;
        }
        var ids = items.map(function (n) { return n.getAttribute('data-series-id'); });
        return {
          index: index,
          ids: ids,
          top: (y === null) ? 0 : Math.max(0, Math.round(y - listRect.top) - 1)
        };
      }

      function showSortLine(slot) {
        if (!els.untimedList) return;
        if (!sortLine || sortLine.parentNode !== els.untimedList) {
          sortLine = document.createElement('li');
          sortLine.className = 'untimed-drop-line';
          sortLine.setAttribute('aria-hidden', 'true');
          els.untimedList.appendChild(sortLine);
        }
        sortLine.style.top = slot.top + 'px';
      }

      els.panel.addEventListener('dragstart', function (e) {
        var src = sourceOf(e.target ? e.target : null);
        if (!src) return;
        if (src.classList && src.classList.contains('is-expanded')) { e.preventDefault(); return; }
        dragKey = src.getAttribute('data-occ-key');
        dragFromList = !!(els.untimedList && src.parentNode === els.untimedList);
        dragSuppressUntil = Date.now() + 500;
        if (src.classList) src.classList.add('is-dragging');
        try {
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', dragKey);
          }
        } catch (err) { /* 忽略 */ }
      });

      els.panel.addEventListener('dragend', function (e) {
        var src = sourceOf(e.target ? e.target : null);
        if (src && src.classList) src.classList.remove('is-dragging');
        clearTarget();
        hideSortLine();
        clearDropPreview();
        collapseIdleAfterDrag();
        dragKey = null;
        dragFromList = false;
      });

      /* ---- 未排事项拖到时间轴：落点 = 时段中点，默认 1 小时（2026-11-01） ---- */

      function collapseIdleAfterDrag() {
        if (!idleDragExpanded) return;
        setDragIdleExpanded(false, null, 'band');
      }

      function timelineDragAllowed() { return !!(dragKey && dragFromList); }

      if (els.scroll) {
        els.scroll.addEventListener('dragover', function (e) {
          if (!timelineDragAllowed()) return;
          /* 必须 preventDefault，否则浏览器不认这里是合法放置区 */
          e.preventDefault();
          try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } catch (err) { /* 忽略 */ }
          hideSortLine();
          dragPointer = { x: e.clientX, y: e.clientY, mode: 'drag' };
          if (updateDragAt(e.clientX, e.clientY)) startAutoScroll();
          else stopAutoScroll();
        });

        els.scroll.addEventListener('dragleave', function (e) {
          if (!timelineDragAllowed()) return;
          /* 子元素之间移动不算离开；指针仍在滚动区内也不算 —— 否则折叠区刚展开就收拢，来回闪 */
          var to = e.relatedTarget;
          if (to && els.scroll.contains && els.scroll.contains(to)) return;
          if (typeof e.clientX === 'number' && pointerOverScroll(e.clientX, e.clientY, 16)) return;
          clearDropPreview();
          collapseIdleAfterDrag();
        });

        els.scroll.addEventListener('drop', function (e) {
          if (!timelineDragAllowed()) return;
          e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
          var key = dragKey;
          var x = e.clientX;
          /* 先按「展开态」的轴反算分钟，再收拢，否则落点会被压缩带改写 */
          var minute = minuteAtClientX(x);
          dragKey = null;
          dragFromList = false;
          clearDropPreview();
          idleDragExpanded = false;
          scheduleOccurrence(key, minute, x);
        });
      }

      /* 触屏长按拖动的系统菜单（contextmenu / 长按菜单）一律压掉，否则会触发卡片的右键操作 */
      if (document && typeof document.addEventListener === 'function') {
        document.addEventListener('contextmenu', function (e) {
          if (!touchDrag || !touchDrag.active) return;
          if (e && e.preventDefault) e.preventDefault();
          if (e && e.stopPropagation) e.stopPropagation();
        }, true);
      }

      /* 列表内拖动排序：dragover 按指针几何标落点（卡片空隙 / 列表空白也能落），
         drop 重排并落盘。落点线是全列表唯一一条，避免移动过程中的闪烁。 */
      if (els.untimedList) {
        els.untimedList.addEventListener('dragover', function (e) {
          if (!dragKey || !dragFromList) return;
          /* 必须 preventDefault：指针在卡片之间或列表空白处时，浏览器默认也不允许 drop */
          e.preventDefault();
          try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } catch (err) { /* 忽略 */ }
          showSortLine(sortSlot(e.clientY));
        });

        els.untimedList.addEventListener('dragleave', function (e) {
          /* 子元素之间移动（relatedTarget 仍在列表内）不算离开，否则落点线会闪 */
          var to = e.relatedTarget;
          if (to && els.untimedList.contains && els.untimedList.contains(to)) return;
          hideSortLine();
        });

        els.untimedList.addEventListener('drop', function (e) {
          if (!dragKey || !dragFromList) return;
          e.preventDefault();
          var slot = sortSlot(e.clientY);
          hideSortLine();
          var fromKey = dragKey;
          dragKey = null;
          dragFromList = false;
          var fromSeries = null;
          (state.occurrences || []).forEach(function (o) { if (o.key === fromKey) fromSeries = o.seriesId; });
          if (!fromSeries) return;
          moveUntimedToSlot(fromSeries, slot.index, slot.ids);
        });
      }

      if (body) {
        body.addEventListener('dragover', function (e) {
          if (!dragKey) return;
          e.preventDefault();
          try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } catch (err) { /* 忽略 */ }
          if (dockEl && dockEl.classList) dockEl.classList.add('is-drop-target');
        });

        body.addEventListener('dragleave', clearTarget);

        body.addEventListener('drop', function (e) {
          e.preventDefault();
          clearTarget();
          var key = dragKey;
          if (!key && e.dataTransfer && e.dataTransfer.getData) {
            try { key = e.dataTransfer.getData('text/plain'); } catch (err) { key = null; }
          }
          dragKey = null;
          if (!key || !dock) return;
          var occ = null;
          (state.occurrences || []).forEach(function (o) { if (o.key === key) occ = o; });
          if (!occ) return;
          if (!dock.add(occ)) M.toast(occ.done ? '已完成的事项不需要再计时' : '这件已经在完成台里了');
        });
      }
    }

    /* ---------------- 五十一轮：倒计时 ---------------- */

    function setupCountdown() {
      var CD = root.DayPlan.countdown;
      if (!CD || typeof CD.create !== 'function' || !els.countdownList) return;
      countdown = CD.create({
        list: els.countdownList,
        emptyArt: els.countdownEmpty,
        addBtn: els.countdownAdd,
        store: store,
        getCat: function (id) { return categoryMap()[id]; },
        onChange: function () { afterWrite(); }
      });
      countdown.render();
    }

    function renderCountdowns() {
      if (countdown) countdown.render();
    }

    /* ---------------- 右栏图片（2026-11-01） ---------------- */

    function setupRailCover() {
      var RC = root.DayPlan.railCover;
      if (!RC || typeof RC.create !== 'function' || !els.railCover) return;
      railCover = RC.create({
        store: store,
        scope: 'day',
        label: '今日',
        element: els.railCover,
        getKey: function () { return state.date; }
      });
      railCover.render();
    }

    function renderRailCover() {
      if (railCover) railCover.render();
    }

    /* ---------------- 渲染总入口 ---------------- */

    function renderAll() {
      renderHead();
      renderTimeline();
      renderUntimed();
      renderRailCover();
      renderCountdowns();
      renderNotes();
    }

    function refresh() {
      syncHideDone();
      compute();
      renderAll();
    }

    /* 迭代 10 批次 5（条9）：完成台必须在首次渲染前就位（visible() 依赖它判断「已空出」） */
    setupFinishDock();
    setupDrag();
    setupRailCover();
    setupCountdown();

    nowTimer = setInterval(updateNowLine, 60000);
    if (nowTimer && typeof nowTimer.unref === 'function') nowTimer.unref();

    /* 页面缩放 / 改窗后，轨道高度是按渲染那一刻的视口量出来的内联值。
       不重排就会沿用旧高度：视口变矮时轨道比滚动区高一截，底部事项被横向滚动条盖住。
       只认宽高真的变了（滚动不会触发），日视图不可见时跳过。
       注意：Electron 的 setZoomFactor 实测不派发 resize，故再加一条低频轮询兜底。 */
    var viewport = { w: root.innerWidth || 0, h: root.innerHeight || 0 };
    var resizeTimer = null;
    function scheduleReflow() {
      var w = root.innerWidth || 0;
      var h = root.innerHeight || 0;
      if (w === viewport.w && h === viewport.h) return;
      viewport.w = w;
      viewport.h = h;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        if (els.panel.hidden) return;
        if (els.panel.style) els.panel.style.removeProperty('--day-floor');
        renderTimeline();
      }, 160);
    }
    if (typeof root.addEventListener === 'function') root.addEventListener('resize', scheduleReflow);
    var viewportPoll = setInterval(scheduleReflow, 400);
    if (viewportPoll && typeof viewportPoll.unref === 'function') viewportPoll.unref();

    /* 2026-10-31（用户反馈「刷新之后还是会被遮挡」）：
       上面那条只认 window 的宽高变化。可是刷新后容器会**自己**变矮 ——
       底行（未排时段 / 完成台）异步渲染变高、顶部演示提示挂出、右栏图片加载完成，
       任何一条都会把时间轴挤矮，而 window 尺寸一点没变，于是没人复检：
       轨道按渲染那一刻的富余高度拉伸过，容器变矮后底部事项就被下沿切掉。
       这里直接盯住滚动区与面板本身，尺寸一变就在下一帧复检（幂等，装得下就什么都不做）。 */
    var fitRaf = 0;
    var fitObserver = null;
    function scheduleFitCheck() {
      if (fitRaf) return;
      var raf = (typeof root.requestAnimationFrame === 'function')
        ? function (fn) { return root.requestAnimationFrame(fn); }
        : function (fn) { return setTimeout(fn, 16); };
      fitRaf = raf(function () {
        fitRaf = 0;
        if (els.panel && els.panel.hidden) return;
        if (els.panel && !els.panel.isConnected) return;
        ensureTimelineFits();
      });
    }
    if (typeof root.ResizeObserver === 'function') {
      try {
        fitObserver = new root.ResizeObserver(scheduleFitCheck);
        if (els.scroll) fitObserver.observe(els.scroll);
        if (els.panel) fitObserver.observe(els.panel);
      } catch (e) { fitObserver = null; }
    }
    /* 字体 / 图片加载完会再挪一次版，补两枪（不依赖 ResizeObserver 也能兜住） */
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('load', scheduleFitCheck);
    }
    if (document && document.fonts && typeof document.fonts.ready === 'object') {
      try {
        document.fonts.ready.then(scheduleFitCheck, function () {});
      } catch (e) { /* 老引擎没有 fonts.ready */ }
    }

    syncHideDone();

    return {
      element: els.panel,
      setDate: setDate,
      shiftDate: shiftDate,
      refresh: refresh,
      getDate: function () { return state.date; },
      flushNotes: flushNotes,
      banner: banner,
      openEdit: openEdit,
      renderTimeline: renderTimeline,
      /** 事项完成台实例（冒烟断言与后续扩展用；模块缺失时为 null） */
      finishDock: function () { return dock; },
      /** 倒计时实例（五十一轮，冒烟断言用；模块缺失时为 null） */
      countdown: function () { return countdown; }
    };
  }

  /** #rrggbb -> rgba(...)，用于时段块底色 */
  function hexToRgba(hex, alpha) {
    if (!hex || hex[0] !== '#' || hex.length !== 7) return 'rgba(148,163,184,' + alpha + ')';
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  root.DayPlan.dayView = {
    createDayView: createDayView,
    hexToRgba: hexToRgba,
    FALLBACK_PX_PER_HOUR: FALLBACK_PX_PER_HOUR
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
