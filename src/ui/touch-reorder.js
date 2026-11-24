/**
 * DayPlan · 列表指针拖动排序（F-108 手机长按；F-110 桌面鼠标 + 贴边自动滚动；F-117 可选网格落点；F-118 跟手幽灵 + 三向边缘滚动）
 *
 * 触屏：长按 320ms 起拖；鼠标（allowMouse）：按下移动超过阈值即起拖。
 * 跟手把行插到指针所在位置，松手提交新顺序；起拖后抑制 click，避免误触发完成/编辑。
 * 指针停在列表上下边缘时自动滚动（edgeScroll），让长列表能拖到需要滚动才到的位置。
 *
 * attach(listEl, {
 *   rowSelector, getId(row)->string|null, allowMouse,
 *   onReorder(ids), onSuppress(ms), onDragChange(bool),
 *   gridOf(node)->col|null, onGridMove(col,x,y), onGridLeave(), onGridDrop(col,x,y,id), hitTest(x,y),
 *   makeGhost(row)->element|null, edgeTargets:[{ target, axis:'y'|'x', when:'list'|'grid'|'always' }]
 * }) -> { destroy, abort }
 *   传 gridOf 时启用「落点决定去向」：命中网格列 → 网格模式（源行归位，松手交 onGridDrop）；
 *   命中列表 → 列表模式（跟手换序，松手交 onReorder）；两者都不在 → 保持（不写不改）。
 *   传 makeGhost 时起拖建跟手克隆（触摸上抬 36px 不挡手指），松手/abort 摘除；不传则不建。
 *   edgeTargets 按 when 门控额外边缘滚动（页面竖滚 / 网格横滚），滚动时重算落点。
 *   不传 gridOf / makeGhost / edgeTargets 时行为与旧版逐条一致（月面板）。
 *
 * edgeScroll(target, { axis, getPos|getY, onScroll, edge, maxSpeed }) -> { start, stop, stepFor }
 *   纯几何驱动，可脱离 DOM 单测。target 可以是元素（fake 只需 getBoundingClientRect/scrollHeight/clientHeight/scrollTop），
 *   也可以是适配器 { getRect, getScroll, setScroll, getScrollSize, getClientSize }（文档滚动取视口矩形）。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.touchReorder = factory(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var LONG_PRESS_MS = 320;
  var SLOP_PX = 8;
  var SUPPRESS_MS = 450;
  var EDGE_PX = 48;
  var MAX_SPEED = 18;
  var GHOST_LIFT_PX = 36;

  /** 贴边自动滚动：指针进入上/下（横轴左/右）EDGE_PX 带内按接近程度变速滚动，离带即停。
      target 可以是元素，也可以是适配器 { getRect, getScroll, setScroll, getScrollSize, getClientSize }
      ——文档滚动时 documentElement 的矩形是全高负顶，不能当视口用，故由调用方给视口矩形。 */
  function edgeScroll(target, opts) {
    opts = opts || {};
    var axis = opts.axis === 'x' ? 'x' : 'y';
    var edge = typeof opts.edge === 'number' ? opts.edge : EDGE_PX;
    var maxSpeed = typeof opts.maxSpeed === 'number' ? opts.maxSpeed : MAX_SPEED;
    var getPos = typeof opts.getPos === 'function' ? opts.getPos
      : (typeof opts.getY === 'function' ? opts.getY : function () { return null; });
    var onScroll = typeof opts.onScroll === 'function' ? opts.onScroll : function () {};
    var rafFn = (root && typeof root.requestAnimationFrame === 'function')
      ? function (cb) { return root.requestAnimationFrame(cb); }
      : function (cb) { return setTimeout(function () { cb(Date.now()); }, 16); };
    var cancelFn = (root && typeof root.cancelAnimationFrame === 'function')
      ? function (id) { root.cancelAnimationFrame(id); }
      : function (id) { clearTimeout(id); };
    var handle = null;
    var isAdapter = !!target && typeof target.getRect === 'function';

    function rectOf() {
      if (isAdapter) return target.getRect();
      return (target && target.getBoundingClientRect) ? target.getBoundingClientRect() : null;
    }
    function scrollSize() {
      if (isAdapter) return target.getScrollSize();
      return axis === 'x' ? target.scrollWidth : target.scrollHeight;
    }
    function clientSize() {
      if (isAdapter) return target.getClientSize();
      return axis === 'x' ? target.clientWidth : target.clientHeight;
    }
    function getScroll() {
      if (isAdapter) return Number(target.getScroll()) || 0;
      return Number(axis === 'x' ? target.scrollLeft : target.scrollTop) || 0;
    }
    function setScroll(v) {
      if (isAdapter) { target.setScroll(v); return; }
      if (axis === 'x') target.scrollLeft = v; else target.scrollTop = v;
    }

    /** 单帧滚动量（px）：带外 0，带内随接近边缘线性增大到 maxSpeed。导出供单测。 */
    function stepFor(pos, rect, size, client) {
      if (pos == null || !(size > client) || !rect) return 0;
      var lo = axis === 'x' ? rect.left : rect.top;
      var hi = axis === 'x' ? rect.right : rect.bottom;
      var d = 0;
      if (pos < lo + edge) {
        var t = (pos - lo) / edge;
        if (t < 0) t = 0; if (t > 1) t = 1;
        d = -Math.ceil(maxSpeed * (1 - t));
      } else if (pos > hi - edge) {
        var b = (hi - pos) / edge;
        if (b < 0) b = 0; if (b > 1) b = 1;
        d = Math.ceil(maxSpeed * (1 - b));
      }
      return d;
    }

    function tick() {
      var pos = getPos();
      if (target) {
        var d = stepFor(pos, rectOf(), scrollSize(), clientSize());
        if (d) {
          var max = scrollSize() - clientSize();
          var next = getScroll() + d;
          if (next < 0) next = 0; if (next > max) next = max;
          if (next !== getScroll()) { setScroll(next); onScroll(); }
        }
      }
      handle = rafFn(tick);
    }

    return {
      start: function () { if (handle == null) handle = rafFn(tick); },
      stop: function () { if (handle != null) { cancelFn(handle); handle = null; } },
      stepFor: stepFor
    };
  }

  function attach(listEl, opts) {
    opts = opts || {};
    var rowSelector = opts.rowSelector || '.wp-item';
    var allowMouse = opts.allowMouse === true;
    var getId = typeof opts.getId === 'function' ? opts.getId : function (row) {
      return row.getAttribute ? row.getAttribute('data-plan-id') : null;
    };
    var onReorder = typeof opts.onReorder === 'function' ? opts.onReorder : function () {};
    var onSuppress = typeof opts.onSuppress === 'function' ? opts.onSuppress : function () {};
    var onDragChange = typeof opts.onDragChange === 'function' ? opts.onDragChange : function () {};
    /* F-117：可选网格落点。不传 gridOf → 旧版纯列表换序（月面板零改动） */
    var gridOf = typeof opts.gridOf === 'function' ? opts.gridOf : null;
    var onGridMove = typeof opts.onGridMove === 'function' ? opts.onGridMove : function () {};
    var onGridLeave = typeof opts.onGridLeave === 'function' ? opts.onGridLeave : function () {};
    var onGridDrop = typeof opts.onGridDrop === 'function' ? opts.onGridDrop : function () {};
    /* 命中测试在调用时解析 document.elementFromPoint：垫片无此方法，用例可注入几何桩 */
    var hitTest = typeof opts.hitTest === 'function' ? opts.hitTest : function (x, y) {
      return (typeof document !== 'undefined' && document && typeof document.elementFromPoint === 'function')
        ? document.elementFromPoint(x, y) : null;
    };

    var press = null;
    var drag = null;
    var touchBlockOn = false;
    /* F-115：touch-action 允许平移时浏览器会接管滚动并发 pointercancel 掐断指针流；起拖后必须自己消化 touchmove */
    function onTouchMoveBlock(e) {
      if (drag && e.preventDefault) e.preventDefault();
    }
    function attachTouchBlock() {
      if (touchBlockOn) return;
      touchBlockOn = true;
      document.addEventListener('touchmove', onTouchMoveBlock, { passive: false });
    }
    function detachTouchBlock() {
      if (!touchBlockOn) return;
      touchBlockOn = false;
      document.removeEventListener('touchmove', onTouchMoveBlock);
    }
    var scroller = edgeScroll(listEl, {
      getY: function () { return (drag && !drag.col) ? drag.lastY : null; },
      onScroll: function () { if (drag && !drag.col) insertAt(drag.lastY); }
    });

    /* F-118：可选跟手幽灵克隆。不传 makeGhost → 不建（月面板零改动）。
       克隆由工厂建（周视图克隆整行），引擎只管定位/摘除；触摸上抬 GHOST_LIFT_PX 不挡手指。 */
    var makeGhost = typeof opts.makeGhost === 'function' ? opts.makeGhost : null;
    var ghost = null;
    var ghostOffX = 0;
    var ghostOffY = 0;
    var ghostLift = 0;
    function positionGhost(x, y) {
      if (!ghost || !ghost.style) return;
      ghost.style.left = Math.round(x - ghostOffX) + 'px';
      ghost.style.top = Math.round(y - ghostOffY - ghostLift) + 'px';
    }
    function removeGhost() {
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      ghost = null;
    }

    /* F-118：可选额外边缘滚动目标（页面竖滚 / 周网格横滚），按 when 门控拖拽模式。
       自动滚动时重算落点：网格模式重发 onGridMove（内容在静止指针下移动），列表模式重插行。 */
    var edgeTargets = Array.isArray(opts.edgeTargets) ? opts.edgeTargets : [];
    var extraScrollers = edgeTargets.map(function (t) {
      return edgeScroll(t.target, {
        axis: t.axis === 'x' ? 'x' : 'y',
        getPos: function () {
          if (!drag) return null;
          if (t.when === 'list' && drag.col) return null;
          if (t.when === 'grid' && !drag.col) return null;
          return t.axis === 'x' ? drag.lastX : drag.lastY;
        },
        onScroll: function () {
          if (!drag) return;
          if (drag.col) onGridMove(drag.col, drag.lastX, drag.lastY);
          else insertAt(drag.lastY);
        }
      });
    });
    function startScrollers() {
      scroller.start();
      for (var i = 0; i < extraScrollers.length; i += 1) extraScrollers[i].start();
    }
    function stopScrollers() {
      scroller.stop();
      for (var i = 0; i < extraScrollers.length; i += 1) extraScrollers[i].stop();
    }

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
      var list = rows();
      var row = p.row;
      var i = list.indexOf(row);
      if (i < 0) {
        /* 按压期间列表被重渲染（如收起展开卡）→ 按 id 认领新行；计划已不在则放弃本次按压 */
        var pid = getId(row);
        row = null;
        for (var k = 0; k < list.length; k += 1) {
          if (getId(list[k]) === pid) { row = list[k]; i = k; break; }
        }
        if (!row) { cancelPress(); return; }
      }
      drag = {
        row: row, startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, col: null,
        homeNext: (i >= 0 && i + 1 < list.length) ? list[i + 1] : null,
        homeIds: list.map(getId).filter(function (v) { return !!v; }).join('|')
      };
      if (row.classList) row.classList.add('is-dragging');
      onDragChange(true);
      onSuppress(SUPPRESS_MS);
      startScrollers();
      if (makeGhost) {
        var gr = row.getBoundingClientRect ? row.getBoundingClientRect() : null;
        ghost = makeGhost(row);
        if (ghost) {
          ghostOffX = gr ? p.x - gr.left : 0;
          ghostOffY = gr ? p.y - gr.top : 0;
          ghostLift = p.mouse ? 0 : GHOST_LIFT_PX;
          if (gr && ghost.style) ghost.style.width = Math.round(gr.width) + 'px';
          if (typeof document !== 'undefined' && document && document.body) document.body.appendChild(ghost);
          positionGhost(p.x, p.y);
        }
      }
      if (press === p) press = null;
    }

    /** 源行插回起拖前的位置：进网格 / 保持时不留未提交的假顺序。 */
    function restoreHome() {
      var list = rows();
      var ref = drag.homeNext;
      if (ref && list.indexOf(ref) >= 0) {
        if (drag.row.nextSibling !== ref) listEl.insertBefore(drag.row, ref);
        return;
      }
      var last = list[list.length - 1];
      if (last && last !== drag.row && last.nextSibling !== drag.row) {
        listEl.insertBefore(drag.row, last.nextSibling);
      }
    }

    /** 落点三分：网格列 / 计划列表 / 其余（保持）。 */
    function zoneAt(x, y) {
      var node = hitTest(x, y);
      var col = node ? gridOf(node) : null;
      if (col) return { col: col };
      if (node && listEl.contains && listEl.contains(node)) return { list: true };
      return null;   /* 非列非列表 → 保持 */
    }

    /** 列表模式：按行中点把拖拽行插到指针处。 */
    function insertAt(y) {
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

    function moveDrag(x, y) {
      if (!drag) return;
      drag.lastX = x;
      drag.lastY = y;
      positionGhost(x, y);
      if (!gridOf) { insertAt(y); return; }
      var zone = zoneAt(x, y);
      if (zone && zone.col) {
        if (!drag.col) restoreHome();
        drag.col = zone.col;
        onGridMove(zone.col, x, y);
        return;
      }
      if (drag.col) { drag.col = null; onGridLeave(); }
      if (zone && zone.list) { insertAt(y); return; }
      restoreHome();
    }

    function endDrag() {
      if (!drag) return;
      var d = drag;
      drag = null;
      detach();
      stopScrollers();
      removeGhost();
      if (d.row.classList) d.row.classList.remove('is-dragging');
      onDragChange(false);
      onSuppress(SUPPRESS_MS);
      if (d.col) { onGridDrop(d.col, d.lastX, d.lastY, getId(d.row)); return; }
      var ids = rows().map(getId).filter(function (v) { return !!v; });
      /* 网格模式下顺序没变（保持 / 往返归位）→ 不写入 */
      if (!gridOf || ids.join('|') !== d.homeIds) onReorder(ids);
    }

    /** 丢弃在飞的拖拽：不提交换序、摘监听、清预览。重渲染 / 销毁前调用。
        未起拖的按压保留——beginDrag 会按 id 认领重渲染后的新行。 */
    function abort() {
      if (!drag) return;
      var row = drag.row;
      drag = null;
      detach();
      stopScrollers();
      removeGhost();
      if (row.classList) row.classList.remove('is-dragging');
      onDragChange(false);
    }

    function onMove(e) {
      if (drag) {
        if (e.cancelable !== false && e.preventDefault) e.preventDefault();
        moveDrag(e.clientX, e.clientY);
        return;
      }
      if (!press) return;
      var dx = Math.abs(e.clientX - press.x);
      var dy = Math.abs(e.clientY - press.y);
      if (press.mouse) {
        /* 鼠标：移动超阈值即起拖（无需长按），起拖后立刻跟手 */
        if (dx > SLOP_PX || dy > SLOP_PX) {
          var p = press;
          beginDrag(p);
          if (e.cancelable !== false && e.preventDefault) e.preventDefault();
          moveDrag(e.clientX, e.clientY);
        }
        return;
      }
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
      detachTouchBlock();
    }

    function onDown(e) {
      if (drag) return;
      var isMouse = e.pointerType === 'mouse';
      if (isMouse && !allowMouse) return;
      if (typeof e.button === 'number' && e.button !== 0) return;
      var row = rowOf(e.target);
      if (!row || !getId(row)) return;
      press = { row: row, x: e.clientX, y: e.clientY, mouse: isMouse, timer: null };
      var p = press;
      if (!isMouse) {
        press.timer = setTimeout(function () {
          if (press === p) beginDrag(p);
        }, LONG_PRESS_MS);
      }
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
      attachTouchBlock();
    }

    if (listEl) listEl.addEventListener('pointerdown', onDown);

    return {
      abort: abort,
      destroy: function () {
        cancelPress();
        abort();
        stopScrollers();
        removeGhost();
        if (listEl) listEl.removeEventListener('pointerdown', onDown);
      }
    };
  }

  return { attach: attach, edgeScroll: edgeScroll, LONG_PRESS_MS: LONG_PRESS_MS, EDGE_PX: EDGE_PX };
});