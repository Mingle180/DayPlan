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
  var RETRY_LIMIT = 20;   /* 未布局（矩形退化）时的最大重试帧数，超过则释放并降级为原位展开 */

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
        maxWidth: node.style.maxWidth || ''
      };
    }

  function applyFixed(node, ref, dx, dy, width) {
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
      applyFixed(entry.node, entry.ref, entry.dx, entry.dy, entry.width);
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
     * @returns {boolean} true = 已登记（本帧或下一帧定位，含 pending）；false = 环境不支持，调用方原位展开
     */
    function pin(node, ref) {
      if (!node || !ref) return false;
      if (!hasRect(node) || !hasRect(ref)) return false;
      if (isPinned(node)) return true;

      var nr = node.getBoundingClientRect();
      var rr = ref.getBoundingClientRect();
      var entry = {
        node: node,
        ref: ref,
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
        if (entry.node.classList && entry.node.classList.remove) entry.node.classList.remove(PIN_CLASS);
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
    DEFAULT_Z_INDEX: DEFAULT_Z_INDEX,
    DEFAULT_MIN_WIDTH: DEFAULT_MIN_WIDTH,
    createExpandPinner: createExpandPinner
  };
});
