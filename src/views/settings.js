/**
 * DayPlan · 设置面板（F-05 类别管理 / F-09 导入导出 / F-12.3 清空 / DM-10 显示选项）
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var D = root.DayPlan.datetime;
  var S = root.DayPlan.schema;
  var Form = root.DayPlan.form;
  var M = root.DayPlan.modal;
  var el = M.el;

  /**
   * 类别管理（供设置面板与其它入口复用）
   * @param {object} opts { store, onChange }
   */
  function categoryManager(opts) {
    var store = opts.store;
    var wrap = el('div', {});

    function render() {
      wrap.innerHTML = '';
      var doc = store.getState();
      var refCount = {};
      doc.items.forEach(function (it) { refCount[it.categoryId] = (refCount[it.categoryId] || 0) + 1; });

      // 迭代 4（BR-37）：紧急恒排首位；其余按类别次序（order 升序）
      var sorted = (doc.categories || []).slice().sort(function (a, b) {
        var ua = S.isUrgentCategory(a) ? 0 : 1;
        var ub = S.isUrgentCategory(b) ? 0 : 1;
        if (ua !== ub) return ua - ub;
        var oa = (typeof a.order === 'number' && isFinite(a.order)) ? a.order : 0;
        var ob = (typeof b.order === 'number' && isFinite(b.order)) ? b.order : 0;
        return oa - ob;
      });

      var list = el('ul', { class: 'cat-list' });
      var draggingId = null;

      function clearDropMarks() {
        Array.prototype.slice.call(list.children).forEach(function (n) {
          if (n.classList) n.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-x');
        });
      }

      /* 两列布局（五十一轮反馈）：与下一格同排即视为两列，落点改按左右半判定 */
      function isTwoColumn(node) {
        var parent = node && node.parentNode;
        if (!parent || !parent.children) return false;
        var kids = Array.prototype.slice.call(parent.children);
        var next = kids[kids.indexOf(node) + 1];
        if (!next || typeof node.getBoundingClientRect !== 'function'
            || typeof next.getBoundingClientRect !== 'function') return false;
        var a = node.getBoundingClientRect();
        var b = next.getBoundingClientRect();
        return Math.abs(a.top - b.top) < 2 && b.left > a.left + 1;
      }

      function dropSide(node, ev) {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        var r = node.getBoundingClientRect();
        if (isTwoColumn(node)) {
          var x = (ev && typeof ev.clientX === 'number') ? ev.clientX : 0;
          return x > r.left + r.width / 2;
        }
        var y = (ev && typeof ev.clientY === 'number') ? ev.clientY : 0;
        return y > r.top + r.height / 2;
      }

      /* 落点提示：单列画格的上下横线，两列画格的左右竖线 */
      function markDrop(node, ev) {
        var after = dropSide(node, ev);
        clearDropMarks();
        node.classList.add(after ? 'is-drop-after' : 'is-drop-before');
        if (isTwoColumn(node)) node.classList.add('is-drop-x');
        return after;
      }

      /* 拖动落点 → 非紧急子序列的新次序（紧急恒首位，不参与） */
      function reorderTo(fromId, toId, after) {
        var ids = sorted.filter(function (c) { return !S.isUrgentCategory(c); })
          .map(function (c) { return c.id; });
        var from = ids.indexOf(fromId);
        if (from < 0) return;
        ids.splice(from, 1);
        var anchor = ids.indexOf(toId);
        if (anchor < 0) return;
        ids.splice(after ? anchor + 1 : anchor, 0, fromId);
        try {
          store.reorderCategories(ids);
        } catch (e) {
          if (M && M.toast) M.toast(e.message || '调整次序失败');
          return;
        }
        render();
        notify();
      }

      list.addEventListener('dragend', function () {
        draggingId = null;
        clearDropMarks();
        Array.prototype.slice.call(list.children).forEach(function (n) {
          if (n.classList) n.classList.remove('is-dragging');
        });
      });

      sorted.forEach(function (cat) {
        var urgent = S.isUrgentCategory(cat);
        var li = el('li', {
          class: 'cat-item' + (urgent ? ' is-urgent' : ''),
          'data-category-id': cat.id,
          'data-builtin': cat.builtin ? 'true' : 'false',
          'data-urgent': urgent ? 'true' : 'false'
        });

        /* 2026-10-20（用户反馈）：颜色可自定义，但「紧急」只可改名 —— 它只有红这一个身份色。
           紧急的色块因此不是按钮，而是一个带锁样式的标记（不可点、有说明），
           避免用户点了没反应还以为界面坏了。 */
        if (urgent) {
          li.appendChild(el('span', {
            class: 'cat-swatch is-locked', style: 'background:' + cat.color,
            title: '「' + cat.name + '」只可改名，颜色固定',
            'aria-label': '「' + cat.name + '」的颜色固定，不可修改'
          }));
        } else {
          li.appendChild(el('button', {
            class: 'cat-swatch', type: 'button',
            style: 'background:' + cat.color,
            title: '修改颜色', 'aria-label': '修改「' + cat.name + '」的颜色',
            onclick: function () { pickColor(cat); }
          }));
        }

        li.appendChild(el('div', { class: 'cat-name', text: cat.name }));

        /* 拖动排序（2026-10-21 用户反馈：去掉 ▲▼，整行拖动）：
           紧急恒首位 → 不挂 draggable；其余行可拖，Alt+↑/↓ 作为键盘等价操作。 */
        if (!urgent) {
          li.setAttribute('draggable', 'true');
          li.setAttribute('tabindex', '0');
          li.setAttribute('title', '拖动调整次序（Alt+↑/↓）');
          li.addEventListener('dragstart', function (e) {
            draggingId = cat.id;
            li.classList.add('is-dragging');
            try {
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', cat.id);
              }
            } catch (err) { /* 忽略 */ }
          });
          li.addEventListener('dragover', function (e) {
            if (!draggingId || draggingId === cat.id) return;
            e.preventDefault();
            try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } catch (err) { /* 忽略 */ }
            markDrop(li, e);
          });
          li.addEventListener('drop', function (e) {
            if (!draggingId || draggingId === cat.id) return;
            e.preventDefault();
            var after = dropSide(li, e);
            var fromId = draggingId;
            draggingId = null;
            clearDropMarks();
            reorderTo(fromId, cat.id, after);
          });
          li.addEventListener('keydown', function (e) {
            if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
            e.preventDefault();
            move(cat, e.key === 'ArrowUp' ? -1 : 1);
          });
        }

        /* 2026-10-20（用户反馈）：除「紧急」外一律可自定义 ——
           · 紧急：只可改名（颜色锁定、恒首位、不可删）；
           · 其余（含内置类别，四十八轮起）：改名、改色、排序、删除全部开放。 */
        if (urgent) {
          li.appendChild(el('button', {
            class: 'btn btn-sm', type: 'button', text: '改名',
            title: '「' + cat.name + '」只可改名（颜色固定、恒在首位）',
            onclick: function () { rename(cat); }
          }));
          /* 禁用态统一走灰（不用 btn-danger）：同一列表里两个「删除」一个是红的、
             一个是灰的，会让人以为红色的那个还能点。红色只留给可点的删除。 */
          li.appendChild(el('button', {
            class: 'btn btn-sm', type: 'button', text: '删除', disabled: true,
            title: '「' + cat.name + '」不可删除'
          }));
        } else {
          li.appendChild(el('button', {
            class: 'btn btn-sm', type: 'button', text: '改名',
            onclick: function () { rename(cat); }
          }));
          li.appendChild(el('button', {
            class: 'btn btn-sm btn-danger', type: 'button', text: '删除',
            onclick: function () { remove(cat, refCount[cat.id] || 0); }
          }));
        }
        list.appendChild(li);
      });
      wrap.appendChild(list);

      wrap.appendChild(el('div', { class: 'field', style: 'margin-top:10px' }, [
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '+ 新增类别',
          onclick: function () { create(); }
        })
      ]));
    }

    /** 键盘 Alt+↑/↓：等价于拖动一步（调用 store.moveCategoryOrder；紧急被 store 拒绝为无操作） */
    function move(cat, delta) {
      try {
        store.moveCategoryOrder(cat.id, delta);
      } catch (e) {
        if (M && M.toast) M.toast(e.message || '调整次序失败');
        return;
      }
      render();
      notify();
    }

    function notify() {
      if (opts.onChange) opts.onChange();
    }

    /**
     * 颜色选择网格（19 色，带中文色名）。create / pickColor 共用，避免两处色板走偏。
     * @param {string} current 当前颜色
     * @param {function(string):void} onPick 选中回调
     * @returns {HTMLElement}
     */
    function colorGrid(current, onPick) {
      var grid = el('div', { class: 'color-grid', role: 'group', 'aria-label': '颜色' });
      Form.COLOR_PRESETS.forEach(function (c) {
        var name = Form.colorNameOf(c);
        var dot = el('button', {
          class: 'color-dot' + (c === current ? ' is-on' : ''), type: 'button',
          style: 'background:' + c,
          title: name + ' ' + c,
          'aria-label': '颜色 ' + name + '（' + c + '）',
          'aria-pressed': c === current ? 'true' : 'false',
          onclick: function () {
            Array.prototype.slice.call(grid.children).forEach(function (n) {
              n.classList.remove('is-on');
              n.setAttribute('aria-pressed', 'false');
            });
            dot.classList.add('is-on');
            dot.setAttribute('aria-pressed', 'true');
            onPick(c);
          }
        });
        grid.appendChild(dot);
      });
      return grid;
    }

    function create() {
      var nameInput = el('input', { type: 'text', maxlength: String(S.CATEGORY_NAME_MAX) });
      /* 默认色取「现有类别还没用过」的第一个预设色 —— 新增类别不该一上来就和别人撞色 */
      var color = Form.nextUnusedColor((store.getState().categories || []).map(function (c) { return c.color; }));
      var grid = colorGrid(color, function (c) { color = c; });
      var handle = M.open({
        title: '新增类别',
        body: el('div', {}, [
          el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '名称' }), nameInput]),
          el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '颜色' }), grid])
        ]),
        submitLabel: '创建',
        onSubmit: function (ctx) {
          try {
            store.addCategory({ name: nameInput.value, color: color });
          } catch (e) {
            ctx.setError(e.message);
            return false;
          }
          handle.close();
          render();
          notify();
          M.toast('已新增类别');
        }
      });
      nameInput.focus();
    }

    function rename(cat) {
      var input = el('input', { type: 'text', maxlength: String(S.CATEGORY_NAME_MAX), value: cat.name });
      var handle = M.open({
        title: '重命名类别',
        body: el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '名称' }), input]),
        submitLabel: '保存',
        onSubmit: function (ctx) {
          try {
            store.updateCategory(cat.id, { name: input.value });
          } catch (e) {
            ctx.setError(e.message);
            return false;
          }
          handle.close(); render(); notify();
        }
      });
      input.focus();
      input.select();
    }

    function pickColor(cat) {
      /* 入口防御：紧急的色块已渲染成不可点的标记，这里再兜一层（store 也会拒绝） */
      if (S.isUrgentCategory(cat)) {
        if (M && M.toast) M.toast('「' + cat.name + '」只可改名，颜色固定');
        return;
      }
      var color = cat.color;
      var grid = colorGrid(cat.color, function (c) { color = c; });
      var handle = M.open({
        title: '修改颜色 · ' + cat.name,
        body: el('div', { class: 'field' }, [grid]),
        submitLabel: '保存',
        onSubmit: function (ctx) {
          try {
            store.updateCategory(cat.id, { color: color });
          } catch (e) {
            ctx.setError(e.message);
            return false;
          }
          handle.close(); render(); notify();
        }
      });
    }

    function remove(cat, count) {
      if (count === 0) {
        M.confirm({ title: '删除类别', message: '确定删除类别「' + cat.name + '」？', confirmLabel: '删除', danger: true })
          .then(function (ok) {
            if (!ok) return;
            store.removeCategory(cat.id);
            render(); notify();
            M.toast('已删除类别');
          });
        return;
      }
      // 被引用：必须选择迁移目标
      var doc = store.getState();
      var preferredId = doc.settings && doc.settings.defaultCategoryId;
      if (preferredId === cat.id) preferredId = null;
      var select = el('select', { 'aria-label': '迁移到' });
      doc.categories.filter(function (c) { return c.id !== cat.id; }).forEach(function (c) {
        var o = el('option', { value: c.id, text: c.name });
        if (c.id === preferredId) o.selected = true;
        select.appendChild(o);
      });
      var handle = M.open({
        title: '删除类别并迁移事项',
        body: el('div', {}, [
          el('p', { style: 'margin:0 0 8px', text: '类别「' + cat.name + '」正被 ' + count + ' 个事项使用。请选择要把它们迁移到的类别：' }),
          el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '迁移到' }), Form.selectFieldControl(select).wrap])
        ]),
        submitLabel: '迁移并删除',
        onSubmit: function (ctx) {
          try {
            store.removeCategory(cat.id, select.value);
          } catch (e) {
            ctx.setError(e.message);
            return false;
          }
          handle.close(); render(); notify();
          M.toast('类别已删除，事项已迁移');
        }
      });
    }

    render();
    return { element: wrap, render: render };
  }

  /**
   * 打开设置面板。
   * @param {object} opts { store, onDataChanged, onOpenChange }
   */
  function openSettings(opts) {
    var store = opts.store;
    var body = el('div', {});
    var changed = false;

    function dataChanged() {
      changed = true;
      if (opts.onDataChanged) opts.onDataChanged();
    }

    /* ---------- 类别 ---------- */
    var catSection = el('section', { class: 'settings-section' }, [
      el('h3', { text: '类别' })
    ]);
    var catMgr = categoryManager({
      store: store,
      onChange: function () { dataChanged(); }
    });
    catSection.appendChild(catMgr.element);
    body.appendChild(catSection);

    /* ---------- 显示 ---------- */
    var doc = store.getState();
    /* 美化迭代 3：界面主题（浅色 / 深色 / 跟随系统），由 app.js 写 <html data-theme> */
    var themeSelect = el('select', { 'aria-label': '界面主题' });
    [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].forEach(function (pair) {
      themeSelect.appendChild(el('option', { value: pair[0], text: pair[1] }));
    });
    themeSelect.value = (doc.settings.theme === 'light' || doc.settings.theme === 'dark')
      ? doc.settings.theme : 'auto';
    themeSelect.addEventListener('change', function () {
      store.updateSettings({ theme: themeSelect.value });
      dataChanged();
    });
    var lunarChk = el('input', { type: 'checkbox' });
    lunarChk.checked = doc.settings.showLunarInCalendar !== false;
    lunarChk.addEventListener('change', function () {
      store.updateSettings({ showLunarInCalendar: lunarChk.checked });
      dataChanged();
    });
    var noteChk = el('input', { type: 'checkbox' });
    noteChk.checked = doc.settings.showNoteMarker !== false;
    noteChk.addEventListener('change', function () {
      store.updateSettings({ showNoteMarker: noteChk.checked });
      dataChanged();
    });
    // 迭代 3（F-19）：日视图时间轴缩放改用 range 滑块，范围 60–160 px/小时，默认 96
    var dayPx = Number(doc.settings.dayPxPerHour);
    if (!isFinite(dayPx) || dayPx <= 0) dayPx = Number(doc.settings.pxPerHour);
    if (!isFinite(dayPx) || dayPx <= 0) dayPx = 96;
    dayPx = Math.min(160, Math.max(60, dayPx));
    var zoomRange = el('input', {
      class: 'range',
      type: 'range', min: '60', max: '160', step: '4',
      'aria-label': '日视图时间轴缩放'
    });
    zoomRange.value = String(dayPx);
    var zoomOut = el('span', { class: 'range-value', text: dayPx + ' px/小时' });
    zoomRange.addEventListener('input', function () {
      var v = parseInt(zoomRange.value, 10);
      zoomOut.textContent = v + ' px/小时';
      syncRangeFill(zoomRange);
    });
    zoomRange.addEventListener('change', function () {
      var v = parseInt(zoomRange.value, 10);
      store.updateSettings({ dayPxPerHour: v, pxPerHour: v });
      dataChanged();
    });

    // 周视图纵向缩放（F-18.1，40–96）
    var weekPx = Number(doc.settings.weekPxPerHour);
    if (!isFinite(weekPx) || weekPx <= 0) weekPx = 56;
    weekPx = Math.min(96, Math.max(40, weekPx));
    var weekRange = el('input', {
      class: 'range',
      type: 'range', min: '40', max: '96', step: '4',
      'aria-label': '周视图时间轴缩放'
    });
    weekRange.value = String(weekPx);
    var weekOut = el('span', { class: 'range-value', text: weekPx + ' px/小时' });
    weekRange.addEventListener('input', function () {
      weekOut.textContent = weekRange.value + ' px/小时';
      syncRangeFill(weekRange);
    });
    weekRange.addEventListener('change', function () {
      store.updateSettings({ weekPxPerHour: parseInt(weekRange.value, 10) });
      dataChanged();
    });

    // 空闲紧凑开关与窄带高度（F-16.4 / BR-20）
    var compressChk = el('input', { type: 'checkbox', 'aria-label': '启用空闲时段紧凑' });
    compressChk.checked = doc.settings.idleCompressEnabled !== false;
    compressChk.addEventListener('change', function () {
      store.updateSettings({ idleCompressEnabled: compressChk.checked });
      dataChanged();
    });
    var holidayChk = el('input', { type: 'checkbox', 'aria-label': '标注中国大陆节假日' });
    holidayChk.checked = doc.settings.showHolidayMarker !== false;
    holidayChk.addEventListener('change', function () {
      store.updateSettings({ showHolidayMarker: holidayChk.checked });
      dataChanged();
    });

    /* 2026-10-21（用户反馈）：「隐藏已完成」从日 / 周视图工具栏移入设置；
       沿用 UI state（非文档设置），改动后经 dataChanged → 各视图 refresh 生效。 */
    var hideDoneChk = el('input', { type: 'checkbox', 'aria-label': '隐藏已完成' });
    var uiState = (typeof store.loadUIState === 'function') ? store.loadUIState() : null;
    hideDoneChk.checked = !!(uiState && uiState.hideDone);
    hideDoneChk.addEventListener('change', function () {
      store.saveUIState({ hideDone: hideDoneChk.checked });
      dataChanged();
    });

    /* 2026-10-22 二十三轮（用户反馈）：完成台的提示音响铃开关从标题栏移入设置；
       仍写 UI 状态（非文档设置），并即时同步到已创建的完成台实例。 */
    var finishSoundChk = el('input', { type: 'checkbox', 'aria-label': '事项完成台计时结束提示音' });
    finishSoundChk.checked = !uiState || uiState.finishSound !== false;
    finishSoundChk.addEventListener('change', function () {
      var on = finishSoundChk.checked;
      store.saveUIState({ finishSound: on });
      if (opts.onFinishSoundChange) opts.onFinishSoundChange(on);
    });

    /* 2026-10-20（用户反馈）：
       ① 四个是否型选项原来各占一整行、还把两条滑条夹在中间；改成两列网格（一排两个），
          含义相邻的配成一行：农历 / 记录，节假日 / 压缩。
       ② 两条滑条改成「标签 + 当前值」一行、滑条通铺下一行（用户要求「横向顶满」），
          并把初值同步进 --range-fill，让已划区一开始就是蓝色。
       2026-10-22 二十四轮（用户反馈）：六个开关固定三行、每行两个，行距相等；
       「隐藏已完成」与「完成台提示音」不再整行跨列。 */
    function switchField(input, text) {
      return el('div', { class: 'field' }, [
        el('label', { class: 'switch' }, [input, el('span', { text: text })])
      ]);
    }

    function rangeField(labelText, input, out) {
      return el('div', { class: 'field' }, [
        el('div', { class: 'range-head' }, [
          el('label', { class: 'field-label', text: labelText }),
          out
        ]),
        input
      ]);
    }

    function syncRangeFill(input) {
      var min = Number(input.min);
      var max = Number(input.max);
      var v = Number(input.value);
      var pct = (isFinite(min) && isFinite(max) && max > min) ? ((v - min) / (max - min)) * 100 : 0;
      if (input.style && typeof input.style.setProperty === 'function') {
        input.style.setProperty('--range-fill', pct.toFixed(2) + '%');
      }
    }

    syncRangeFill(zoomRange);
    syncRangeFill(weekRange);

    body.appendChild(el('section', { class: 'settings-section' }, [
      el('h3', { text: '显示' }),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '界面主题' }), Form.selectFieldControl(themeSelect).wrap
      ]),
      el('div', { class: 'switch-grid' }, [
        switchField(lunarChk, '月历显示农历日期'),
        switchField(noteChk, '月历标注有记录的日子'),
        switchField(holidayChk, '标注中国大陆节假日（休 / 班）'),
        switchField(compressChk, '压缩无安排时段（首末两端，日/周视图）'),
        switchField(hideDoneChk, '隐藏已完成（日 / 周视图）'),
        switchField(finishSoundChk, '事项完成台计时结束提示音')
      ]),
      rangeField('日视图时间轴宽度', zoomRange, zoomOut),
      rangeField('周视图时间轴高度', weekRange, weekOut)
    ]));

    /* ---------- 数据 ---------- */
    var exportBtn = el('button', {
      class: 'btn', type: 'button', text: '导出 JSON 备份',
      onclick: function () {
        try {
          var payload = store.exportDocument();
          var name = 'dayplan-' + D.todayISO().replace(/-/g, '') + '-' +
            new Date().toTimeString().slice(0, 5).replace(':', '') + '.json';
          downloadJson(name, payload);
          M.toast('已导出 ' + name);
        } catch (e) {
          M.toast('导出失败：' + e.message);
        }
      }
    });

    var fileInput = el('input', {
      type: 'file', accept: '.json,application/json', style: 'display:none',
      'aria-label': '选择要导入的 JSON 文件'
    });
    var modeSelect = el('select', { 'aria-label': '导入方式' });
    [['merge', '合并（同 id 取较新）'], ['replace', '覆盖（替换全部数据）']].forEach(function (pair) {
      modeSelect.appendChild(el('option', { value: pair[0], text: pair[1] }));
    });
    var importBtn = el('button', {
      class: 'btn', type: 'button', text: '导入 JSON',
      onclick: function () { fileInput.click(); }
    });

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var res = store.importDocument(String(reader.result), modeSelect.value);
        fileInput.value = '';
        if (!res.ok) {
          var lines = (res.errors || []).slice(0, 8).map(function (e) { return '· ' + e.path + '：' + e.message; });
          M.open({
            title: '导入失败（未修改任何数据）',
            body: el('div', {}, [
              el('p', { style: 'margin:0 0 6px', text: '错误码：' + (res.code || 'E_UNKNOWN') }),
              el('pre', { style: 'white-space:pre-wrap;margin:0;font-size:12px', text: lines.join('\n') || '无详细信息' })
            ]),
            showSubmit: false,
            cancelLabel: '关闭'
          });
          return;
        }
        dataChanged();
        M.toast('导入成功' + (res.warnings && res.warnings.length ? '（有 ' + res.warnings.length + ' 条警告）' : ''), {
          actionLabel: '回退',
          onAction: function () {
            var rb = store.rollbackImport();
            if (rb.ok) { dataChanged(); M.toast('已回退到导入前'); }
            else M.toast('回退失败：' + (rb.errors && rb.errors[0] ? rb.errors[0].message : '无快照'));
          }
        });
      };
      reader.onerror = function () { M.toast('读取文件失败'); };
      reader.readAsText(file);
    });

    var rollbackBtn = el('button', {
      class: 'btn', type: 'button', text: '回退到导入前',
      onclick: function () {
        var rb = store.rollbackImport();
        if (rb.ok) { dataChanged(); M.toast('已回退到导入前快照'); }
        else M.toast('没有可回退的快照');
      }
    });

    var clearBtn = el('button', {
      class: 'btn btn-danger', type: 'button', text: '清空全部数据',
      onclick: function () {
        M.typedConfirm({
          title: '清空全部数据',
          message: '将删除本机保存的全部事项、类别与记录，且不会重新注入演示数据。建议先导出备份。',
          expect: '清空',
          confirmLabel: '确认清空'
        }).then(function (ok) {
          if (!ok) return;
          if (!store.clearAll()) {
            var err = store.getLastError();
            M.toast('清空失败：' + (err && err.message ? err.message : '浏览器存储不可用'));
            return;
          }
          /* 只清的是**当前作用域**（游客或某个账号副本）。云端那一份没动，
             但同步必须立刻停下：否则下一次编辑会走 push()，把空文档推上云端，
             而用户以为自己只是「清空了本机」。 */
          if (typeof opts.onDataCleared === 'function') {
            try { opts.onDataCleared(); } catch (e) { /* 同步暂停失败不影响清空结果 */ }
          }
          dataChanged();
          var cloudKept = false;
          try {
            var w = typeof opts.getWiring === 'function' ? opts.getWiring() : null;
            var d = w && typeof w.describe === 'function' ? w.describe() : null;
            cloudKept = !!(d && d.uid);
          } catch (e) { cloudKept = false; }
          M.toast(cloudKept ? '已清空本机数据（云端那份仍然保留）' : '已清空全部数据');
        });
      }
    });

    /* 同步分组自带 <section> + <h3>，这里只负责挂载，不再套一层外壳
       （套了会让「同步」在设置里出现两次，SC-101 会判红）。 */
    (function () {
      var panel = root.DayPlan.syncPanel;
      if (!panel || typeof panel.createSyncSection !== 'function') {
        body.appendChild(el('section', { class: 'settings-section' }, [
          el('h3', { text: '同步' }),
          el('div', { class: 'field', text: '同步模块未加载，当前为本机模式。' })
        ]));
        return;
      }
      /* 状态行要能实时刷新：调度层的推送是异步完成的，打开面板时读到的那一次
         很可能还是上一次的结果。把实例存下来，onStatus 触发时重渲染。 */
      var inst = panel.createSyncSection({
        getWiring: opts.getWiring || function () { return null; },
        getConn: opts.getConn || function () { return null; },
        getSteady: opts.getSteady || function () { return null; },
        /* 契约 §4.2 C / §4.7：覆盖前任一边之前必须先把本机导出一份。
           这里复用「数据」分组同一个导出实现，命名上前缀区分开，便于事后辨认。 */
        exportBackup: function () {
          var payload = store.exportDocument();
          var name = 'dayplan-同步前备份-' + D.todayISO().replace(/-/g, '') + '-' +
            new Date().toTimeString().slice(0, 5).replace(':', '') + '.json';
          downloadJson(name, payload);
          M.toast('已导出备份，可随时用「导入 JSON」恢复');
        },
        onConnectReal: opts.onConnectReal,
        /* 2026-10-27：必须转发——「登录并同步」按钮靠它判断内置云服务是否可用，
           漏传会让按钮在任何环境都报「当前版本没有内置云服务」（UI-18 守护）。 */
        getDefaultConn: opts.getDefaultConn,
        /* D11：「断开连接」入口已移除，onDisconnectReal 不再下发给面板。 */
        onEnableDemo: opts.onEnableDemoSync,
        onDisable: opts.onDisableDemoSync,
        onSessionChanged: opts.onSessionChanged,
        /* 有损修复（§1.8）要求导出两份**指定文件名**的 JSON：
           remote-raw.json（云端原始 payload）与 local-current.json（当前本机文档）。
           文件名是引擎核对凭据的一部分（lossy-gate.REQUIRED_DOWNLOADS），
           所以这里必须交出「按名字下载」的能力，不能只给一个「导出备份」。 */
        downloadJson: downloadJson,
        exportDocument: function () { return store.exportDocument(); },
        /* 清空本机之后必须让同步停下来（T-R03）：否则下一次编辑会把空文档推上云。 */
        onDataCleared: opts.onDataCleared,
        onDataChanged: function () { dataChanged(); }
      });
      if (opts.registerSyncSection) opts.registerSyncSection(inst);
      body.appendChild(inst.element);
    })();

    body.appendChild(el('section', { class: 'settings-section' }, [
      el('h3', { text: '数据' }),
      el('div', { class: 'field' }, [
        el('div', { class: 'inline' }, [exportBtn, importBtn, rollbackBtn, fileInput])
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '导入方式' }), Form.selectFieldControl(modeSelect).wrap
      ]),
      el('div', { class: 'field', style: 'margin-top:14px' }, [clearBtn])
    ]));

    M.open({
      title: '设置',
      body: body,
      wide: true,
      showSubmit: false,
      cancelLabel: '关闭',
      onClose: function () {
        if (changed && opts.onDataChanged) opts.onDataChanged();
      }
    });
  }

  function downloadJson(filename, payload) {
    var text = JSON.stringify(payload, null, 2);
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  root.DayPlan.settingsView = {
    openSettings: openSettings,
    categoryManager: categoryManager,
    downloadJson: downloadJson
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
