/**
 * DayPlan · 弹窗 / 确认 / Toast（无第三方依赖）
 *
 * 契约：F-03 / F-11 / 04-§4.3（焦点管理、Esc 关闭、Enter 提交）
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  var openStack = [];

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

  function getModalRoot() {
    return document.getElementById('modal-root') || document.body;
  }

  /**
   * 打开一个弹窗。
   * @param {object} opts
   *   - title: string
   *   - body: HTMLElement|string
   *   - footer: HTMLElement[]  自定义底部按钮
   *   - wide: boolean
   *   - center: boolean  垂直居中（默认贴顶，避免长表单被截）
   *   - onSubmit: function(ctx)  表单提交（Enter / 保存按钮）
   *   - onClose: function(reason)
   *   - submitLabel / cancelLabel
   *   - showCancel / showSubmit
   * @returns {{close:Function, root:HTMLElement, body:HTMLElement, footer:HTMLElement}}
   */
  function openModal(opts) {
    opts = opts || {};
    var previouslyFocused = document.activeElement;
    var backdrop = el('div', { class: 'modal-backdrop' + (opts.center ? ' is-centered' : '') });
    var modal = el('div', { class: 'modal' + (opts.wide ? ' modal-wide' : ''), role: 'dialog', 'aria-modal': 'true' });
    var titleId = 'modal-title-' + Math.random().toString(36).slice(2, 8);
    modal.setAttribute('aria-labelledby', titleId);

    var head = el('div', { class: 'modal-head' }, [
      el('h2', { class: 'modal-title', id: titleId, text: opts.title || '' }),
      el('button', {
        class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': '关闭', title: '关闭（Esc）',
        text: '✕', onclick: function () { close('button'); }
      })
    ]);

    var body = el('div', { class: 'modal-body' });
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);

    var footer = el('div', { class: 'modal-foot' });
    var ctx = {
      root: modal, body: body, footer: footer,
      close: function (reason) { close(reason || 'api'); },
      submit: function () { doSubmit(); },
      setError: function (msg) { showError(msg); }
    };

    var submitBtn = null;
    if (opts.showSubmit !== false) {
      submitBtn = el('button', {
        class: 'btn btn-primary', type: 'button', text: opts.submitLabel || '保存',
        onclick: function () { doSubmit(); }
      });
    }
    // 取消按钮：无提交按钮、也没有自定义底部元素时不渲染，避免与标题栏的 ✕ 重复
    // 美化迭代 15：取消按钮幽灵化，让主按钮成为底栏唯一视觉重心
    var hasCustomFooter = !!(opts.footer && opts.footer.length);
    if (opts.showCancel !== false && (submitBtn || hasCustomFooter)) {
      footer.appendChild(el('button', {
        class: 'btn btn-ghost', type: 'button', text: opts.cancelLabel || '取消',
        onclick: function () { close('cancel'); }
      }));
    }
    if (hasCustomFooter) {
      opts.footer.forEach(function (n) { footer.appendChild(n); });
    }
    if (submitBtn) footer.appendChild(submitBtn);

    var errorBox = el('div', { class: 'form-error', hidden: true });
    var hasCustomBody = !!opts.body;
    if (!hasCustomBody) body.appendChild(errorBox); else body.insertBefore(errorBox, body.firstChild);

    function showError(msg) {
      if (!msg) { errorBox.hidden = true; errorBox.textContent = ''; return; }
      errorBox.hidden = false;
      errorBox.textContent = msg;
    }

    function doSubmit() {
      if (!opts.onSubmit) { close('submit'); return; }
      showError('');
      try {
        var r = opts.onSubmit(ctx);
        if (r === false) return; // 校验失败，保持打开
        close('submit');
      } catch (e) {
        if (e && e.code) {
          showError(e.message || String(e));
        } else {
          showError((e && e.message) || '操作失败');
          if (root.console) console.error(e);
        }
      }
    }

    modal.appendChild(head);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    getModalRoot().appendChild(backdrop);

    var closed = false;
    function close(reason) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeydown, true);
      backdrop.remove();
      var i = openStack.indexOf(handle);
      if (i >= 0) openStack.splice(i, 1);
      if (previouslyFocused && previouslyFocused.focus) {
        try { previouslyFocused.focus({ preventScroll: true }); } catch (e) { /* 元素可能已移除 */ }
      }
      if (opts.onClose) opts.onClose(reason);
    }

    function onKeydown(e) {
      if (openStack[openStack.length - 1] !== handle) return; // 只处理最上层
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close('escape');
        return;
      }
      if (e.key === 'Enter' && opts.submitOnEnter !== false) {
        var t = e.target;
        var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
        if (tag === 'textarea') return; // 多行框内 Enter 为换行
        if (tag === 'button') return;   // 交给按钮自身
        e.preventDefault();
        doSubmit();
        return;
      }
      if (e.key === 'Tab') {
        var nodes = Array.prototype.slice.call(modal.querySelectorAll(FOCUSABLE))
          .filter(function (n) { return n.offsetParent !== null || n === document.activeElement; });
        if (!nodes.length) return;
        var first = nodes[0];
        var last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }

    backdrop.addEventListener('mousedown', function (e) {
      if (e.target === backdrop) close('backdrop');
    });
    document.addEventListener('keydown', onKeydown, true);

    var handle = {
      root: modal, body: body, footer: footer, backdrop: backdrop,
      close: close, setError: showError, submit: doSubmit
    };
    openStack.push(handle);

    // 焦点：优先第一个表单控件，否则弹窗本体
    var firstField = modal.querySelector('input:not([type=hidden]),select,textarea');
    if (firstField) {
      firstField.focus();
      if (firstField.select && firstField.type === 'text') firstField.select();
    } else {
      modal.setAttribute('tabindex', '-1');
      modal.focus();
    }

    return handle;
  }

  /**
   * 确认框。
   * @returns {Promise<boolean>}
   */
  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      var body = el('div', {}, [
        el('p', { text: opts.message || '确认执行该操作？', style: 'margin:0 0 6px' }),
        opts.detail ? el('p', { class: 'hint', text: opts.detail, style: 'margin:0' }) : null
      ]);
      var handle = openModal({
        title: opts.title || '请确认',
        body: body,
        submitLabel: opts.confirmLabel || '确定',
        cancelLabel: opts.cancelLabel || '取消',
        onSubmit: function () { done(true); },
        onClose: function () { done(false); }
      });
      if (opts.danger) {
        var btn = handle.footer.querySelector('.btn-primary');
        if (btn) { btn.className = 'btn btn-danger'; }
      }
    });
  }

  /**
   * 需要输入指定文字才能确认的危险操作（F-12.3）。
   * @returns {Promise<boolean>}
   */
  function typedConfirmDialog(opts) {
    opts = opts || {};
    var expect = opts.expect || '清空';
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) { if (!settled) { settled = true; resolve(v); } }
      var input = el('input', { type: 'text', placeholder: '请输入「' + expect + '」', 'aria-label': '确认文字' });
      var body = el('div', {}, [
        el('p', { text: opts.message || '', style: 'margin:0 0 10px' }),
        el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '确认文字' }), input]),
        el('p', { class: 'hint', text: '该操作不可撤销（但可用「导入」恢复此前导出的备份）。' })
      ]);
      var handle = openModal({
        title: opts.title || '危险操作',
        body: body,
        submitLabel: opts.confirmLabel || '确认清空',
        onSubmit: function (ctx) {
          if (input.value.trim() !== expect) {
            ctx.setError('请输入「' + expect + '」以确认');
            return false;
          }
          done(true);
        },
        onClose: function () { done(false); }
      });
      var btn = handle.footer.querySelector('.btn-primary');
      if (btn) btn.className = 'btn btn-danger';
      input.focus();
    });
  }

  /* ---------------- Toast ---------------- */

  function toastWrap() {
    var w = document.querySelector('.toast-wrap');
    if (!w) {
      w = el('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(w);
    }
    return w;
  }

  /**
   * @param {string} message
   * @param {{actionLabel?:string, onAction?:Function, duration?:number, type?:string}} [opts]
   */
  function toast(message, opts) {
    opts = opts || {};
    var wrap = toastWrap();
    var t = el('div', { class: 'toast' + (opts.type ? ' toast-' + opts.type : '') });
    t.appendChild(el('span', { text: message }));
    var timer = null;
    function dismiss() {
      if (timer) clearTimeout(timer);
      t.remove();
      if (!wrap.children.length) wrap.remove();
    }
    if (opts.actionLabel) {
      t.appendChild(el('button', {
        class: 'btn', type: 'button', text: opts.actionLabel,
        onclick: function () {
          if (opts.onAction) {
            try { opts.onAction(); } catch (e) { if (root.console) console.error(e); }
          }
          dismiss();
        }
      }));
    }
    wrap.appendChild(t);
    var duration = typeof opts.duration === 'number' ? opts.duration : (opts.actionLabel ? 6000 : 2600);
    if (duration > 0) timer = setTimeout(dismiss, duration);
    return dismiss;
  }

  root.DayPlan.modal = {
    el: el,
    open: openModal,
    confirm: confirmDialog,
    typedConfirm: typedConfirmDialog,
    toast: toast
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
