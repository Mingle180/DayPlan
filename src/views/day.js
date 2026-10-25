/**
 * DayPlan · 单日视图（F-02 / F-03 / F-04 / F-08 / F-11 / F-14 / F-16 / F-19 / F-24 / F-26）
 *
 * 结构：日期标题 + 日期导航 → 时间轴（横向时间轴 + 纵向类别行组 + 两端空闲竖窄带）
 *       → 无时事项列表 → 今日记录。
 *
 * 迭代 4（07-delta US-19…US-25 / ADR-19 / ADR-20 / BR-35）：
 *   - 时间轴恒为**横向**：x = computeAxisGeometry().getX(minute)；刻度 / 网格线 / 空闲窄带 /
 *     事项块 / 当前时间线**全部**使用同一坐标映射（不再混用纵向压缩坐标）。
 *   - 纵向只表达类别行组与道号：行组 top 依次堆叠，块 top = 组 top + lane × 组 laneHeight。
 *   - 行高由纯函数 categoryLabelMetrics 推导：laneHeight = max(48, 名称文本高 + 内边距)。
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
  var GROUP_GAP_FALLBACK = 10;
  var LABEL_CHAR_PX = 14;
  var LABEL_PAD_PX = 8;
  var OVERFLOW_OFFSET_STEP = 8;
  var RULER_TICK_TOP = 4;
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
      untimedTitle: document.getElementById('untimed-title'),
      untimedCount: document.getElementById('untimed-count'),
      untimedList: document.getElementById('untimed-list'),
      untimedEmpty: document.getElementById('untimed-empty'),
      notesInput: document.getElementById('notes-input'),
      notesStatus: document.getElementById('notes-status')
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
    /* BR-35 首屏定位：只在「进入日视图 / 换日期」时把横轴滚到最早时段附近。
       互动引起的重绘（展开/收起、隐藏已完成、写入后刷新）**必须保留**用户当前的
       横向位置 —— 否则轴较长时点右侧的事项，时间轴会立刻弹回头部、根本没法操作。 */
    var pendingFirstScroll = true;

    /* 迭代 10 批次 5（条9）：拖放结束后浏览器可能补发一次 click，
       用短时间窗抑制，避免「拖进完成台」又顺手把卡片展开 */
    var dragSuppressUntil = 0;
    /** 完成台实例（finishdock 模块缺失时为 null → 右侧栏保持空台） */
    var dock = null;

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

    function hiddenDoneCount() {
      if (!state.hideDone) return 0;
      return state.occurrences.filter(function (o) { return o.done; }).length;
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
      els.title.textContent = D.formatDateCN(state.date);
      var parts = [];
      var today = D.todayISO();
      if (state.date === today) parts.push('今天');
      else {
        var diff = D.diffDays(today, state.date); // 正值 = 未来
        parts.push(diff > 0 ? diff + ' 天后' : Math.abs(diff) + ' 天前');
      }
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
      var counts = { timed: 0, untimed: 0, done: 0 };
      state.occurrences.forEach(function (o) {
        if (o.time) counts.timed++; else counts.untimed++;
        if (o.done) counts.done++;
      });
      parts.push('共 ' + state.occurrences.length + ' 项（时段 ' + counts.timed + ' · 未排时段 ' + counts.untimed +
        (counts.done ? ' · 已完成 ' + counts.done : '') + '）');
      /* 2026-10-22：工具条删除后，「隐藏已完成」状态说明并入日期副标题。 */
      var visibleTimed = state.occurrences.filter(function (o) { return o.time && visible(o); }).length;
      if (!visibleTimed && hiddenDoneCount() > 0) {
        parts.push('已隐藏 ' + hiddenDoneCount() + ' 项已完成事项');
      }
      els.sub.textContent = parts.join(' · ');
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
     * 迭代 8（F-52）：该类别当天「内容完整显示」所需的道高。
     * 口径（用户裁定）：以**整条类别道**为单位，取该类别里最高的那个事项所需的块高
     * （含备注按当前块宽自然换行）；与车道高下限取最大值。
     * 美化迭代 10：标题右侧的类别胶囊占宽 → chipWidthFor(name) 参与度量。
     * @param {string} name 类别名
     * @param {Array} items 该组的事项（occurrence 或 {occ}）
     * @param {number} wrapWidth 该组事项中最宽的块宽（换行宽度；缺省回落到整天轴宽）
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

    /** 组纵向排布（DM-21.6 / BR-26）：laneHeight 由类别名推导；组间不相交。 */
    function layoutGroups(geometry, groups, catNames, rate, lanesMax) {
      var ordered = groups.slice();
      var pin = urgentCategoryId();          /* v2 由 pinFirst 处理；v1 在此本地前置（幂等） */
      if (pin) {
        var head = [];
        var tail = [];
        ordered.forEach(function (g) { (String(g.categoryId) === pin ? head : tail).push(g); });
        ordered = head.concat(tail);
      }

      var minBlockWidth = Number(Layout.DEFAULT_MIN_BLOCK_WIDTH) || 12;
      var groupGap = Number(Layout.GROUP_GAP);
      if (!isFinite(groupGap) || groupGap < 0) groupGap = GROUP_GAP_FALLBACK;

      var laid = (Layout && typeof Layout.assignGroupedLanes === 'function')
        ? Layout.assignGroupedLanes(ordered, {
          pxPerHour: rate,
          lanesMax: lanesMax,
          laneHeight: LANE_HEIGHT_MIN,
          /* 迭代 8（F-52）：道高 = max(类别名高度, 该类别内容完整显示所需高度)；
             换行宽度取该类别里最宽的块（不是整天轴宽，否则 30 分钟的块会按 24 小时宽算，明显偏高） */
          laneHeightFor: function (categoryId) {
            var g = null;
            for (var gi = 0; gi < ordered.length; gi += 1) {
              if (String(ordered[gi].categoryId) === String(categoryId)) { g = ordered[gi]; break; }
            }
            var its = (g && g.items) || [];
            return groupLaneHeightFor(catNames[categoryId] || '未分类', its,
              groupWrapWidth(geometry, its, minBlockWidth), geometry);
          },
          minBlockWidth: minBlockWidth,
          groupGap: groupGap,
          projectX: function (minute) { return axisX(geometry, minute); }
        })
        : { groups: [] };

      var list = (laid && laid.groups) || [];

      /* layout.js v1 不认识 laneHeightFor（组对象无 laneHeight）→ 用同一公式本地重排 */
      var needsVerticalFix = list.some(function (g) { return typeof g.laneHeight !== 'number'; });
      var y = 0;
      list.forEach(function (g) {
        var catName = catNames[g.categoryId] || '未分类';
        var laneHeight = needsVerticalFix
          ? groupLaneHeightFor(catName, g.items || [], groupWrapWidth(geometry, g.items, minBlockWidth), geometry)
          : Math.max(LANE_HEIGHT_MIN, Number(g.laneHeight) || LANE_HEIGHT_MIN);
        var laneCount = Math.max(1, Number(g.laneCount) || 1);
        if (needsVerticalFix) {
          if (y > 0) y += groupGap;
          g.top = y;
          g.laneHeight = laneHeight;
          g.height = laneCount * laneHeight;
          y += g.height;
        }
        (g.items || []).forEach(function (item) {
          var start = D.minutesOf(item.occ.time.start);
          var end = D.minutesOf(item.occ.time.end);
          /* 横向坐标统一取自 computeAxisGeometry（ADR-20 / BR-35）；v2 的 projectX 结果与此一致 */
          item.left = axisX(geometry, start);
          item.width = Math.max(axisX(geometry, end) - item.left, minBlockWidth);
          /* 纵向 = 组内道号 × 该组 laneHeight，与开始时间无关（US-25.2） */
          item.top = (item.lane || 0) * laneHeight;
        });
      });

      /* 迭代 5（F-32 / 规范 08）：总高必须两条通路都算对。
         v2 下 needsVerticalFix === false，上面的 y 不再累加，若直接返回 y 会让
         #timeline-track/#timeline-labels 恒为 LANE_HEIGHT_MIN(48)，行组与事项块底部
         被 `.timeline-scroll{overflow-y:hidden}` 裁掉（用户条目 1 的真根因）。
         这里取「layout.js 返回的高度」与「各组 top+height 的最大值」的较大者。 */
      var height = Number(laid && laid.height);
      if (!isFinite(height) || height < 0) height = 0;
      if (y > height) height = y;
      list.forEach(function (g) {
        var bottom = (Number(g.top) || 0) + Math.max(0, Number(g.height) || 0);
        if (bottom > height) height = bottom;
      });

      return { groups: list, height: height };
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
        ? { unitPx: 11, padX: 8, chipWidth: 14 }
        : { unitPx: 13, padX: 14, chipWidth: 22 };
    }

    /** 设置内联 px 值：真实浏览器与 DOM 垫片（含 getPropertyValue 回退）都能读到。 */
    function setPx(node, prop, value) {
      node.style[prop] = Math.round(value) + 'px';
    }

    function renderTimeline() {
      var doc = currentDoc();
      var cats = categoryMap();
      var catNames = {};
      Object.keys(cats).forEach(function (id) { catNames[id] = (cats[id] && cats[id].name) || '未分类'; });
      var rate = pxPerHour();
      var lanesMax = Number((doc.settings && doc.settings.maxLanes) || 3);
      if (!isFinite(lanesMax) || lanesMax < 1) lanesMax = 3;
      var compressible = !doc.settings || doc.settings.idleCompressEnabled !== false;
      var labelWidth = catLabelWidth();

      if (els.panel) {
        els.panel.style.setProperty('--px-per-hour', rate + 'px');
        els.panel.style.setProperty('--compress-height', compressHeight() + 'px');
        els.panel.style.setProperty('--cat-label-width', labelWidth + 'px');
      }

      /* 上一轮已固定的展开卡：节点即将被替换，先清账（真实滚动/缩放由 overlay 自行 sync） */
      if (pinner) pinner.sync();

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
      var laid = layoutGroups(geometry, groups, catNames, rate, lanesMax);

      /* ADR-19：inner 宽 = 类别名列宽 + 轴长（美化迭代 10：labelWidth 恒 0） */
      var axisLength = Number(geometry && geometry.axisLength);
      if (!isFinite(axisLength)) axisLength = Number(geometry && geometry.totalHeight);
      if (!isFinite(axisLength)) axisLength = Math.round(24 * rate);
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
        /* 空态（BR-28 / AC-20.1）：时间轴区内不出现任何占位文案，只保留整日刻度与网格线 */
        contentHeight = LANE_HEIGHT_MIN;
        els.track.style.height = contentHeight + 'px';
        renderGridlines(null, rate);
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
          /* 2026-10-20（用户反馈）：块高按自身内容走，道高只是上限 */
          var blockHeight = blockHeightFor(item, laneBlockH);
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
          node.style.setProperty('--cat', cat.color);
          node.style.setProperty('--cat-bg', hexToRgba(cat.color, 0.14));
          node.style.setProperty('--cat-border', hexToRgba(cat.color, 0.45));
          if (expanded) {
            /* 迭代 10 批次 3（条7）：展开后与原形状一致 —— 不再横向加宽、不再左移；
               仅抬高层级（pin 成功时由 overlay 覆盖为 fixed） */
            node.style.zIndex = '8';
            toPin.push(node);
          }
          box.appendChild(node);
        });

        els.track.appendChild(box);
        /* 美化迭代 10：左侧竖排类别名列整体下线（类别信息移到块内标题右侧的胶囊） */
      });

      /* 重建后再还原横向位置：此时 DOM 已恢复完整宽度，写回才不会被夹取 */
      if (els.scroll && els.scroll.scrollLeft !== keepScrollLeft) {
        els.scroll.scrollLeft = keepScrollLeft;
      }

      /* US-24 / DM-25：展开卡脱离裁切上下文；pin 返回 false 时保持上面的原位展开 */
      if (pinner) {
        toPin.forEach(function (node) { pinner.pin(node, els.track); });
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

      updateNowLine();
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
      /* 迭代 10 批次 5（条9）：已进完成台的未排事项不再计入（原位置已空出） */
      els.untimedCount.textContent = p.untimed.filter(function (o) {
        return !dock || !dock.has(o.key);
      }).length + ' 项';
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

    function updateNotesStatus(saving) {
      var len = els.notesInput.value.length;
      els.notesStatus.textContent = (saving ? '保存中… ' : '') + len + ' 字';
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
      els.nowLine.style.left = Math.round(catLabelWidth() + axisX(axis, now)) + 'px';
      els.nowLine.title = '当前时间 ' + D.formatMinutes(now);
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
        /* 迭代 7（F-45 第 6 条 / R-23）：只设紧急未做其他改动 → 不渲染「恢复默认」 */
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
        style: '--cat:' + cat.color
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
        defaultCategoryId: doc.settings.defaultCategoryId || 'cat_short_task',
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
        store.updateItem(item.id, {
          title: v.title, categoryId: v.categoryId, date: v.date,
          time: v.time, note: v.note, done: v.done, meta: meta
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
      if (opts2.notify !== false && opts.onSelectDate) opts.onSelectDate(iso);
      compute();
      renderAll();
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

      /* 刷新恢复（用户裁定 2026-10-19）：完成台条目与计时状态都从 UI 状态还原。
       * 必须在首次渲染之前完成 —— visible() 依赖 dock.has(key) 判断「已空出」，
       * 否则刚恢复的条目会同时出现在台里和原位置。 */
      if (dock && typeof dock.restore === 'function' && Array.isArray(ui.finishDock)) {
        try { dock.restore(ui.finishDock); } catch (e) { /* 快照损坏：降级为空台 */ }
      }

    }

    /**
     * 拖放：未排卡片与折叠块 → 完成台。
     * HTML5 DnD（桌面与浏览器一致）；dataTransfer 不可用时用内存 dragKey 兜底。
     */
    function setupDrag() {
      var body = document.getElementById('finish-dock-body');
      var dockEl = document.getElementById('day-finish-dock');
      if (!body || !els.panel) return;
      var dragKey = null;
      var dragFromList = false;   /* 源是否来自未排列表（只有它能参与列表内排序） */

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
        dragKey = null;
        dragFromList = false;
      });

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

    /* ---------------- 渲染总入口 ---------------- */

    function renderAll() {
      renderHead();
      renderTimeline();
      renderUntimed();
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

    nowTimer = setInterval(updateNowLine, 60000);
    if (nowTimer && typeof nowTimer.unref === 'function') nowTimer.unref();

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
      finishDock: function () { return dock; }
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
