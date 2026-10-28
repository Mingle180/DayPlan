/**
 * DayPlan · 启动与全局装配（迭代 3：月 / 周 / 日三视图路由）
 *
 * 职责：
 *   1. 创建 store（注入演示数据工厂）→ 装配侧栏迷你日历与三个主视图；
 *   2. 维护共享的「视图日期」与「视图模式」状态（持久化到 dayplan.ui.v1）；
 *   3. 绑定快捷键、全局事件、存储降级 / 数据损坏警告；
 *   4. 暴露 window.__dayplan 调试入口。
 *
 * 契约见 docs/spec/02-functional-spec.md F-02、docs/spec/04-system-design.md §2.13。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var D = root.DayPlan.datetime;
  var Store = root.DayPlan.store;
  var Seed = root.DayPlan.seed;
  var SettingsView = root.DayPlan.settingsView;
  var M = root.DayPlan.modal;

  var VIEW_MODES = ['month', 'week', 'day'];

  /**
   * 启动时窥探持久凭据里的会话 uid（只读：不刷新令牌、不写盘）。
   *
   * Store 创建时要用它解析活动指针。拿不到 uid，`resolveBootScope` 只能按
   * 契约 §2.2 把 `user:<uid>` 回落成 guest 并写回——用户看到的现象是
   * 「刷新一下同步就断了、还让你重新选择」（Q-28 实测）。
   * 真正的会话恢复仍然只有 wiring.restore() 一条路；它失败时由装配层回落 guest。
   */
  function peekBootSessionUid() {
    var S = root.DayPlan.session;
    var W = root.DayPlan.syncWiring;
    if (!S || typeof S.peekPersistedUserId !== 'function') return null;
    var storage = null;
    try { storage = typeof Store.detectLocalStorage === 'function' ? Store.detectLocalStorage() : null; } catch (e) { storage = null; }
    if (!storage) return null;
    var kv = null;
    try { kv = (W && typeof W.adaptKv === 'function') ? W.adaptKv(storage) : null; } catch (e) { kv = null; }
    if (!kv) return null;
    try { return S.peekPersistedUserId(kv); } catch (e) { return null; }
  }

  function boot() {
    /* 迭代 7（F-47）：先注入节假日判定，再做任何展开/渲染（顺序敏感） */
    wireHolidayResolver();

    var els = {
      app: document.getElementById('app'),
      banners: document.getElementById('banners'),
      todayChip: document.getElementById('today-chip'),
      settingsBtn: document.getElementById('btn-settings'),
      viewSwitch: document.getElementById('view-switch'),
      monthRoot: document.getElementById('view-month-root'),
      weekRoot: document.getElementById('view-week-root'),
      dayPanel: document.getElementById('day-panel')
    };

    /* ---------------- 警告条 ---------------- */

    function warn(type, text, actions) {
      if (!els.banners) return null;
      var node = M.el('div', { class: 'banner banner-' + type });
      node.appendChild(M.el('div', { class: 'banner-body', text: text }));
      if (actions && actions.length) {
        var box = M.el('div', { class: 'banner-actions' });
        actions.forEach(function (a) {
          box.appendChild(M.el('button', {
            class: 'btn', type: 'button', text: a.label,
            onclick: function () { a.onClick(); node.remove(); }
          }));
        });
        node.appendChild(box);
      }
      node.appendChild(M.el('button', {
        class: 'btn btn-ghost btn-icon', type: 'button', text: '✕', 'aria-label': '关闭提示',
        onclick: function () { node.remove(); }
      }));
      els.banners.appendChild(node);
      return node;
    }

    /* ---------------- store ---------------- */

    var store = Store.createStore({
      seedFactory: function () { return Seed.createDemoDocument(); },
      /* 有可恢复的凭据就把 uid 交给 Store：否则指针 `user:<uid>` 会在启动时
         被当成「未登录」回落成 guest（契约 §2.2 的回落规则本身是对的，
         错的是启动时没告诉 Store 会话还在）。 */
      sessionUid: peekBootSessionUid()
    });

    var loadResult = store.load();

    if (loadResult && !loadResult.ok) {
      warn('danger',
        '本地数据无法读取，已备份原始内容并以空数据启动。' +
        (loadResult.code ? '（' + loadResult.code + '）' : '') +
        (loadResult.error ? '：' + loadResult.error : ''),
        [{ label: '我知道了', onClick: function () { /* 仅关闭 */ } }]);
    } else if (loadResult && loadResult.recovered && loadResult.warnings && loadResult.warnings.length) {
      warn('warn', '读取时自动修复了 ' + loadResult.warnings.length + ' 处问题：' +
        loadResult.warnings.slice(0, 3).map(function (w) { return w.path; }).join('、') +
        (loadResult.warnings.length > 3 ? ' 等' : ''));
    }

    /* 迭代 4（DM-20.2 / BR-40）：★ 重要 → 紧急 的自动迁移要**告知用户**，不能静默改数据。
       迁移幂等：用户产生任意一次写入后 v3 落盘，之后不再产生该告警。 */
    (function () {
      var warns = [];
      if (loadResult && loadResult.warnings) warns = warns.concat(loadResult.warnings);
      try { if (store.getWarnings) warns = warns.concat(store.getWarnings() || []); } catch (e) { /* 非关键 */ }
      var moved = warns.filter(function (w) { return w && w.code === 'E_MIGRATE_URGENT'; });
      if (!moved.length) return;
      warn('info', '已把 ' + moved.length + ' 项原「★ 重要」的事项归入「紧急」类型' +
        '（可在事项详情里点「取消紧急」还原为原来的类型）。');
    })();

    if (store.isStorageDegraded()) {
      warn('warn', '浏览器存储不可用，已切换到临时内存模式：本次修改不会被保存。');
    }

    /* ---------------- 主题（美化迭代 3：设置里可选 浅色/深色/跟随系统） ----------------
       CSS 的暗色变量绑在 <html data-theme="dark"> 上；'auto' 由 JS 解析系统偏好，
       matchMedia 不可用（垫片/老旧环境）时按浅色处理。 */
    function applyTheme() {
      var theme = 'auto';
      try {
        var s = (store.getState() || {}).settings || {};
        if (s.theme === 'light' || s.theme === 'dark' || s.theme === 'auto') theme = s.theme;
      } catch (e) { /* 读取失败按 auto */ }
      var dark = false;
      if (theme === 'dark') dark = true;
      else if (theme === 'auto' && root.matchMedia) {
        try { dark = root.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { /* 按浅色 */ }
      }
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    }
    applyTheme();
    if (root.matchMedia) {
      try {
        root.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { applyTheme(); });
      } catch (e) { /* 老浏览器不支持监听，切换主题需重进设置 */ }
    }

    if (loadResult && loadResult.seeded) {
      warn('info', '首次运行已载入演示数据（含农历八月初六与每周一 08:00–10:00 两个示例）。', [{
        label: '清空演示数据',
        onClick: function () { SettingsView.openSettings(settingsOpts); }
      }]);
    }

    /* ---------------- 视图状态 ---------------- */

    var ui0 = store.loadUIState() || {};
    var state = {
      viewDate: (ui0.viewDate && D.isValidDate(ui0.viewDate)) ? ui0.viewDate : D.todayISO(),
      viewMode: VIEW_MODES.indexOf(ui0.viewMode) >= 0 ? ui0.viewMode : 'day'
    };

    var instances = { month: null, week: null, day: null };
    var settingsOpts = null;

    function persistViewState() {
      store.saveUIState({ viewDate: state.viewDate, viewMode: state.viewMode });
    }

    /* ---------------- 懒创建视图 ---------------- */

    function monthView() {
      if (instances.month) return instances.month;
      var factory = root.DayPlan.monthView;
      if (!factory || !factory.createMonthView) return null;
      instances.month = factory.createMonthView({
        store: store,
        container: els.monthRoot,
        onSelectDate: function (iso) { setViewDate(iso); },
        /* 迭代 6（F-42 / R-20）：月视图整周行（含日期格）→ 该周周视图；
           月视图不再下钻到日视图，故不再注入 onOpenDay（下钻到某天由周视图承担）。 */
        onOpenWeek: function (iso) { goWeek(iso, { animate: true }); },
        /* 三十七轮：月 ↔ 年视图状态变化 → 分段控件「年」的选中态 / 白块跟随 */
        onYearModeChange: function () { syncSwitchUI(); },
        onDataChanged: function () { onDataChanged(); }
      });
      return instances.month;
    }

    function weekView() {
      if (instances.week) return instances.week;
      var factory = root.DayPlan.weekView;
      if (!factory || !factory.createWeekView) return null;
      instances.week = factory.createWeekView({
        store: store,
        container: els.weekRoot,
        onSelectDate: function (iso) { setViewDate(iso); },
        /* 迭代 4（S26 / US-22.2）：周视图单击某一天 → 日视图 */
        onOpenDay: function (iso) { goDay(iso, { animate: true }); },
        onDataChanged: function () { onDataChanged(); }
      });
      return instances.week;
    }

    function dayView() {
      if (instances.day) return instances.day;
      if (!root.DayPlan.dayView) return null;
      instances.day = root.DayPlan.dayView.createDayView({
        store: store,
        /* 日视图内的「今天」与左右横滑改的是视图自己的 state.date，必须回写到共享 state.viewDate 并落盘。
           原先这里写成 `persistViewState()` 丢掉了入参 iso —— 于是 viewDate 停在旧值，
           刷新后日视图会跳回旧日期（往往是周视图归一化出的周一）。日视图自身已重绘，
           这里只同步周/月两个隐藏视图，不再回调日视图以免重入。 */
        onSelectDate: function (iso) {
          if (!D.isValidDate(iso)) { persistViewState(); return; }
          state.viewDate = iso;
          if (instances.week) instances.week.setDate(iso, { notify: false });
          if (instances.month) instances.month.setDate(iso, { notify: false });
          persistViewState();
        },
        /* 迭代 4 修正（DM-23 / BR-16）：折叠状态持久化到 dayplan.ui.v1.expanded（LRU 200）。
           迭代 3 只实现了 store 侧 API，此处漏了注入，导致展开态实际未持久化。 */
        isExpanded: function (key) { return store.isExpanded(key); },
        setExpanded: function (key, on) { store.setExpanded(key, on); },
        onDataChanged: function () { onDataChanged(); }
      });
      return instances.day;
    }

    /* ---------------- 主流程 ---------------- */

    function onDataChanged() {
      applyTheme();
      Object.keys(instances).forEach(function (k) {
        var v = instances[k];
        if (v && typeof v.refresh === 'function') v.refresh();
      });
      refreshTodayChip();
    }

    /** 切换共享视图日期（三视图同步）。 */
    function setViewDate(iso, opts) {
      if (!D.isValidDate(iso)) return;
      state.viewDate = iso;
      var slide = opts && opts.slide;
      if (instances.day) instances.day.setDate(iso, { notify: false, slide: slide });
      if (instances.week) instances.week.setDate(iso, { notify: false });
      if (instances.month) instances.month.setDate(iso, { notify: false });
      persistViewState();
    }

    /** 切到日视图。 */
    function goDay(iso, opts) {
      if (iso) setViewDate(iso);
      setViewMode('day', opts);
    }

    /** 切到周视图（iso 所在周）。 */
    function goWeek(iso, opts) {
      if (iso) setViewDate(iso);
      setViewMode('week', opts);
    }

    /** 切到月视图（ym 或 iso 所在月居中）。 */
    function goMonth(isoOrYm, opts) {
      if (isoOrYm) {
        if (/^\d{4}-\d{2}$/.test(isoOrYm)) setViewDate(isoOrYm + '-01');
        else setViewDate(isoOrYm);
      }
      setViewMode('month', opts);
    }

    /* ---------------- 视图切换过渡（三十七轮：左右滑入 + 年视图缩放） ---------------- */

    var VIEW_ORDER = { year: 0, month: 1, week: 2, day: 3 };
    var VIEW_SLIDE_MS = 420;
    var switchToken = 0;
    var reducedMotionMql = null;

    function prefersReducedMotion() {
      if (!reducedMotionMql && typeof root.matchMedia === 'function') {
        try { reducedMotionMql = root.matchMedia('(prefers-reduced-motion: reduce)'); }
        catch (e) { reducedMotionMql = null; }
      }
      return !!(reducedMotionMql && reducedMotionMql.matches);
    }

    /** 当前真正高亮的档位：年视图复用月视图的 DOM，但分段控件上算「年」。 */
    function activeViewKey() {
      if (state.viewMode === 'month' && instances.month &&
        typeof instances.month.isYearView === 'function' && instances.month.isYearView()) {
        return 'year';
      }
      return state.viewMode;
    }

    function rootOf(key) {
      if (key === 'month' || key === 'year') return els.monthRoot;
      if (key === 'week') return els.weekRoot;
      return els.dayPanel;
    }

    /** 清掉上一个视图的滑入动画与内联样式（快速连点时旧动画必须立刻让位）。 */
    function clearViewSlide(node) {
      if (!node) return;
      if (node.__viewSlide) {
        try { node.__viewSlide.cancel(); } catch (e) { /* 已结束 */ }
        node.__viewSlide = null;
      }
      if (node.style) {
        node.style.transform = '';
        node.style.opacity = '';
        node.style.visibility = '';
      }
    }

    /**
     * 切档期间把页头从毛玻璃临时改纯色（CSS 与 is-year-flipping 共用一条规则）。
     * 半透明页头要在每一帧采样下方正在位移的内容，Chromium 会闪；
     * 结束（或下一次切档接管）时恢复。
     */
    function setViewSwitchChrome(on) {
      if (typeof document === 'undefined' || !document.body || !document.body.classList) return;
      document.body.classList.toggle('is-view-switching', !!on);
    }

    /**
     * 按分段顺序做水平滑入：切到更右的档位从右侧进来，切回更左的档位从左侧进来。
     * 只动进入的视图（旧视图立即隐藏）——两个视图同时占位会把页面高度翻倍、挤压布局。
     */
    function playViewSlide(node, fromKey, toKey, done) {
      if (!node) { if (done) done(); return; }
      clearViewSlide(node);
      if (prefersReducedMotion() || typeof node.animate !== 'function') {
        if (done) done();
        return;
      }
      var a = VIEW_ORDER[fromKey];
      var b = VIEW_ORDER[toKey];
      var dir = (typeof a === 'number' && typeof b === 'number' && b < a) ? -1 : 1;
      var width = 0;
      try { width = node.getBoundingClientRect().width || 0; } catch (e) { width = 0; }
      var offset = Math.round(Math.max(28, Math.min(120, width * 0.28))) * dir;
      var anim = node.animate([
        { transform: 'translateX(' + offset + 'px)', opacity: 0.86 },
        { transform: 'translateX(0px)', opacity: 1 }
      ], { duration: VIEW_SLIDE_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      node.__viewSlide = anim;
      var finish = function () {
        if (node.__viewSlide !== anim) return;   /* 已被下一次切换接管 */
        node.__viewSlide = null;
        try { anim.cancel(); } catch (e) { /* 已结束 */ }
        if (node.style) {
          node.style.transform = '';
          node.style.opacity = '';
          node.style.visibility = '';
        }
        if (done) done();
      };
      if (anim.finished && typeof anim.finished.then === 'function') {
        anim.finished.then(finish, function () { /* 被后续切换取消 */ });
      } else if ('onfinish' in anim) {
        anim.onfinish = finish;
      } else {
        finish();
      }
    }

    /**
     * 日 / 周视图「前移 / 后移」的左右滑入（三十九轮）。
     * 与切档不同：档位没变，只换日期，因此方向由调用方给出（+1 下一段，-1 上一段）。
     * 复用 __viewSlide / clearViewSlide，快速连点不会叠加动画。
     */
    var DATE_SLIDE_MS = 320;
    function slideDatePanel(node, dir, done) {
      if (!node || !node.style) { if (done) done(); return; }
      clearViewSlide(node);
      if (prefersReducedMotion() || typeof node.animate !== 'function') {
        if (done) done();
        return;
      }
      var width = 0;
      try { width = node.getBoundingClientRect().width || 0; } catch (e) { width = 0; }
      var offset = Math.round(Math.max(24, Math.min(72, width * 0.16))) * (dir < 0 ? -1 : 1);
      var anim = node.animate([
        { transform: 'translateX(' + offset + 'px)', opacity: 0.9 },
        { transform: 'translateX(0px)', opacity: 1 }
      ], { duration: DATE_SLIDE_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      node.__viewSlide = anim;
      var finish = function () {
        if (node.__viewSlide !== anim) return;
        node.__viewSlide = null;
        try { anim.cancel(); } catch (e) { /* 已结束 */ }
        if (node.style) { node.style.transform = ''; node.style.opacity = ''; node.style.visibility = ''; }
        if (done) done();
      };
      if (anim.finished && typeof anim.finished.then === 'function') {
        anim.finished.then(finish, function () { /* 被下一次切换取消 */ });
      } else if ('onfinish' in anim) {
        anim.onfinish = finish;
      } else {
        finish();
      }
    }

    /* ---------------- 手机横滑切日期 / 周（四十七轮） ---------------- */

    var SWIPE_SLOP_PX = 7;       // 判方向的手指位移（小于浏览器滚动阈值，先手拿住手势）
    var SWIPE_LOCK_RATIO = 0.9;  // |x| > |y|×0.9 即锁成横滑（约 42° 以内都算横滑）
    var SWIPE_HOLD_PX = 20;      // 纵向占优到这个距离才认定是在滚页面
    var SWIPE_COMMIT_PX = 40;    // 距离阈值（宽度的 14% 与它取大）
    var SWIPE_COMMIT_RATIO = 0.14;
    var SWIPE_FLICK_VX = 0.28;   // px/ms：快速轻扫可低于距离阈值
    var SWIPE_FLICK_MIN_PX = 12;
    var SWIPE_OUT_MS = 150;
    var SWIPE_IN_MS = 230;

    var SWIPE_NO_START = ['input', 'textarea', 'select', 'button', 'a', '.modal-backdrop', '.dp-pop'];
    function isInteractiveTarget(target) {
      if (!target || typeof target.closest !== 'function') return false;
      for (var i = 0; i < SWIPE_NO_START.length; i += 1) {
        if (target.closest(SWIPE_NO_START[i])) return true;
      }
      return false;
    }

    /**
     * 给日 / 周视图接横滑：时间表以外的区域按 1:1 跟手，松手后旧页滑出、
     * 新页从另一侧滑入。换内容发生在旧页完全离屏时，用户看不到中间帧。
     * 只接管 pointerType=touch —— 鼠标拖拽（未排排序）和桌面点击不受影响。
     * @param {HTMLElement} el 被平移的视图根节点
     * @param {{exclude?:function(Element):boolean, onCommit:function(number)}} opts
     */
    function enableSwipe(el, opts) {
      if (!el || !el.addEventListener) return;
      opts = opts || {};
      var excluded = typeof opts.exclude === 'function' ? opts.exclude : function () { return false; };
      var onCommit = typeof opts.onCommit === 'function' ? opts.onCommit : function () {};
      var active = false;
      var decided = false;
      var busy = false;
      var pointerId = null;
      var startX = 0;
      var startY = 0;
      var dx = 0;
      var lastX = 0;
      var lastT = 0;
      var vx = 0;

      function stopMotion() {
        var motion = root.DayPlan.motion;
        if (motion && typeof motion.clearSlide === 'function') motion.clearSlide(el);
        try {
          el.getAnimations().forEach(function (a) { a.cancel(); });
        } catch (e) { /* 不支持 getAnimations */ }
      }

      function resetStyles() {
        if (el.classList) el.classList.remove('is-swiping');
        el.style.transition = '';
        el.style.transform = '';
      }

      function settleBack() {
        var reduced = prefersReducedMotion() || typeof el.animate !== 'function';
        if (reduced) { resetStyles(); return; }
        var a = el.animate([
          { transform: 'translateX(' + dx + 'px)' },
          { transform: 'translateX(0px)' }
        ], { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
        var done = function () { resetStyles(); };
        if (a.finished && typeof a.finished.then === 'function') a.finished.then(done, done);
        else setTimeout(done, 240);
      }

      function commit(dir) {
        busy = true;
        var width = 0;
        try { width = el.getBoundingClientRect().width || 0; } catch (e) { width = 0; }
        if (!width) width = root.innerWidth || 320;
        var outX = dir > 0 ? -width : width;
        var reduced = prefersReducedMotion() || typeof el.animate !== 'function';
        if (reduced) {
          resetStyles();
          try { onCommit(dir); } finally { busy = false; }
          return;
        }
        var dist = Math.abs(outX - dx);
        var outMs = Math.max(90, Math.round(dist / width * SWIPE_OUT_MS));
        var out = el.animate([
          { transform: 'translateX(' + dx + 'px)' },
          { transform: 'translateX(' + outX + 'px)' }
        ], { duration: outMs, easing: 'cubic-bezier(0.4, 0, 1, 1)' });

        var swingIn = function () {
          /* 旧页已完全离屏：此时换内容不会出现「中间帧」 */
          el.style.transition = '';
          el.style.transform = 'translateX(' + (-outX) + 'px)';
          try { el.offsetWidth; } catch (e) { /* 强制布局 */ }
          try { onCommit(dir); } catch (e) { resetStyles(); busy = false; return; }
          var enter = el.animate([
            { transform: 'translateX(' + (-outX) + 'px)' },
            { transform: 'translateX(0px)' }
          ], { duration: SWIPE_IN_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
          var done = function () { resetStyles(); busy = false; };
          if (enter.finished && typeof enter.finished.then === 'function') enter.finished.then(done, done);
          else setTimeout(done, SWIPE_IN_MS + 40);
        };
        if (out.finished && typeof out.finished.then === 'function') out.finished.then(swingIn, swingIn);
        else setTimeout(swingIn, outMs + 40);

        /* 动画被外部取消时兜底释放手势锁 */
        setTimeout(function () {
          if (!busy) return;
          stopMotion();
          resetStyles();
          busy = false;
        }, outMs + SWIPE_IN_MS + 480);
      }

      function onPointerDown(e) {
        if (busy || !e.isPrimary) return;
        if (e.pointerType && e.pointerType !== 'touch') return;
        if (isInteractiveTarget(e.target) || excluded(e.target)) return;
        active = true;
        decided = false;
        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        dx = 0;
        lastX = e.clientX;
        lastT = e.timeStamp || Date.now();
        vx = 0;
        stopMotion();
        el.style.transition = 'none';
        el.style.transform = '';
      }

      function onPointerMove(e) {
        if (!active || e.pointerId !== pointerId) return;
        var x = e.clientX - startX;
        var y = e.clientY - startY;
        if (!decided) {
          var ax = Math.abs(x);
          var ay = Math.abs(y);
          if (ax < SWIPE_SLOP_PX && ay < SWIPE_HOLD_PX) return;
          if (ax >= SWIPE_SLOP_PX && ax > ay * SWIPE_LOCK_RATIO) {
            decided = true;
            if (el.classList) el.classList.add('is-swiping');
            try { el.setPointerCapture(pointerId); } catch (err) { /* 合成事件无捕获 */ }
          } else if (ay >= SWIPE_HOLD_PX && ay > ax) {
            /* 明确的纵向意图：放手让浏览器滚页面 */
            active = false;
            el.style.transition = '';
            return;
          } else {
            /* 还没分出主方向：继续观察，不锁死这次手势 */
            return;
          }
        }
        dx = x;
        var now = e.timeStamp || Date.now();
        var span = now - lastT;
        if (span > 0) vx = vx * 0.7 + ((e.clientX - lastX) / span) * 0.3;
        lastX = e.clientX;
        lastT = now;
        el.style.transform = 'translateX(' + dx + 'px)';
      }

      function finishGesture(e, canceled) {
        if (!active || e.pointerId !== pointerId) return;
        active = false;
        pointerId = null;
        if (!decided) {
          el.style.transition = '';
          el.style.transform = '';
          return;
        }
        decided = false;
        var width = 0;
        try { width = el.getBoundingClientRect().width || 0; } catch (err) { width = 0; }
        var threshold = Math.max(SWIPE_COMMIT_PX, width * SWIPE_COMMIT_RATIO);
        var commitOk = Math.abs(dx) >= threshold
          || (Math.abs(vx) >= SWIPE_FLICK_VX && Math.abs(dx) >= SWIPE_FLICK_MIN_PX);
        /* 已经被锁定为横滑才可能收到 pointercancel（浏览器抢去滚动）。
           此时按半程距离或甩速照常提交，避免拖到一半突然弹回。 */
        if (canceled && !commitOk) {
          commitOk = Math.abs(dx) >= threshold * 0.5
            || (Math.abs(vx) >= SWIPE_FLICK_VX && Math.abs(dx) >= SWIPE_FLICK_MIN_PX);
        }
        if (commitOk) commit(dx < 0 ? 1 : -1);
        else settleBack();
      }

      el.addEventListener('pointerdown', onPointerDown);
      el.addEventListener('pointermove', onPointerMove);
      el.addEventListener('pointerup', function (e) { finishGesture(e, false); });
      el.addEventListener('pointercancel', function (e) { finishGesture(e, true); });
      /* 锁定横滑后自己消化 touchmove，浏览器就不会把这次手势改成纵向滚动
         （纵向滚动的接管正是「划到一半断掉」的来源）。未锁定前放行，页面照常滚。 */
      el.addEventListener('touchmove', function (e) {
        if (e && e.cancelable === false) return;
        if (!decided) {
          var t = e && e.touches && e.touches[0];
          if (!active || !t) return;
          var ax = Math.abs(t.clientX - startX);
          var ay = Math.abs(t.clientY - startY);
          if (ax < SWIPE_SLOP_PX || ax <= ay * SWIPE_LOCK_RATIO) return;
        }
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
      }, { passive: false });
    }

    /* 视图模块（日 / 周）在事件回调里取：模块加载顺序早于 app，不能在它们顶层捕获。 */
    root.DayPlan.motion = {
      slidePanel: slideDatePanel,
      clearSlide: clearViewSlide,
      enableSwipe: enableSwipe
    };

    function setViewMode(mode, opts) {
      if (VIEW_MODES.indexOf(mode) < 0) return;
      opts = opts || {};
      var prevKey = activeViewKey();
      var prevRoot = rootOf(prevKey);
      var changed = state.viewMode !== mode;
      state.viewMode = mode;
      var token = ++switchToken;

      /* 2026-10-21 用户口径：月视图的月份显示窗要顶满可用高度。
         档位写到 body 上，供 month.css 只在该档位拉直 #app → .month-view 的纵向链。 */
      if (document.body && document.body.setAttribute) {
        document.body.setAttribute('data-view-mode', mode);
      }

      // 按需创建，保证首次进入才计算
      if (mode === 'month') monthView();
      else if (mode === 'week') weekView();
      else dayView();

      /* 快速连点：把上一次没跑完的滑入动画取消并清干净，避免两套变换叠加。 */
      [els.monthRoot, els.weekRoot, els.dayPanel].forEach(clearViewSlide);

      var targetRoot = rootOf(mode);
      var animate = changed && opts.animate === true && !prefersReducedMotion();
      if (animate) setViewSwitchChrome(true);

      /* 换档的关键顺序：先把新视图以「不可见但参与布局」的状态挂出来，
         完成日期 / 窗口 / 滚动定位后再显示并滑入。
         旧实现先显示再滚动，会画出中间帧（页头跳动、新视图先闪一下）。 */
      if (targetRoot) {
        targetRoot.hidden = false;
        if (animate) targetRoot.style.visibility = 'hidden';
      }
      if (changed && prevRoot && prevRoot !== targetRoot) prevRoot.hidden = true;
      /* 启动恢复档位（state.viewMode 已持久化）时 changed=false，上面那行不会跑；
         而 index.html 里只有月 / 周两个容器带 hidden，day-panel 默认可见——
         于是「刷新时停在周 / 月档」会同时挂出两套视图（下方多出一个空白日视图）。
         这里按最终状态统一收口：目标之外的容器一律隐藏，幂等。 */
      [els.monthRoot, els.weekRoot, els.dayPanel].forEach(function (r) {
        if (r && r !== targetRoot) r.hidden = true;
      });

      if (mode === 'month' && instances.month) {
        instances.month.setDate(state.viewDate, { notify: false });
        if (opts.yearView && typeof instances.month.setYearView === 'function') {
          /* 三十八轮（用户口径）：周 / 日 → 年不经过月视图。直接把月根节点
             渲染成年视图布局（instant，无 FLIP），随后整块滑入。 */
          instances.month.setYearView(true, state.viewDate.slice(0, 7), { instant: true });
        } else if (typeof instances.month.scrollToToday === 'function') {
          /* 迭代 6（F-40）：每次切到月视图都回到「今天」的位置 */
          instances.month.scrollToToday();
        }
      } else if (mode !== 'month' && instances.month &&
        typeof instances.month.isYearView === 'function' && instances.month.isYearView()) {
        /* 离开月视图时静默退出年视图（不做 700ms 缩放，反正马上要被隐藏）。 */
        instances.month.setYearView(false, null, { instant: true });
      }
      if (mode === 'week' && instances.week) instances.week.setDate(state.viewDate, { notify: false });
      if (mode === 'day' && instances.day) instances.day.setDate(state.viewDate, { notify: false });

      /* 周 / 日视图不沿用月视图长列表的页面滚动位置（手机档滚的是 window）。 */
      if (changed && mode !== 'month' && root && typeof root.scrollTo === 'function') {
        root.scrollTo(0, 0);
      }

      syncSwitchUI();
      if (changed && animate) {
        if (targetRoot) targetRoot.style.visibility = '';
        playViewSlide(targetRoot, prevKey, opts.yearView ? 'year' : mode, function () {
          setViewSwitchChrome(false);
          if (token !== switchToken) return;
          if (typeof opts.afterSwitch === 'function') opts.afterSwitch();
        });
      } else {
        if (targetRoot && targetRoot.style) targetRoot.style.visibility = '';
        setViewSwitchChrome(false);
        if (token === switchToken && typeof opts.afterSwitch === 'function') opts.afterSwitch();
      }
      if (opts.persist !== false) persistViewState();
    }

    function syncSwitchUI() {
      if (!els.viewSwitch) return;
      var active = activeViewKey();
      Array.prototype.slice.call(els.viewSwitch.querySelectorAll('[data-view]')).forEach(function (b) {
        var on = b.getAttribute('data-view') === active;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      /* 迭代 10 批次 2（条6）：白块跟随当前档位（拖动结束后由 endDrag 再同步一次） */
      if (viewThumbSync) viewThumbSync();
    }

    /**
     * 手机端「年」段：年在月视图的缩放下。
     * 三十八轮（用户口径）：从周 / 日点「年」不再先滑入月视图、再缩成一年——
     * 直接以年视图布局滑入（否则用户会看到「周/日 → 月 → 年」两段动画）。
     * 月 → 年仍走 700ms FLIP 缩放。
     */
    function showYearView() {
      var mv = monthView();
      if (!mv || typeof mv.setYearView !== 'function') return;
      if (mv.isYearView()) return;
      if (state.viewMode !== 'month') {
        setViewMode('month', { animate: true, yearView: true });
        return;
      }
      mv.setYearView(true);
    }

    /** 段控 / 拖动落档的统一入口：年不是独立 viewMode，而是月视图的子状态。 */
    function selectSwitchKey(key) {
      if (key === 'year') { showYearView(); return; }
      if (key === 'month' && instances.month
        && typeof instances.month.isYearView === 'function' && instances.month.isYearView()) {
        if (state.viewMode !== 'month') { setViewMode('month', { animate: true }); return; }
        /* 三十九轮（用户口径）：直接点「月」= 回到今天所在月；
           点某一月卡才放大到那个月（month.js exitYearView 走 iso 的月份）。 */
        if (typeof instances.month.exitToToday === 'function') instances.month.exitToToday();
        else instances.month.setYearView(false);
        return;
      }
      if (VIEW_MODES.indexOf(key) < 0) return;
      setViewMode(key, { animate: true });
    }

    /* ---------------- 同步装配（Phase 2 骨架，默认 off，绝不自动联网） ----------------
       mode 由外部配置决定：window.DAYPLAN_SYNC = { mode:'mock'|'real', config:{url,anonKey} }。
       默认 off —— 不登录、不建 engine、不产生任何请求。
       mock 只用于界面自测（数据进内存）；real 缺 config 会由 wiring 抛 E_NOT_CONFIGURED，
       这里接住并如实告知，**不降级**。 */
    var syncWiring = null;

    /* 真实连接配置：只存 url 与 publishable key（两者都是浏览器可见的公开值），
       绝不存密码 —— 密码只在登录时用一次，不落盘。 */
    var CONN_KEY = 'dayplan.sync.conn.v1';

    /* 默认项目（2026-10-27 所有者口径）：用户不该被要求理解「Project URL /
       publishable key」这两个概念——这是部署者的知识，不是使用者的。
       没连过自己项目时，登录直接用这份默认配置；publishable key 本来就是
       设计为放进浏览器的公开值（真正的权限边界在数据库 RLS）。想换成自己的
       项目仍走「连接 Supabase…」，连过的优先用连过的。 */
    var DEFAULT_SYNC_CONN = {
      url: 'https://ceqcgiekjrgrtzsxvwpk.supabase.co',
      anonKey: 'sb_publishable_FUQ6sA9gZjcrqdXMuDzifg_T0MfxNjl'
    };

    function connStorage() {
      var s = null;
      try { s = store.getStorage(); } catch (e) { s = null; }
      return s;
    }

    function readConn() {
      var s = connStorage();
      if (!s) return null;
      try {
        var raw = s.getItem(CONN_KEY);
        if (!raw) return null;
        var o = JSON.parse(raw);
        if (!o || typeof o.url !== 'string' || typeof o.anonKey !== 'string') return null;
        if (o.url === '' || o.anonKey === '') return null;
        return { url: o.url, anonKey: o.anonKey };
      } catch (e) {
        return null;
      }
    }

    function writeConn(conn) {
      var s = connStorage();
      if (!s) throw new Error('本机存储不可用，无法保存连接配置');
      s.setItem(CONN_KEY, JSON.stringify({ url: String(conn.url || ''), anonKey: String(conn.anonKey || '') }));
    }

    function clearConn() {
      var s = connStorage();
      if (!s) return;
      try { s.removeItem(CONN_KEY); } catch (e) { /* 删不掉也不影响内存态 */ }
    }

    /**
     * 把 Store 的活动数据源切到某个作用域并重绘（契约 §2.2：activityDoc 由指针决定）。
     * 切换失败不抛：调用方（引擎/会话流程）要能继续走完并如实告知用户。
     * @returns {{ok:boolean, code?:string, id?:string}}
     */
    function switchStoreScope(scopeId, uid) {
      if (uid) store.setSessionUid(uid);
      var r = store.switchScope(scopeId, uid ? { sessionUid: uid } : undefined);
      if (r && r.ok) {
        onDataChanged();
        if (syncSectionInst && typeof syncSectionInst.render === 'function') {
          try { syncSectionInst.render(); } catch (e) { /* 面板已关闭 */ }
        }
      }
      return r || { ok: false, code: 'E_SCOPE_SWITCH' };
    }

    /**
     * 确认成功后的切源（Q-29）。引擎只负责写指针；不在这里切 Store 的话，
     * 界面会继续写游客键：账号副本零更新，下一次推送还会把游客内容推到云端 uid 行。
     * 这是「数据看着在、其实落错地方」那类最难查的缺陷，所以切源失败必须显式告警，
     * 不能让用户以为一切正常继续编辑。
     */
    function onScopeChangedFromSync(scopeId) {
      var uid = null;
      try {
        var s = syncWiring && typeof syncWiring.getSession === 'function' ? syncWiring.getSession() : null;
        uid = s && typeof s.getUserId === 'function' ? s.getUserId() : null;
      } catch (e) { uid = null; }
      var r = switchStoreScope(scopeId, uid);
      if (r.ok) {
        /* D11（2026-10-27）：登录切源后同样按新作用域文档重建完成台，
           否则上一作用域（guest）的台内条目会残留在界面上。 */
        syncDockFromDoc(store.getState());
      }
      if (!r.ok) {
        warn('danger',
          '同步已完成，但界面没能切换到账号数据（' + (r.code || '未知原因') + '）。'
          + '先不要继续编辑——接下来的改动可能落到游客数据里。请刷新页面后重试。',
          [{ label: '重新加载', onClick: function () { if (root.location) root.location.reload(); } }]);
      }
      return r;
    }

    /** D9：文档被同步路径替换后，完成台按 doc.finishDock 整体重建（幂等，一致时跳过）。 */
    function syncDockFromDoc(doc) {
      try {
        var dv = instances.day;
        var d = dv && typeof dv.finishDock === 'function' ? dv.finishDock() : null;
        if (d && typeof d.replace === 'function' && doc && Array.isArray(doc.finishDock)) {
          d.replace(doc.finishDock);
        }
      } catch (e) { /* 非关键状态：重建失败不影响文档应用 */ }
    }

    function buildSyncWiring() {
      var cfg = root.DAYPLAN_SYNC && typeof root.DAYPLAN_SYNC === 'object' ? root.DAYPLAN_SYNC : {};
      var mode = cfg.mode === 'mock' || cfg.mode === 'real' ? cfg.mode : 'off';
      var config = cfg.config;
      if (mode === 'real' && !config) {
        /* 兜底：调用方只给了 mode 没带 config 时，从连接记录补齐。
           「点过连接」本身就是 opt-in 记录（见下方 off 分支同款逻辑）。 */
        var savedConn = readConn();
        if (savedConn) config = savedConn;
      }
      if (mode === 'off') {
        // 没有显式指定模式时，看是否连接过真实项目。连接过就进 real ——
        // 「点过连接」本身就是 opt-in 记录，不需要再让用户每次手动开。
        var conn = readConn();
        if (conn) {
          mode = 'real';
          config = conn;
        }
      }
      if (mode === 'off') { teardownSteady(); syncWiring = null; return null; }
      // 重建 wiring 意味着旧的 engine 作废，挂在它上面的 steady 必须一起拆掉
      teardownSteady();
      try {
        syncWiring = root.DayPlan.syncWiring.createWiring({
          mode: mode,
          storage: store.getStorage(),
          getLocalDoc: function () { return store.getState(); },
          setLocalDoc: function (doc) { store.mutate(function () { return doc; }); syncDockFromDoc(doc); },
          config: config,
          demoUid: cfg.demoUid,
          fetchImpl: cfg.fetchImpl,
          /* 只有 real 模式由这里接管切源：mock 的 kv 是内存（persistMock 关闭时），
             指针与账号副本都在内存里，而 Store 读的是真 storage——接上去会让界面
             切到一份并不存在的账号副本。mock 走引擎原来的单文档替换路径。 */
          onScopeChanged: mode === 'real' ? onScopeChangedFromSync : undefined,
          /* 四象限拉取会把账号副本换掉。只有界面**正停在这个账号**时才换内容；
             指针还是 guest 时什么都不做——那时必须继续显示游客数据（§4.6.6）。 */
          onDocApplied: mode === 'real' ? function (scopeId, doc) {
            if (store.getScopeId() === scopeId) {
              store.mutate(function () { return doc; });
              /* D9（2026-10-27）：远端文档可能带来新的完成台快照——整体重建台内条目。 */
              syncDockFromDoc(doc);
            }
          } : undefined
        });
      } catch (e) {
        syncWiring = null;
        warn('danger',
          '同步未能启用：' + (e && e.message ? e.message : '未知错误') +
          (e && e.code ? '（' + e.code + '）' : ''),
          [{ label: '我知道了', onClick: function () { /* 仅关闭 */ } }]);
      }
      return syncWiring;
    }

    buildSyncWiring();

    /* ---------------- 稳态同步（首次同步之后的持续推送/拉取） ----------------
       steady 只在引擎进入 syncing 后才真正工作：它订阅 store，数据一变就防抖推一次；
       切回页面时拉一次。checking / paused-error 下一律不发请求。 */
    var syncSteady = null;
    var syncSectionInst = null;   // 设置页「同步」分组的实例，用于状态实时重渲染
    var lastSyncStatus = null;    // steady 被拆掉后仍要能显示"最后一次同步结果"
    var conflictNotified = false; // 冲突横幅每条会话只弹一次，避免连续编辑刷屏

    function teardownSteady() {
      if (syncSteady) {
        syncSteady.dispose();
        syncSteady = null;
      }
    }

    function attachSteady() {
      teardownSteady();
      conflictNotified = false;   // 新会话允许再提示一次冲突
      if (!syncWiring) return null;
      var mod = root.DayPlan && root.DayPlan.syncSteady;
      if (!mod || typeof mod.createSteady !== 'function') return null;
      var engine = null;
      try { engine = syncWiring.getEngine(); } catch (e) { engine = null; }
      if (!engine || typeof engine.push !== 'function') return null;
      try {
        syncSteady = mod.createSteady({
          engine: engine,
          subscribe: function (fn) { return store.subscribe(fn); },
          onStatus: function (st) {
            lastSyncStatus = st;
            // 推送是异步完成的：面板若开着，必须重渲染，否则用户看到的永远是打开那一刻的旧状态
            if (syncSectionInst && typeof syncSectionInst.render === 'function') {
              try { syncSectionInst.render(); } catch (e) { /* 面板已关闭 */ }
            }
            /* 冲突是唯一一种「用户必须立刻知道」的失败：引擎会转 paused-error，
               steady 从此不再推送，本机继续编辑也上不了云。不弹一次提示，
               用户会以为一切正常，直到换设备才发现数据没过去。 */
            if (st && st.kind === 'push' && st.ok === false && st.code === 'E_CONFLICT'
                && !conflictNotified) {
              conflictNotified = true;
              warn('danger',
                '云端已被另一台设备改过，这次的改动没有上传（你的数据都还在本机，没有被覆盖）。'
                + '请到「同步」里点「开始检查」，选择保留哪一边。',
                [
                  { label: '去同步设置', onClick: function () { SettingsView.openSettings(settingsOpts); } },
                  { label: '稍后再说', onClick: function () { /* 仅关闭 */ } }
                ]);
            }
          }
        });
      } catch (e) {
        syncSteady = null;
      }
      return syncSteady;
    }

    /* ---------------- D17：启动/登录路径的自动恢复 ----------------
       resume 判成 recovery（记录丢失）/ lossy 时，走与同步面板完全同款的自动路径
       （备份尽力而为 → 以云端为准 → 需要时写回）。成功后引擎回到 syncing，
       这里负责把稳态同步重新挂上。 */

    function autoResumeHelpers() {
      var dl = SettingsView && typeof SettingsView.downloadJson === 'function'
        ? SettingsView.downloadJson : null;
      return {
        /* 静默备份：尽力而为，失败不阻塞自动恢复（D16 口径）。 */
        exportBackup: function () {
          try {
            var payload = store.exportDocument();
            var name = 'dayplan-同步前备份-' + D.todayISO().replace(/-/g, '') + '-'
              + new Date().toTimeString().slice(0, 5).replace(':', '') + '.json';
            if (dl) dl(name, payload);
          } catch (e) { /* 备份失败不阻塞 */ }
        },
        downloadJson: dl,
        /* 会话没变（登录态不变），数据刷新由引擎 onDocApplied 钩子负责。 */
        onSessionChanged: function () { /* 无需处理 */ },
        onDataChanged: function () { /* 无需处理 */ }
      };
    }

    function afterAutoResume() {
      var eng = syncWiring && typeof syncWiring.getEngine === 'function' ? syncWiring.getEngine() : null;
      var st = eng && typeof eng.getState === 'function' ? eng.getState() : null;
      if (st === 'syncing') {
        attachSteady();
        if (syncSteady) syncSteady.schedule();
      }
      if (syncSectionInst && typeof syncSectionInst.render === 'function') {
        try { syncSectionInst.render(); } catch (e) { /* 面板未打开 */ }
      }
    }

    function autoResumeRecovery() {
      var Panel = root.DayPlan && root.DayPlan.syncPanel;
      if (!Panel || typeof Panel.autoRecoveryRemote !== 'function' || !syncWiring) return;
      Panel.autoRecoveryRemote(syncWiring, autoResumeHelpers(), afterAutoResume);
    }

    function autoResumeLossy() {
      var Panel = root.DayPlan && root.DayPlan.syncPanel;
      if (!Panel || typeof Panel.autoLossyApply !== 'function' || !syncWiring) return;
      Panel.autoLossyApply(syncWiring, autoResumeHelpers(), afterAutoResume);
    }

    /**
     * 登录 / 刷新后的四象限（契约 §1.9、§4.6）。
     *
     * 引擎只把状态从 `checking` 推进到某个确定值，**界面怎么表现由这里决定**：
     *   none / pulled / pushed → 挂上稳态同步（此时才允许推送）
     *   conflict               → 停下来让用户选，绝不自动合并或覆盖
     *   paused-error 等        → 不挂稳态，面板显示错误与重试入口
     *
     * 为什么不能一口气进 syncing：那样会跳过「本地改没改 × 远端变没变」，
     * 两端都改过时先推的一方必然撞一次 E_CONFLICT（Q-28）。
     */
    function resumeSync() {
      if (!syncWiring || typeof syncWiring.resume !== 'function') return Promise.resolve(null);
      var p = Promise.resolve(syncWiring.resume());
      p.then(function (r) {
        if (!r) return;
        if (r.ok && (r.action === 'none' || r.action === 'pulled' || r.action === 'pushed')) {
          attachSteady();
          if (r.action === 'pulled') M.toast('云端有更新，已下载到本机');
          return;
        }
        if (r.action === 'conflict') {
          warn('danger',
            '本机和云端都改过，这次没有自动合并。请到「同步」里点「开始检查」，选择保留哪一边。',
            [
              { label: '去同步设置', onClick: function () { SettingsView.openSettings(settingsOpts); } },
              { label: '稍后再说', onClick: function () { /* 仅关闭 */ } }
            ]);
          return;
        }
        /* 记录丢失/损坏，或云端行已经不在了。D17（2026-10-28）：
           - 本机同步记录丢失（recovery）→ 按 D16 裁定「记录丢失时默认以云端为准」
             直接自动恢复，不再弹红色横幅等人点（弹窗路径与面板同款）；
           - remote-missing（云端被另一台设备删掉）→ 不自动：自动重建会违背删除意图，
             仍用横幅说明并让用户到「同步」里决定。 */
        if (r.action === 'recovery') {
          if (r.kind === 'remote-missing') {
            warn('danger',
              '云端已经没有这个账号的数据了（可能是在别的设备上删掉了）。本机这一份还在，'
              + '这次没有自动上传。请到「同步」里决定是否重新上传。',
              [
                { label: '去同步设置', onClick: function () { SettingsView.openSettings(settingsOpts); } },
                { label: '稍后再说', onClick: function () { /* 仅关闭 */ } }
              ]);
            return;
          }
          teardownSteady();
          autoResumeRecovery();
          return;
        }
        /* 租约被另一个标签页占着（§5.4）：这次没有上传，但同步是开着的，
           改动仍在本地。挂上稳态并立刻排一次重试——不排的话，这次改动要等到
           用户下一次编辑才会被推上去。用 toast 而不是横幅：它会自愈，不值得占一条警告。 */
        if (r.action === 'leased') {
          attachSteady();
          if (syncSteady) syncSteady.schedule();
          M.toast('另一个标签页正在同步，这次改动稍后自动重试');
          return;
        }
        /* 有损修复（§1.8）：D17（2026-10-28）——按 D16 裁定「记录丢失时默认以云端为准」，
           启动/登录路径判到 lossy 时同样**自动应用修复并写回**（先静默备份，尽力而为），
           不再弹红色横幅停下。修复失败时 toast 说明，面板「继续选择」仍是兜底出口。 */
        if (r.action === 'lossy') {
          teardownSteady();
          autoResumeLossy();
          return;
        }
        /* 修复结果还没写回云端：不稳态同步 = 不上传，这是对的。提示一次即可。 */
        if (r.action === 'lossy-push-pending') {
          teardownSteady();
          return;
        }
        /* 关闭同步期间攒下的改动，重新开启时要先问（§4.5.3）。面板会摆出确认框，
           这里只负责别把稳态挂上去。 */
        if (r.action === 'upload-confirm') {
          teardownSteady();
          return;
        }
        /* paused-error：不挂 steady。错误文案与重试入口由同步面板显示，
           这里不再弹第二个横幅，避免一个失败刷两条提示。 */
      }, function () { /* 静默：启动不该被同步拖住 */ });
      return p;
    }

    // 切回页面就拉一次：别的设备可能已经改过。失败静默，不弹窗。
    if (root.document && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('visibilitychange', function () {
        if (!syncSteady || root.document.visibilityState !== 'visible') return;
        syncSteady.pullNow();
      });
    }
    if (root.addEventListener) {
      root.addEventListener('focus', function () {
        if (syncSteady) syncSteady.pullNow();
      });
    }

    /* ---------------- 租约续期与释放（契约 §5.4） ----------------
       引擎只在「云端写之前」懒续期（在那里续期才有意义）；页面长时间不写就没人续，
       于是 30s 后自然过期。这一层补上「持有期间每 10s 续一次」，并在页面隐藏时跳过
       （§5.4：页面隐藏时停止续期）、页面卸载时释放。 */
    function currentLease() {
      if (!syncWiring || typeof syncWiring.getLease !== 'function') return null;
      try { return syncWiring.getLease(); } catch (e) { return null; }
    }

    if (root.setInterval) {
      var leaseTick = root.setInterval(function () {
        if (root.document && root.document.visibilityState === 'hidden') return;
        var l = currentLease();
        if (!l || typeof l.renewIfNeeded !== 'function') return;
        try { l.renewIfNeeded(); } catch (e) { /* 续不上就等过期，正确性不依赖它 */ }
      }, 10000);
      if (leaseTick && typeof leaseTick.unref === 'function') leaseTick.unref();
    }

    root.addEventListener('pagehide', function () {
      var l = currentLease();
      if (l && typeof l.release === 'function') {
        try { l.release(); } catch (e) { /* 卸载路径不抛 */ }
      }
    });

    // 恢复上次的登录态。失败（无凭据 / 过期 / 网断）一律静默回到未登录，
    // 不打扰启动：同步是可选功能，启动不该被它拦住。
    if (syncWiring && typeof syncWiring.restore === 'function') {
      Promise.resolve(syncWiring.restore()).then(function (r) {
        if (r && r.ok) {
          if (r.uid) store.setSessionUid(r.uid);
          /* 有有效 active 记录时引擎停在 checking（Q-28）：先按四象限判定，
             判完再决定挂不挂稳态。直接 attachSteady 会让 steady 在
             checking 下空转，界面停在「正在检查」再也不动。 */
          if (r.needsCheck) {
            resumeSync();
          } else if (r.bootKind === 'blocked') {
            /* 记录形状无法判定：面板负责说明与出口，不挂稳态（挂了也只会在
               第一次推送时得到一个 E_BAD_STATE，徒增一条看不懂的错误）。 */
          } else {
            attachSteady();
          }
          return;
        }
        /* 凭据不可用 = 没有会话：契约 §2.2 要求指针回落 guest 并写回。
           Store 启动时按「窥探到的 uid」进了账号作用域，这里必须纠正——
           否则未登录的页面会继续往某个账号的副本里写。 */
        store.setSessionUid(null);
        if (store.getScopeId() !== 'guest') switchStoreScope('guest');
      }, function () {
        store.setSessionUid(null);
        if (store.getScopeId() !== 'guest') switchStoreScope('guest');
      });
    }


    /* ---------------- 全局设置入口（迭代 4：侧栏月历已删除，见 S26 / ADR-26） ---------------- */

    settingsOpts = {
      store: store,
      onDataChanged: onDataChanged,
      getWiring: function () { return syncWiring; },
      getConn: function () { return readConn(); },
      /* 面板的「登录并同步」：没连过自己项目时，用内置默认项目直接登录，
         不再要求用户理解 URL / key（2026-10-27 所有者口径）。 */
      getDefaultConn: function () { return DEFAULT_SYNC_CONN; },
      /* 设置页读状态用。steady 被拆掉（退出登录）后回退到内存里最后一次结果，
         免得刚退出就看到「还没有同步动作」这种误导性文案。 */
      getSteady: function () {
        if (syncSteady) return syncSteady;
        return {
          getStatus: function () { return lastSyncStatus; },
          pushNow: null,
          pullNow: null
        };
      },
      registerSyncSection: function (inst) { syncSectionInst = inst; },
      /* D12（2026-10-27）：onSyncStopped 钩子已随「关闭同步」按钮一并移除——
         面板不再有停用同步的入口，稳态只由 onDataCleared / onSessionChanged 摘除。 */
      /* 清空本机之后（T-R03）：清空只影响当前作用域，云端那份还在。
         停同步是必须的——否则下一次编辑会走 push()，把空文档推上云端。 */
      onDataCleared: function () {
        teardownSteady();
        lastSyncStatus = null;
        if (!syncWiring || typeof syncWiring.noteLocalCleared !== 'function') return;
        Promise.resolve(syncWiring.noteLocalCleared()).then(function () {}, function () {});
      },
      /* 登录/退出成功后由面板通知：登录后要挂上稳态同步，退出后必须摘掉。
         同时把会话交给 Store——账号作用域的闸门认的是「当前会话」，
         而 Store 创建时拿到的只是启动那一刻的快照。 */
      onSessionChanged: function (signedIn) {
        var uid = null;
        try {
          uid = (syncWiring && typeof syncWiring.describe === 'function') ? syncWiring.describe().uid : null;
        } catch (e) { uid = null; }
        store.setSessionUid(signedIn ? uid : null);
        if (signedIn) {
          /* 登录只建立会话（§4.6）。本机若有该账号的有效 active 记录，
             必须先走四象限，不能直接开始推送。记录丢失/损坏时同样停在
             checking，由 resumeSync 转成恢复流程。 */
          var needsCheck = false;
          var bootKind = null;
          try {
            var eng = syncWiring && typeof syncWiring.getEngine === 'function' ? syncWiring.getEngine() : null;
            needsCheck = !!eng && eng.getState() === 'checking';
            var boot = eng && typeof eng.getBoot === 'function' ? eng.getBoot() : null;
            bootKind = boot ? boot.kind : null;
          } catch (e) { needsCheck = false; }
          if (needsCheck) {
            resumeSync();
          } else if (bootKind === 'blocked') {
            /* 与启动恢复同款：面板负责说明，不挂稳态。 */
          } else {
            attachSteady();
          }
        } else {
          teardownSteady();
          /* 退出登录 → 活动数据源回 guest（契约 §2.2）。不切的话，界面继续写
             账号副本：用户以为在看本机数据，实际改的是一个已登出账号的副本，
             而且这些改动在下次登录前不会被推送。 */
          if (store.getScopeId() !== 'guest') switchStoreScope('guest');
          /* D11（2026-10-27）：完成台条目属于文档数据（finishDock 随作用域走）。
             退出后不重建的话，账号的台内条目（含运行中的计时）会留在界面上，
             甚至被 persist 写进 guest 文档——跨账号串数据。以 guest 文档为准重建。 */
          syncDockFromDoc(store.getState());
        }
      },
      onConnectReal: function (conn) {
        writeConn(conn);
        /* config 必须一起带上：buildSyncWiring 的 real 分支直接用 cfg.config，
           只给 mode 不给 config，createWiring 会抛 E_NOT_CONFIGURED，
           wiring 建不出来 → 面板渲染回「本机模式」，用户连接成功却看不到登录入口
           （2026-10-26 e2e 实测抓到，.probe/debug-connect2.cjs）。 */
        root.DAYPLAN_SYNC = { mode: 'real', config: conn };
        buildSyncWiring();
        return syncWiring;
      },
      onEnableDemoSync: function () {
        root.DAYPLAN_SYNC = { mode: 'mock' };
        buildSyncWiring();
      },
      onDisableDemoSync: function () {
        root.DAYPLAN_SYNC = { mode: 'off' };
        buildSyncWiring();
      },
      /* 2026-10-22 二十三轮：响铃开关移入设置后，立即同步到已创建的完成台实例。 */
      onFinishSoundChange: function (on) {
        var dv = instances.day;
        var d = dv && typeof dv.finishDock === 'function' ? dv.finishDock() : null;
        if (d && typeof d.setSound === 'function') d.setSound(on);
      }
    };

    /* ---------------- 迭代 7（F-47 / R-31）：把节假日判定注入重复引擎 ----------------
     * core/recurrence.js 不直接依赖 src/data/，由引导层注入；失败时该规则静默不生效。 */
    function wireHolidayResolver() {
      var R = root.DayPlan.recurrence;
      var H = root.DayPlan.holidays;
      if (!R || typeof R.setHolidayResolver !== 'function') return;
      if (!H || typeof H.holidayOf !== 'function') { R.setHolidayResolver(null); return; }
      R.setHolidayResolver(function (iso) {
        var rec = H.holidayOf(iso);
        return !!rec && rec.type === 'holiday'; // R-29：只排除法定放假日，补班日不算
      });
    }

    /* ---------------- 顶栏 ---------------- */

    function refreshTodayChip() {
      if (!els.todayChip) return;
      var txt = D.formatDateCN(D.todayISO());
      var holidayName = '';
      var H = root.DayPlan.holidays;
      if (H && H.holidayOf) {
        var h = H.holidayOf(D.todayISO());
        if (h) holidayName = ' · ' + (h.type === 'workday' ? '班 ' : '休 ') + h.name;
      }
      els.todayChip.textContent = txt + holidayName;
    }

    /* 2026-10-22 二十六轮（用户反馈）：节假日数据缺口的说明不再顶在页面顶端，
       改为放进「关于」；口径仍是 BR-23 —— 不推算、只诚实说明。 */
    function holidayGapNote() {
      var H = root.DayPlan.holidays;
      if (!H || !H.missingYears) return '';
      var years;
      try { years = H.missingYears('2008-01-01', '2027-12-31'); } catch (e) { return ''; }
      if (!years || !years.length) return '';
      return '未收录 ' + years.join('、') + ' 年节假日数据（国务院尚未公布），这些年份不做标注、也不推算。';
    }

    if (els.settingsBtn) {
      els.settingsBtn.addEventListener('click', function () {
        SettingsView.openSettings(settingsOpts);
      });
    }

    /* 2026-10-22 二十三轮（用户反馈）：DayPlan 品牌块点击 → 居中「关于」；
       二十六轮起把节假日数据缺口说明放进正文（内容仍待用户补充）。 */
    var brandBtn = document.getElementById('brand-about');
    if (brandBtn) {
      brandBtn.addEventListener('click', function () {
        var aboutBody = M.el('div', { class: 'about-body', id: 'about-content' });
        var note = holidayGapNote();
        if (note) aboutBody.appendChild(M.el('p', { class: 'about-note', text: note }));
        M.open({
          title: '关于 DayPlan',
          body: aboutBody,
          showSubmit: false,
          center: true
        });
      });
    }

    /* 迭代 10 批次 2（条6）：分段控件白块拖动。
       - 白块（.view-switch-thumb）跟手移动，拖动中不高亮目标档；
       - 松手按指针位置落到最近一档（无布局信息的环境按方向切相邻一档）；
       - 位移 < 4px 视为点击，沿用原有 click 行为（点击切档不回归）。 */
    var viewThumbSync = null;
    var suppressSwitchClick = false;

    function setupViewSwitchThumb() {
      var sw = els.viewSwitch;
      if (!sw || typeof document.createElement !== 'function') return;
      var thumb = document.createElement('span');
      thumb.className = 'view-switch-thumb';
      thumb.setAttribute('aria-hidden', 'true');

      var drag = null;

      function buttons() {
        return Array.prototype.slice.call(sw.querySelectorAll('[data-view]'));
      }
      function activeIndex() {
        var list = buttons();
        var active = activeViewKey();
        for (var i = 0; i < list.length; i += 1) {
          if (list[i].getAttribute('data-view') === active) return i;
        }
        return 0;
      }
      function rectOf(node) {
        if (!node || typeof node.getBoundingClientRect !== 'function') return null;
        var r = node.getBoundingClientRect();
        return (r && r.width > 0) ? r : null;   /* 垫片环境无布局 → null，退回纯点击 */
      }
      function paint(btn) {
        var r = rectOf(btn);
        var sr = rectOf(sw);
        if (!r || !sr) return false;
        thumb.style.width = r.width + 'px';
        thumb.style.height = r.height + 'px';
        thumb.style.transform = 'translate(' + (r.left - sr.left) + 'px,' + (r.top - sr.top) + 'px)';
        sw.classList.add('has-thumb');
        return true;
      }
      function sync() { paint(buttons()[activeIndex()]); }

      sw.appendChild(thumb);
      /* 首次定位不做补间（避免加载时白块从 0 尺寸展开） */
      thumb.style.transition = 'none';
      viewThumbSync = sync;
      sync();
      if (typeof root.requestAnimationFrame === 'function') {
        root.requestAnimationFrame(function () { thumb.style.transition = ''; });
      }

      sw.addEventListener('pointerdown', function (e) {
        if (!e || (typeof e.button === 'number' && e.button !== 0)) return;
        var list = buttons();
        var idx = activeIndex();
        var r = rectOf(list[idx]);
        var sr = rectOf(sw);
        if (!r || !sr) return;
        drag = {
          pointerId: e.pointerId,
          startX: Number(e.clientX),
          baseLeft: r.left - sr.left,
          baseTop: r.top - sr.top,
          width: r.width,
          from: idx,
          moved: false,
          captured: false
        };
        thumb.classList.add('is-dragging');
        /* 迭代 10 批次 3 反馈（保留点击）：**不要**在 pointerdown 里立刻 setPointerCapture。
           指针被容器捕获后，pointerup / 随后的 click 目标会变成容器本身，
           e.target.closest('[data-view]') 拿不到按钮 → 点击切档失效。
           改为首次真正拖动（|dx| > 4）时才捕获，纯点击全程不捕获。 */
      });

      sw.addEventListener('pointermove', function (e) {
        if (!drag || !e) return;
        var x = Number(e.clientX);
        if (!isFinite(x)) return;
        var dx = x - drag.startX;
        if (!drag.moved && Math.abs(dx) > 4) {
          drag.moved = true;
          /* 确认是拖动后才捕获指针，保证拖出容器也能收到 pointerup */
          if (drag.pointerId !== undefined && typeof sw.setPointerCapture === 'function') {
            try { sw.setPointerCapture(drag.pointerId); drag.captured = true; } catch (err) { /* 忽略 */ }
          }
        }
        var sr = rectOf(sw);
        var maxLeft = sr ? Math.max(0, sr.width - drag.width) : drag.baseLeft;
        var left = Math.max(0, Math.min(maxLeft, drag.baseLeft + dx));
        thumb.style.transform = 'translate(' + left + 'px,' + drag.baseTop + 'px)';
      });

      function endDrag(e, cancelled) {
        if (!drag) return;
        var info = drag;
        drag = null;
        thumb.classList.remove('is-dragging');
        if (info.captured && info.pointerId !== undefined && typeof sw.releasePointerCapture === 'function') {
          try { sw.releasePointerCapture(info.pointerId); } catch (err) { /* 忽略 */ }
        }
        if (cancelled || !info.moved) { sync(); return; }
        var list = buttons();
        var target = info.from;
        var hasLayout = false;
        var x = Number(e && e.clientX);
        if (isFinite(x)) {
          var best = Infinity;
          for (var i = 0; i < list.length; i += 1) {
            var r = rectOf(list[i]);
            if (!r) continue;
            hasLayout = true;
            var center = r.left + r.width / 2;
            var d = Math.abs(x - center);
            if (d < best) { best = d; target = i; }
          }
        }
        if (!hasLayout) {
          /* 无布局（Node 垫片）：按拖动方向切相邻一档，保证拖拽逻辑可被回归测试覆盖 */
          target = Math.max(0, Math.min(list.length - 1, info.from + ((x >= info.startX) ? 1 : -1)));
        }
        if (target !== info.from && list[target]) {
          /* 拖动会切档，浏览器仍可能补发一次 click。**不用时间窗抑制**（那会吞掉用户
             紧接着的真心点击），改为在 click 里按目标判定：目标不是按钮（被指针捕获
             重定向到容器）才忽略，落在按钮上就视为真实点击、照常切档。 */
          suppressSwitchClick = true;
          selectSwitchKey(list[target].getAttribute('data-view'));
        }
        sync();
      }
      sw.addEventListener('pointerup', function (e) { endDrag(e, false); });
      sw.addEventListener('pointercancel', function (e) { endDrag(e, true); });

      if (typeof root.addEventListener === 'function') root.addEventListener('resize', sync);
    }

    if (els.viewSwitch) {
      setupViewSwitchThumb();
      els.viewSwitch.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-view]') : null;
        if (suppressSwitchClick) {
          suppressSwitchClick = false;
          /* 无按钮 = 拖动后指针捕获把 click 目标改到了容器，忽略这一次；
             有按钮 = 用户真心点击（或补发 click 正落在目标档上），照常放行。
             重复切到同一档是幂等的，不会错档。 */
          if (!btn) return;
        }
        if (!btn) return;
        selectSwitchKey(btn.getAttribute('data-view'));
      });
    }

    /* ---------------- 全局快捷键 ---------------- */

    document.addEventListener('keydown', function (e) {
      if (document.querySelector('.modal-backdrop')) return;
      var t = e.target;
      var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable);
      if (typing) return;

      var dv = dayView();
      switch (e.key) {
        case 'ArrowLeft':
          if (e.altKey) { moveSelected(-1); } else { shiftViewDate(-1); }
          e.preventDefault();
          break;
        case 'ArrowRight':
          if (e.altKey) { moveSelected(1); } else { shiftViewDate(1); }
          e.preventDefault();
          break;
        case 'ArrowUp':
          if (e.altKey) { moveSelected(-1); } else { shiftViewDate(-7); }
          e.preventDefault();
          break;
        case 'ArrowDown':
          if (e.altKey) { moveSelected(1); } else { shiftViewDate(7); }
          e.preventDefault();
          break;
        case 'PageUp':
        case 'PageDown':
          /* 迭代 4（BR-31）：迷你月历删除后，PageUp/Down 直接驱动共享视图日期 ±1 月 */
          if (state.viewMode === 'month' && instances.month && instances.month.navigate) {
            instances.month.navigate(e.key === 'PageUp' ? -1 : 1);
          } else {
            setViewDate(D.addMonths(state.viewDate, e.key === 'PageUp' ? -1 : 1));
          }
          e.preventDefault();
          break;
        case '[':
          shiftViewDate(-1); e.preventDefault(); break;
        case ']':
          shiftViewDate(1); e.preventDefault(); break;
        case 't': case 'T':
          setViewDate(D.todayISO());
          e.preventDefault();
          break;
        case 'n': case 'N':
          if (state.viewMode === 'week') {
            if (weekView() && instances.week.openNewWeekPlan) instances.week.openNewWeekPlan();
          } else if (dv) {
            dv.openEdit(null);
          }
          e.preventDefault();
          break;
        case 'm': case 'M':
          /* 年视图里按 M = 月段：走 selectSwitchKey，让选中月居中放大而不是跳回今天 */
          selectSwitchKey('month'); e.preventDefault(); break;
        case 'w': case 'W':
          setViewMode('week', { animate: true }); e.preventDefault(); break;
        case 'd': case 'D':
          setViewMode('day', { animate: true }); e.preventDefault(); break;
        default:
          break;
      }
    });

    /** 当前模式下「前后一天/一周」的主键移动。 */
    function shiftViewDate(days) {
      if (state.viewMode === 'week' && instances.week && instances.week.shiftWeek) {
        instances.week.shiftWeek(days / 7);
        return;
      }
      // 日视图与月视图都按自然日推进（月视图用 ↑↓ 时 days = ±7）
      var dir = days < 0 ? -1 : (days > 0 ? 1 : 0);
      /* 四十轮（用户口径）：键盘切日期与点前后按钮同一套左右滑入。 */
      setViewDate(D.addDays(state.viewDate, days),
        (state.viewMode === 'day' && dir) ? { slide: dir } : null);
    }

    /** Alt+↑/↓：调整当前日期下第一个（或末尾）无时事项次序。 */
    function moveSelected(delta) {
      var doc = store.getState();
      var date = state.viewDate;
      var untimed = doc.items.filter(function (it) {
        if (it.time) return false;
        if (it.kind === 'single') return it.date === date;
        return it.repeat && it.repeat.startDate === date;
      });
      if (!untimed.length) return;
      untimed.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      var target = untimed[delta > 0 ? 0 : untimed.length - 1];
      try {
        store.moveItemOrder(date, target.id, delta);
        onDataChanged();
      } catch (e) { /* 边界无操作 */ }
    }

    /* ---------------- 存储失败提示 ---------------- */

    function flushEverything() {
      Object.keys(instances).forEach(function (k) {
        var v = instances[k];
        if (v && typeof v.flushNotes === 'function') v.flushNotes();
      });
      store.flush();
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushEverything();
    });
    window.addEventListener('pagehide', flushEverything);
    window.addEventListener('beforeunload', function () {
      flushEverything();
      store.saveNow();
    });

    // 契约 §5.2 检测点 2：其他标签页改动了当前数据键 → 立即暂停本页写入，
    // 避免用本页的旧快照覆盖对方。
    // 只停本地是不够的：§5.2「冲突处理」第 3 条要求**同步同时保持 paused-error**。
    // 只停本地、不停同步，会得到最坏的一种组合——本页不再落盘，却把内存里的旧内容
    // 推上云端，等于用旧快照覆盖了两个标签页的内容。
    var staleBanner = null;

    /** 覆盖 / 重载之前先导出一份（§5.2，导出失败就不做不可逆动作）。 */
    function exportBeforeResolve(prefix) {
      var payload = store.exportDocument();
      var name = prefix + '-' + D.todayISO().replace(/-/g, '') + '-'
        + new Date().toTimeString().slice(0, 5).replace(':', '') + '.json';
      SettingsView.downloadJson(name, payload);
    }

    function pauseSyncForStale() {
      if (!syncWiring || typeof syncWiring.noteLocalStale !== 'function') return;
      try {
        syncWiring.noteLocalStale('其他页面改动了本地数据，同步已暂停');
      } catch (e) { /* 同步层不可用时无所谓：本来就没在同步 */ }
    }

    function showStaleBanner() {
      if (staleBanner) return;   // 一次只摆一条，避免连续编辑把横幅堆成墙
      staleBanner = warn('danger',
        '另一个标签页改动了数据，本页已停止保存与同步（避免互相覆盖）。请选择如何处理：',
        [
          {
            label: '导出后重新加载',
            onClick: function () {
              staleBanner = null;
              var backedUp = true;
              try { exportBeforeResolve('dayplan-冲突前备份'); } catch (e) { backedUp = false; }
              /* 导出失败也要让用户能走：这一项只丢弃本页未落盘的修改，
                 磁盘上那份（对方写的）不会被毁掉。 */
              var r = store.resolveStale('reload');
              if (!r.ok) { showStaleBanner(); M.toast('重新加载失败：' + (r.error || '未知错误')); return; }
              resumeSync();
              M.toast(backedUp ? '已重新载入磁盘上的最新内容' : '已重新载入，但导出失败：本页修改已丢弃');
            }
          },
          {
            label: '用本页覆盖',
            onClick: function () {
              staleBanner = null;
              /* 覆盖会毁掉对方那一份，所以先导出。导出失败就取消覆盖（fail closed）——
                 宁可这次不同步，也不在用户不知情时删数据。 */
              try {
                exportBeforeResolve('dayplan-覆盖前备份');
              } catch (e) {
                showStaleBanner();
                M.toast('导出失败，已取消覆盖');
                return;
              }
              var r = store.resolveStale('overwrite');
              if (!r.ok) { showStaleBanner(); M.toast('覆盖失败：' + (r.error || '未知错误')); return; }
              resumeSync();
              M.toast('已用本页内容覆盖（对方那份已备份到本机存储）');
            }
          },
          {
            label: '暂不处理',
            onClick: function () { staleBanner = null; }   // 允许下一次改动时再提示
          }
        ]);
    }

    function onExternalChange(key) {
      if (!store.noteExternalChange(key)) return;
      pauseSyncForStale();
      showStaleBanner();
    }

    window.addEventListener('storage', function (e) {
      if (e && typeof e.key === 'string') onExternalChange(e.key);
    });

    /* 检测点 3（写后回读不一致）不会触发 storage 事件——它是本页自己写坏的。
       在每次渲染/冲刷之后补一次检查，让两条路径落到同一个处置上。 */
    store.subscribe(function () {
      if (store.isStale() && !staleBanner) {
        pauseSyncForStale();
        showStaleBanner();
      }
    });

    /* ---------------- 初始化渲染 ---------------- */

    refreshTodayChip();
    setViewMode(state.viewMode, { persist: false });

    /* ---------------- 调试入口 ---------------- */

    root.__dayplan = {
      store: store,
      state: state,
      views: instances,
      modules: root.DayPlan,
      setViewMode: setViewMode,
      setViewDate: setViewDate,
      goDay: goDay,
      goWeek: goWeek,
      goMonth: goMonth,
      openSettings: function () { SettingsView.openSettings(settingsOpts); },
      /* 同步线的只读快照：排障时最想知道的是「引擎停在哪一步」，
         而它不在 DOM 里（状态行只显示一部分）。只读，不提供任何写入口。 */
      sync: function () {
        if (!syncWiring) return { mode: 'off', engineState: null, uid: null, error: null, steady: false };
        var d = null;
        try { d = syncWiring.describe(); } catch (e) { d = null; }
        return {
          mode: d && d.mode,
          uid: d && d.uid,
          sessionState: d && d.sessionState,
          engineState: d && d.engineState,
          bootKind: d && d.bootKind,
          /* 租约（§5.4）。多标签问题在界面上几乎不可见，
             排障时必须能一眼看出「本页到底有没有拿着租约、被谁挡着」。 */
          lease: (d && d.lease) || null,
          error: d && d.error,
          steady: !!syncSteady
        };
      }
    };

    // 暴露后续可观测的错误
    setInterval(function () {
      var err = store.getLastError && store.getLastError();
      if (err && err.code === 'E_QUOTA') {
        var node = warn('danger', '保存失败：浏览器存储空间不足。请导出备份后清理。', []);
        if (node) node.dataset.once = '1';
      }
    }, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
