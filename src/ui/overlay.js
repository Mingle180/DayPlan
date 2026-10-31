/**
 * DayPlan · src/ui/overlay.js
 * 展开卡浮层（临时脱离裁切上下文）——契约见 docs/spec/07-iteration-4-delta.md DM-25 / ADR-22 / ADR-25。
 *
 * 背景：`#timeline-scroll` / `.week-scroll` 需要 `overflow-x:auto`，
 * 而 CSS 规定一轴为 auto 时另一轴无法为 visible → 展开卡会被纵向裁切（用户条目 6）。
 * 做法：展开时把**同一个节点**临时切到 `position:fixed`（fixed 不受祖先 overflow 裁切），
 * 位置由「锚点相对参照容器（轨道）的偏移」+「参照容器当前视口矩形」推导，滚动/缩放时重算。
 * 不做节点克隆、不新增浮层宿主，收起时恢复原始内联样式。
 *
 * 降级：环境缺 getBoundingClientRect（如 Node DOM 垫片）→ pin() 返回 false，调用方保持原位展开。
 *
 * 零依赖；UMD 头：window.DayPlan.overlay / module.exports。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.DayPlan = root.DayPlan || {}; root.DayPlan.overlay = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_Z_INDEX = 60;
  var DEFAULT_MIN_WIDTH = 220;
  var PIN_CLASS = 'is-pinned-expand';
  var FIT_CLASS = 'is-expanded-fitted';
  var RETRY_LIMIT = 20;   /* 未布局（矩形退化）时的最大重试帧数，超过则释放并降级为原位展开 */
  /* 卡片收进滚动容器时四周留的空隙（像素）。改这里要同步 docs/spec 的 DM-25 口径。 */
  var CLIP_PAD = 6;

  function num(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  function hasRect(node) {
    return !!(node && typeof node.getBoundingClientRect === 'function');
  }

  /**
   * 矩形是否「尚未布局」。
   * 脱离文档的元素 getBoundingClientRect() 返回全 0；若拿它当锚点会把卡片钉到页面左上角
   * （迭代 5 用户条目 2 的真根因：周视图在列节点插入文档前就 pin 了）。
   */
  function isDegenerate(rect) {
    if (!rect) return true;
    return rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0;
  }

  /**
   * 纯几何：卡片盒与容器盒的「收进可视区」方案。
   * @param {{top:number,bottom:number,height:number}} card
   * @param {{top:number,bottom:number,height:number}} box 滚动容器（裁切盒）
   * @param {number} [pad] 四周留白
   * @returns {{top:number,maxHeight:number}|null} null = 不用动；maxHeight>0 表示要封顶
   */
  function planClipFit(card, box, pad) {
    var gap = num(pad, CLIP_PAD);
    if (!card || !box) return null;
    var cardH = num(card.height, 0);
    var boxH = num(box.height, 0);
    if (!(cardH > 0) || !(boxH > 0)) return null;
    if (!(num(card.bottom, 0) > num(box.bottom, 0) - gap)) return null;   /* 没越过下沿 */
    var avail = Math.max(80, Math.round(boxH - gap * 2));
    var height = Math.min(cardH, avail);
    var top = Math.min(Math.max(num(card.top, 0), box.top + gap), box.bottom - gap - height);
    if (!isFinite(top)) return null;
    return { top: Math.round(top), maxHeight: cardH > avail ? avail : 0 };
  }

  function nowRaf() {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame;
    return function (fn) { return setTimeout(fn, 16); };
  }

  /**
   * @param {Object} [options] {zIndex=60, minWidth=220}
   * @returns {{pin, release, releaseAll, sync, isPinned, destroy, count}}
   */
  function createExpandPinner(options) {
    var opts = options || {};
    var zIndex = num(opts.zIndex, DEFAULT_Z_INDEX);
    var minWidth = num(opts.minWidth, DEFAULT_MIN_WIDTH);
    var raf = nowRaf();

    var entries = [];        // {node, ref, dx, dy, width, prev}
    var frame = null;
    var listening = false;

    function rememberInline(node) {
      return {
        position: node.style.position || '',
        left: node.style.left || '',
        top: node.style.top || '',
        width: node.style.width || '',
        zIndex: node.style.zIndex || '',
        maxWidth: node.style.maxWidth || '',
        maxHeight: node.style.maxHeight || '',
        overflowY: node.style.overflowY || ''
      };
    }

  /**
   * 卡片底部此刻是否真的能被点到。
   *
   * 为什么需要它：`position: fixed` 按规范不受祖先 overflow 裁切，桌面 Chromium 与
   * WebKit 都如此；但 iOS 的 WebKit 会把滚动容器里的 fixed 后代**一起裁掉**。
   * 那种引擎里 `getBoundingClientRect()` 仍是完整矩形（几何看不出问题），
   * 只有真实命中测试能发现「这一块根本点不到」。2026-10-31 用户截图
   * 「日视图点下排事项，展开块被挡住」正是这种形态：卡片下半截（按钮）被时间轴容器切掉。
   *
   * 没有命中测试能力的环境（Node 垫片 / 无 document）一律当作可见，
   * 这样既有断言不会被这条兜底改写。
   */
  function bottomReachable(node, box) {
    if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return true;
    var x = Math.round(box.left + box.width / 2);
    var y = Math.round(box.bottom - 4);
    var hit = null;
    try { hit = document.elementFromPoint(x, y); } catch (e) { return true; }
    /* 点在视口外（返回 null）：同样说明用户看不到卡片底部 */
    if (!hit) return false;
    return hit === node || !!(node.contains && node.contains(hit));
  }

  /**
   * 把展开卡收进滚动容器的可视区 —— 只在「确实被容器裁掉」时动手。
   * 判定顺序：先看矩形有没有越过容器下沿，再做一次命中测试确认引擎真的裁了它。
   * 正常引擎里 fixed 卡片命中测试落在自己身上 → 原样保留（可以盖到下面的卡片上）。
   * @returns {boolean} true = 做了收缩
   */
  function fitIntoClip(node, clip) {
    if (!hasRect(clip)) return false;
    var cr = clip.getBoundingClientRect();
    var box = node.getBoundingClientRect();
    var plan = planClipFit(box, cr, CLIP_PAD);
    if (!plan) return false;
    if (bottomReachable(node, box)) return false;             /* 引擎没裁 → 保持浮层 */
    node.style.top = plan.top + 'px';
    /* 卡片比容器还高：按容器高度封顶，内容在卡片内部滚动，绝不把按钮切掉 */
    if (plan.maxHeight > 0) {
      node.style.maxHeight = plan.maxHeight + 'px';
      node.style.overflowY = 'auto';
    }
    if (node.classList && node.classList.add) node.classList.add(FIT_CLASS);
    return true;
  }

  function applyFixed(node, ref, dx, dy, width, clip) {
    var r = ref.getBoundingClientRect();
    /* 2026-10-21（用户裁定）：展开卡默认与原块**完全重叠**（宽、左、顶都取原几何）。
       只有会放大/超出原块的面板才需要夹回视口：
         · is-expanded-grow —— 折叠时太小而省略 / 只剩色块；
         · is-expanded-fit  —— 日视图较窄的块（竖排按钮，允许适当超出原块）。
       普通块夹取反而会破坏重叠。 */
    var grow = !!(node.classList &&
      (node.classList.contains('is-expanded-grow') || node.classList.contains('is-expanded-fit')));
    node.style.position = 'fixed';
    node.style.width = Math.round(width) + 'px';
    node.style.top = Math.round(r.top + dy) + 'px';
    node.style.zIndex = String(zIndex);
    if (node.classList && node.classList.add) node.classList.add(PIN_CLASS);
    var left = Math.round(r.left + dx);
    if (grow) {
      /* 加类后 CSS min-width 可能把面板撑宽 → 用真实宽度把右边缘夹回视口 */
      var effective = width;
      try {
        var nr = node.getBoundingClientRect();
        if (nr && nr.width > 0) effective = nr.width;
      } catch (e) { /* 无布局能力 → 退回传入宽度 */ }
      var vw = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 0;
      if (vw > 0 && effective > 0 && left + effective > vw - 8) {
        left = Math.max(8, Math.round(vw - 8 - effective));
      }
      /* 2026-10-30：手机档的展开卡由 CSS 放大到接近屏宽，靠「右边缘夹回」会贴在原块左侧、
         整卡偏右。窄屏改为水平居中（仅 grow 面板，普通块的重叠定位不受影响）。 */
      if (vw > 0 && vw <= 640 && effective > 0 && effective <= vw - 16) {
        left = Math.round((vw - effective) / 2);
      }
    }
    node.style.left = left + 'px';
    if (grow) {
      /* 2026-10-30：手机端展开卡可大于原块 → 纵向也要夹回视口，避免下半截按钮落在屏幕外。
         CSS 已给 max-height，这里只负责补出被底边裁掉的高度。 */
      try {
        var vh = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 0;
        var box = node.getBoundingClientRect();
        if (vh > 0 && box && box.height > 0) {
          var top = r.top + dy;
          if (top + box.height > vh - 8) top = Math.max(8, vh - 8 - box.height);
          if (top < 8) top = 8;
          node.style.top = Math.round(top) + 'px';
        }
      } catch (e) { /* 无布局能力 → 保持原位 */ }
    }
    /* 2026-10-31（用户反馈「日视图点下排事项，展开块被挡住」）：
       某些引擎（iOS WebKit）会把滚动容器里的 fixed 后代一起裁掉 —— 几何正常、
       画面被切、按钮点不到。这里做最后一次实测：真被裁了就把卡片收进容器可视区。 */
    if (clip) fitIntoClip(node, clip);
  }

    /**
     * 测量并定位一个条目。
     * @returns {boolean} true = 已定位（或本轮刚测量成功）；false = 仍未布局，等下一次 sync
     */
    function position(entry) {
      if (!entry.measured) {
        var nr = hasRect(entry.node) ? entry.node.getBoundingClientRect() : null;
        var rr = hasRect(entry.ref) ? entry.ref.getBoundingClientRect() : null;
        /* 参照容器或卡片还没进文档 → 不施加 fixed，等元素真正布局后再测（D2） */
        if (isDegenerate(rr) || isDegenerate(nr)) {
          entry.retries = (entry.retries || 0) + 1;
          return false;
        }
        entry.dx = nr.left - rr.left;
        entry.dy = nr.top - rr.top;
        entry.width = Math.max(num(nr.width, 0), minWidth);
        entry.measured = true;
      }
      applyFixed(entry.node, entry.ref, entry.dx, entry.dy, entry.width, entry.clip);
      return true;
    }

    function schedule() {
      if (frame !== null) return;
      frame = raf(function () {
        frame = null;
        sync();
      });
      if (frame && typeof frame.unref === 'function') frame.unref();
    }

    function onScrollResize() { schedule(); }

    function listen() {
      if (listening) return;
      listening = true;
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('scroll', onScrollResize, true);
        window.addEventListener('resize', onScrollResize);
      }
    }

    function unlisten() {
      if (!listening) return;
      listening = false;
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('scroll', onScrollResize, true);
        window.removeEventListener('resize', onScrollResize);
      }
    }

    function isPinned(node) {
      for (var i = 0; i < entries.length; i += 1) {
        if (entries[i].node === node) return true;
      }
      return false;
    }

    /**
     * 展开卡脱离裁切上下文（F-34）。
     * 允许在元素**尚未插入文档**时调用：此时矩形退化，先登记为 pending，
     * 由挂载后的 `sync()`（或视图侧显式调用）完成测量与定位，绝不把卡片钉到 (0,0)。
     * @param {HTMLElement} node 展开的事项卡
     * @param {HTMLElement} ref  参照容器（日视图 = #timeline-track；周视图 = .wk-col）
     * @param {{clip?:HTMLElement}} [o] clip = 会裁切展开卡的滚动容器（日视图 = .timeline-scroll；
     *        周视图 = .week-scroll）。给了它才做「被裁就收进容器」的兜底，不给则维持老行为。
     * @returns {boolean} true = 已登记（本帧或下一帧定位，含 pending）；false = 环境不支持，调用方原位展开
     */
    function pin(node, ref, o) {
      if (!node || !ref) return false;
      if (!hasRect(node) || !hasRect(ref)) return false;
      if (isPinned(node)) return true;

      var nr = node.getBoundingClientRect();
      var rr = ref.getBoundingClientRect();
      var entry = {
        node: node,
        ref: ref,
        clip: (o && o.clip) || null,
        dx: 0,
        dy: 0,
        width: 0,
        retries: 0,
        measured: false,
        prev: rememberInline(node)
      };
      if (!isDegenerate(rr) && !isDegenerate(nr)) {
        entry.dx = nr.left - rr.left;
        entry.dy = nr.top - rr.top;
        entry.width = Math.max(num(nr.width, 0), minWidth);
        entry.measured = true;
      }
      entries.push(entry);
      listen();
      if (entry.measured) position(entry); else schedule();
      return true;
    }

    /** 收起：恢复原始内联样式。 */
    function release(node) {
      for (var i = entries.length - 1; i >= 0; i -= 1) {
        var entry = entries[i];
        if (entry.node !== node) continue;
        var p = entry.prev;
        entry.node.style.position = p.position;
        entry.node.style.left = p.left;
        entry.node.style.top = p.top;
        entry.node.style.width = p.width;
        entry.node.style.zIndex = p.zIndex;
        entry.node.style.maxWidth = p.maxWidth;
        entry.node.style.maxHeight = p.maxHeight;
        entry.node.style.overflowY = p.overflowY;
        if (entry.node.classList && entry.node.classList.remove) {
          entry.node.classList.remove(PIN_CLASS);
          entry.node.classList.remove(FIT_CLASS);
        }
        entries.splice(i, 1);
      }
      if (!entries.length) unlisten();
    }

    function releaseAll() {
      for (var i = entries.length - 1; i >= 0; i -= 1) release(entries[i].node);
    }

    /** 重算所有已固定节点的位置（滚动 / 缩放 / 数据重排 / 挂载完成后调用）。 */
    function sync() {
      var pending = false;
      for (var i = 0; i < entries.length; i += 1) {
        /* 只把「明确已脱离文档」视为失效：isConnected 在部分环境/垫片里不存在，
           用 !node.isConnected 会把仍挂载的节点误判为失效（曾导致垫片环境假释放/类残留）。 */
        if (entries[i].node.isConnected === false) {
          release(entries[i].node);
          i -= 1;
          continue;
        }
        if (!position(entries[i])) {
          if ((entries[i].retries || 0) >= RETRY_LIMIT) {
            /* 始终测不到（长期未布局）→ 放弃浮层，恢复原位展开，不残留 fixed/类（D2 降级） */
            release(entries[i].node);
            i -= 1;
            continue;
          }
          pending = true;
        }
      }
      if (pending) schedule();
    }

    function destroy() {
      releaseAll();
      unlisten();
      if (frame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frame);
        frame = null;
      }
    }

    return {
      pin: pin,
      release: release,
      releaseAll: releaseAll,
      sync: sync,
      isPinned: isPinned,
      destroy: destroy,
      count: function () { return entries.length; }
    };
  }

  return {
    PIN_CLASS: PIN_CLASS,
    FIT_CLASS: FIT_CLASS,
    CLIP_PAD: CLIP_PAD,
    DEFAULT_Z_INDEX: DEFAULT_Z_INDEX,
    DEFAULT_MIN_WIDTH: DEFAULT_MIN_WIDTH,
    planClipFit: planClipFit,
    createExpandPinner: createExpandPinner
  };
});
