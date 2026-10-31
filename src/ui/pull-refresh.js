/*
 * 手机端下拉刷新：页面滚到顶后继续往下拖，松手即重载（重新读取本地数据）。
 *
 * 只在手机布局（<1024）与触屏下生效；弹窗、表单编辑、未排事项拖拽期间不接管。
 * 顶部提示条由本模块自建，样式见 vintage.css「手机端下拉刷新」。
 */
(function (root) {
  'use strict';

  var doc = root.document;
  if (!doc || typeof doc.addEventListener !== 'function') return;
  if (!('ontouchstart' in root)) return;

  var SLOP = 8;
  var THRESHOLD = 64;
  var MAX_PULL = 96;

  var el = null;
  var armed = false;
  var decided = false;
  var refreshing = false;
  var startX = 0;
  var startY = 0;
  var pull = 0;

  function isPhone() { return (root.innerWidth || 0) < 1024; }

  function atTop() {
    var y = root.pageYOffset;
    if (typeof y !== 'number') {
      y = (doc.documentElement && doc.documentElement.scrollTop) || (doc.body && doc.body.scrollTop) || 0;
    }
    return y <= 0;
  }

  function hasModal() {
    var html = doc.documentElement;
    return !!(html && html.classList && html.classList.contains('has-modal'));
  }

  function isBusyTarget(t) {
    if (!t || typeof t.closest !== 'function') return false;
    return !!t.closest('.modal, .modal-backdrop, .untimed-item, form, input, textarea, select, [contenteditable="true"]');
  }

  function ensureEl() {
    if (el) return el;
    el = doc.createElement('div');
    el.className = 'pull-refresh';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.textContent = '下拉刷新';
    (doc.body || doc.documentElement).appendChild(el);
    return el;
  }

  function render() {
    var e = ensureEl();
    e.style.setProperty('--pull', Math.round(pull) + 'px');
    e.style.setProperty('--pull-alpha', pull > 2 ? 1 : 0);
    if (refreshing) return;
    var ready = pull >= THRESHOLD;
    e.textContent = ready ? '松开刷新' : '下拉刷新';
    if (e.classList) e.classList.toggle('is-ready', ready);
  }

  function reset() {
    armed = false;
    decided = false;
    pull = 0;
    if (!el) return;
    el.style.transition = 'transform .22s ease, opacity .16s ease';
    el.style.setProperty('--pull', '0px');
    el.style.setProperty('--pull-alpha', 0);
    root.setTimeout(function () { if (el) el.style.transition = ''; }, 240);
  }

  function triggerRefresh() {
    refreshing = true;
    var e = ensureEl();
    e.textContent = '正在刷新…';
    if (e.classList) e.classList.remove('is-ready');
    e.style.transition = 'transform .18s ease, opacity .16s ease';
    pull = 56;
    render();
    root.setTimeout(function () {
      try {
        root.location.reload();
      } catch (err) {
        refreshing = false;
        reset();
      }
    }, 220);
  }

  function onStart(event) {
    if (refreshing || !isPhone() || hasModal()) return;
    var t = event.touches && event.touches[0];
    if (!t || event.touches.length > 1) return;
    if (!atTop() || isBusyTarget(event.target)) return;
    armed = true;
    decided = false;
    startX = t.clientX;
    startY = t.clientY;
  }

  function onMove(event) {
    if (!armed || refreshing) return;
    var t = event.touches && event.touches[0];
    if (!t) return;
    var dx = t.clientX - startX;
    var dy = t.clientY - startY;
    if (!decided) {
      if (Math.abs(dy) < SLOP) return;
      if (dy <= 0 || Math.abs(dy) <= Math.abs(dx) || !atTop() || doc.querySelector('.is-dragging')) {
        armed = false;
        return;
      }
      decided = true;
      if (el) el.style.transition = 'none';
    }
    if (event.cancelable !== false && typeof event.preventDefault === 'function') event.preventDefault();
    pull = Math.min(MAX_PULL, Math.max(0, dy) * 0.55);
    render();
  }

  function onEnd(event) {
    if (!armed) return;
    var wasPull = decided;
    armed = false;
    decided = false;
    if (wasPull && event && event.cancelable !== false && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    if (refreshing) return;
    if (wasPull && pull >= THRESHOLD) triggerRefresh();
    else reset();
  }

  doc.addEventListener('touchstart', onStart, { passive: true });
  doc.addEventListener('touchmove', onMove, { passive: false });
  doc.addEventListener('touchend', onEnd, { passive: false });
  doc.addEventListener('touchcancel', function () {
    if (refreshing) return;
    reset();
  }, { passive: true });
})(window);
