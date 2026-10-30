/**
 * DayPlan · 设置 →「云端」分组
 *
 * 契约：docs/spec/18-manual-cloud-save.md §4 / §5。
 *
 * 只做展示与发起动作：
 *   · 账号行：已登录显示名称 / 邮箱 + 退出登录；未登录显示登录入口
 *   · 版本列表：当前版本 + 最多 4 个历史版本（时间 · 设备 · 事项数），历史可回溯
 * 真正切作用域、保存、回溯由装配层注入的函数完成。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var M = root.DayPlan.modal;
  var D = root.DayPlan.datetime;
  var el = M.el;

  function formatTime(iso) {
    if (!iso) return '时间未知';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var now = new Date();
    var datePart = (d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-') +
      D.pad2(d.getMonth() + 1) + '-' + D.pad2(d.getDate());
    return datePart + ' ' + D.pad2(d.getHours()) + ':' + D.pad2(d.getMinutes());
  }

  function metaText(entry) {
    var parts = [formatTime(entry.savedAt)];
    if (entry.device) parts.push(entry.device);
    parts.push((entry.items || 0) + ' 条事项');
    return parts.join(' · ');
  }

  function maskedUid(uid) {
    var s = String(uid || '');
    return s.length > 8 ? (s.slice(0, 4) + '…' + s.slice(-4)) : s;
  }

  /**
   * @param {object} opts
   * @param {Function} opts.getSession       () => session|null
   * @param {Function} [opts.getAccountName] (uid) => 显示名
   * @param {Function} opts.openSignIn       打开登录对话框
   * @param {Function} opts.signOut          () => Promise
   * @param {Function} opts.listVersions     () => Promise<{ok,current,older}|{ok:false,code,message}>
   * @param {Function} opts.restoreVersion   (entry) => Promise<{ok,message?}>
   * @param {Function} [opts.onRestored]     回溯成功后通知装配层刷新视图
   * @param {Function} [opts.onSignedOut]    退出登录后通知装配层切回游客
   * @returns {{element:HTMLElement, render:Function}}
   */
  function createCloudSection(opts) {
    opts = opts || {};
    /* 2026-10-30：设置整体按大类折叠（见 modal.foldSection）。这里只往稳定的
       body 里灌内容，重渲染（重试 / 回溯 / 登录态变化）不会把折叠壳一起冲掉。 */
    var fold = M.foldSection('云端');
    var wrap = fold.element;
    var panelBody = fold.body;
    var loadSeq = 0;

    function session() {
      try { return opts.getSession ? opts.getSession() : null; } catch (e) { return null; }
    }

    function isSignedIn() {
      var s = session();
      return !!(s && typeof s.getState === 'function' && s.getState() === 'signed-in' && s.getUserId());
    }

    function accountLabel(uid) {
      var name = '';
      try { name = opts.getAccountName ? String(opts.getAccountName(uid) || '') : ''; } catch (e) { name = ''; }
      return name || maskedUid(uid);
    }

    function renderSignedOut(body) {
      body.appendChild(el('p', { class: 'hint', text: '登录后可以把手动保存的内容放到云端，并在其它设备载入。' }));
      body.appendChild(el('div', { class: 'inline' }, [
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '登录',
          onclick: function () { if (opts.openSignIn) opts.openSignIn(); }
        })
      ]));
    }

    function renderSignedIn(body) {
      var uid = session().getUserId();

      body.appendChild(el('div', { class: 'settings-row' }, [
        el('span', { class: 'settings-row-label', text: '账号' }),
        el('span', { class: 'settings-row-value', text: accountLabel(uid) }),
        el('button', {
          class: 'btn btn-sm', type: 'button', text: '退出登录',
          onclick: function () {
            M.confirm({
              title: '退出登录',
              message: '退出后界面回到游客数据；账号副本仍保留在本机与云端。',
              confirmLabel: '退出'
            }).then(function (ok) {
              if (!ok) return;
              Promise.resolve(opts.signOut ? opts.signOut() : null).then(function () {
                M.toast('已退出登录');
                if (opts.onSignedOut) opts.onSignedOut();
              }, function (err) {
                M.toast('退出失败：' + ((err && err.message) || '未知错误'));
              });
            });
          }
        })
      ]));

      var listBox = el('div', { class: 'cloud-versions' }, [
        el('p', { class: 'hint', text: '正在读取云端版本…' })
      ]);
      body.appendChild(listBox);

      var seq = ++loadSeq;
      Promise.resolve(opts.listVersions ? opts.listVersions() : null).then(function (res) {
        if (seq !== loadSeq) return;  // 期间又渲染过一次，丢弃旧结果
        listBox.innerHTML = '';
        if (!res || !res.ok) {
          listBox.appendChild(el('p', { class: 'hint', text: '读取失败：' + ((res && res.message) || '未知错误') }));
          listBox.appendChild(el('div', { class: 'inline' }, [
            el('button', { class: 'btn btn-sm', type: 'button', text: '重试', onclick: render })
          ]));
          return;
        }
        if (!res.current) {
          listBox.appendChild(el('p', { class: 'hint', text: '云端还没有保存过。点顶部「保存」把当前内容传上去。' }));
          return;
        }
        listBox.appendChild(versionRow(res.current, true));
        (res.older || []).forEach(function (entry) {
          listBox.appendChild(versionRow(entry, false));
        });
      }, function (err) {
        if (seq !== loadSeq) return;
        listBox.innerHTML = '';
        listBox.appendChild(el('p', { class: 'hint', text: '读取失败：' + ((err && err.message) || '网络不可用') }));
      });
    }

    function versionRow(entry, isCurrent) {
      var row = el('div', { class: 'cloud-version-row' + (isCurrent ? ' is-current' : '') }, [
        el('span', { class: 'cloud-version-meta', text: metaText(entry) }),
        isCurrent
          ? el('span', { class: 'cloud-version-tag', text: '云端最新' })
          : el('button', {
              class: 'btn btn-sm', type: 'button', text: '回溯',
              onclick: function () { confirmRestore(entry); }
            })
      ]);
      return row;
    }

    function confirmRestore(entry) {
      M.confirm({
        title: '回溯版本',
        message: '将把本机内容替换为 ' + formatTime(entry.savedAt) + ' 的版本，并立即保存到云端。'
          + '当前版本会进入历史，不会丢失。',
        confirmLabel: '回溯'
      }).then(function (ok) {
        if (!ok) return;
        Promise.resolve(opts.restoreVersion ? opts.restoreVersion(entry) : { ok: false, message: '回溯不可用' })
          .then(function (r) {
            if (!r || !r.ok) {
              M.toast('回溯失败：' + ((r && r.message) || '未知错误'));
              return;
            }
            M.toast('已回溯并保存到云端');
            if (opts.onRestored) opts.onRestored();
            render();
          }, function (err) {
            M.toast('回溯失败：' + ((err && err.message) || '未知错误'));
          });
      });
    }

    function render() {
      loadSeq++;  // 任何一次重渲染都让进行中的读取作废
      panelBody.innerHTML = '';
      var body = el('div', {});
      if (isSignedIn()) renderSignedIn(body);
      else renderSignedOut(body);
      panelBody.appendChild(body);
    }

    render();
    return { element: wrap, render: render };
  }

  root.DayPlan.cloudPanel = {
    createCloudSection: createCloudSection,
    formatTime: formatTime
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
