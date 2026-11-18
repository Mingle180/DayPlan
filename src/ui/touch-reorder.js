/**
 * DayPlan · 列表长按拖动排序（F-108，手机端）
 *
 * 触屏专用：长按 320ms 起拖，跟手把行插到指针所在位置，松手提交新顺序。
 * 鼠标不接管（桌面端计划行用 HTML5 拖拽：落列表内排序 / 落网格复制）。
 * 起拖后抑制 click，避免手机「单击=完成」误触发。
 *
 * attach(listEl, {
 *   rowSelector, getId(row)->string|null,
 *   onReorder(ids), onSuppress(ms), onDragChange(bool)
 * }) -> { destroy }
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.touchReorder = factory(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LONG_PRESS_MS = 320;
  var SLOP_PX = 8;
  var SUPPRESS_MS = 450;

  function attach(listEl, opts) {
    opts = opts || {};
    var rowSelector = opts.rowSelector || '.wp-item';
    var getId = typeof opts.getId === 'function' ? opts.getId : function (row) {
      return row.getAttribute ? row.getAttribute('data-plan-id') : null;
    };
    var onReorder = typeof opts.onReorder === 'function' ? opts.onReorder : function () {};
    var onSuppress = typeof opts.onSuppress === 'function' ? opts.onSuppress : function () {};
    var onDragChange = typeof opts.onDragChange === 'function' ? opts.onDragChange : function () {};

    var press = null;
    var drag = null;

    function rowOf(target) {
      var n = target;
      while (n && n !== listEl) {
        if (n.classList && n.matches && n.matches(rowSelector)) return n;
        n = n.parentNode;
      }
      return null;
    }

    function rows() {
      var out = [];
      var children = listEl.children;
      for (var i = 0; i < children.length; i += 1) {
        if (children[i].matches && children[i].matches(rowSelector)) out.push(children[i]);
      }
      return out;
    }

    function cancelPress() {
      if (press && press.timer) clearTimeout(press.timer);
      press = null;
      detach();
    }

    function beginDrag(p) {
      if (p.timer) clearTimeout(p.timer);
      drag = { row: p.row, startY: p.y };
      if (p.row.classList) p.row.classList.add('is-dragging');
      onDragChange(true);
      onSuppress(SUPPRESS_MS);
      if (press === p) press = null;
    }

    function moveDrag(y) {
      if (!drag) return;
      var list = rows();
      var before = null;
      for (var i = 0; i < list.length; i += 1) {
        var n = list[i];
        if (n === drag.row || !n.getBoundingClientRect) continue;
        var r = n.getBoundingClientRect();
        if (y < r.top + r.height / 2) { before = n; break; }
      }
      if (before) {
        if (drag.row.nextSibling !== before) listEl.insertBefore(drag.row, before);
      } else if (list.length) {
        /* 落到末尾：插在最后一个可拖行之后（不越过列表里不参与排序的行） */
        var last = list[list.length - 1];
        if (last !== drag.row && last.nextSibling !== drag.row) {
          listEl.insertBefore(drag.row, last.nextSibling);
        }
      }
    }

    function endDrag() {
      if (!drag) return;
      var row = drag.row;
      drag = null;
      if (row.classList) row.classList.remove('is-dragging');
      onDragChange(false);
      onSuppress(SUPPRESS_MS);
      var ids = rows().map(getId).filter(function (v) { return !!v; });
      onReorder(ids);
    }

    function onMove(e) {
      if (drag) {
        if (e.cancelable !== false && e.preventDefault) e.preventDefault();
        moveDrag(e.clientY);
        return;
      }
      if (!press) return;
      var dx = Math.abs(e.clientX - press.x);
      var dy = Math.abs(e.clientY - press.y);
      if (dx > SLOP_PX || dy > SLOP_PX) cancelPress();
    }

    function onUp() {
      if (press) cancelPress();
      detach();
      endDrag();
    }

    function detach() {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
    }

    function onDown(e) {
      if (drag) return;
      if (e.pointerType === 'mouse') return;
      if (typeof e.button === 'number' && e.button !== 0) return;
      var row = rowOf(e.target);
      if (!row || !getId(row)) return;
      press = { row: row, x: e.clientX, y: e.clientY, timer: null };
      var p = press;
      press.timer = setTimeout(function () {
        if (press === p) beginDrag(p);
      }, LONG_PRESS_MS);
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
    }

    if (listEl) listEl.addEventListener('pointerdown', onDown);

    return {
      destroy: function () {
        cancelPress();
        if (drag) { drag.row.classList.remove('is-dragging'); drag = null; }
        if (listEl) listEl.removeEventListener('pointerdown', onDown);
      }
    };
  }

  return { attach: attach, LONG_PRESS_MS: LONG_PRESS_MS };
});