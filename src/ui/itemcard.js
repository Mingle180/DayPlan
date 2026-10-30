/**
 * DayPlan · 事项卡（折叠 / 展开 + 紧急标记）
 *
 * 契约（冻结）：docs/spec/04-system-design.md §2.10；迭代 4：07-iteration-4-delta.md
 * 功能：F-14（折叠/展开）、F-28（紧急类型）；数据：DM-18 / DM-16。
 *
 *   createItemCard(occ, ctx) -> HTMLElement
 *
 * ctx.variant:
 *   "block" → div.tl-block     内含 div.tl-time / div.tl-title
 *   "card"  → li.untimed-item  内含 span.ui-seq / button.ui-main
 *             （迭代 10 条13：折叠态不再有 div.ui-actions / ▲▼ —— 次序改由列表内拖动）
 *   "week"  → div.wk-item      内含 div.wk-time / div.wk-title
 *
 * 展开态（ctx.expanded === true）：在根元素内追加 div.item-detail，依序为
 *   div.item-note → div.item-actions（紧急 / 修改 / 删除 / [恢复默认] / 收起）。
 *   恢复默认仅 occ.dirty === true 时渲染。
 *
 * 迭代 4（AC-27.5）：不再渲染 ★/☆ 与 .item-star；紧急项在折叠态显示
 *   `<span class="item-urgent-tag">紧急</span>`；切换回调优先取 `ctx.onToggleUrgent(occ)`
 *   （`ctx.onToggleStar` 仅作过渡兼容）。
 *
 * 迭代 6（10-iteration-6-delta F-39，取代 01 AC-9.1 / AC-11.5）：
 *   - **不再渲染完成勾选框**（无 tl-check / ui-check / wk-check）；完成状态由 `.is-done` 表达；
 *   - **右键单击事项块**（contextmenu）切换完成：preventDefault 屏蔽浏览器菜单后调
 *     `ctx.onToggleDone(occ)`，再次右键即取消完成；展开区 `.item-detail` 内右键不切换。
 *
 * 迭代 6（F-37）：展开区「修改」按钮**先收起**（onToggleExpand(occ,false)）再调 onEdit(occ)，
 *   避免 fixed 展开浮层压住随后弹出的编辑弹窗。
 *
 * 迭代 7（11-iteration-7-delta）：
 *   - F-43：**不再渲染 `.item-urgent-tag`**（右上角「紧急」角标）与 card 变体的第二个 `ui-cat`「改」标签；
 *     紧急只留颜色提示（`.is-urgent` → CSS 左侧加粗色条 + 淡底），`title` / `aria-label` 仍含「紧急」。
 *   - F-44：折叠态追加备注节点（`.tl-note` / `.wk-note` / `.ui-note`）；
 *     备注溢出时 `wheel` 只滚备注自身，展开态隐藏时间/标题/折叠备注且不再渲染 `.item-note`。
 *   - F-45：展开区**不再有「收起」按钮**；点展开区空白处或卡片外部即收起（R-25）。
 *   - F-45 第 6 条：`ctx.hasNonUrgentOverride` 返回 false 时不渲染「恢复默认」（R-23）。
 *
 * 纯 DOM 工厂：不访问 store、不读全局状态、不发网络请求；所有行为经 ctx 回调。
 * 可选扩展（非契约字段）：
 *   ctx.width / ctx.pxPerHour 仅用于时段块的 is-narrow 判定；
 *   ctx.hasNonUrgentOverride(occ) -> boolean 由视图注入（读纯函数），用于「恢复默认」按钮判定。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.DayPlan = root.DayPlan || {}; root.DayPlan.itemcard = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DEFAULT_CAT = { name: '未分类', color: '#94a3b8' };
  /* 时段块窄判定阈值（与迭代 2 一致）。2026-10-20：改成**运行时**从 core/layout.js 取，
     保证「窄块」在度量（标题让位 / 时间行数）与渲染两侧是同一个数，不再两处各写 72。 */
  var NARROW_PX_FALLBACK = 72;
  function narrowPx() {
    var L = root && root.DayPlan && root.DayPlan.layout;
    var v = L && Number(L.NARROW_BLOCK_PX);
    return (isFinite(v) && v > 0) ? v : NARROW_PX_FALLBACK;
  }
  /* 2026-10-20（用户裁定）：放不下标题 → 「…」+ 类别首字。缺省阈值与
   * core/layout.js 的 BLOCK_OMIT_MIN_W 对齐（视图可用 ctx.omit 覆盖）。 */
  var OMIT_PX = 40;
  var DEFAULT_PX_PER_HOUR = 60;

  /* ---------------- 基础工具 ---------------- */

  /** 创建元素：attrs 支持 class / text / style / dataset / on* / 其余走 setAttribute。 */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  /** 设置 CSS 自定义属性（类别色）。用 style 属性逐条合并，便于视图再补几何样式。 */
  function setVars(node, vars) {
    Object.keys(vars).forEach(function (k) {
      if (vars[k]) node.style.setProperty(k, vars[k]);
    });
  }

  function hexToRgba(hex, alpha) {
    if (!hex || hex[0] !== '#' || hex.length !== 7) return 'rgba(148,163,184,' + alpha + ')';
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function closestIn(node, selector) {
    if (!node || node.nodeType !== 1 || typeof node.closest !== 'function') return null;
    return node.closest(selector);
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function num(value, fallback) {
    var n = Number(value);
    return (typeof value !== 'undefined' && value !== null && isFinite(n)) ? n : fallback;
  }

  /** 前两个字（按码点取，避免把一个 emoji/代理对切成半个）：
   *  日 / 周视图与完成台的类别胶囊都显示「紧急 / 长期 / 短期 / 临时」这样的两个字。
   *  2026-10-30 用户口径：从一个字改成两个字，类型更好认。 */
  function firstChars(value, n) {
    var s = text(value);
    if (!s) return '';
    var take = Math.max(1, Number(n) || 2);
    var out = '';
    var i = 0;
    while (out.length < take && i < s.length) {
      var cp = s.codePointAt(i);
      out += String.fromCodePoint(cp);
      i += cp > 0xffff ? 2 : 1;
    }
    return out;
  }

  /** 类别：ctx.cats 缺失或未命中时退回「未分类」（不抛错，保持纯函数）。 */
  function categoryOf(ctx, occ) {
    var cats = ctx.cats || {};
    var cat = occ.categoryId ? cats[occ.categoryId] : null;
    return cat || DEFAULT_CAT;
  }

  /** 紧急类别 id（DM-18.2）：优先读冻结常量，缺省回退字面量 */
  function urgentCategoryId() {
    var S = root.DayPlan && root.DayPlan.schema;
    return (S && S.URGENT_CATEGORY_ID) || 'urgent';
  }

  function isUrgent(occ) { return !!occ && occ.categoryId === urgentCategoryId(); }

  /**
   * 类别色 -> 色板三件套（DM-25 / 2026-10-30）。
   * 事项块的颜色完全跟随类别：background / accent / text 都取自 core/palette.js；
   * 旧的高饱和类别色会先按色相归一到色板。palette 未加载时返回 null，
   * CSS 退回 --cat / 默认纸色，不致白块。
   */
  function catTone(hex) {
    var P = root && root.DayPlan && root.DayPlan.palette;
    if (!P || typeof P.categoryTone !== 'function') return null;
    return P.categoryTone(hex);
  }

  function toneVars(cat) {
    var tone = catTone(cat && cat.color);
    if (!tone) return null;
    return {
      '--cat': tone.accent,
      '--cat-bg': tone.background,
      '--cat-border': hexToRgba(tone.accent, 0.45),
      '--event-bg': tone.background,
      '--event-accent': tone.accent,
      '--event-text': tone.text
    };
  }

  /** 紧急类别的当前名称：设置里改名后，按钮 / 提示 / 无障碍文案都要跟随。 */
  function urgentName(ctx) {
    var cat = ctx && ctx.cats ? ctx.cats[urgentCategoryId()] : null;
    var name = cat ? text(cat.name) : '';
    return name || '紧急';
  }
  function isDirty(occ) { return occ.dirty === true; }
  function timeText(occ) { return occ.time ? text(occ.time.start) + '–' + text(occ.time.end) : ''; }

  /**
   * 触屏模式：右键不可用 → 展开区补一颗可见的「完成 / 取消完成」。
   * 优先用调用方注入的 ctx.touch（测试用），否则读 (hover:none)/(pointer:coarse)。
   * 桌面鼠标环境保持原状（右键切换完成），行动按钮数不变。
   */
  function touchMode(ctx) {
    if (ctx && typeof ctx.touch === 'boolean') return ctx.touch;
    try {
      return !!(root && typeof root.matchMedia === 'function'
        && root.matchMedia('(hover: none), (pointer: coarse)').matches);
    } catch (e) { return false; }
  }

  /**
   * 手机档（≤640px）：展开卡按视口放大、显示完整信息、四宫格固定四按钮。
   * 与 touchMode 分开：窄窗口用鼠标时也要用大卡片，但不必强加「完成」以外的触屏逻辑——
   * 展开卡一律给 4 颗按钮，所以这里也把「完成」当成必选。
   */
  function narrowScreen(ctx) {
    if (ctx && typeof ctx.sheet === 'boolean') return ctx.sheet;
    try {
      return !!(root && typeof root.matchMedia === 'function'
        && root.matchMedia('(max-width: 640px)').matches);
    } catch (e) { return false; }
  }

  /**
   * 「恢复默认」是否可渲染（迭代 7 / F-45 第 6 条，用户裁定 R-23）。
   * 优先用视图注入的读纯函数 `ctx.hasNonUrgentOverride(occ)`；未注入时退回 `occ.dirty === true`，
   * 保持本组件可脱离视图独立使用（既有用例不依赖该回调）。
   */
  function shouldOfferRestore(occ, ctx) {
    if (typeof ctx.hasNonUrgentOverride === 'function') {
      try { return ctx.hasNonUrgentOverride(occ) === true; } catch (e) { return isDirty(occ); }
    }
    return isDirty(occ);
  }

  function minutesOf(hhmm) {
    var parts = text(hhmm).split(':');
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
  }

  /* ---------------- 折叠态片段 ---------------- */

  /**
   * 备注（迭代 8 / F-52）：折叠态显示，备注为空时不渲染（不占位）。
   * **不再自己做滚动**（用户裁定：去掉块内滚动备注）——块高/块宽会按内容撑开
   * （日视图行组高、周视图列宽由 core/layout.js 的内容度量决定），备注自然换行完整显示。
   * @param {object} occ
   * @param {'block'|'card'|'week'} variant
   */
  function noteNode(occ, variant) {
    var value = text(occ.note);
    if (value.trim() === '') return null;
    var cls = variant === 'week' ? 'wk-note' : (variant === 'card' ? 'ui-note' : 'tl-note');
    return el('div', {
      class: cls, text: value, title: value, 'data-note': '1',
      'aria-label': '备注：' + value
    });
  }

  /** 面板通用的完成 / 角标类。card 的 dirty 用「改」角标，不加 is-dirty（契约 2）。 */
  function applyFoldedState(node, occ, expanded, variant) {
    var cls = node.className;
    if (occ.done) cls += ' is-done';
    if ((variant === 'block' || variant === 'week') && isDirty(occ)) cls += ' is-dirty';
    if (isUrgent(occ)) cls += ' is-urgent'; // 迭代 4：样式钩子（紧急行/块）
    if (expanded) cls += ' is-expanded';
    node.className = cls;
  }

  /** 时段块窄判定：优先 ctx.width / occ.width，其次按时长 × pxPerHour 估算。 */
  function blockWidth(occ, ctx) {
    if (typeof ctx.width === 'number' && isFinite(ctx.width)) return ctx.width;
    if (typeof occ.width === 'number' && isFinite(occ.width)) return occ.width;
    if (!occ.time || !occ.time.start || !occ.time.end) return null;
    var px = (typeof ctx.pxPerHour === 'number' && ctx.pxPerHour > 0) ? ctx.pxPerHour : DEFAULT_PX_PER_HOUR;
    var mins = minutesOf(occ.time.end) - minutesOf(occ.time.start);
    if (!(mins > 0)) return null;
    return mins * px / 60;
  }

  /**
   * 迭代 8（F-53）：块是否窄到「什么都不显示」。
   * **只认调用方注入的 ctx.tooNarrow**（布尔或函数）：像素宽只有视图/布局层知道，
   * 本组件**不得**按「时长 × pxPerHour」自行估算 —— 周视图的 ctx.width 是百分比，
   * 曾因此把 220px 的大块误判为 2px 而隐藏内容（用户实测 bug）。
   * ctx.tooNarrow 为函数时按 (width) 调用（仅当日/周视图确实给了像素宽才可用）。
   */
  function isTooNarrow(occ, ctx, width) {
    if (typeof ctx.tooNarrow === 'boolean') return ctx.tooNarrow;
    if (typeof ctx.tooNarrow === 'function') {
      if (width === null || !isFinite(width)) return false;
      try { return ctx.tooNarrow(width) === true; } catch (e) { return false; }
    }
    return false;
  }

  /**
   * 2026-10-20（用户裁定）：块是否「放不下标题」→ 折叠态只显示 **省略号 + 类别首字**。
   * 与 isTooNarrow 是两级：
   *   tooNarrow（连省略号都放不下）→ .is-tiny 什么都不显示
   *   omit（放不下标题，但放得下「…」+首字）→ .is-omitted
   * 视图可注入 ctx.omit（布尔或按宽度判定的函数）；未注入时按 ctx.width 与 OMIT_PX 兜底。
   */
  function isOmitted(ctx, width) {
    if (typeof ctx.omit === 'boolean') return ctx.omit;
    if (typeof ctx.omit === 'function') {
      if (width === null || !isFinite(width)) return false;
      try { return ctx.omit(width) === true; } catch (e) { return false; }
    }
    return width !== null && isFinite(width) && width < OMIT_PX;
  }

  /**
   * 2026-10-20（用户裁定）：省略态/微块的**悬停预览** —— 移入即按内容自然尺寸展开
   * （`.is-peek`，宽高由 CSS 的 auto + max-width 控制，不必等于原块尺寸），移出复原。
   * 只负责加类、兜住宽度下限与「贴右边界时左移让位」，几何全部交给 CSS。
   *
   * 宽度兜底（用户：「可以换行，但展开块仍要覆盖住原块」）：预览宽度是 auto，
   * 内容窄时会缩到比原块还窄 —— 原块区域就露出背景。这里量出原块宽度，
   * 只在「原块比 CSS 下限更宽」时用内联 min-width 抬上去（不缩小 CSS 下限）。
   */
  function bindHoverPeek(node, ctx) {
    if (typeof node.addEventListener !== 'function') return;
    /* 触屏没有真正的悬停：mouseenter 会在点按后黏住 → 省略块一碰就停在预览态。
       展开本身已经给出完整内容，触屏不再挂悬停预览。 */
    if (touchMode(ctx)) return;
    var on = false;
    function enter() {
      if (on || ctx.expanded) return;
      on = true;
      /* 必须在加类**之前**量（加类后就被预览尺寸覆盖了）。 */
      var origW = rectWidth(node);
      var origH = rectHeight(node);
      node.classList.add('is-peek');
      /* 预览态下限（CSS 的 min-width：日 150 / 周 120）。原块更宽时才抬内联值，
         既能覆盖原块，又不会把 CSS 下限改小。 */
      var peekMin = minWidthOf(node);
      if (origW > peekMin) node.style.minWidth = Math.round(origW) + 'px';
      /* 2026-10-30（用户口径）：预览必须**完整盖住原块**，高度也不许缩回去。 */
      if (origH > 0) node.style.minHeight = Math.round(origH) + 'px';
      shiftIntoView(node, ctx);
    }
    function leave() {
      if (!on) return;
      on = false;
      node.classList.remove('is-peek');
      node.style.marginLeft = '';
      node.style.minWidth = '';
      node.style.minHeight = '';
    }
    node.addEventListener('mouseenter', enter);
    node.addEventListener('mouseleave', leave);
  }

  /** 元素当前像素宽（无布局能力的环境返回 0）。 */
  function rectWidth(node) {
    try {
      if (typeof node.getBoundingClientRect !== 'function') return 0;
      var r = node.getBoundingClientRect();
      return (r && isFinite(r.width)) ? r.width : 0;
    } catch (e) { return 0; }
  }

  /** 元素当前像素高（无布局能力的环境返回 0）。 */
  function rectHeight(node) {
    try {
      if (typeof node.getBoundingClientRect !== 'function') return 0;
      var r = node.getBoundingClientRect();
      return (r && isFinite(r.height)) ? r.height : 0;
    } catch (e) { return 0; }
  }

  /** 当前生效的 min-width（px）；读不到（垫片/无障碍环境）当 0。 */
  function minWidthOf(node) {
    try {
      if (typeof getComputedStyle !== 'function') return 0;
      var cs = getComputedStyle(node);
      var v = cs ? parseFloat(cs.minWidth) : 0;
      return isFinite(v) ? v : 0;
    } catch (e) { return 0; }
  }

  /** 悬停展开后若越过容器右边界，则用负 margin 左移，避免展开内容跑到视口外。 */
  function shiftIntoView(node, ctx) {
    try {
      var box = (typeof ctx.peekContainer === 'function') ? ctx.peekContainer() : null;
      if (!box || typeof node.getBoundingClientRect !== 'function'
        || typeof box.getBoundingClientRect !== 'function') return;
      var nb = node.getBoundingClientRect();
      var cb = box.getBoundingClientRect();
      if (!nb || !cb || !cb.width) return;
      var over = nb.right - (cb.right - 8);
      if (over > 0) node.style.marginLeft = Math.round(-over) + 'px';
    } catch (e) { /* 无布局能力（纯函数环境/垫片）→ 只靠 CSS 展开 */ }
  }

  /* ---------------- 展开区（契约 6） ---------------- */

  /* 2026-10-21（用户裁定）：
     · 展开卡默认与原块完全重叠；只有折叠时因太小省略（.is-omitted）/只剩色块（.is-tiny）
       的块允许放大；
     · **周视图按钮一律竖排并铺满块高**；
     · **日视图较窄的块按钮竖排**，原块放不下时允许面板适当超出（is-expanded-fit）。
     阈值与 CSS 里的 padding / min-height 同源（改样式必须同步这里）。 */
  var ACTION_MIN_W_DAY = 30;
  var ACTION_GAP_PX = 4;
  var ACTION_ROW_H_DAY = 26;
  var DAY_PAD_X = 8;
  var DAY_PAD_Y = 4;
  var DETAIL_PAD = 2;           /* .item-detail 在展开块里的 padding（日/周都是 2px） */
  var DAY_NARROW_W = 120;       /* 日视图「较窄」口径：低于此宽度的块竖排按钮 */

  function actionCount(occ, ctx) {
    return shouldOfferRestore(occ, ctx) ? 4 : 3;
  }

  /**
   * 给展开根节点挑按钮排布（只对 block / week；card 变体有自己的一行布局）。
   * - 省略 / 微块 → `is-expanded-grow` + 竖排：CSS 允许放大，按钮按内容定高；
   * - 周视图（其余）→ 一律竖排，CSS 让按钮组铺满整个块高（用户 2026-10-21 口径）；
   * - 日视图较窄的块 → 竖排 + `is-expanded-fit`：原块放不下时允许面板适当超出；
   * - 日视图较宽的块 → 按原宽高挑「横排 / 四宫格 / 四按钮一行」，盒子不变。
   * 尺寸测不到（垫片/缺几何）时不加类，沿用各自默认排布。
   */
  function applyExpandLayout(node, occ, ctx, variant) {
    var isWeek = variant === 'week';
    /* 2026-10-30（用户口径）：手机端展开卡不再迁就原块尺寸 —— 统一放大到可读宽度，
       完整显示标题 / 时间 / 备注，按钮固定四宫格。类是 CSS 的唯一开关，排布全在样式里。 */
    if (narrowScreen(ctx)) {
      node.classList.add('is-mobile-expand');
      node.classList.add('is-expanded-grow');
      return;
    }
    if (node.classList.contains('is-omitted') || node.classList.contains('is-tiny')) {
      node.classList.add('is-expanded-grow');
      node.classList.add('is-actions-column');
      return;
    }
    var w = num(isWeek ? ctx.origWidth : ctx.width, NaN);
    var h = num(ctx.origHeight, NaN);
    if (!(w > 0) || !(h > 0)) return;
    var count = actionCount(occ, ctx);

    if (isWeek) {
      /* 周视图不再按宽高挑排布：按钮竖排后，窄块不会再把文字挤成竖排；
         高度由 CSS 均分（is-actions-column 的按钮 flex:1 1 0）。 */
      node.classList.add('is-actions-column');
      return;
    }

    if (w < DAY_NARROW_W) {
      /* 日视图窄块：竖排按钮；min-height 按「每颗 26px + 间隙 + 内边距」算，
         原块够高时不生效，原块不够高（或过窄）才适当超出。 */
      var fitNeed = count * ACTION_ROW_H_DAY + (count - 1) * ACTION_GAP_PX +
        DAY_PAD_Y * 2 + DETAIL_PAD * 2;
      node.classList.add('is-actions-column');
      node.classList.add('is-expanded-fit');
      if (node.style && typeof node.style.setProperty === 'function') {
        node.style.setProperty('--blk-fit-min-h', fitNeed + 'px');
      }
      return;
    }

    var innerW = w - DAY_PAD_X * 2 - DETAIL_PAD * 2;
    var innerH = h - DAY_PAD_Y * 2 - DETAIL_PAD * 2;
    var quadNeed = 2 * ACTION_ROW_H_DAY + ACTION_GAP_PX;
    var quadFits = count === 4 && innerW >= 2 * ACTION_MIN_W_DAY + ACTION_GAP_PX && innerH >= quadNeed;

    var mode;
    if (count === 4) mode = quadFits ? 'grid' : 'line4';
    else mode = 'row';
    node.classList.add('is-actions-' + mode);
  }

  function actionButton(attrs, handler) {
    var a = { class: 'btn', type: 'button' };
    Object.keys(attrs).forEach(function (k) { a[k] = attrs[k]; });
    a.onclick = function (e) {
      e.stopPropagation();
      handler();
    };
    return el('button', a);
  }

  function detailNode(occ, ctx) {
    var detail = el('div', { class: 'item-detail' });

    var actions = el('div', { class: 'item-actions' });
    var urgent = isUrgent(occ);
    var urgentLabel = urgentName(ctx);
    var mobile = narrowScreen(ctx);
    /* 手机档展开卡固定四颗按钮（完成 / 紧急 / 修改 / 删除），「完成」必选。 */
    var touch = touchMode(ctx) || mobile;

    /* 触屏没有右键：把完成做成展开区里看得见的第一颗按钮。 */
    if (touch) {
      actions.appendChild(el('button', {
        class: 'btn is-complete' + (occ.done ? ' is-on' : ''),
        type: 'button',
        text: occ.done ? '取消完成' : '完成',
        title: occ.done ? '取消完成（回到未完成）' : '标记完成',
        'aria-label': occ.done ? '取消完成' : '标记完成',
        'aria-pressed': occ.done ? 'true' : 'false',
        onclick: function (e) {
          e.stopPropagation();
          if (typeof ctx.onToggleDone === 'function') ctx.onToggleDone(occ);
        }
      }));
    }

    // 1) 紧急（迭代 4 / AC-27.5）：文案跟随类别名（设置里可改名），优先回调 ctx.onToggleUrgent
    actions.appendChild(el('button', {
      class: 'btn' + (urgent ? ' is-on' : ''),
      type: 'button',
      text: urgent ? '取消' + urgentLabel : urgentLabel,
      title: urgent ? '取消' + urgentLabel + '（还原原类别）' : '列入' + urgentLabel,
      'aria-label': urgent ? '取消' + urgentLabel : '列入' + urgentLabel,
      onclick: function (e) {
        e.stopPropagation();
        var handler = (typeof ctx.onToggleUrgent === 'function') ? ctx.onToggleUrgent
          : (typeof ctx.onToggleStar === 'function' ? ctx.onToggleStar : null); // 过渡兼容
        if (handler) handler(occ);
      }
    }));

    // 2) 修改（迭代 6 / F-37）：先收起本卡的展开态，再打开编辑表单 ——
    //    否则 fixed 展开浮层会压住随后弹出的编辑弹窗（用户截图 D6）
    actions.appendChild(actionButton({ text: '修改' }, function () {
      toggleExpand(occ, ctx, false);
      if (typeof ctx.onEdit === 'function') ctx.onEdit(occ);
    }));

    // 3) 删除
    actions.appendChild(actionButton({ class: 'btn btn-danger', text: '删除' }, function () {
      if (typeof ctx.onRemove === 'function') ctx.onRemove(occ);
    }));

    // 4) 恢复默认：仅「该次改动不只是紧急/取消紧急」时渲染（迭代 7 / F-45 第 6 条 / R-23）
    //    2026-10-30（用户口径）：手机端不提供「恢复默认」——固定四颗按钮（完成/紧急/修改/删除）。
    if (!mobile && shouldOfferRestore(occ, ctx)) {
      actions.appendChild(actionButton({ text: '恢复默认' }, function () {
        if (typeof ctx.onRestoreDefault === 'function') ctx.onRestoreDefault(occ);
      }));
    }

    // 迭代 7 / F-45：不再渲染「收起」按钮（收起改由「点展开区空白 / 点卡片外部」完成）

    /* 迭代 10 批次 3（条7）：三按钮并排、四按钮四宫格 —— 由样式按 is-quad 切换两行两列。
       触屏追加的「完成」不参与四宫格判定，后台排布仍与桌面一致。 */
    var actionButtons = actions.querySelectorAll ? actions.querySelectorAll('button').length : 0;
    if (actionButtons - (touch ? 1 : 0) === 4) {
      actions.classList.add('is-quad');
    }

    detail.appendChild(actions);
    /* 展开区内的点击：按钮各自 stopPropagation；落在展开区空白处 → 直接收起本卡（F-45 第 2 条）。
     * 注意：`.item-detail` 的根节点也要拦（它是外层 div，不会随按钮一起 stop 到这里）。 */
    detail.addEventListener('click', function (e) {
      var t = e && e.target;
      if (t && t.tagName === 'BUTTON') { e.stopPropagation(); return; }
      e.stopPropagation();
      toggleExpand(occ, ctx, false);
    });
    return detail;
  }

  /* ---------------- 行为 ---------------- */

  function toggleExpand(occ, ctx, next) {
    if (typeof ctx.onToggleExpand === 'function') ctx.onToggleExpand(occ, next);
  }

  /** 单击非紧急角标、非展开区 → onToggleExpand(occ, !ctx.expanded)（契约 4）。 */
  function onRootClick(occ, ctx, expanded, e) {
    var t = e.target;
    if (closestIn(t, '.item-detail')) return;                       // 展开区按钮各自处理
    if (closestIn(t, '.item-urgent-tag')) return;                   // 紧急角标区域
    if (closestIn(t, '.ui-actions')) return;                        // 兼容旧结构（条13 起已不渲染 ▲▼）
    toggleExpand(occ, ctx, !expanded);
  }

  /**
   * 右键单击事项块 = 切换完成状态（迭代 6 / F-39，取代 01 AC-9.1 / AC-11.5）。
   * 一律 preventDefault 屏蔽浏览器右键菜单；展开区（.item-detail）内不切换完成。
   */
  function onRootContextMenu(occ, ctx, e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (closestIn(e && e.target, '.item-detail')) return;
    if (typeof ctx.onToggleDone === 'function') ctx.onToggleDone(occ);
  }

  /**
   * 键盘（契约 5）：
   *   Enter / Space 展开（焦点在根元素时；展开区内控件自行处理）
   *   Esc 收起，并把焦点还给根元素
   */
  function onRootKeydown(root, occ, ctx, expanded, e) {
    /* 迭代 10 条13：▲▼ 按钮下线后，无时卡片的次序改由列表内拖动 ——
       键盘用户的等价操作留在 Alt+↑ / Alt+↓（只对 card 变体生效）。 */
    if (e.altKey && ctx.variant === 'card' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      var move = e.key === 'ArrowUp' ? ctx.onMoveUp : ctx.onMoveDown;
      if (typeof move === 'function') {
        e.preventDefault();
        e.stopPropagation();
        move(occ);
        return;
      }
    }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      if (e.target !== root) return;
      e.preventDefault();
      if (!expanded) toggleExpand(occ, ctx, true);
      return;
    }
    if (e.key === 'Escape' || e.key === 'Esc') {
      if (!expanded) return;
      e.preventDefault();
      e.stopPropagation();
      toggleExpand(occ, ctx, false);
      if (typeof root.focus === 'function') root.focus();
    }
  }

  /* ---------------- 三种折叠态结构 ---------------- */

  function buildBlock(occ, ctx, cat, expanded) {
    var block = el('div', { class: 'tl-block' });
    applyFoldedState(block, occ, expanded, 'block');
    setVars(block, toneVars(cat));
    var width = blockWidth(occ, ctx);
    var tooNarrow = (width !== null && isTooNarrow(occ, ctx, width));
    if (width !== null && width < narrowPx()) block.classList.add('is-narrow');
    /* 迭代 8（F-53）：窄到放不下「…」→ 折叠态只留色块，点击/悬停后展开显示全部 */
    if (tooNarrow) {
      block.classList.add('is-tiny');
      block.setAttribute('data-tiny', '1');
    } else if (isOmitted(ctx, width)) {
      /* 2026-10-20：放不下标题但放得下「…」+首字 → 省略态 */
      block.classList.add('is-omitted');
      block.setAttribute('data-omit', '1');
    }

    /* 美化迭代 10 / 2026-10-20：
       标题行 = [省略号（仅省略态可见）] + 标题（flex:1，不省略、可换行）+ 类别胶囊；
       胶囊**取类别首字**，由 CSS 固定在块右上角（绝对定位，不参与标题行排版）。 */
    var head = el('div', { class: 'tl-titlerow' });
    head.appendChild(el('span', { class: 'tl-dots', text: '…', 'aria-hidden': 'true' }));
    head.appendChild(el('div', { class: 'tl-title', text: text(occ.title) }));
    /* 美化迭代 10 / 2026-10-30：日 / 周视图胶囊统一取类别**前两个字**（紧急 / 长期 / 短期 / 临时）。 */
    var chipText = firstChars(cat.name, 2);
    head.appendChild(el('span', {
      class: 'tl-chip',
      text: chipText,
      title: '类别：' + cat.name,
      'aria-label': '类别：' + cat.name
    }));
    block.appendChild(head);
    block.appendChild(el('div', { class: 'tl-time', text: timeText(occ) }));
    /* 四十五轮：重复类型与起止日期按事项选项显示（缺省显示）。
       折叠态单行省略，悬停 peek 时换行显示全文；完整文案同时放进 title。 */
    if (occ.showRepeat && occ.repeatLabel) {
      block.appendChild(el('div', { class: 'tl-repeat', text: occ.repeatLabel, title: occ.repeatLabel }));
    }
    var note = noteNode(occ, 'block');
    if (note) block.appendChild(note);
    if ((tooNarrow || block.classList.contains('is-omitted')) && !expanded) {
      bindHoverPeek(block, ctx);
    }
    return block;
  }

  function buildCard(occ, ctx, cat, expanded) {
    var li = el('li', { class: 'untimed-item' });
    applyFoldedState(li, occ, expanded, 'card');
    var tone = catTone(cat.color);
    setVars(li, toneVars(cat));

    // 序号：ctx.index 为 0 基数组下标（对齐迭代 2 的 list.forEach((occ, idx) → idx + 1)）
    var seq = (typeof ctx.index === 'number' && isFinite(ctx.index)) ? ctx.index + 1 : 1;
    li.appendChild(el('span', { class: 'ui-seq', text: String(seq) }));

    var main = el('button', {
      class: 'ui-main', type: 'button',
      'aria-label': '查看详情：' + text(occ.title)
    });
    /* 2026-10-30（用户口径）：类别色点移到标题左侧只作颜色提示；
       两位类别胶囊挂到这一条的最右侧（.ui-main 是 flex，胶囊靠 margin-left:auto 贴右）。 */
    main.appendChild(el('span', {
      class: 'ui-cat', style: 'background:' + (tone ? tone.accent : cat.color),
      title: '类别：' + cat.name, 'aria-label': '类别：' + cat.name
    }));
    main.appendChild(el('span', { class: 'ui-title', text: text(occ.title) }));
    /* 迭代 7（F-43）：card 变体不再渲染第二个 ui-cat「改」标签（与右上角角标同源，一并下线） */
    if (occ.showRepeat && occ.repeatLabel) main.appendChild(el('span', { class: 'muted', text: occ.repeatLabel }));
    var uiNote = noteNode(occ, 'card');
    if (uiNote) main.appendChild(uiNote);
    main.appendChild(el('span', {
      class: 'ui-chip', text: firstChars(cat.name, 2),
      title: '类别：' + cat.name
    }));
    li.appendChild(main);

    /* 迭代 10 条13：删掉折叠态的 ▲▼ 次序按钮 —— 次序改为**在列表里拖动**（视图层接线）。
       折叠态不再有任何操作按钮；编辑/删除仍在展开区。 */

    /* 迭代 7（F-43）：card 变体的紧急角标同样下线（只留 .is-urgent 颜色提示） */
    return li;
  }

  function buildWeek(occ, ctx, cat, expanded) {
    var item = el('div', { class: 'wk-item' });
    applyFoldedState(item, occ, expanded, 'week');
    setVars(item, toneVars(cat));

    // 迭代 6（F-39）：完成勾选框整体下线，时间行不再为其让位
    /* 美化迭代 10 / 2026-10-20：
       标题行 = [省略号（仅省略态可见）] + 标题（左对齐）+ 类别胶囊；
       胶囊取类别前两个字（与日视图、完成台同口径），由 CSS 固定在块右上角。 */
    var head = el('div', { class: 'wk-titlerow' });
    head.appendChild(el('span', { class: 'wk-dots', text: '…', 'aria-hidden': 'true' }));
    head.appendChild(el('div', { class: 'wk-title', text: text(occ.title) }));
    head.appendChild(el('span', {
      class: 'wk-chip',
      text: firstChars(cat.name, 2),
      title: '类别：' + cat.name,
      'aria-label': '类别：' + cat.name
    }));
    item.appendChild(head);
    item.appendChild(el('div', { class: 'wk-time', text: timeText(occ) }));
    var wkNote = noteNode(occ, 'week');
    if (wkNote) item.appendChild(wkNote);
    /* 迭代 8（F-53）：周视图的窄块标记**只认视图注入的布尔值**（像素宽由 week-layout 判定），
       这里刻意不用 blockWidth() 的回退估算 —— 周视图的可用宽度不是本组件能知道的。
       2026-10-20：两级 —— tooNarrow（连「…」都放不下）→ 微块；omit（放不下标题）→ 省略态。 */
    var weekTooNarrow = (ctx.tooNarrow === true);
    if (weekTooNarrow) {
      item.classList.add('is-tiny');
      item.setAttribute('data-tiny', '1');
    } else if (ctx.omit === true) {
      item.classList.add('is-omitted');
      item.setAttribute('data-omit', '1');
    }
    if ((weekTooNarrow || item.classList.contains('is-omitted')) && !expanded) {
      bindHoverPeek(item, ctx);
    }
    return item;
  }

  /* ---------------- 无障碍标签 ---------------- */

  function labelFor(occ, cat, ctx) {
    var urgent = isUrgent(occ) ? urgentName(ctx) + '，' : '';
    return urgent + (occ.time ? text(occ.time.start) + ' 到 ' + text(occ.time.end) + ' ' : '') +
      text(occ.title) + '（' + cat.name + '）';
  }

  function titleFor(occ, ctx) {
    var base = (occ.time ? timeText(occ) + ' ' : '') + text(occ.title);
    if (isUrgent(occ)) base = '【' + urgentName(ctx) + '】' + base;
    /* 迭代 6（F-39）：完成标记改为右键，折叠态用 tooltip 提示可发现性。
       触屏没有右键 → 提示改为「点开后可标记完成」。 */
    if (touchMode(ctx)) return base + '（点开后可标记完成）';
    return base + (occ.done ? '（右键单击取消完成）' : '（右键单击标记完成）');
  }

  /**
   * 展开态：点卡片外部任意位置 → 收起（迭代 7 / F-45 第 4 条，用户裁定 R-25）。
   * - 忽略「刚触发展开的那一次点击」（自击穿），用事件对象同一性判定，不依赖延迟；
   * - 卡片已被重渲染移除（或本就不在文档里）→ 不动，并自解绑；
   * - 捕获阶段优先触发：即使外部元素 stopPropagation 也能收起；
   * - 无 document（Node 纯函数环境 / 垫片降级）时静默跳过。
   */
  function bindDismissOnOutside(node, occ, ctx) {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    var doc = document;
    /** 是否仍在文档树里（不依赖 isConnected：垫片与部分环境缺失该属性） */
    function stillConnected() {
      if (node.isConnected === true) return true;
      if (typeof node.contains !== 'function') return true;   // 无法判定：按仍有效处理
      var root = doc.documentElement;
      return !!(root && typeof root.contains === 'function' && root.contains(node));
    }
    function inNode(target) {
      if (!target) return false;
      if (node === target) return true;
      if (typeof node.contains === 'function' && node.contains(target)) return true;
      var p = target;
      while (p) {
        if (p === node) return true;
        p = p.parentNode;
      }
      return false;
    }
    function detach() {
      doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('mousedown', onDown, true);
      doc.removeEventListener('keydown', onKey, true);
    }
    function onDown(e) {
      if (!stillConnected()) { detach(); return; }
      if (inNode(e && e.target)) return;
      toggleExpand(occ, ctx, false);
    }
    function onKey(e) {
      if (!e || (e.key !== 'Escape' && e.key !== 'Esc')) return;
      if (!stillConnected()) { detach(); return; }
      if (e.preventDefault) e.preventDefault();
      toggleExpand(occ, ctx, false);
      if (typeof node.focus === 'function') node.focus();
    }
    /* 用 pointerdown（按下即收起）而不是 click：
       ① 它发生在 click 之前，打开卡片的那一次点击不会立刻把卡片收起（自击穿）；
       ② 需要绕开「垫片不执行捕获阶段、document 级监听在冒泡链之外同步执行」的差异；
       ③ 未实现 Pointer Events 的环境（如 Node 垫片）退回 mousedown。 */
    doc.addEventListener('pointerdown', onDown, true);
    if (typeof doc.addEventListener === 'function') doc.addEventListener('mousedown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
  }

  /* ---------------- 工厂入口 ---------------- */

  /**
   * @param {object} occ Occurrence（DM-5）
   * @param {object} ctx 见 §2.10
   * @returns {HTMLElement} div.tl-block | li.untimed-item | div.wk-item
   */
  function createItemCard(occ, ctx) {
    occ = occ || {};
    ctx = ctx || {};
    var expanded = !!ctx.expanded;
    var variant = ctx.variant === 'card' ? 'card' : (ctx.variant === 'week' ? 'week' : 'block');
    var cat = categoryOf(ctx, occ);

    var node = variant === 'card' ? buildCard(occ, ctx, cat, expanded)
      : variant === 'week' ? buildWeek(occ, ctx, cat, expanded)
        : buildBlock(occ, ctx, cat, expanded);

    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    /* 迭代 6（F-39）：勾选框下线后，完成状态仍要能被辅助技术读到 → role=button + aria-pressed */
    node.setAttribute('aria-pressed', occ.done ? 'true' : 'false');
    /* 迭代 7（F-43）：紧急角标下线，颜色提示之外的语义由 aria / title 承担（无文字角标） */
    if (isUrgent(occ)) node.setAttribute('data-urgent', '1');
    node.setAttribute('title', titleFor(occ, ctx));
    node.setAttribute('aria-label', labelFor(occ, cat, ctx));

    node.addEventListener('click', function (e) { onRootClick(occ, ctx, expanded, e); });
    /* 迭代 6（F-39）：右键切换完成（取代勾选框） */
    node.addEventListener('contextmenu', function (e) { onRootContextMenu(occ, ctx, e); });
    node.addEventListener('keydown', function (e) { onRootKeydown(node, occ, ctx, expanded, e); });

    if (expanded) {
      node.appendChild(detailNode(occ, ctx));
      if (variant !== 'card') applyExpandLayout(node, occ, ctx, variant);
      bindDismissOnOutside(node, occ, ctx);
    }
    return node;
  }

  return { createItemCard: createItemCard };
});
