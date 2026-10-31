/**
 * DayPlan · 事项完成台（迭代 10 批次 5 / 条9）
 *
 * 契约（用户裁定，2026-10-18）：
 *   - 可拖入：未排时段事项 + 日视图时间表已排块；拖入后原位置空出。
 *   - 「原位置空出」**仅界面隐藏**，不改事项数据（刷新/重开后回原位）。
 *   - 点「完成」：标记该次发生为已完成（series 只作用于这一次），从台里移除并回原位。
 *   - 刷新/重开后**保留台里的条目与计时**（2026-10-19 用户裁定，取代早先「仅内存」口径）：
 *     条目与计时状态写入 UI 状态 `dayplan.ui.v1.finishDock`；仍**不写事项字段**、不改入库数据。
 *     只存状态快照（`running` + `lastTs`），真实读数由「快照 + 时间差」推出，所以无需按 tick 写盘。
 *   - 到时：响铃「叮」并停在 0 等用户确认（不自动完成）。
 *   - 多个事项并列、各计各的。
 *   - 倒计时默认 25 分钟；番茄钟 25/5 自动交替。
 *   - **时长只在「设置」阶段可改**（滚轮仅在设置时出现，开始计时后收起，重置后再现）：
 *       倒计时 = 时 / 分 / 秒 三个轴（时 0–23，分秒 0–59，**每轴以 1 为单位**）；
 *       番茄钟 = 专注 / 休息 两个轴（5–180 分钟，**5 分钟一档**）。
 *   - 滚轮观感与建事项的时间「密码锁」一致（复用 core/picker.js 的 createWheel）。
 *   - 未选计时方式时**不出提示文案**，只留三个方式按钮。
 *
 * 纪律：
 *   - 不依赖 DOM 之外的全局状态；所有元素都用传入的 document 创建（便于垫片环境断言）。
 *   - 计时用时间戳差值（`api.tick(nowMs)` 可注入时间），不累加 interval 次数，避免漂移。
 *   - 「叮」在 soundOn=false 时既不发声也不派发 `dayplan:ding` 事件（可被断言观测）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(typeof globalThis !== 'undefined' ? globalThis : this);
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.finishdock = factory(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var TICK_MS = 200;
  /* 倒计时三轴：时 0–23 / 分 0–59 / 秒 0–59，每轴以 1 为单位 */
  var CD_HOUR_MAX = 23;
  var CD_SEC_TOP = 59;
  var COUNTDOWN_DEFAULT_SEC = 25 * 60;
  /* 番茄钟两轴：专注 / 休息，5–180 分钟，5 分钟一档 */
  var PM_MIN = 5;
  var PM_MAX = 180;
  var PM_STEP = 5;
  var FOCUS_DEFAULT_MIN = 25;
  var BREAK_DEFAULT_MIN = 5;

  var MODES = [
    { id: 'stopwatch', label: '正计时', title: '从 0 往上累计，可暂停 / 清零' },
    { id: 'countdown', label: '倒计时', title: '设定分钟数，倒数到 0 响铃' },
    { id: 'pomodoro', label: '番茄钟', title: '专注 / 休息自动交替' }
  ];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 毫秒 → 「时:分:秒」 */
  function fmtClock(ms) {
    var t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return pad2(Math.floor(t / 3600)) + ':' + pad2(Math.floor((t % 3600) / 60)) + ':' + pad2(t % 60);
  }

  function firstChars(name, n) {
    var s = String(name === null || name === undefined ? '' : name);
    if (!s) return '';
    var take = Math.max(1, Number(n) || 2);
    var out = '';
    var i = 0;
    while (out.length < take && i < s.length) {
      var cp = s.codePointAt(i);
      out += String.fromCodePoint(cp);
      i += cp > 0xffff ? 2 : 1;
    }
    return out;
  }

  /** 2026-10-30：类别色走 20 色色板（旧高饱和色由 categoryTone 就近归一） */
  function inkOf(hex) {
    var P = root && root.DayPlan && root.DayPlan.palette;
    return (P && typeof P.categoryTone === 'function') ? P.categoryTone(hex).accent : hex;
  }

  function tintOf(hex, alpha) {
    var h = String(hex || '').replace('#', '');
    if (h.length !== 6) return 'rgba(120, 120, 128, ' + alpha + ')';
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return 'rgba(120, 120, 128, ' + alpha + ')';
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  function mk(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  /** 滚轮取值：from…to 按 step 递增；pad=true 补两位（时 / 分 / 秒） */
  function rangeValues(from, to, step, pad) {
    var out = [];
    var inc = step > 0 ? step : 1;
    for (var v = from; v <= to; v += inc) out.push(pad ? pad2(v) : String(v));
    return out;
  }

  var CD_HOUR_VALUES = rangeValues(0, CD_HOUR_MAX, 1, true);
  var CD_MIN_VALUES = rangeValues(0, CD_SEC_TOP, 1, true);
  var CD_SEC_VALUES = rangeValues(0, CD_SEC_TOP, 1, true);
  var PM_VALUES = rangeValues(PM_MIN, PM_MAX, PM_STEP, false);

  /** 总秒数 → {h, m, s}（倒计时三轴的初始值） */
  function splitSec(total) {
    var t = Math.max(0, Math.floor(Number(total) || 0));
    return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
  }

  /** 取整并夹到 [lo, hi]（滚轮回传值兜底） */
  function clampInt(v, lo, hi) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return lo;
    return n < lo ? lo : (n > hi ? hi : n);
  }

  /** 有限数字判定（快照恢复时逐字段兜底；本模块不依赖 schema） */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /** 纯对象判定 */
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /**
   * 单列滚轮：优先复用 core/picker.js 的 createWheel —— 与建事项时的
   * 时间「密码锁」同一实现，因此观感（中间行高亮带、无滚动条、选中项主色加粗）天然一致；
   * picker 缺失或降级时退回 <select>，保证功能可用。
   */
  function buildWheel(doc, picker, opts) {
    var onChange = opts.onChange;
    if (picker && typeof picker.createWheel === 'function' && doc) {
      var wheel = picker.createWheel({
        document: doc,
        values: opts.values,
        value: String(opts.value),
        step: opts.step || 1,
        ariaLabel: opts.ariaLabel,
        onChange: function (v) { onChange(Number(v)); }
      });
      if (wheel && wheel.element) {
        return {
          element: wheel.element,
          value: function () { return Number(wheel.value()); },
          setValue: function (v) { wheel.setValue(String(v)); },
          /* 元素挂进文档之前赋值 scrollTop 不生效（picker 文档第 8 条）→ 挂载后必须重对齐 */
          syncScroll: function () { try { wheel.syncScroll(); } catch (e) { /* 忽略 */ } },
          destroy: function () { try { wheel.destroy(); } catch (e) { /* 忽略 */ } }
        };
      }
    }
    var sel = mk(doc, 'select', 'dock-select');
    sel.setAttribute('aria-label', opts.ariaLabel || '数值');
    opts.values.forEach(function (v) {
      var o = mk(doc, 'option', null, v);
      o.value = v;
      if (String(opts.value) === v) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { onChange(Number(sel.value)); });
    return {
      element: sel,
      value: function () { return Number(sel.value); },
      setValue: function (v) { sel.value = String(v); },
      destroy: function () {}
    };
  }

  /**
   * @param {object} opts
   *   root      完成台内容容器（必填）
   *   countEl   右上角计数元素（可选）
   *   store     store 实例（用于记住音效开关，可选）
   *   getCat    (categoryId) => {name,color}
   *   onDockChange () => void  台内条目增减时通知视图重绘（隐藏/恢复原位置）
   *   onComplete   (occ) => void 标记该次发生为已完成
   *   sound     初始音效开关（布尔）
   *   document  可选，默认全局 document
   */
  function create(opts) {
    opts = opts || {};
    var doc = opts.document || (typeof document !== 'undefined' ? document : null);
    var rootEl = opts.root || null;
    var countEl = opts.countEl || null;
    var store = opts.store || null;
    var getCat = typeof opts.getCat === 'function' ? opts.getCat : function () { return null; };
    var onDockChange = typeof opts.onDockChange === 'function' ? opts.onDockChange : null;
    var onComplete = typeof opts.onComplete === 'function' ? opts.onComplete : null;
    var picker = root && root.DayPlan ? root.DayPlan.picker : null;

    var items = [];
    var timer = null;
    var soundOn = opts.sound !== false;
    var audioCtx = null;
    /* 已响铃次数：既是运行时可观测状态，也让「静音后不再响」可被断言 */
    var dingCount = 0;

    /* ---------------- 音效 ---------------- */

    function ding() {
      if (!soundOn) return;
      dingCount += 1;
      try {
        var AC = root ? (root.AudioContext || root.webkitAudioContext) : null;
        if (AC) {
          if (!audioCtx) audioCtx = new AC();
          if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') audioCtx.resume();
          var t0 = audioCtx.currentTime;
          [0, 0.18].forEach(function (off, i) {
            var osc = audioCtx.createOscillator();
            var gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = i ? 1320 : 1760;
            gain.gain.setValueAtTime(0.0001, t0 + off);
            gain.gain.exponentialRampToValueAtTime(0.22, t0 + off + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.16);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(t0 + off);
            osc.stop(t0 + off + 0.18);
          });
        }
      } catch (e) { /* 环境不支持音频：静默降级 */ }
      try {
        if (root && typeof root.dispatchEvent === 'function'
          && typeof root.CustomEvent === 'function') {
          root.dispatchEvent(new root.CustomEvent('dayplan:ding', { detail: { at: Date.now() } }));
        }
      } catch (e) { /* 忽略 */ }
    }

    /* ---------------- 查找 ---------------- */

    function indexOfKey(key) {
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].key === key) return i;
      }
      return -1;
    }

    function find(key) {
      var i = indexOfKey(key);
      return i < 0 ? null : items[i];
    }

    /* ---------------- 渲染：计数 ---------------- */

    function renderCount() {
      if (!countEl) return;
      countEl.textContent = items.length ? items.length + ' 项' : '';
    }

    /* ---------------- 渲染：单条 ---------------- */

    function syncClock(it) {
      if (!it.clockEl) return;
      var ms = it.mode === 'stopwatch' ? it.elapsedMs : it.remainingMs;
      if (it.mode === null) ms = 0;
      it.clockEl.textContent = fmtClock(ms);
      /* is-done 只表示「时间到了」；设置阶段把时长拨到 00:00:00 不算到时 */
      var isZero = !it.setting && it.mode !== null && it.mode !== 'stopwatch'
        && it.remainingMs <= 0 && !it.running;
      if (it.clockEl.classList) it.clockEl.classList.toggle('is-done', !!isZero);
    }

    function modeRow(it) {
      var row = mk(doc, 'div', 'dock-modes');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', '计时方式');
      MODES.forEach(function (m) {
        var b = mk(doc, 'button', 'btn dock-mode', m.label);
        b.type = 'button';
        b.title = m.title;
        b.setAttribute('data-mode', m.id);
        if (it.mode === m.id) b.classList.add('is-active');
        b.setAttribute('aria-pressed', it.mode === m.id ? 'true' : 'false');
        b.addEventListener('click', function () { setMode(it, m.id); });
        row.appendChild(b);
      });
      return row;
    }

    function actionRow(it, buttons) {
      var row = mk(doc, 'div', 'dock-actions');
      buttons.forEach(function (b) { row.appendChild(b); });
      return row;
    }

    function button(cls, text, onClick, title) {
      var b = mk(doc, 'button', cls, text);
      b.type = 'button';
      if (title) b.title = title;
      b.addEventListener('click', onClick);
      return b;
    }

    /** 重建面板前释放旧滚轮：createWheel 在 document 上挂了 mousemove/mouseup，必须 destroy */
    function dropWheels(it) {
      (it.wheels || []).forEach(function (w) {
        if (w && typeof w.destroy === 'function') w.destroy();
      });
      it.wheels = [];
      it.startBtn = null;
    }

    /** 追加一列滚轮（带等分容器），并登记到 it.wheels 以便重建时释放 */
    function addWheel(it, parent, opts) {
      var box = mk(doc, 'div', 'dock-wheel-box');
      var w = buildWheel(doc, picker, opts);
      box.appendChild(w.element);
      parent.appendChild(box);
      if (!it.wheels) it.wheels = [];
      it.wheels.push(w);
      return w;
    }

    function wheelSep() { return mk(doc, 'span', 'dock-wheel-sep', ':'); }

    /** 滚轮元素进入文档后重新对齐到「中间行」：挂载前赋值 scrollTop 在真实浏览器里不生效 */
    function syncWheels(it) {
      (it.wheels || []).forEach(function (w) {
        if (w && typeof w.syncScroll === 'function') w.syncScroll();
      });
    }

    /* ---------------- 倒计时的「时/分/秒」三轴 ---------------- */

    function countdownSecOf(it) { return (it.cdH * 3600) + (it.cdM * 60) + it.cdS; }

    /** 0 时长不启动：按钮同步置灰（否则一按就立刻响铃） */
    function refreshStartBtn(it) {
      if (!it.startBtn) return;
      var zero = it.mode === 'countdown' && countdownSecOf(it) <= 0;
      it.startBtn.disabled = zero;
      it.startBtn.title = zero ? '请先设置时长' : (it.running ? '暂停倒计时' : '开始倒计时');
    }

    function syncCountdownSetting(it) {
      it.countdownSec = countdownSecOf(it);
      if (!it.running) {
        it.remainingMs = it.countdownSec * 1000;
        it.finished = false;
        syncClock(it);
      }
      refreshStartBtn(it);
      persist();
    }

    function countdownWheels(it, panel) {
      var wheels = mk(doc, 'div', 'dock-wheels');
      addWheel(it, wheels, {
        values: CD_HOUR_VALUES, value: pad2(it.cdH), ariaLabel: '倒计时小时',
        onChange: function (v) { it.cdH = clampInt(v, 0, CD_HOUR_MAX); syncCountdownSetting(it); }
      });
      wheels.appendChild(wheelSep());
      addWheel(it, wheels, {
        values: CD_MIN_VALUES, value: pad2(it.cdM), ariaLabel: '倒计时分钟',
        onChange: function (v) { it.cdM = clampInt(v, 0, CD_SEC_TOP); syncCountdownSetting(it); }
      });
      wheels.appendChild(wheelSep());
      addWheel(it, wheels, {
        values: CD_SEC_VALUES, value: pad2(it.cdS), ariaLabel: '倒计时秒',
        onChange: function (v) { it.cdS = clampInt(v, 0, CD_SEC_TOP); syncCountdownSetting(it); }
      });
      panel.appendChild(wheels);
    }

    function paintStage(it) {
      if (!it.stageEl) return;
      var stage = it.stageEl;
      dropWheels(it);
      stage.innerHTML = '';

      /* ① 初始态：只有一个「计时」+「完成」 */
      if (it.mode === null) {
        syncClock(it);
        stage.appendChild(actionRow(it, [
          button('btn btn-primary dock-start', '计时', function () {
            it.mode = 'choose';
            paintStage(it);
          }, '选择计时方式'),
          button('btn dock-done', '完成', function () { api.complete(it.key); }, '标记完成并回到原位置')
        ]));
        return;
      }

      /* ② 三模式按钮（点「计时」后出现；切换模式直接点）。
             未选方式时**不加任何提示文案** —— 三个按钮本身就是选择器。 */
      stage.appendChild(modeRow(it));
      if (it.mode === 'choose') {
        stage.appendChild(actionRow(it, [
          button('btn dock-done', '完成', function () { api.complete(it.key); }, '标记完成并回到原位置')
        ]));
        syncClock(it);
        return;
      }

      /* ③ 模式面板：滚轮**只在设置阶段出现**，开始计时后收起（it.setting 控制） */
      var panel = mk(doc, 'div', 'dock-panel');
      if (it.mode === 'stopwatch') {
        panel.appendChild(actionRow(it, [
          button('btn dock-toggle', it.running ? '暂停' : (it.elapsedMs > 0 ? '继续' : '开始'),
            function () { toggleRun(it); }, it.running ? '暂停计时' : '开始正计时'),
          button('btn dock-reset', '清零', function () { resetRun(it); }, '计时归零')
        ]));
      } else if (it.mode === 'countdown') {
        if (it.setting) countdownWheels(it, panel);
        var cdStart = button('btn btn-primary dock-toggle', it.running ? '暂停' : '开始',
          function () { toggleRun(it); }, it.running ? '暂停倒计时' : '开始倒计时');
        it.startBtn = cdStart;
        panel.appendChild(actionRow(it, [
          cdStart,
          button('btn dock-reset', '重置', function () { resetRun(it); }, '回到设定时长')
        ]));
      } else if (it.mode === 'pomodoro') {
        if (it.setting) {
          /* 两轴需要标签区分（专注 / 休息）：与下方两列等分对齐 */
          var caps = mk(doc, 'div', 'dock-fields');
          caps.appendChild(mk(doc, 'span', 'dock-field-cap', '专注'));
          caps.appendChild(mk(doc, 'span', 'dock-field-cap', '休息'));
          panel.appendChild(caps);

          var pWheels = mk(doc, 'div', 'dock-wheels');
          addWheel(it, pWheels, {
            values: PM_VALUES, step: PM_STEP, value: String(it.focusMin), ariaLabel: '番茄钟专注分钟',
            onChange: function (v) {
              it.focusMin = clampInt(v, PM_MIN, PM_MAX);
              if (!it.running && it.phase === 'focus') {
                it.remainingMs = it.focusMin * 60000;
                it.finished = false;
                syncClock(it);
              }
              persist();
            }
          });
          addWheel(it, pWheels, {
            values: PM_VALUES, step: PM_STEP, value: String(it.breakMin), ariaLabel: '番茄钟休息分钟',
            onChange: function (v) {
              it.breakMin = clampInt(v, PM_MIN, PM_MAX);
              if (!it.running && it.phase === 'break') {
                it.remainingMs = it.breakMin * 60000;
                it.finished = false;
                syncClock(it);
              }
              persist();
            }
          });
          panel.appendChild(pWheels);
        } else {
          /* 收起滚轮后由阶段标签承担「现在是哪一段」 */
          var phaseEl = mk(doc, 'p', 'dock-phase', it.phase === 'break' ? '休息' : '专注');
          phaseEl.setAttribute('data-phase', it.phase);
          it.phaseEl = phaseEl;
          panel.appendChild(phaseEl);
        }

        panel.appendChild(actionRow(it, [
          button('btn btn-primary dock-toggle', it.running ? '暂停' : '开始',
            function () { toggleRun(it); }, it.running ? '暂停番茄钟' : '开始番茄钟'),
          button('btn dock-reset', '重置', function () { resetRun(it); }, '回到专注段开头')
        ]));
      }
      stage.appendChild(panel);
      refreshStartBtn(it);

      /* ④ 完成（常驻） */
      stage.appendChild(actionRow(it, [
        button('btn dock-done', '完成', function () { api.complete(it.key); }, '标记完成并回到原位置')
      ]));

      syncWheels(it);

      syncClock(it);
    }

    function buildItemNode(it) {
      var node = mk(doc, 'article', 'dock-item');
      node.setAttribute('data-key', it.key);
      node.setAttribute('role', 'listitem');

      var head = mk(doc, 'div', 'dock-item-head');
      var title = mk(doc, 'span', 'dock-title', it.occ.title || '（无标题）');
      title.title = it.occ.title || '';
      head.appendChild(title);

      var cat = getCat(it.occ.categoryId);
      if (cat && cat.name) {
        var chip = mk(doc, 'span', 'dock-chip', firstChars(cat.name, 2));
        chip.style.setProperty('--cat', inkOf(cat.color));
        chip.style.setProperty('--cat-bg', tintOf(inkOf(cat.color), 0.10));
        chip.title = '类别：' + cat.name;
        chip.setAttribute('aria-label', '类别：' + cat.name);
        head.appendChild(chip);
      }

      head.appendChild(button('dock-back', '×', function () {
        api.remove(it.key);
      }, '放回原位（不标记完成）'));

      node.appendChild(head);

      it.clockEl = mk(doc, 'div', 'dock-clock', '00:00:00');
      node.appendChild(it.clockEl);

      it.stageEl = mk(doc, 'div', 'dock-stage');
      node.appendChild(it.stageEl);

      paintStage(it);
      return node;
    }

    /* ---------------- 计时状态机 ---------------- */

    function ensureTimer() {
      if (timer || !root || typeof root.setInterval !== 'function') return;
      timer = root.setInterval(function () { api.tick(); }, TICK_MS);
    }

    function stopTimerIfIdle() {
      if (timer && !items.length) {
        if (typeof root.clearInterval === 'function') root.clearInterval(timer);
        timer = null;
      }
    }

    /* ---------------- 刷新持久化（用户裁定 2026-10-19；D9 扩 2026-10-27） ----------------
     * 原先「计时状态与用时仅内存、不落盘」；用户要求刷新后完成台条目与计时都保留，
     * 故改为写入 UI 状态（`dayplan.ui.v1.finishDock`，非关键状态，不入事项库）。
     *
     * D9（2026-10-27）起落点升级：快照写入**文档字段 `doc.finishDock`**
     * （store.setFinishDock），随文档参与多设备同步（用户裁定：完成台也要同步）；
     * 旧 UI 状态键只作为无 setFinishDock 环境（独立测试 / 旧注入）的降级落点。
     *
     * 只存**状态快照**，不存派生读数：`running` 为真时真实读数 = elapsedMs/remainingMs
     * + (now − lastTs)，所以即使两次落盘之间隔了很久，恢复后依然精确——不需要按 tick 写盘。 */

    var DOCK_MAX = 20;
    var MODE_IDS = ['choose', 'stopwatch', 'countdown', 'pomodoro'];
    var restoring = false;

    /* D14：运行中条目的读数容差。远端回放的快照最多落后一个同步周期
       （拉取间隔 + 往返延迟），推算读数差在这个范围内视为同一状态。 */
    var RUN_DERIVE_TOLERANCE_MS = 5000;

    function numOr0(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

    /**
     * 快照与当前台是否**语义一致**（D14）。不能直接 JSON 比较：
     * lastTs/elapsedMs 每秒都在变，全等比较会让运行中的计时在每次
     * 拉取回放时都被判「不一致」→ 整台重建 → 界面闪烁。
     * 语义口径：非时间字段必须全等；运行中条目把对方快照按时间差推算到
     * 当前时刻，读数差在容差内即视为相同（谁后写谁是权威，LWW 语义不变）。
     */
    function dockSemanticallySame(incoming) {
      if (!Array.isArray(incoming) || incoming.length !== items.length) return false;
      var nowCmp = Date.now();
      for (var i = 0; i < incoming.length; i++) {
        var raw = incoming[i];
        var it = items[i];
        if (!raw || !isObj(raw.occ) || raw.occ.key !== it.key) return false;
        if (!!raw.running !== it.running) return false;
        if ((MODE_IDS.indexOf(raw.mode) >= 0 ? raw.mode : null) !== it.mode) return false;
        if (!!raw.setting !== it.setting) return false;
        if (!!raw.finished !== it.finished) return false;
        if ((raw.phase === 'break' ? 'break' : 'focus') !== it.phase) return false;
        if (numOr0(raw.countdownSec) !== numOr0(it.countdownSec)) return false;
        if (numOr0(raw.cdH) !== numOr0(it.cdH)) return false;
        if (numOr0(raw.cdM) !== numOr0(it.cdM)) return false;
        if (numOr0(raw.cdS) !== numOr0(it.cdS)) return false;
        if (numOr0(raw.focusMin) !== numOr0(it.focusMin)) return false;
        if (numOr0(raw.breakMin) !== numOr0(it.breakMin)) return false;
        if (!raw.running) {
          /* 停着的条目读数就是权威值，必须精确相等 */
          if (numOr0(raw.elapsedMs) !== numOr0(it.elapsedMs)) return false;
          if (numOr0(raw.remainingMs) !== numOr0(it.remainingMs)) return false;
        } else {
          var gap = Math.max(0, nowCmp - numOr0(raw.lastTs));
          var elapsed = numOr0(raw.elapsedMs) + gap;
          if (Math.abs(elapsed - numOr0(it.elapsedMs)) > RUN_DERIVE_TOLERANCE_MS) return false;
          if (it.mode === 'countdown' || it.mode === 'pomodoro') {
            var remain = numOr0(raw.remainingMs) - gap;
            if (Math.abs(remain - numOr0(it.remainingMs)) > RUN_DERIVE_TOLERANCE_MS) return false;
          }
        }
      }
      return true;
    }

    function snapshotItem(it) {
      return {
        occ: it.occ,
        mode: it.mode,
        running: !!it.running,
        setting: !!it.setting,
        finished: !!it.finished,
        elapsedMs: it.elapsedMs,
        remainingMs: it.remainingMs,
        countdownSec: it.countdownSec,
        cdH: it.cdH,
        cdM: it.cdM,
        cdS: it.cdS,
        focusMin: it.focusMin,
        breakMin: it.breakMin,
        phase: it.phase,
        lastTs: it.lastTs
      };
    }

    function persist() {
      if (restoring) return;
      var snap = items.slice(0, DOCK_MAX).map(snapshotItem);
      /* D9：文档字段是权威落点（随 doc 同步）；store 没有 setFinishDock 时降级回 UI 状态 */
      if (store && typeof store.setFinishDock === 'function') {
        try {
          store.setFinishDock(snap);
          return;
        } catch (e) { /* 落库失败继续尝试 UI 状态，双保险 */ }
      }
      if (!store || typeof store.saveUIState !== 'function') return;
      try {
        store.saveUIState({ finishDock: snap });
      } catch (e) { /* 非关键状态，失败可忽略 */ }
    }

    function setMode(it, mode) {
      if (it.mode === mode) return;
      it.mode = mode;
      it.running = false;
      it.finished = false;
      it.elapsedMs = 0;
      /* 换方式 = 回到「设置」阶段 → 滚轮重新出现 */
      it.setting = true;
      if (mode === 'countdown') {
        var p = splitSec(it.countdownSec);
        it.cdH = p.h;
        it.cdM = p.m;
        it.cdS = p.s;
        it.remainingMs = it.countdownSec * 1000;
      } else if (mode === 'pomodoro') {
        it.phase = 'focus';
        it.remainingMs = it.focusMin * 60000;
      } else {
        it.remainingMs = 0;
      }
      paintStage(it);
      persist();
    }

    function toggleRun(it) {
      if (it.running) {
        it.running = false;
        /* 暂停留在「已开始」态：滚轮不回来（改时长要先「重置」） */
      } else {
        if (it.mode === 'countdown') {
          if (countdownSecOf(it) <= 0) return;   /* 0 时长不启动（按钮同时是 disabled） */
          if (it.remainingMs <= 0) it.remainingMs = it.countdownSec * 1000;
        }
        if (it.mode === 'pomodoro' && it.remainingMs <= 0) {
          it.remainingMs = (it.phase === 'focus' ? it.focusMin : it.breakMin) * 60000;
        }
        it.running = true;
        it.finished = false;
        it.setting = false;                      /* 开始计时 → 收起滚轮 */
        it.lastTs = Date.now();
      }
      paintStage(it);
      persist();
    }

    function resetRun(it) {
      it.running = false;
      it.finished = false;
      it.elapsedMs = 0;
      it.setting = true;                         /* 重置 = 回到设置，滚轮复现 */
      if (it.mode === 'countdown') it.remainingMs = it.countdownSec * 1000;
      else if (it.mode === 'pomodoro') {
        it.phase = 'focus';
        it.remainingMs = it.focusMin * 60000;
      } else it.remainingMs = 0;
      paintStage(it);
      persist();
    }

    /** 倒计时/番茄钟到时 */
    function reachZero(it) {
      ding();
      if (it.mode === 'countdown') {
        it.remainingMs = 0;
        it.running = false;
        it.finished = true;
        paintStage(it);
        persist();
        return;
      }
      /* 番茄钟：自动交替到下一段并继续跑 */
      it.phase = it.phase === 'break' ? 'focus' : 'break';
      it.remainingMs = (it.phase === 'focus' ? it.focusMin : it.breakMin) * 60000;
      it.running = true;
      it.lastTs = Date.now();
      paintStage(it);
      persist();
    }

    function tick(nowMs) {
      if (!items.length) return;
      var now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
      items.forEach(function (it) {
        if (!it.running) { it.lastTs = now; return; }
        var delta = it.lastTs ? (now - it.lastTs) : 0;
        it.lastTs = now;
        if (delta <= 0) return;
        if (it.mode === 'stopwatch') {
          it.elapsedMs += delta;
          syncClock(it);
          return;
        }
        it.remainingMs -= delta;
        if (it.remainingMs <= 0) {
          reachZero(it);
          return;
        }
        syncClock(it);
      });
    }

    /* ---------------- 对外 API ---------------- */

    var api = {
      /** 拖入一条发生（未排或已排均可）。已存在返回 true，已完成/非法返回 false。 */
      add: function (occ) {
        if (!occ || !occ.key) return false;
        if (occ.done) return false;
        if (find(occ.key)) return true;
        var cd = splitSec(COUNTDOWN_DEFAULT_SEC);
        var it = {
          key: occ.key,
          occ: occ,
          mode: null,
          running: false,
          finished: false,
          /* 设置阶段（滚轮可见）＝ 刚选完方式 / 刚重置；开始计时即退出该阶段 */
          setting: false,
          elapsedMs: 0,
          remainingMs: 0,
          countdownSec: COUNTDOWN_DEFAULT_SEC,
          cdH: cd.h,
          cdM: cd.m,
          cdS: cd.s,
          focusMin: FOCUS_DEFAULT_MIN,
          breakMin: BREAK_DEFAULT_MIN,
          phase: 'focus',
          lastTs: 0,
          wheels: [],
          startBtn: null
        };
        items.push(it);
        if (rootEl && doc) {
          it.node = buildItemNode(it);
          rootEl.appendChild(it.node);
          /* 新条目首次渲染时 stage 还没进文档 → 挂上之后再对齐一次滚轮 */
          syncWheels(it);
        }
        renderCount();
        ensureTimer();
        persist();
        if (onDockChange) onDockChange();
        return true;
      },

      /** 放回原位（不标记完成） */
      remove: function (key) {
        var i = indexOfKey(key);
        if (i < 0) return false;
        var it = items[i];
        dropWheels(it);
        if (it.node && it.node.parentNode) it.node.parentNode.removeChild(it.node);
        items.splice(i, 1);
        renderCount();
        stopTimerIfIdle();
        persist();
        if (onDockChange) onDockChange();
        return true;
      },

      /** 完成：标记 done + 回到原位（由 onComplete 负责落库与重绘） */
      complete: function (key) {
        var it = find(key);
        if (!it) return false;
        var occ = it.occ;
        api.remove(key);
        if (onComplete) onComplete(occ);
        return true;
      },

      has: function (key) { return indexOfKey(key) >= 0; },
      keys: function () { return items.map(function (it) { return it.key; }); },
      count: function () { return items.length; },

      /** 当前状态快照（持久化与断言共用；纯数据，可直接 JSON 序列化） */
      snapshot: function () { return items.map(snapshotItem); },

      /**
       * 从快照恢复条目与计时（刷新后调用）。
       * 只还原**状态**：`running` 为真时读数由 `lastTs` 与当前时间差补上，
       * 因此两次落盘之间隔多久都不会丢时间。
       * @param {Array} list snapshot() 的结果；非法项逐条跳过。
       * @returns {number} 实际恢复的条数
       */
      restore: function (list) {
        if (!Array.isArray(list) || !list.length) return 0;
        var n = 0;
        restoring = true;
        try {
          list.slice(0, DOCK_MAX).forEach(function (raw) {
            if (!raw || !isObj(raw.occ) || !raw.occ.key) return;
            if (!api.add(raw.occ)) return;
            var it = find(raw.occ.key);
            if (!it) return;
            it.mode = MODE_IDS.indexOf(raw.mode) >= 0 ? raw.mode : null;
            it.running = !!raw.running;
            it.setting = !!raw.setting;
            it.finished = !!raw.finished;
            it.elapsedMs = isNum(raw.elapsedMs) ? Math.max(0, raw.elapsedMs) : 0;
            it.remainingMs = isNum(raw.remainingMs) ? Math.max(0, raw.remainingMs) : 0;
            it.countdownSec = isNum(raw.countdownSec) ? raw.countdownSec : COUNTDOWN_DEFAULT_SEC;
            it.cdH = isNum(raw.cdH) ? raw.cdH : splitSec(it.countdownSec).h;
            it.cdM = isNum(raw.cdM) ? raw.cdM : splitSec(it.countdownSec).m;
            it.cdS = isNum(raw.cdS) ? raw.cdS : splitSec(it.countdownSec).s;
            it.focusMin = isNum(raw.focusMin) ? raw.focusMin : FOCUS_DEFAULT_MIN;
            it.breakMin = isNum(raw.breakMin) ? raw.breakMin : BREAK_DEFAULT_MIN;
            it.phase = raw.phase === 'break' ? 'break' : 'focus';
            /* 运行中的条目沿用上次落盘的 lastTs：下一次 tick 会补上这段空档 */
            it.lastTs = isNum(raw.lastTs) ? raw.lastTs : 0;
            /* 已开始却没有任何时间基准（异常快照）：从此刻起算，避免凭空多算 */
            if (it.running && !it.lastTs) it.lastTs = Date.now();
            /* D14：恢复瞬间就把「快照时刻 → 现在」的空档补进读数。
               不补的话，重建出的节点先显示快照里的旧 elapsedMs/remainingMs
               （可能还停在刚开始计时的值），要等下一个 tick 才跳到真实读数——
               刷新页面 / 远端文档应用时看起来就是「闪一下初始计时」。
               补算后 lastTs 归位到当前时刻，首个 tick 从零起算不重复叠加。 */
            if (it.running && it.lastTs) {
              var nowR = Date.now();
              var deltaR = nowR - it.lastTs;
              if (deltaR > 0) {
                if (it.mode === 'stopwatch') {
                  it.elapsedMs += deltaR;
                } else if (it.mode === 'countdown' || it.mode === 'pomodoro') {
                  it.remainingMs -= deltaR;
                  if (it.remainingMs < 0) it.remainingMs = 0; /* 归零铃由 tick 的 reachZero 负责 */
                }
                it.lastTs = nowR;
              }
            }
            paintStage(it);
            syncWheels(it);
            syncClock(it);
            n += 1;
          });
        } finally {
          restoring = false;
        }
        if (n) {
          ensureTimer();
          renderCount();
          if (onDockChange) onDockChange();
        }
        return n;
      },

      /**
       * D9：用一份快照**整体重建**台内条目（远端应用后的入口）。
       * 与 restore 的差异：先静默清台（不清不在新快照里的旧条目会「幽灵复驻」），
       * 且内容与当前一致时跳过（拉取回放不重建，运行中的计时不被打断）。
       * 静默清台与 restore 全程不走 persist——新快照要么已在 doc 里（远端来），
       * 要么由 restore 落盘，避免同步回环。
       * @param {Array} list snapshot()/doc.finishDock 形状
       * @returns {number} 实际恢复的条数（空快照返回 0，台子被清空）
       */
      replace: function (list) {
        var incoming = Array.isArray(list) ? list : [];
        try {
          /* D14：语义比较取代 JSON 全等——运行中条目的 lastTs/读数每秒都在变，
             全等比较会把每次拉取回放都判成「有变化」而整台重建（界面闪烁）。 */
          if (dockSemanticallySame(incoming)) return items.length;
        } catch (e) { /* 比较失败就走重建，重建本身幂等 */ }
        restoring = true;
        try {
          items.forEach(function (it) {
            dropWheels(it);
            if (it.node && it.node.parentNode) it.node.parentNode.removeChild(it.node);
          });
          items = [];
          if (rootEl && doc) rootEl.innerHTML = '';
          renderCount();
          stopTimerIfIdle();
        } finally {
          restoring = false;
        }
        var n = api.restore(incoming);
        if (!n && onDockChange) onDockChange(); /* 空台也要让视图重绘（原位置恢复显示） */
        return n;
      },

      /** 当前运行中的条目数（用于冒烟断言「多事项各计各的」） */
      runningCount: function () { return items.filter(function (it) { return it.running; }).length; },
      /** 单条的计时读数（毫秒；正计时=已用时，倒计时/番茄=剩余） */
      readMs: function (key) {
        var it = find(key);
        if (!it) return 0;
        return it.mode === 'stopwatch' ? it.elapsedMs : it.remainingMs;
      },
      readMode: function (key) {
        var it = find(key);
        return it ? it.mode : null;
      },
      readPhase: function (key) {
        var it = find(key);
        return it ? it.phase : null;
      },
      /** 设置阶段快照（滚轮只在 setting=true 时出现）：读数与断言共用 */
      readSetup: function (key) {
        var it = find(key);
        if (!it) return null;
        return {
          setting: !!it.setting,
          countdownSec: it.mode === 'countdown' ? countdownSecOf(it) : it.countdownSec,
          cdH: it.cdH, cdM: it.cdM, cdS: it.cdS,
          focusMin: it.focusMin, breakMin: it.breakMin
        };
      },
      tick: tick,

      soundEnabled: function () { return soundOn; },
      /** 响过的「叮」次数（静音时不增加） */
      dingCount: function () { return dingCount; },
      setSound: function (on) {
        soundOn = !!on;
        try { if (store && typeof store.saveUIState === 'function') store.saveUIState({ finishSound: soundOn }); } catch (e) { /* 忽略 */ }
        return soundOn;
      },

      destroy: function () {
        if (timer && typeof root.clearInterval === 'function') root.clearInterval(timer);
        timer = null;
        items.slice().forEach(function (it) { api.remove(it.key); });
        items = [];
        if (rootEl && doc) rootEl.innerHTML = '';
        audioCtx = null;
      }
    };

    /* ---------------- 初始化 ---------------- */

    if (rootEl && doc) {
      rootEl.innerHTML = '';
      renderCount();
    }

    return api;
  }

  return { create: create, fmtClock: fmtClock };
});
