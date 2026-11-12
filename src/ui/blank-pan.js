/**
 * DayPlan - src/ui/blank-pan.js
 * 时间表空白「鼠标拖拽平移」（三十九轮 / F-88）。
 *
 * 用户口径：日 / 周视图的时间表用鼠标拖住空白的地方可以拖动查看（代替滚轮），
 * 周视图要能斜向拖动。仅鼠标左键生效；触屏手势与滚轮完全不变。
 *
 * 设计：一个与视图无关的小工厂 attach(opts)，日 / 周各自传入滚动目标与排除区。
 *   - container：接收 pointerdown 的容器（事件自空白处冒泡上来）。
 *   - scrollX / scrollY：横向 / 纵向跟随的滚动元素（null 表示该方向不平移）。
 *   - exclude：选择器串，命中（含后代）的元素上按下不启动平移（事项块 / 手柄 / 表头 / 控件）。
 *   - onSuppress(ms)：平移结束后通知视图设置 dragSuppressUntil（与既有拖拽抑制同模式）。
 *
 * 交互：按下位移 >4px 才进入平移（以下视为点击，不拦截）；进入即 setPointerCapture、
 * preventDefault 阻止文本选择、body.is-panning（光标 grabbing + user-select:none）；
 * 结束后 250ms 内用 document 捕获吞掉一次 click，防止误开新建 / 误进日视图。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.DayPlan = root.DayPlan || {}; root.DayPlan.blankPan = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var THRESHOLD = 4;       // 位移阈值（px）：以下视为点击
  var SUPPRESS_MS = 250;   // 平移结束后抑制 click 的窗口

  function attach(opts) {
    opts = opts || {};
    var container = opts.container;
    if (!container || typeof container.addEventListener !== 'function') {
      return { destroy: function () {} };
    }
    var scrollX = opts.scrollX || null;
    var scrollY = opts.scrollY || null;
    var exclude = opts.exclude || '';
    var doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    var body = doc ? doc.body : null;
    var st = null;          // { x, y, left, top, pointerId, active }
    var clickBlocker = null;

    function excluded(target) {
      if (!exclude || !target || typeof target.closest !== 'function') return false;
      try { return !!target.closest(exclude); } catch (e) { return false; }
    }

    function blockClick() {
      if (!doc || typeof doc.addEventListener !== 'function') return;
      clickBlocker = function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        if (e && e.preventDefault) e.preventDefault();
        unblockClick();
      };
      doc.addEventListener('click', clickBlocker, true);
      setTimeout(unblockClick, SUPPRESS_MS);
    }
    function unblockClick() {
      if (clickBlocker && doc) doc.removeEventListener('click', clickBlocker, true);
      clickBlocker = null;
    }

    function onDown(e) {
      if (!e || e.pointerType !== 'mouse' || e.button !== 0) return;
      if (st) return;
      if (excluded(e.target)) return;
      st = {
        x: e.clientX, y: e.clientY, pointerId: e.pointerId, active: false,
        left: scrollX ? (Number(scrollX.scrollLeft) || 0) : 0,
        top: scrollY ? (Number(scrollY.scrollTop) || 0) : 0
      };
      if (doc) {
        doc.addEventListener('pointermove', onMove, true);
        doc.addEventListener('pointerup', onUp, true);
        doc.addEventListener('pointercancel', onUp, true);
      }
    }

    function onMove(e) {
      if (!st) return;
      if (st.pointerId !== undefined && e && e.pointerId !== undefined && e.pointerId !== st.pointerId) return;
      var dx = e.clientX - st.x;
      var dy = e.clientY - st.y;
      if (!st.active) {
        if (Math.abs(dx) <= THRESHOLD && Math.abs(dy) <= THRESHOLD) return;
        st.active = true;
        try {
          if (container.setPointerCapture && st.pointerId !== undefined) container.setPointerCapture(st.pointerId);
        } catch (err) { /* 垫片 / 老内核忽略 */ }
        if (body && body.classList) body.classList.add('is-panning');
      }
      if (e && e.preventDefault) e.preventDefault();
      /* 抓住内容拖动：指针左移 dx<0 → 看到右侧 → scrollLeft 增 */
      if (scrollX) scrollX.scrollLeft = st.left - dx;
      if (scrollY) scrollY.scrollTop = st.top - dy;
    }

    function onUp(e) {
      if (!st) return;
      if (st.pointerId !== undefined && e && e.pointerId !== undefined && e.pointerId !== st.pointerId) return;
      var wasActive = st.active;
      try {
        if (container.releasePointerCapture && st.pointerId !== undefined) container.releasePointerCapture(st.pointerId);
      } catch (err) { /* 忽略 */ }
      if (body && body.classList) body.classList.remove('is-panning');
      if (doc) {
        doc.removeEventListener('pointermove', onMove, true);
        doc.removeEventListener('pointerup', onUp, true);
        doc.removeEventListener('pointercancel', onUp, true);
      }
      st = null;
      if (wasActive) {
        blockClick();
        if (typeof opts.onSuppress === 'function') opts.onSuppress(SUPPRESS_MS);
      }
    }

    container.addEventListener('pointerdown', onDown);

    return {
      destroy: function () {
        container.removeEventListener('pointerdown', onDown);
        if (st) onUp({ pointerId: st.pointerId });
        unblockClick();
      }
    };
  }

  return { attach: attach, THRESHOLD: THRESHOLD, SUPPRESS_MS: SUPPRESS_MS };
});