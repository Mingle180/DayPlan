/**
 * DayPlan · 倒计时（五十一轮）
 *
 * 一块全局的「距离截止还有多久」清单：
 *   · 数据在 doc.countdowns（数组顺序即显示顺序），不产生事项、不按日期过滤；
 *   · 剩余 > 1 天显示「d天 h小时」，≤ 1 天显示「h小时 m分钟」，到点归零并标「已到期」；
 *   · 新建时按剩余时间升序插入，之后可用拖动调整（桌面推着走 / 手机长按后拖）。
 *
 * 纯函数（parseTargetAt / formatRemaining / insertIndexFor）导出给单测与冒烟断言。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.countdown = factory(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var MINUTE_MS = 60 * 1000;
  var DAY_MINUTES = 24 * 60;
  var TICK_MS = 1000;
  var LONG_PRESS_MS = 320;
  var TOUCH_SLOP_PX = 8;
  var MOUSE_SLOP_PX = 4;
  var CLICK_SUPPRESS_MS = 400;

  var TARGET_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

  /** 本地墙钟 "YYYY-MM-DDTHH:mm" → 毫秒；非法（含 13 月、24 时等回卷值）返回 null */
  function parseTargetAt(targetAt) {
    if (typeof targetAt !== 'string') return null;
    var m = TARGET_RE.exec(targetAt);
    if (!m) return null;
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    var h = Number(m[4]);
    var mi = Number(m[5]);
    var dt = new Date(y, mo - 1, d, h, mi, 0, 0);
    /* 与 schema.isCountdownTargetAt 同口径：Date 会把越界值滚进下个月 / 下一天，必须逐字段回读校验 */
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d
      || dt.getHours() !== h || dt.getMinutes() !== mi) return null;
    var t = dt.getTime();
    return isFinite(t) ? t : null;
  }

  /**
   * 剩余时间 → 两个「数字 + 单位」组 + 是否已到期。
   * 向下取整到分钟：2天23小时59分 → 2天 23小时；59分59秒 → 0小时 59分钟。
   */
  function formatRemaining(targetMs, nowMs) {
    if (!isFinite(targetMs)) return { expired: true, groups: [{ value: 0, unit: '天' }, { value: 0, unit: '小时' }] };
    var diff = targetMs - (isFinite(nowMs) ? nowMs : Date.now());
    if (diff <= 0) {
      return { expired: true, groups: [{ value: 0, unit: '天' }, { value: 0, unit: '小时' }] };
    }
    var totalMin = Math.floor(diff / MINUTE_MS);
    var groups;
    if (totalMin >= DAY_MINUTES) {
      groups = [
        { value: Math.floor(totalMin / DAY_MINUTES), unit: '天' },
        { value: Math.floor((totalMin % DAY_MINUTES) / 60), unit: '小时' }
      ];
    } else {
      groups = [
        { value: Math.floor(totalMin / 60), unit: '小时' },
        { value: totalMin % 60, unit: '分钟' }
      ];
    }
    return { expired: false, groups: groups };
  }

  /**
   * 新条目的插入位：按剩余时间升序；已到期的排在有剩余时间的条目之后。
   * @param {Array<{targetAt:string}>} list 现有条目（显示顺序）
   * @param {string} targetAt 新条目目标时刻
   * @param {number} nowMs
   */
  function insertIndexFor(list, targetAt, nowMs) {
    var arr = Array.isArray(list) ? list : [];
    var ms = parseTargetAt(targetAt);
    var now = isFinite(nowMs) ? nowMs : Date.now();
    if (ms === null || ms <= now) return arr.length;
    for (var i = 0; i < arr.length; i += 1) {
      var other = parseTargetAt(arr[i] && arr[i].targetAt);
      if (other !== null && other > now && other > ms) return i;
    }
    return arr.length;
  }

  function mk(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function create(opts) {
    opts = opts || {};
    var listEl = opts.list;
    var emptyBtn = opts.emptyBtn || null;
    var addBtn = opts.addBtn || null;
    var countEl = opts.countEl || null;
    var store = opts.store;
    var getCat = typeof opts.getCat === 'function' ? opts.getCat : function () { return null; };
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};

    var M = root.DayPlan.modal;
    var Form = root.DayPlan.form;
    var D = root.DayPlan.datetime;

    /** id → { li, clock, targetMs } */
    var nodes = {};
    var timer = null;
    var press = null;
    var drag = null;
    var suppressClickUntil = 0;

    /* ---------------- 渲染 ---------------- */

    function clockNode() {
      var clock = mk('div', 'cd-clock');
      clock.setAttribute('role', 'timer');
      clock.setAttribute('aria-live', 'off');
      var values = [];
      for (var i = 0; i < 2; i += 1) {
        var group = mk('span', 'cd-value');
        var num = mk('span', 'cd-num');
        var unit = mk('span', 'cd-unit');
        group.appendChild(num);
        group.appendChild(unit);
        clock.appendChild(group);
        values.push({ num: num, unit: unit });
      }
      var tag = mk('span', 'cd-expired', '已到期');
      tag.hidden = true;
      clock.appendChild(tag);
      return { root: clock, values: values, tag: tag };
    }

    function syncClock(clock, targetMs, nowMs) {
      var f = formatRemaining(targetMs, nowMs);
      for (var i = 0; i < clock.values.length; i += 1) {
        var g = f.groups[i];
        var cell = clock.values[i];
        var text = String(g.value);
        if (cell.num.textContent !== text) cell.num.textContent = text;
        if (cell.unit.textContent !== g.unit) cell.unit.textContent = g.unit;
      }
      clock.tag.hidden = !f.expired;
      var label = f.expired
        ? '已到期'
        : ('剩余 ' + f.groups.map(function (g) { return g.value + g.unit; }).join(' '));
      if (clock.root.getAttribute('aria-label') !== label) clock.root.setAttribute('aria-label', label);
      return f;
    }

    function buildItem(cd) {
      var li = mk('li', 'cd-item');
      li.setAttribute('data-cd-id', cd.id);
      li.setAttribute('role', 'button');
      li.setAttribute('tabindex', '0');
      var cat = getCat(cd.categoryId) || {};
      li.style.setProperty('--cat', cat.color || 'var(--text-3)');

      var head = mk('div', 'cd-head');
      var dot = mk('span', 'cd-dot');
      dot.setAttribute('aria-hidden', 'true');
      head.appendChild(dot);
      head.appendChild(mk('span', 'cd-title', cd.title));

      var clock = clockNode();
      li.appendChild(head);
      li.appendChild(clock.root);
      li.addEventListener('click', function () {
        if (Date.now() < suppressClickUntil) return;
        openForm(cd.id);
      });
      li.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        e.preventDefault();
        openForm(cd.id);
      });
      return { li: li, clock: clock, targetMs: parseTargetAt(cd.targetAt) };
    }

    function render() {
      var list = store.getCountdowns();
      nodes = {};
      listEl.innerHTML = '';
      list.forEach(function (cd) {
        var item = buildItem(cd);
        nodes[cd.id] = item;
        listEl.appendChild(item.li);
      });
      var empty = list.length === 0;
      listEl.hidden = empty;
      if (emptyBtn) emptyBtn.hidden = !empty;
      if (addBtn) addBtn.hidden = empty;
      if (countEl) countEl.textContent = empty ? '' : (list.length + ' 项');
      tick();
    }

    function tick() {
      var nowMs = Date.now();
      Object.keys(nodes).forEach(function (id) {
        var item = nodes[id];
        var f = syncClock(item.clock, item.targetMs, nowMs);
        var has = item.li.classList.contains('is-expired');
        if (f.expired && !has) item.li.classList.add('is-expired');
        else if (!f.expired && has) item.li.classList.remove('is-expired');
      });
    }

    /* ---------------- 新建 / 编辑 ---------------- */

    function defaultTarget() {
      var d = new Date(Date.now() + 60 * MINUTE_MS);
      return {
        date: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
        time: pad2(d.getHours()) + ':' + pad2(d.getMinutes())
      };
    }

    function openForm(id) {
      if (!M || !Form || typeof Form.createCountdownForm !== 'function') return;
      var doc = store.getState();
      var cd = null;
      (doc.countdowns || []).forEach(function (e) { if (e.id === id) cd = e; });
      var fallback = defaultTarget();
      var form = Form.createCountdownForm({
        countdown: cd,
        date: fallback.date,
        time: fallback.time,
        categories: doc.categories,
        defaultCategoryId: doc.settings && doc.settings.defaultCategoryId
      });

      var handle = null;
      var footer = [];
      if (cd) {
        var del = mk('button', 'btn btn-danger', '删除');
        del.type = 'button';
        del.addEventListener('click', function () {
          M.confirm({
            title: '删除倒计时',
            message: '确定删除「' + cd.title + '」？',
            confirmLabel: '删除',
            danger: true
          }).then(function (ok) {
            if (!ok) return;
            try {
              store.removeCountdown(cd.id);
            } catch (e) {
              M.toast('删除失败：' + e.message);
              return;
            }
            if (handle) handle.close('delete');
            render();
            onChange();
            M.toast('已删除');
          });
        });
        footer.push(del);
      }

      handle = M.open({
        title: cd ? '编辑倒计时' : '新建倒计时',
        body: form.element,
        footer: footer,
        submitLabel: cd ? '保存' : '创建',
        onSubmit: function (ctx) {
          var check = form.validate();
          if (!check.ok) { ctx.setError(check.message); return false; }
          var v = check.values;
          var targetAt = v.date + 'T' + v.time;
          try {
            if (!cd) {
              store.addCountdown({
                title: v.title,
                categoryId: v.categoryId,
                targetAt: targetAt,
                note: v.note
              });
            } else {
              store.updateCountdown(cd.id, {
                title: v.title,
                categoryId: v.categoryId,
                targetAt: targetAt,
                note: v.note
              });
            }
          } catch (e) {
            ctx.setError(e.message || String(e));
            return false;
          }
          render();
          onChange();
          M.toast(cd ? '已保存' : '已创建');
        }
      });
      form.focus();
    }

    /* ---------------- 拖动排序 ---------------- */

    function itemsInDom() {
      var out = [];
      if (!listEl || !listEl.children) return out;
      for (var i = 0; i < listEl.children.length; i += 1) out.push(listEl.children[i]);
      return out;
    }

    function onTouchMoveBlock(e) {
      if (drag && e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
    }

    /** 跟手虚拟块：按条目数据重建一份白卡，固定到原位置后再用 translate3d 跟指针。 */
    function makeGhost(li) {
      var id = li.getAttribute ? li.getAttribute('data-cd-id') : '';
      var cd = null;
      if (id) {
        store.getCountdowns().forEach(function (e) { if (e.id === id) cd = e; });
      }
      var node = null;
      if (cd) node = buildItem(cd).li;
      else if (typeof li.cloneNode === 'function') node = li.cloneNode(true);
      if (!node) return null;
      var expired = !!(li.classList && li.classList.contains('is-expired'));
      node.className = 'cd-item cd-ghost' + (expired ? ' is-expired' : '');
      node.setAttribute('aria-hidden', 'true');
      if (node.removeAttribute) node.removeAttribute('data-cd-id');
      var r = (li.getBoundingClientRect ? li.getBoundingClientRect() : null) || { left: 0, top: 0, width: 0, height: 0 };
      node.style.left = r.left + 'px';
      node.style.top = r.top + 'px';
      node.style.width = r.width + 'px';
      node.style.height = r.height + 'px';
      node.style.transform = 'translate3d(0,0,0)';
      document.body.appendChild(node);
      return node;
    }

    function dropGhost(node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }

    function beginDrag(fromPress, y) {
      if (fromPress.timer) clearTimeout(fromPress.timer);
      /* 跟手基准取按下的那一点：越过 4px 阈值才开始拖时，虚拟块不该先归零再跳。 */
      drag = { li: fromPress.li, y: y, startY: fromPress.y, ghost: makeGhost(fromPress.li) };
      suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
      if (fromPress.li.classList) fromPress.li.classList.add('is-dragging');
      if (typeof fromPress.li.setPointerCapture === 'function' && fromPress.pointerId !== undefined) {
        try { fromPress.li.setPointerCapture(fromPress.pointerId); } catch (e) { /* 垫片 / 旧内核 */ }
      }
      document.addEventListener('touchmove', onTouchMoveBlock, { passive: false });
      if (press === fromPress) press = null;
    }

    function moveDrag(y) {
      if (!drag) return;
      drag.y = y;
      if (drag.ghost) {
        drag.ghost.style.transform = 'translate3d(0,' + Math.round(y - drag.startY) + 'px,0)';
      }
      var li = drag.li;
      var children = itemsInDom();
      var before = null;
      for (var i = 0; i < children.length; i += 1) {
        var n = children[i];
        if (n === li || !n.getBoundingClientRect) continue;
        var r = n.getBoundingClientRect();
        if (y < r.top + r.height / 2) { before = n; break; }
      }
      if (before) {
        if (before !== li && li.nextSibling !== before) listEl.insertBefore(li, before);
      } else if (listEl.lastChild !== li) {
        listEl.appendChild(li);
      }
    }

    function endDrag() {
      document.removeEventListener('touchmove', onTouchMoveBlock, { passive: false });
      if (!drag) return;
      var li = drag.li;
      var ghost = drag.ghost;
      drag = null;
      dropGhost(ghost);
      suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
      if (li.classList) li.classList.remove('is-dragging');
      var ids = itemsInDom().map(function (n) { return n.getAttribute('data-cd-id'); })
        .filter(function (v) { return !!v; });
      try {
        store.reorderCountdowns(ids);
      } catch (e) {
        if (M) M.toast('调整次序失败：' + e.message);
        render();
        return;
      }
      onChange();
    }

    function cancelPress() {
      if (!press) return;
      if (press.timer) clearTimeout(press.timer);
      press = null;
      detachWindow();
    }

    function detachWindow() {
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerUp, true);
    }

    function onPointerMove(e) {
      if (drag) { moveDrag(e.clientY); return; }
      if (!press) return;
      var dx = Math.abs(e.clientX - press.x);
      var dy = Math.abs(e.clientY - press.y);
      if (press.touch) {
        /* 长按期间手指一动就交还给页面滚动 */
        if (dx > TOUCH_SLOP_PX || dy > TOUCH_SLOP_PX) cancelPress();
        return;
      }
      if (dx > MOUSE_SLOP_PX || dy > MOUSE_SLOP_PX) {
        beginDrag(press, e.clientY);
        moveDrag(e.clientY);
      }
    }

    function onPointerUp() {
      if (press) cancelPress();
      detachWindow();
      endDrag();
    }

    if (listEl) {
      listEl.addEventListener('pointerdown', function (e) {
        if (drag) return;
        if (typeof e.button === 'number' && e.button !== 0) return;
        var target = e.target;
        var li = (target && typeof target.closest === 'function') ? target.closest('.cd-item') : null;
        if (!li || (listEl.contains && !listEl.contains(li))) return;
        var touch = e.pointerType !== 'mouse';
        press = {
          li: li, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch: touch, timer: null
        };
        if (touch) {
          var p = press;
          press.timer = setTimeout(function () {
            if (press === p) beginDrag(p, p.y);
          }, LONG_PRESS_MS);
        }
        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerUp, true);
      });
    }

    /* ---------------- 接线 ---------------- */

    if (emptyBtn) emptyBtn.addEventListener('click', function () { openForm(null); });
    if (addBtn) addBtn.addEventListener('click', function () { openForm(null); });

    timer = setInterval(tick, TICK_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();

    return {
      element: listEl,
      render: render,
      tick: tick,
      openForm: openForm,
      formatRemaining: formatRemaining,
      destroy: function () {
        if (timer) clearInterval(timer);
        timer = null;
        detachWindow();
        if (drag) { dropGhost(drag.ghost); drag = null; }
        document.removeEventListener('touchmove', onTouchMoveBlock, { passive: false });
      }
    };
  }

  return {
    create: create,
    parseTargetAt: parseTargetAt,
    formatRemaining: formatRemaining,
    insertIndexFor: insertIndexFor,
    TICK_MS: TICK_MS
  };
});
