/**
 * DayPlan · 事项表单（新建 / 编辑 / 重复实例的范围操作）
 *
 * 契约：F-03、F-06、F-11.3、BR-2、DM-4、DM-6。
 * 表单只负责取值与前端校验；写入由 store 负责（store 会做二次校验）。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var D = root.DayPlan.datetime;
  var S = root.DayPlan.schema;
  var R = root.DayPlan.recurrence;
  var M = root.DayPlan.modal;
  var el = M.el;

  /* 2026-10-20（用户反馈）：类别颜色只给 12 种不够用 —— 扩到 19 种，按色相红→紫→蓝→绿→
     黄→橙→棕→中性排列，相邻两色差异肉眼可辨。原 12 色**全部保留在原值上**（已存数据的
     color 不做任何迁移，只是新选择变多）。新增的 7 色都取 600/700 档：类别色同时用作
     9px 胶囊文字色与 14% 淡底的描边，太浅的 300/400 档在白底上读不出来。 */
  var COLOR_PRESETS = [
    '#dc2626', '#be123c', '#db2777', '#a21caf', '#7c3aed', '#4338ca',
    '#2563eb', '#0ea5e9', '#0891b2', '#0d9488', '#059669', '#16a34a',
    '#4d7c0f', '#ca8a04', '#ea580c', '#92400e', '#78716c', '#475569',
    '#111827'
  ];
  /** 与 COLOR_PRESETS 一一对应的中文色名（只用于 title / aria-label，不参与渲染） */
  var COLOR_NAMES = [
    '红', '玫红', '粉', '品红', '紫', '靛',
    '蓝', '天蓝', '青', '蓝绿', '翠绿', '绿',
    '橄榄', '黄', '橙', '棕', '灰', '石板灰',
    '黑'
  ];
  /** 迭代 7（F-47 / R-30）：时间滚轮刻度（分钟） */
  var TIME_STEP = 5;
  var WEEKDAY_LABELS = [[1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [7, '周日']];
  var REPEAT_TYPES = [
    ['none', '不重复'],
    ['daily', '每天'],
    ['weekly', '每周'],
    ['monthly', '每月'],
    ['yearly', '每年（公历）'],
    ['lunarYearly', '每年（农历）']
  ];

  function numberInput(attrs) {
    return el('input', Object.assign({ type: 'number', min: '1' }, attrs));
  }

  /* ---------------- 迭代 7：日期「日历簿」/ 时间「密码锁」（F-48） ---------------- */

  /** picker 模块（src/core/picker.js）；未加载时返回 null，控件降级为原生输入。 */
  function pickerApi() {
    return (root.DayPlan && root.DayPlan.picker) || null;
  }

  function changeNow(node) {
    if (!node || typeof node.dispatchEvent !== 'function') return;
    /* 真实浏览器要求 Event 实例（普通对象会抛 TypeError 且被吞掉，change 监听静默失效）；
       垫片环境可能没有 Event 构造器，回退到普通对象交给垫片自己的 dispatchEvent。 */
    try {
      var ev = null;
      if (typeof root.Event === 'function') {
        ev = new root.Event('change', { bubbles: true });
      } else if (typeof document !== 'undefined' && typeof document.createEvent === 'function') {
        ev = document.createEvent('Event');
        ev.initEvent('change', true, false);
      }
      if (ev) node.dispatchEvent(ev);
      else node.dispatchEvent({ type: 'change' });
    } catch (e) {
      try { node.dispatchEvent({ type: 'change' }); } catch (e2) { /* 垫片无事件系统时忽略 */ }
    }
  }

  /* 美化迭代 9：字段级红字提示改为「亮起数秒后自动消失」（用户裁定，顶部横幅不再重复显示） */
  var FIELD_ERROR_TTL_MS = 4000;
  var fieldErrorTimers = Object.create(null);
  function flashFieldError(node, key, text) {
    if (!node) return;
    node.textContent = text || '';
    if (fieldErrorTimers[key]) clearTimeout(fieldErrorTimers[key]);
    if (!text) return;
    fieldErrorTimers[key] = setTimeout(function () {
      node.textContent = '';
      delete fieldErrorTimers[key];
    }, FIELD_ERROR_TTL_MS);
  }

  /** 下一帧回调（无 rAF 时退化为 setTimeout 0）。 */
  function nextFrame(fn) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
    return setTimeout(fn, 0);
  }

  /** 日期显示文案：优先 picker.formatDateCN，其次 datetime.formatDateCN，最后回退原文 */
  function dateLabelCN(iso) {
    var P = pickerApi();
    if (P && typeof P.formatDateCN === 'function') {
      var s = P.formatDateCN(iso);
      if (s) return s;
    }
    if (D && typeof D.formatDateCN === 'function' && D.isValidDate(iso)) return D.formatDateCN(iso);
    return iso || '选择日期';
  }

  /**
   * 日期控件（迭代 7 / F-48.3）：可见按钮显示「2026年7月26日」，点击展开日历浮层；
   * 隐藏的文本输入仍是唯一取值载体（既有 change/input 监听与校验链路不变）。
   * @returns {{wrap:HTMLElement, input:HTMLElement, button:HTMLElement}}
   */
  function dateFieldControl(attrs) {
    var input = dateTextInput(attrs);
    input.style.display = 'none';   // 取值载体：日历浮层写回；显示由 .dp-date-btn 承担
    var button = el('button', {
      class: 'dp-date-btn', type: 'button',
      text: dateLabelCN(input.value), 'aria-label': '选择日期（当前 ' + (input.value || '未选') + '）',
      'data-date-value': input.value || ''
    });
    var wrap = el('div', { class: 'dp-date-field' }, [input, button]);

    var P = pickerApi();
    if (!P || typeof P.createCalendar !== 'function') {
      /* 降级：picker 未加载时回到可手输的文本框（观感不同，但不丢功能） */
      input.style.display = '';
      button.style.display = 'none';
      return { wrap: wrap, input: input, button: button };
    }

    var pop = el('div', { class: 'dp-pop', hidden: true });
    var cal = null;
    try {
      cal = P.createCalendar({
        value: input.value,
        ariaLabel: '日期选择',
        /* 复核修复（真实浏览器时序）：文档捕获阶段的「外部点击关闭」必须忽略本控件自己的
           按钮与容器，否则按钮的 click 会先被 close、再被自身处理器重新打开 → 关不掉。 */
        ignoreOutside: [wrap, button],
        onSelect: function (iso) {
          input.value = iso;
          button.textContent = dateLabelCN(iso);
          button.setAttribute('data-date-value', iso);
          button.setAttribute('aria-label', '选择日期（当前 ' + iso + '）');
          pop.hidden = true;
          if (cal && typeof cal.close === 'function') cal.close();
          changeNow(input);
        },
        /* 浮层显隐由 form 拥有；picker 只维护自身状态，靠 onClose 回灌（picker-dev 约定） */
        onClose: function () { pop.hidden = true; }
      });
    } catch (e) {
      cal = null;
    }
    if (!cal || !cal.element) return { wrap: wrap, input: input, button: button };
    pop.appendChild(cal.element);
    wrap.appendChild(pop);

    function syncFromInput() {
      button.textContent = dateLabelCN(input.value);
      button.setAttribute('data-date-value', input.value || '');
      if (typeof cal.setValue === 'function') cal.setValue(input.value);
    }
    button.addEventListener('click', function (e) {
      e.stopPropagation();
      /* 用「picker 此刻是否打开」而不是 DOM 的 pop.hidden 判定：
         真实浏览器里 document 捕获监听可能已经先跑过（见 ignoreOutside 的说明）。 */
      var isOpen = (typeof cal.isOpen === 'function') ? cal.isOpen() : (pop.hidden === false);
      if (isOpen) {
        if (typeof cal.close === 'function') cal.close();
        pop.hidden = true;
        return;
      }
      pop.hidden = false;
      if (typeof cal.open === 'function') cal.open();
      nextFrame(function () {
        if (typeof cal.focus === 'function') cal.focus();
      });
    });
    input.addEventListener('change', syncFromInput);
    input.addEventListener('input', syncFromInput);
    wrap.className = 'dp-date-field is-picker';
    return { wrap: wrap, input: input, button: button };
  }

  /** 单列滚轮（小时 / 分钟）；picker 缺失时返回 null，由调用方降级。 */
  function buildWheel(P, opts) {
    try {
      var wheel = P.createWheel(opts);
      if (wheel && wheel.element) return wheel;
    } catch (e) { /* 降级 */ }
    return null;
  }

  /**
   * 时间控件（迭代 7 / F-48.2）：可见按钮显示 `HH:mm`，点击展开「密码锁」滚轮（时 + 分，默认 5 分钟刻度）；
   * 隐藏的 `input[type=time]` 仍是唯一取值载体。
   * @param {object} attrs
   * @param {{step?: number}} [opts] step：分钟刻度（五十一轮倒计时用 1，精确到分）
   * @returns {{wrap:HTMLElement, input:HTMLElement, button:HTMLElement}}
   */
  function timeFieldControl(attrs, opts) {
    opts = opts || {};
    var input = el('input', Object.assign({ type: 'time' }, attrs));
    input.style.display = 'none';
    var button = el('button', {
      class: 'dp-time-btn', type: 'button', text: input.value || '--:--',
      'aria-label': '选择时间（当前 ' + (input.value || '未选') + '）'
    });
    button.textContent = input.value || '--:--';
    var wrap = el('div', { class: 'dp-time-field' }, [input, button]);

    var P = pickerApi();
    if (!P || typeof P.createWheel !== 'function') return { wrap: wrap, input: input, button: button };

    var step = TIME_STEP;
    if (typeof opts.step === 'number' && opts.step > 0 && opts.step <= 60) step = Math.floor(opts.step);
    var hours = (typeof P.hourOptions === 'function') ? P.hourOptions() : null;
    var minutes = (typeof P.minuteOptions === 'function') ? P.minuteOptions(step) : null;
    if (!hours || !minutes) return { wrap: wrap, input: input, button: button };

    var pop = el('div', { class: 'dp-pop', hidden: true });
    var cols = el('div', { class: 'dp-wheels' });
    var parts = (typeof P.timeParts === 'function') ? (P.timeParts(input.value) || {}) : {};
    var hWheel = null;
    var mWheel = null;

    function write() {
      if (!hWheel || !mWheel) return;
      var hh = hWheel.value();
      var mm = mWheel.value();
      if (!hh || !mm) return;
      var v = hh + ':' + mm;
      if (input.value === v) return;
      input.value = v;
      button.textContent = v;
      button.setAttribute('aria-label', '选择时间（当前 ' + v + '）');
      changeNow(input);
    }

    hWheel = buildWheel(P, {
      values: hours, value: parts.hour || '09', itemHeight: 32, ariaLabel: '小时'
    });
    mWheel = buildWheel(P, {
      values: minutes, value: parts.minute || '00', itemHeight: 32, ariaLabel: '分钟'
    });
    if (!hWheel || !mWheel) return { wrap: wrap, input: input, button: button };
    cols.appendChild(hWheel.element);
    cols.appendChild(el('span', { class: 'dp-wheel-sep', text: ':' }));
    cols.appendChild(mWheel.element);
    pop.appendChild(cols);
    wrap.appendChild(pop);
    wrap.className = 'dp-time-field is-picker';

    /* 迭代 8（F-56）：浮层从 hidden 变可见后必须重新对齐「中间行」——
       隐藏期对 .dp-wheel 赋 scrollTop 不生效，不补这一下会把中间行读成 00。 */
    function syncWheels() {
      if (hWheel && typeof hWheel.syncScroll === 'function') hWheel.syncScroll();
      if (mWheel && typeof mWheel.syncScroll === 'function') mWheel.syncScroll();
    }

    /* 迭代 8（F-58）：点外部关闭 —— 判定交给 picker.createOutsideCloser（document 捕获期），
       自己的容器（含触发按钮）放进 ignore：否则真实浏览器里捕获先关、按钮再开 → 关不掉。 */
    var closer = (typeof P.createOutsideCloser === 'function')
      ? P.createOutsideCloser({
        ignore: [wrap, button],
        isOpen: function () { return !pop.hidden; },
        onOutside: function () {
          pop.hidden = true;
          if (closer) closer.unbind();
        }
      })
      : null;

    function openPop() {
      pop.hidden = false;
      syncWheels();
      nextFrame(syncWheels);
      if (closer) closer.bind();
    }

    function closePop() {
      pop.hidden = true;
      if (closer) closer.unbind();
    }

    /* 落点提交：优先 scrollend（真实浏览器），其次滚动节流兜底（垫片/旧内核） */
    function bindCommit(wheel) {
      var list = wheel.element;
      var timer = null;
      function later() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(write, 120);
      }
      list.addEventListener('scroll', later);
      list.addEventListener('scrollend', write);
    }
    bindCommit(hWheel);
    bindCommit(mWheel);

    button.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop.hidden) openPop();
      else closePop();
    });
    input.addEventListener('change', function () {
      var p = (typeof P.timeParts === 'function') ? (P.timeParts(input.value) || {}) : {};
      button.textContent = input.value || '--:--';
      if (p.hour && hWheel.setValue) hWheel.setValue(p.hour);
      if (p.minute && mWheel.setValue) mWheel.setValue(p.minute);
    });
    return { wrap: wrap, input: input, button: button };
  }

  /**
   * 下拉控件（美化迭代 7）：隐藏原生 <select>（仍是唯一取值载体，既有 change 监听与
   * collect()/校验链路不变），可见按钮显示当前选项，点击展开与「日历簿」同风格的浮层列表。
   * picker 缺失时降级为原生 select（观感不同，但不丢功能）。
   * @param {HTMLSelectElement} select 已装配好 option 的原生下拉
   * @returns {{wrap:HTMLElement, select:HTMLSelectElement, button:HTMLElement}}
   */
  function selectFieldControl(select) {
    var P = pickerApi();
    var wrap = el('div', { class: 'dp-select-field' }, [select]);
    if (!P || typeof P.createOutsideCloser !== 'function') {
      return { wrap: wrap, select: select, button: null };
    }
    select.style.display = 'none';

    function optionText(v) {
      var opts = select.options || [];
      for (var i = 0; i < opts.length; i += 1) {
        if (opts[i].value === v) return opts[i].textContent;
      }
      return '';
    }
    var label = el('span', { class: 'dp-select-label', text: optionText(select.value) });
    var caret = el('span', { class: 'dp-select-caret', 'aria-hidden': 'true' });
    var button = el('button', {
      class: 'dp-select-btn', type: 'button',
      'aria-haspopup': 'listbox',
      'aria-label': (select.getAttribute('aria-label') || '选择') + '（当前 ' + (optionText(select.value) || '未选') + '）'
    }, [label, caret]);

    var pop = el('div', { class: 'dp-pop dp-select-pop', hidden: true, role: 'listbox' });
    var closer = P.createOutsideCloser({
      ignore: [wrap, button, pop],
      isOpen: function () { return !pop.hidden; },
      onOutside: function () {
        pop.hidden = true;
        if (closer) closer.unbind();
      }
    });

    function syncButton() {
      label.textContent = optionText(select.value);
      button.setAttribute('aria-label', (select.getAttribute('aria-label') || '选择') + '（当前 ' + (optionText(select.value) || '未选') + '）');
    }

    function renderList() {
      pop.innerHTML = '';
      Array.prototype.forEach.call(select.options, function (o) {
        var on = o.value === select.value;
        var item = el('button', {
          class: 'dp-select-item' + (on ? ' is-selected' : ''),
          type: 'button', text: o.textContent,
          role: 'option', 'aria-selected': on ? 'true' : 'false'
        });
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          if (select.value !== o.value) {
            select.value = o.value;
            syncButton();
            changeNow(select);
          }
          pop.hidden = true;
          if (closer) closer.unbind();
        });
        pop.appendChild(item);
      });
    }

    button.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop.hidden) {
        renderList();
        pop.hidden = false;
        if (closer) closer.bind();
      } else {
        pop.hidden = true;
        if (closer) closer.unbind();
      }
    });
    /* 值被程序改写（校验回填 / 预览链路）时按钮文案跟随 */
    select.addEventListener('change', syncButton);

    wrap.appendChild(button);
    wrap.appendChild(pop);
    wrap.className = 'dp-select-field is-picker';
    return { wrap: wrap, select: select, button: button };
  }

  /* ---------------- 紧急（迭代 4 / DM-18 / AC-27.2） ---------------- */

  var URGENT_ID = (S && S.URGENT_CATEGORY_ID) || 'urgent';

  function isUrgentId(id) {
    return id === URGENT_ID;
  }

  /** 下拉里必须始终存在「紧急」选项（即使调用方传来的类别表缺失它） */
  function ensureUrgentOption(list) {
    var arr = (list || []).slice();
    if (!arr.some(function (c) { return c && c.id === URGENT_ID; })) {
      arr.unshift({ id: URGENT_ID, name: '紧急', color: '#dc2626', builtin: true, special: 'urgent', order: -1 });
    }
    return arr;
  }

  /** 第一个非紧急类别（取消勾选时回落） */
  function firstNonUrgentId(list) {
    var arr = list || [];
    for (var i = 0; i < arr.length; i += 1) {
      if (arr[i] && !isUrgentId(arr[i].id)) return arr[i].id;
    }
    return null;
  }

  /** 复制 item.meta（保留 origin 等既有字段），并按紧急状态增删 previousCategoryId */
  function metaFor(item, urgent, prevCategoryId) {
    var base = (item && S.isPlainObject(item.meta)) ? Object.assign({}, item.meta) : {};
    if (urgent) base.previousCategoryId = prevCategoryId;
    else delete base.previousCategoryId;
    return base;
  }

  /**
   * 日期文本输入（YYYY-MM-DD）。
   * 不用 `input[type=date]`：其占位符随浏览器语言显示为 `yyyy/mm/日`，观感差；
   * 文本输入在不同浏览器/语言下外观一致，并自带格式提示与校验。
   */
  function dateTextInput(attrs) {
    return el('input', Object.assign({
      type: 'text', inputmode: 'numeric', maxlength: '10',
      placeholder: 'YYYY-MM-DD', autocomplete: 'off', spellcheck: 'false'
    }, attrs));
  }

  /** 把各种可能的值归一为 "YYYY-MM-DD" 或 "" */
  function normalizeDateText(value) {
    if (!value) return '';
    var s = String(value).trim();
    if (D.isValidDate(s)) return s;
    var m = /^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/.exec(s);
    if (m) {
      var iso = m[1] + '-' + D.pad2(Number(m[2])) + '-' + D.pad2(Number(m[3]));
      if (D.isValidDate(iso)) return iso;
    }
    return s; // 保留原值，交给校验报错
  }

  /**
   * 构建事项表单。
   * @param {object} opts
   *   - mode: 'new' | 'edit' | 'occurrence'
   *   - date: 视图日期（新建时的默认日期）
   *   - item: 被编辑的事项/序列（edit/occurrence）
   *   - occurrence: 该次发生的合并后字段（occurrence 模式）
   *   - categories: 类别数组
   *   - defaultCategoryId
   *   - allowScope: 是否显示「仅此次 / 此次及以后」
   *   - onSubmit(values) —— 由调用方写入 store；抛错则报错并保持打开
   *   - extraFooter: 额外的底部元素（如删除按钮）
   */
  function createItemForm(opts) {
    opts = opts || {};
    var mode = opts.mode || 'new';
    var categories = (opts.categories || []).slice();
    var item = opts.item || null;
    var occ = opts.occurrence || null;
    var values = {};
    var errors = {};

    function baseValue(fieldName, fallback) {
      if (occ && Object.prototype.hasOwnProperty.call(occ, fieldName)) return occ[fieldName];
      if (item && Object.prototype.hasOwnProperty.call(item, fieldName)) return item[fieldName];
      return fallback;
    }

    var initial = {
      title: baseValue('title', '') || '',
      categoryId: baseValue('categoryId', opts.defaultCategoryId || (categories[0] && categories[0].id) || URGENT_ID),
      date: (item && item.kind === 'single' ? item.date : null) || opts.date || D.todayISO(),
      time: baseValue('time', opts.time || null),
      note: baseValue('note', '') || '',
      done: !!baseValue('done', false)
    };
    if (!initial.time) initial.time = null;

    // 重复规则初始值
    var repeat = (item && item.kind === 'series' && item.repeat) ? item.repeat : null;
    var repeatType = repeat ? repeat.type : 'none';

    var form = el('div', { class: 'item-form' });

    /* ---------------- 标题 ---------------- */
    var titleInput = el('input', {
      type: 'text', maxlength: String(S.TITLE_MAX), value: initial.title,
      'aria-label': '标题'
    });
    var titleErr = el('div', { class: 'field-error' });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '标题' }), titleInput, titleErr
    ]));

    /* ---------------- 类别（迭代 7 / F-49：紧急的唯一入口就是本下拉） ---------------- */
    var catOptions = ensureUrgentOption(categories);
    var catSelect = el('select', { 'aria-label': '类别' });
    catOptions.forEach(function (c) {
      var o = el('option', { value: c.id, text: c.name });
      if (c.id === initial.categoryId) o.selected = true;
      catSelect.appendChild(o);
    });
    // 转出前的类别（从下拉切走「紧急」时还原）
    var preUrgentCategoryId = isUrgentId(initial.categoryId)
      ? ((item && item.meta && item.meta.previousCategoryId) || firstNonUrgentId(catOptions) || initial.categoryId)
      : initial.categoryId;
    catSelect.addEventListener('change', function () {
      if (catSelect.value !== URGENT_ID) preUrgentCategoryId = catSelect.value;
    });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '类别' }), selectFieldControl(catSelect).wrap
    ]));

    /* ---------------- 日期 + 时间（迭代 7 / F-48：日历簿 + 密码锁） ---------------- */
    var dateCtl = dateFieldControl({ value: initial.date, 'aria-label': '日期（YYYY-MM-DD）' });
    var dateInput = dateCtl.input;
    var dateField = el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: (mode === 'new' && repeatType === 'none') ? '日期' : '开始日期' }),
      dateCtl.wrap
    ]);
    dateField.querySelector('.field-label').id = 'lbl-date';
    var dateErr = el('div', { class: 'field-error' });
    dateField.appendChild(dateErr);

    var timeToggle = el('input', { type: 'checkbox', 'aria-label': '设置起止时间' });
    var timeRow = el('div', { class: 'field-row' });
    var startCtl = timeFieldControl({ value: initial.time ? initial.time.start : '09:00', 'aria-label': '开始时间' });
    var endCtl = timeFieldControl({ value: initial.time ? initial.time.end : '10:00', 'aria-label': '结束时间' });
    var startInput = startCtl.input;
    var endInput = endCtl.input;
    timeRow.appendChild(el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '开始时间' }), startCtl.wrap]));
    timeRow.appendChild(el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '结束时间' }), endCtl.wrap]));
    var timeErr = el('div', { class: 'field-error' });
    var timeBlock = el('div', { class: 'fieldset' }, [
      el('div', { class: 'inline' }, [
        el('label', { class: 'switch' }, [timeToggle, el('span', { text: '设置起止时间' })])
      ]),
      timeRow, timeErr
    ]);

    function syncTimeVisibility() {
      var on = timeToggle.checked;
      timeRow.style.display = on ? '' : 'none';
      if (!on) timeErr.textContent = '';
      // 未定时段的重复事项也可以没有时间，因此不强制
    }
    timeToggle.checked = !!initial.time;
    timeToggle.addEventListener('change', syncTimeVisibility);
    syncTimeVisibility();

    /* ---------------- 重复 ---------------- */
    var repeatBlock = el('div', { class: 'fieldset' });
    var repeatLegend = el('legend', { text: '重复' });
    repeatBlock.appendChild(repeatLegend);

    var repeatTypeSelect = el('select', { 'aria-label': '重复方式' });
    REPEAT_TYPES.forEach(function (t) {
      var o = el('option', { value: t[0], text: t[1] });
      if (t[0] === repeatType) o.selected = true;
      repeatTypeSelect.appendChild(o);
    });

    var repeatParams = el('div', { class: 'repeat-params' });

    // 每周：星期多选
    var weekdayWrap = el('div', { class: 'weekdays' });
    var weekdayInputs = {};
    WEEKDAY_LABELS.forEach(function (pair) {
      var cb = el('input', { type: 'checkbox', value: String(pair[0]) });
      var chip = el('label', { class: 'weekday-chip' }, [cb, el('span', { text: pair[1] })]);
      if (repeat && repeat.weekdays && repeat.weekdays.indexOf(pair[0]) >= 0) {
        cb.checked = true;
      } else if (!repeat && pair[0] === D.isoWeekday(opts.date || D.todayISO())) {
        cb.checked = true; // 新建时默认选中当前星期
      }
      cb.addEventListener('change', function () {
        chip.classList.toggle('is-on', cb.checked);
        updatePreview();
      });
      chip.classList.toggle('is-on', cb.checked);
      weekdayInputs[pair[0]] = cb;
      weekdayWrap.appendChild(chip);
    });

    var intervalInput = numberInput({ value: String((repeat && repeat.interval) || 1), 'aria-label': '间隔', style: 'width:70px' });
    var intervalLabel = el('span', { text: '每' });
    var intervalSuffix = el('span', { text: '周' });
    var monthDayInput = numberInput({ value: String((repeat && repeat.day) || D.parseYearMonth(initial.date).day), min: '1', max: '31', 'aria-label': '每月日期', style: 'width:70px' });
    // 每年（公历）：默认取当前日期的月与日
    var yearMonthInput = numberInput({
      value: String((repeat && repeat.type === 'yearly' && repeat.month) || D.parseYearMonth(initial.date).month),
      min: '1', max: '12', 'aria-label': '公历月份', style: 'width:70px'
    });
    var yearDayInput = numberInput({
      value: String((repeat && repeat.type === 'yearly' && repeat.day) || D.parseYearMonth(initial.date).day),
      min: '1', max: '31', 'aria-label': '公历日期', style: 'width:70px'
    });
    var lunarMonthInput = numberInput({ value: String((repeat && repeat.lunarMonth) || 8), min: '1', max: '12', 'aria-label': '农历月份', style: 'width:70px' });
    var lunarDayInput = numberInput({ value: String((repeat && repeat.lunarDay) || 6), min: '1', max: '30', 'aria-label': '农历日期', style: 'width:70px' });
    var leapCheck = el('input', { type: 'checkbox' });
    if (repeat && repeat.leap) leapCheck.checked = true;
    /* 迭代 7（F-47）：节假日开关对 5 种重复方式全部适用（R-28）。
       四十六轮（用户口径）：日视图与周 / 月计划统一为「不含节假日和周末」，
       勾选时同时写 excludeHolidays / excludeWeekends。 */
    var holidaySkipCheck = el('input', { type: 'checkbox', 'aria-label': '不含节假日和周末' });
    if (repeat && (repeat.excludeHolidays === true || repeat.excludeWeekends === true)) {
      holidaySkipCheck.checked = true;
    }
    var rowHolidaySkip = el('div', { class: 'field' }, [
      el('label', { class: 'switch' }, [holidaySkipCheck, el('span', { text: '不含节假日和周末' })])
    ]);
    /* 四十五轮：是否在事项上显示重复类型与起止日期（时间轴块 / 未排列表同口径）。
       缺省显示；只有显式取消勾选才写 showLabel:false。 */
    var showLabelCheck = el('input', { type: 'checkbox', 'aria-label': '显示重复类型和起止日期' });
    if (!repeat || repeat.showLabel !== false) showLabelCheck.checked = true;
    var rowShowLabel = el('div', { class: 'field' }, [
      el('label', { class: 'switch' }, [showLabelCheck, el('span', { text: '显示重复类型和起止日期' })])
    ]);
    var endDateCtl = dateFieldControl({ value: normalizeDateText((repeat && repeat.endDate) || ''), 'aria-label': '结束日期（不含，YYYY-MM-DD）' });
    var endDateInput = endDateCtl.input;

    var rowInterval = el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '间隔' }),
      el('div', { class: 'inline' }, [intervalLabel, intervalInput, intervalSuffix])
    ]);
    var rowWeekdays = el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '星期（可多选）' }),
      weekdayWrap
    ]);
    var rowMonthDay = el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '每月第几天' }), monthDayInput
    ]);
    var rowLunar = el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '农历日期' }),
      el('div', { class: 'inline' }, [
        el('span', { text: '每年农历' }), lunarMonthInput, el('span', { text: '月' }),
        lunarDayInput, el('span', { text: '日' }),
        el('label', { class: 'switch', style: 'margin-left:8px' }, [leapCheck, el('span', { text: '闰月' })])
      ])
    ]);
    var rowYearly = el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '公历日期' }),
      el('div', { class: 'inline' }, [
        el('span', { text: '每年' }), yearMonthInput, el('span', { text: '月' }),
        yearDayInput, el('span', { text: '日' })
      ])
    ]);
    var rowEndDate = el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '结束日期（不含当天，可留空表示长期）' }),
      endDateCtl.wrap
    ]);

    var previewBox = el('div', { class: 'hint repeat-preview' });

    function currentRepeatType() { return repeatTypeSelect.value; }

    function syncRepeatVisibility() {
      var t = currentRepeatType();
      repeatParams.innerHTML = '';
      // 说明文字由下拉框自身表达（不重复一行"重复：不重复/重复设置"）
      repeatLegend.textContent = '';
      repeatLegend.hidden = true;
      dateField.querySelector('.field-label').textContent = t === 'none' ? '日期' : '开始日期';
      if (t === 'none') { previewBox.textContent = ''; return; }
      if (t === 'daily') {
        intervalSuffix.textContent = '天';
        repeatParams.appendChild(rowInterval);
      } else if (t === 'weekly') {
        intervalSuffix.textContent = '周';
        repeatParams.appendChild(rowInterval);
        repeatParams.appendChild(rowWeekdays);
      } else if (t === 'monthly') {
        intervalSuffix.textContent = '月';
        repeatParams.appendChild(rowInterval);
        repeatParams.appendChild(rowMonthDay);
      } else if (t === 'yearly') {
        repeatParams.appendChild(rowYearly);
      } else if (t === 'lunarYearly') {
        repeatParams.appendChild(rowLunar);
      }
      /* 迭代 7（F-47 / R-28）：5 种重复方式都提供「不含法定节假日」 */
      repeatParams.appendChild(rowHolidaySkip);
      repeatParams.appendChild(rowEndDate);
      /* 四十五轮：显示开关排在结束日期之后，缺省勾选 */
      repeatParams.appendChild(rowShowLabel);
      repeatParams.appendChild(previewBox);
      updatePreview();
    }

    /** 取值（不含校验） */
    function collect() {
      var t = currentRepeatType();
      var repeatOut = null;
      if (t !== 'none') {
        var weekdays = [];
        WEEKDAY_LABELS.forEach(function (p) { if (weekdayInputs[p[0]].checked) weekdays.push(p[0]); });
        repeatOut = {
          type: t,
          startDate: normalizeDateText(dateInput.value),
          endDate: normalizeDateText(endDateInput.value) || null,
          interval: Math.max(1, parseInt(intervalInput.value, 10) || 1),
          weekdays: weekdays,
          day: parseInt(monthDayInput.value, 10) || 1,
          month: parseInt(yearMonthInput.value, 10) || 1,
          lunarMonth: parseInt(lunarMonthInput.value, 10) || 1,
          lunarDay: parseInt(lunarDayInput.value, 10) || 1,
          leap: !!leapCheck.checked
        };
        if (t === 'yearly') repeatOut.day = parseInt(yearDayInput.value, 10) || 1;
        /* 四十六轮：日视图与周 / 月计划同口径——勾选即同时跳过节假日与周末。 */
        if (holidaySkipCheck.checked === true) {
          repeatOut.excludeHolidays = true;
          repeatOut.excludeWeekends = true;
        }
        /* 缺省显示（不写键）；取消勾选时显式写 false。 */
        if (showLabelCheck.checked !== true) repeatOut.showLabel = false;
      }
      var urgentNow = isUrgentId(catSelect.value);
      var prevCat = urgentNow
        ? (preUrgentCategoryId || firstNonUrgentId(catOptions) || initial.categoryId)
        : null;
      return {
        title: titleInput.value.trim(),
        categoryId: urgentNow ? URGENT_ID : catSelect.value,
        date: normalizeDateText(dateInput.value),
        time: timeToggle.checked ? { start: startInput.value, end: endInput.value } : null,
        // noteInput 在重复区之后才创建；collect() 可能被预览提前调用
        note: noteInput ? noteInput.value : initial.note,
        /* 迭代 7（F-49）：表单不再提供「已完成」入口 → 保留既有完成态，不得改回未完成 */
        done: initial.done === true,
        // 迭代 4：meta.previousCategoryId 仅在紧急时写入；其余 meta 字段原样保留
        meta: metaFor(item, urgentNow, prevCat),
        repeat: repeatOut,
        kind: t === 'none' ? 'single' : 'series'
      };
    }

    function updatePreview() {
      if (currentRepeatType() === 'none') { previewBox.textContent = ''; return; }
      var v = collect();
      if (!D.isValidDate(v.date)) {
        previewBox.textContent = v.date ? '开始日期格式应为 YYYY-MM-DD（如 2026-09-01）' : '';
        return;
      }
      var range = { from: v.date, to: D.addDays(v.date, 366 * 2), max: 50 };
      if (v.repeat.endDate) {
        if (!D.isValidDate(v.repeat.endDate)) {
          previewBox.textContent = '结束日期格式应为 YYYY-MM-DD（留空表示长期重复）';
          return;
        }
        if (D.diffDays(v.repeat.endDate, range.to) > 0) range.to = v.repeat.endDate;
      }
      try {
        var res = R.expandSeries({ id: '__preview__', kind: 'series', repeat: v.repeat, exceptions: {}, time: v.time, title: v.title }, range);
        var dates = res.occurrences.map(function (o) { return o.date; });
        if (!dates.length) {
          previewBox.textContent = '在未来两年内没有命中的日期，请检查规则。';
          return;
        }
        var head = dates.slice(0, 6).join('、');
        var more = dates.length > 6 ? ' … 共 ' + dates.length + ' 次' : '（共 ' + dates.length + ' 次）';
        previewBox.textContent = '预览：' + head + more + '｜' + R.repeatLabel(v.repeat);
      } catch (e) {
        previewBox.textContent = '无法预览：' + e.message;
      }
    }

    repeatTypeSelect.addEventListener('change', syncRepeatVisibility);
    [dateInput, endDateInput, intervalInput, monthDayInput, yearMonthInput, yearDayInput,
      lunarMonthInput, lunarDayInput, titleInput]
      .forEach(function (n) {
        n.addEventListener('change', updatePreview);
        n.addEventListener('input', updatePreview);
      });
    leapCheck.addEventListener('change', updatePreview);
    holidaySkipCheck.addEventListener('change', updatePreview);

    repeatBlock.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '重复方式' }), selectFieldControl(repeatTypeSelect).wrap
    ]));
    repeatBlock.appendChild(repeatParams);
    form.appendChild(dateField);
    form.appendChild(timeBlock);
    form.appendChild(repeatBlock);

    /* ---------------- 备注（迭代 7 / F-49：「已完成」勾选已下线，完成态由右键切换） ---------------- */
    var noteInput = el('textarea', { maxlength: String(S.NOTE_MAX), 'aria-label': '备注' });
    noteInput.value = initial.note;
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '备注' }), noteInput
    ]));

    /* ---------------- 范围选择（重复实例） ---------------- */
    var scopeInputs = null;
    if (opts.allowScope) {
      var onlyRadio = el('input', { type: 'radio', name: 'scope', value: 'only', checked: true });
      var allRadio = el('input', { type: 'radio', name: 'scope', value: 'all' });
      scopeInputs = { only: onlyRadio, all: allRadio };
      form.appendChild(el('div', { class: 'fieldset' }, [
        el('legend', { text: '修改范围' }),
        el('div', { class: 'inline' }, [
          el('label', { class: 'switch' }, [onlyRadio, el('span', { text: '仅此次' })]),
          el('label', { class: 'switch' }, [allRadio, el('span', { text: '此次及以后' })])
        ])
      ]));
    }

    syncRepeatVisibility();

    /* ---------------- 校验与提交 ---------------- */
    function validate() {
      var v = collect();
      errors = {};
      titleErr.textContent = '';
      dateErr.textContent = '';
      timeErr.textContent = '';

      if (!v.title) { errors.title = '请填写标题'; flashFieldError(titleErr, 'title', errors.title); }
      else if (v.title.length > S.TITLE_MAX) { errors.title = '标题不能超过 ' + S.TITLE_MAX + ' 字'; flashFieldError(titleErr, 'title', errors.title); }

      if (!D.isValidDate(v.date)) { errors.date = '请选择合法日期'; flashFieldError(dateErr, 'date', errors.date); }

      if (v.time) {
        var te = S.validateTime(v.time, 'time');
        if (te.length) { errors.time = te[0].message; flashFieldError(timeErr, 'time', errors.time); }
      }

      if (v.repeat) {
        var re = S.validateRepeat(v.repeat, 'repeat');
        if (re.length) {
          errors.repeat = re[0].message;
          if (re[0].path === 'repeat.weekdays') errors.repeat = '请至少选择一个星期';
        }
      }

      /* 美化迭代 9：字段错误只出现在字段下方（红字、数秒后自动消失）；
         顶部横幅只承接没有字段位错误的「重复」类错误。 */
      var anyError = errors.title || errors.date || errors.time || errors.repeat;
      return { ok: !anyError, values: v, message: errors.repeat || '' };
    }

    return {
      element: form,
      getValues: collect,
      validate: validate,
      scope: function () { return scopeInputs ? (scopeInputs.all.checked ? 'all' : 'only') : 'only'; },
      focus: function () { titleInput.focus(); if (titleInput.select) titleInput.select(); }
    };
  }

  /**
   * 五十一轮：倒计时表单（标题 / 类型 / 目标日期 / 时刻（精确到分）/ 备注）。
   * 与 createItemForm 同形状：`{ element, getValues, validate, focus }`。
   * 「类型」复用事项类别（决定块左侧色标），不引入第二套类型数据。
   * @param {object} opts
   *   - countdown: 被编辑的倒计时（可选）
   *   - date: 新建时的默认日期
   *   - time: 新建时的默认时刻
   *   - categories: 类别数组
   */
  function createCountdownForm(opts) {
    opts = opts || {};
    var categories = (opts.categories || []).slice();
    var cd = opts.countdown || null;
    var initialDate = (cd && String(cd.targetAt || '').slice(0, 10)) || opts.date || D.todayISO();
    var initialTime = (cd && String(cd.targetAt || '').slice(11, 16)) || opts.time || '09:00';

    var form = el('div', { class: 'item-form' });

    var titleInput = el('input', {
      type: 'text', maxlength: String(S.TITLE_MAX), value: cd ? cd.title : '',
      'aria-label': '标题'
    });
    var titleErr = el('div', { class: 'field-error' });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '标题' }), titleInput, titleErr
    ]));

    var catSelect = el('select', { 'aria-label': '类型' });
    categories.forEach(function (c) { catSelect.appendChild(el('option', { value: c.id, text: c.name })); });
    var initialCat = (cd && cd.categoryId) || opts.defaultCategoryId || '';
    if (initialCat) catSelect.value = initialCat;
    if (!catSelect.value && categories[0]) catSelect.value = categories[0].id;
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '类型' }), selectFieldControl(catSelect).wrap
    ]));

    var dateCtl = dateFieldControl({ value: initialDate, 'aria-label': '目标日期（YYYY-MM-DD）' });
    var dateErr = el('div', { class: 'field-error' });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '目标日期' }), dateCtl.wrap, dateErr
    ]));

    /* step: 1 → 分钟滚轮逐分可选（事项表单仍是 5 分钟刻度） */
    var timeCtl = timeFieldControl({ value: initialTime, 'aria-label': '时刻' }, { step: 1 });
    var timeErr = el('div', { class: 'field-error' });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '时刻' }), timeCtl.wrap, timeErr
    ]));

    var noteInput = el('textarea', { maxlength: String(S.NOTE_MAX), 'aria-label': '备注' });
    noteInput.value = (cd && cd.note) || '';
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '备注' }), noteInput
    ]));

    function collect() {
      return {
        title: titleInput.value.trim(),
        categoryId: catSelect.value,
        date: dateCtl.input.value,
        time: timeCtl.input.value,
        note: noteInput.value
      };
    }

    function validate() {
      var v = collect();
      var errs = {};
      titleErr.textContent = '';
      dateErr.textContent = '';
      timeErr.textContent = '';
      if (!v.title) { errs.title = '请填写标题'; flashFieldError(titleErr, 'title', errs.title); }
      else if (v.title.length > S.TITLE_MAX) {
        errs.title = '标题不能超过 ' + S.TITLE_MAX + ' 字';
        flashFieldError(titleErr, 'title', errs.title);
      }
      if (!D.isValidDate(v.date)) { errs.date = '请选择合法日期'; flashFieldError(dateErr, 'date', errs.date); }
      if (!D.isValidTime(v.time)) { errs.time = '请选择时刻'; flashFieldError(timeErr, 'time', errs.time); }
      return {
        ok: !(errs.title || errs.date || errs.time),
        values: v,
        message: ''
      };
    }

    return {
      element: form,
      getValues: collect,
      validate: validate,
      focus: function () { titleInput.focus(); if (titleInput.select) titleInput.select(); }
    };
  }

  /**
   * 构建周计划表单（F-20 / DM-6.3 / BR-21，迭代 3 新增）。
   *
   * 与 createItemForm 同形状：`{ element, getValues, values, validate, scope, focus }`
   * （createItemForm 的取值方法名为 getValues，这里同时以 values 暴露，便于 T38 直接调用）。
   *
   * 重复方式被**锁定**为「每天（该周 7 天）」：DOM 内只有只读纯文本，不存在任何可交互的
   * 重复类型控件（无重复方式 select / 无 radio / 无 button），也不显示单日日期输入。
   * 周计划不是新的 rule type（ADR-11），它就是 daily interval=1 + startDate=周一 + endDate=周一+7。
   *
   * @param {object} opts
   *   - date: 视图日期（未给 weekStart 时用它推导该周周一）
   *   - weekStart: 该周周一 `YYYY-MM-DD`
   *   - categories: 类别数组
   *   - defaultCategoryId
   *   - note: 备注初始值
   *   - onSubmit: 与 createItemForm 一致 —— 提交由调用方（modal）驱动，表单本身不调用
   */
  function createWeekPlanForm(opts) {
    opts = opts || {};
    var categories = (opts.categories || []).slice();
    var weekStart = D.isValidDate(opts.weekStart)
      ? opts.weekStart
      : D.startOfWeek(D.isValidDate(opts.date) ? opts.date : D.todayISO());

    /** DM-6.3 / ADR-11：周计划的规则形状（不新增 rule type） */
    function fixedRepeat() {
      var repeat = { type: 'daily', interval: 1, startDate: weekStart, endDate: D.addDays(weekStart, 7) };
      if (skipLongCheck.checked) {
        repeat.excludeHolidays = true;
        repeat.excludeWeekends = true;
      }
      return repeat;
    }

    var rangeLabel = weekStart + ' ~ ' + D.addDays(weekStart, 6);
    var errors = {};
    var form = el('div', { class: 'item-form week-plan-form' });
    /* 三十四轮：周计划固定 7 天，可选「不含节假日和周末」（同时写两个 repeat 键） */
    var skipLongCheck = el('input', { type: 'checkbox', 'aria-label': '不含节假日和周末' });

    /* ---------------- 标题（必填） ---------------- */
    var titleInput = el('input', {
      type: 'text', maxlength: String(S.TITLE_MAX),
      'aria-label': '标题'
    });
    var titleErr = el('div', { class: 'field-error' });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '标题' }), titleInput, titleErr
    ]));

    /* ---------------- 类别（迭代 8 / F-54：删除「列入紧急」，类别下拉是唯一入口） ----------------
     * 用户裁定：已有紧急周计划在编辑保存时按类别下拉的结果走（不再保留旧紧急态）。 */
    var defaultCategoryId = opts.defaultCategoryId || (categories[0] && categories[0].id) || URGENT_ID;
    var catOptions = ensureUrgentOption(categories);
    var catSelect = el('select', { 'aria-label': '类别' });
    catOptions.forEach(function (c) {
      var o = el('option', { value: c.id, text: c.name });
      if (c.id === defaultCategoryId) o.selected = true;
      catSelect.appendChild(o);
    });
    var preUrgentCategoryId = isUrgentId(defaultCategoryId)
      ? ((opts.item && opts.item.meta && opts.item.meta.previousCategoryId) || firstNonUrgentId(catOptions) || defaultCategoryId)
      : defaultCategoryId;
    catSelect.addEventListener('change', function () {
      if (catSelect.value !== URGENT_ID) preUrgentCategoryId = catSelect.value;
    });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '类别' }), selectFieldControl(catSelect).wrap
    ]));

    /* ---------------- 时段（可选；开启时默认 09:00–10:00） ---------------- */
    var timeToggle = el('input', { type: 'checkbox', 'aria-label': '设置起止时间' });
    var startCtlW = timeFieldControl({ value: '09:00', 'aria-label': '开始时间' });
    var endCtlW = timeFieldControl({ value: '10:00', 'aria-label': '结束时间' });
    var startInput = startCtlW.input;
    var endInput = endCtlW.input;
    var timeRow = el('div', { class: 'field-row' }, [
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '开始时间' }), startCtlW.wrap]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '结束时间' }), endCtlW.wrap])
    ]);
    var timeErr = el('div', { class: 'field-error' });

    function syncTimeVisibility() {
      timeRow.style.display = timeToggle.checked ? '' : 'none';
      if (!timeToggle.checked) timeErr.textContent = '';
    }
    timeToggle.checked = false; // 「可选」= 默认不设时段；开启后取 09:00–10:00
    timeToggle.addEventListener('change', syncTimeVisibility);
    syncTimeVisibility();
    form.appendChild(el('div', { class: 'fieldset' }, [
      el('div', { class: 'inline' }, [
        el('label', { class: 'switch' }, [timeToggle, el('span', { text: '设置起止时间' })])
      ]),
      timeRow, timeErr
    ]));

    /* ---------------- 备注（≤ 500 字） ---------------- */
    var noteInput = el('textarea', {
      maxlength: String(S.NOTE_MAX), 'aria-label': '备注'
    });
    noteInput.value = typeof opts.note === 'string' ? opts.note : '';
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '备注' }), noteInput
    ]));

    /* ---------------- 重复方式 + 日期范围：只读锁定（F-20.1） ----------------
     * 刻意只渲染纯文本（div）：DOM 内没有重复方式 select / radio / button，
     * 也没有单日日期输入，用户无法更改重复方式。 */
    var weekRepeatText = el('div', { class: 'readonly-text', text: '每天（该周 7 天）', 'aria-label': '重复方式（只读）' });
    skipLongCheck.addEventListener('change', function () {
      weekRepeatText.textContent = skipLongCheck.checked
        ? '每天（该周 7 天，跳过节假日和周末）'
        : '每天（该周 7 天）';
    });
    form.appendChild(el('div', { class: 'fieldset week-plan-repeat' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '重复' }),
        weekRepeatText
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '日期范围' }),
        el('div', { class: 'readonly-text', text: rangeLabel, 'aria-label': '日期范围（只读）' })
      ]),
      el('div', { class: 'field week-plan-skip' }, [
        el('label', { class: 'switch' }, [skipLongCheck, el('span', { text: '不含节假日和周末' })])
      ])
    ]));

    /* ---------------- 取值 / 校验 ---------------- */
    function collect() {
      /* 迭代 8 / F-54：紧急与否**只看类别下拉**（与建事项表单同口径；不再有勾选框） */
      var urgentNow = isUrgentId(catSelect.value);
      var meta = metaFor(opts.item, urgentNow, urgentNow
        ? (preUrgentCategoryId || firstNonUrgentId(catOptions) || defaultCategoryId)
        : null);
      // 周计划 meta（DM-6.3）：origin / weekStart 由表单补齐，调用方覆盖时以调用方为准
      meta.origin = 'weekPlan';
      meta.weekStart = weekStart;
      return {
        title: titleInput.value.trim(),
        categoryId: catSelect.value,
        time: timeToggle.checked ? { start: startInput.value, end: endInput.value } : null,
        note: noteInput.value,
        meta: meta,
        repeat: fixedRepeat()
      };
    }

    function validate() {
      var v = collect();
      errors = {};
      titleErr.textContent = '';
      timeErr.textContent = '';

      if (!D.isValidDate(weekStart)) errors.weekStart = '周起始日期非法';
      if (!v.title) { errors.title = '请填写标题'; flashFieldError(titleErr, 'wk-title', errors.title); }
      else if (v.title.length > S.TITLE_MAX) {
        errors.title = '标题不能超过 ' + S.TITLE_MAX + ' 字';
        flashFieldError(titleErr, 'wk-title', errors.title);
      }
      if (v.time) {
        var te = S.validateTime(v.time, 'time');
        if (te.length) { errors.time = te[0].message; flashFieldError(timeErr, 'wk-time', errors.time); }
      }
      if (v.note.length > S.NOTE_MAX) errors.note = '备注不能超过 ' + S.NOTE_MAX + ' 字';
      if (!errors.weekStart) {
        var re = S.validateRepeat(v.repeat, 'repeat');
        if (re.length) errors.repeat = re[0].message;
      }

      /* 美化迭代 9：字段错误只留在字段下方（红字、数秒后自动消失），顶部横幅只承接无字段位的错误 */
      var first = errors.title || errors.time || errors.note || errors.weekStart || errors.repeat;
      return { ok: !first, values: v, message: (errors.note || errors.weekStart || errors.repeat) || '' };
    }

    return {
      element: form,
      getValues: collect,
      values: collect, // T38 约定的方法名（与 createItemForm 的 getValues 同实现）
      validate: validate,
      // 周计划是整条序列的创建/编辑，不存在「仅此次」语义
      scope: function () { return 'all'; },
      focus: function () { titleInput.focus(); if (titleInput.select) titleInput.select(); }
    };
  }

  /**
   * 构建月计划表单（三十四轮 / 用户需求）。
   *
   * 与周计划表单同形：重复方式锁定为「每天（该月 N 天）」并**按天同步到日视图**；
   * 新增「不含节假日和周末」选项（同时写 repeat.excludeHolidays / excludeWeekends）。
   * `opts.item` 存在时用于编辑既有月计划序列，预填标题 / 类别 / 时段 / 备注 / 排除选项。
   */
  function createMonthPlanForm(opts) {
    opts = opts || {};
    var categories = (opts.categories || []).slice();
    var monthStart = D.isValidDate(opts.monthStart)
      ? D.startOfMonth(opts.monthStart)
      : ((typeof opts.ym === 'string' && D.isValidDate(opts.ym + '-01'))
        ? opts.ym + '-01'
        : D.startOfMonth(D.isValidDate(opts.date) ? opts.date : D.todayISO()));
    var monthEnd = D.addMonths(monthStart, 1);
    var ymd = D.parseYearMonth(monthStart);
    var dayCount = D.daysInMonth(ymd.year, ymd.month);
    var rangeLabel = monthStart + ' ~ ' + D.endOfMonth(monthStart);
    var item = opts.item || null;
    var errors = {};
    var form = el('div', { class: 'item-form month-plan-form' });
    var skipLongCheck = el('input', { type: 'checkbox', 'aria-label': '不含节假日和周末' });
    if (item && item.repeat && (item.repeat.excludeHolidays === true || item.repeat.excludeWeekends === true)) {
      skipLongCheck.checked = true;
    }

    /** 三十四轮：整月 daily 序列；排除项同时落到两个键上。 */
    function fixedRepeat() {
      var repeat = { type: 'daily', interval: 1, startDate: monthStart, endDate: monthEnd };
      if (skipLongCheck.checked) {
        repeat.excludeHolidays = true;
        repeat.excludeWeekends = true;
      }
      return repeat;
    }

    /* ---------------- 标题（必填） ---------------- */
    var titleInput = el('input', {
      type: 'text', maxlength: String(S.TITLE_MAX), 'aria-label': '标题'
    });
    if (item) titleInput.value = item.title || '';
    var titleErr = el('div', { class: 'field-error' });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '标题' }), titleInput, titleErr
    ]));

    /* ---------------- 类别 ---------------- */
    var defaultCategoryId = (item && item.categoryId) || opts.defaultCategoryId
      || (categories[0] && categories[0].id) || URGENT_ID;
    var catOptions = ensureUrgentOption(categories);
    var catSelect = el('select', { 'aria-label': '类别' });
    catOptions.forEach(function (c) {
      var o = el('option', { value: c.id, text: c.name });
      if (c.id === defaultCategoryId) o.selected = true;
      catSelect.appendChild(o);
    });
    var preUrgentCategoryId = isUrgentId(defaultCategoryId)
      ? ((item && item.meta && item.meta.previousCategoryId) || firstNonUrgentId(catOptions) || defaultCategoryId)
      : defaultCategoryId;
    catSelect.addEventListener('change', function () {
      if (catSelect.value !== URGENT_ID) preUrgentCategoryId = catSelect.value;
    });
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '类别' }), selectFieldControl(catSelect).wrap
    ]));

    /* ---------------- 时段（可选；默认 09:00–10:00） ---------------- */
    var timeToggle = el('input', { type: 'checkbox', 'aria-label': '设置起止时间' });
    var startCtl = timeFieldControl({ value: (item && item.time && item.time.start) || '09:00', 'aria-label': '开始时间' });
    var endCtl = timeFieldControl({ value: (item && item.time && item.time.end) || '10:00', 'aria-label': '结束时间' });
    var startInput = startCtl.input;
    var endInput = endCtl.input;
    var timeRow = el('div', { class: 'field-row' }, [
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '开始时间' }), startCtl.wrap]),
      el('div', { class: 'field' }, [el('label', { class: 'field-label', text: '结束时间' }), endCtl.wrap])
    ]);
    var timeErr = el('div', { class: 'field-error' });

    function syncTimeVisibility() {
      timeRow.style.display = timeToggle.checked ? '' : 'none';
      if (!timeToggle.checked) timeErr.textContent = '';
    }
    timeToggle.checked = !!(item && item.time);
    timeToggle.addEventListener('change', syncTimeVisibility);
    syncTimeVisibility();
    form.appendChild(el('div', { class: 'fieldset' }, [
      el('div', { class: 'inline' }, [
        el('label', { class: 'switch' }, [timeToggle, el('span', { text: '设置起止时间' })])
      ]),
      timeRow, timeErr
    ]));

    /* ---------------- 备注 ---------------- */
    var noteInput = el('textarea', { maxlength: String(S.NOTE_MAX), 'aria-label': '备注' });
    noteInput.value = (item && typeof item.note === 'string') ? item.note
      : (typeof opts.note === 'string' ? opts.note : '');
    form.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '备注' }), noteInput
    ]));

    /* ---------------- 重复方式 + 日期范围：只读锁定 ---------------- */
    var monthRepeatText = el('div', {
      class: 'readonly-text',
      text: '每天（该月 ' + dayCount + ' 天）',
      'aria-label': '重复方式（只读）'
    });
    function syncRepeatText() {
      monthRepeatText.textContent = skipLongCheck.checked
        ? '每天（该月 ' + dayCount + ' 天，跳过节假日和周末）'
        : '每天（该月 ' + dayCount + ' 天）';
    }
    skipLongCheck.addEventListener('change', syncRepeatText);
    syncRepeatText();
    form.appendChild(el('div', { class: 'fieldset month-plan-repeat' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '重复' }), monthRepeatText
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '日期范围' }),
        el('div', { class: 'readonly-text', text: rangeLabel, 'aria-label': '日期范围（只读）' })
      ]),
      el('div', { class: 'field month-plan-skip' }, [
        el('label', { class: 'switch' }, [skipLongCheck, el('span', { text: '不含节假日和周末' })])
      ])
    ]));

    /* ---------------- 取值 / 校验 ---------------- */
    function collect() {
      var urgentNow = isUrgentId(catSelect.value);
      var meta = metaFor(item, urgentNow, urgentNow
        ? (preUrgentCategoryId || firstNonUrgentId(catOptions) || defaultCategoryId)
        : null);
      meta.origin = 'monthPlan';
      meta.month = monthStart.slice(0, 7);
      return {
        title: titleInput.value.trim(),
        categoryId: catSelect.value,
        time: timeToggle.checked ? { start: startInput.value, end: endInput.value } : null,
        note: noteInput.value,
        meta: meta,
        repeat: fixedRepeat()
      };
    }

    function validate() {
      var v = collect();
      errors = {};
      titleErr.textContent = '';
      timeErr.textContent = '';

      if (!v.title) { errors.title = '请填写标题'; flashFieldError(titleErr, 'mp-title', errors.title); }
      else if (v.title.length > S.TITLE_MAX) {
        errors.title = '标题不能超过 ' + S.TITLE_MAX + ' 字';
        flashFieldError(titleErr, 'mp-title', errors.title);
      }
      if (v.time) {
        var te = S.validateTime(v.time, 'time');
        if (te.length) { errors.time = te[0].message; flashFieldError(timeErr, 'mp-time', errors.time); }
      }
      if (v.note.length > S.NOTE_MAX) errors.note = '备注不能超过 ' + S.NOTE_MAX + ' 字';
      var re = S.validateRepeat(v.repeat, 'repeat');
      if (re.length) errors.repeat = re[0].message;

      var first = errors.title || errors.time || errors.note || errors.repeat;
      return { ok: !first, values: v, message: (errors.note || errors.repeat) || '' };
    }

    return {
      element: form,
      getValues: collect,
      values: collect,
      validate: validate,
      scope: function () { return 'all'; },
      focus: function () { titleInput.focus(); if (titleInput.select) titleInput.select(); }
    };
  }

  /**
   * 颜色的中文名（用于 title / aria-label）；未知颜色回退为 `#rrggbb` 本身。
   * @param {string} hex
   * @returns {string}
   */
  function colorNameOf(hex) {
    var i = COLOR_PRESETS.indexOf(String(hex || '').toLowerCase());
    return i >= 0 ? COLOR_NAMES[i] : String(hex || '');
  }

  /**
   * 从预设中挑一个「还没被用过」的颜色，让新增类别默认不与现有类别撞色。
   * @param {string[]} usedColors 现有类别颜色
   * @returns {string} `#rrggbb`
   */
  function nextUnusedColor(usedColors) {
    var used = {};
    (Array.isArray(usedColors) ? usedColors : []).forEach(function (c) {
      used[String(c || '').toLowerCase()] = true;
    });
    for (var i = 0; i < COLOR_PRESETS.length; i++) {
      if (!used[COLOR_PRESETS[i]]) return COLOR_PRESETS[i];
    }
    return COLOR_PRESETS[0];
  }

  root.DayPlan.form = {
    createItemForm: createItemForm,
    createCountdownForm: createCountdownForm,
    createWeekPlanForm: createWeekPlanForm,
    createMonthPlanForm: createMonthPlanForm,
    selectFieldControl: selectFieldControl,
    COLOR_PRESETS: COLOR_PRESETS,
    COLOR_NAMES: COLOR_NAMES,
    colorNameOf: colorNameOf,
    nextUnusedColor: nextUnusedColor,
    REPEAT_TYPES: REPEAT_TYPES,
    WEEKDAY_LABELS: WEEKDAY_LABELS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
