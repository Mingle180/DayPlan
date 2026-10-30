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
   * session / auth 需要 { get, set, remove } 形状的 KV；Store 的 storage 是
   * getItem / setItem / removeItem。这一层只做形状转换，不做任何业务判断。
   */
  function storageKv(storage) {
    if (!storage) return null;
    return {
      get: function (k) { try { return storage.getItem(k); } catch (e) { return null; } },
      set: function (k, v) { try { storage.setItem(k, v); } catch (e) { /* 写不进去等同于未登录 */ } },
      remove: function (k) { try { storage.removeItem(k); } catch (e) { /* 删不掉最多下次再登 */ } }
    };
  }

  /**
   * 启动时窥探持久凭据里的会话 uid（只读：不刷新令牌、不写盘）。
   *
   * Store 创建时要用它解析活动指针。拿不到 uid，`resolveBootScope` 只能按
   * 契约 §2.2 把 `user:<uid>` 回落成 guest 并写回——用户看到的现象是
   * 「刷新一下账号数据就没了」。真正的会话恢复仍然只有 session.restore() 一条路；
   * 它失败时由装配层回落 guest。
   */
  function peekBootSessionUid() {
    var S = root.DayPlan.session;
    if (!S || typeof S.peekPersistedUserId !== 'function') return null;
    var storage = null;
    try { storage = typeof Store.detectLocalStorage === 'function' ? Store.detectLocalStorage() : null; } catch (e) { storage = null; }
    var kv = storageKv(storage);
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
      saveBtn: document.getElementById('btn-cloud-save'),
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

    /* ---------------- 云端（手动保存） ----------------
       契约：docs/spec/18-manual-cloud-save.md。
       本机 300 ms 自动保存照旧；「保存」只负责把当前内容上传成云端最新版本。
       没登录、没点保存就不发写请求；打开页面时最多静默读一次。 */

    var CloudDoc = root.DayPlan.cloudDoc;
    var CloudRecord = root.DayPlan.cloudRecord;
    var CloudVersions = root.DayPlan.cloudVersions;
    var CloudClient = root.DayPlan.cloudClient;
    var CloudAuth = root.DayPlan.cloudAuth;
    var Session = root.DayPlan.session;
    var Supabase = root.DayPlan.supabase;
    var StorageKeys = root.DayPlan.storageKeys;
    var AccountDialogs = root.DayPlan.accountDialogs;

    var CONN_KEY = (StorageKeys && StorageKeys.KEYS && StorageKeys.KEYS.cloudConn) || 'dayplan.cloud.conn.v1';
    var LEGACY_CONN_KEY = (StorageKeys && StorageKeys.KEYS && StorageKeys.KEYS.legacyConn) || 'dayplan.sync.conn.v1';

    /* 默认项目：用户不该被要求理解「Project URL / publishable key」这两个概念。
       publishable key 本就是设计给浏览器的公开值；真正的权限边界在数据库 RLS。 */
    var DEFAULT_CLOUD_CONN = {
      url: 'https://ceqcgiekjrgrtzsxvwpk.supabase.co',
      anonKey: 'sb_publishable_FUQ6sA9gZjcrqdXMuDzifg_T0MfxNjl'
    };

    /* 用户选了「保留本机」、但本机从来没有过云端标记时的占位指纹：
       它保证下次判定仍是 pending（不会被误判 clean 后静默覆盖），同时能记住 declinedRevision。 */
    var DECLINED_HASH = 'declined';

    var cloudSectionInst = null;
    var cloudBusy = false;
    var autoLoadBusy = false;
    var askedRevisions = {};
    var loadRefused = false;
    var lastOpenPassAt = 0;

    function cloudStorage() {
      try { return store.getStorage(); } catch (e) { return null; }
    }

    function readConn() {
      var s = cloudStorage();
      if (!s) return null;
      function probe(key) {
        try {
          var raw = s.getItem(key);
          if (!raw) return null;
          var o = JSON.parse(raw);
          if (!o || typeof o.url !== 'string' || typeof o.anonKey !== 'string') return null;
          if (o.url === '' || o.anonKey === '') return null;
          return { url: o.url, anonKey: o.anonKey };
        } catch (e) { return null; }
      }
      var conn = probe(CONN_KEY);
      if (conn) return conn;
      /* 旧键（实时同步时代）只读一次：读到就迁到新键并删掉，避免两处配置长期并存。 */
      var legacy = probe(LEGACY_CONN_KEY);
      if (legacy) {
        try {
          s.setItem(CONN_KEY, JSON.stringify(legacy));
          s.removeItem(LEGACY_CONN_KEY);
        } catch (e) { /* 迁移失败也照旧用这一份 */ }
        return legacy;
      }
      return null;
    }

    function buildCloudModules() {
      var kv = storageKv(cloudStorage());
      var fetchImpl = typeof root.fetch === 'function'
        ? function (url, init) { return root.fetch(url, init); }
        : null;
      if (!kv || !fetchImpl) return null;
      var config = null;
      try {
        config = Supabase.createConfig(readConn() || DEFAULT_CLOUD_CONN);
      } catch (e) {
        warn('danger', '云端配置不可用：' + (e && e.message ? e.message : '未知错误'),
          [{ label: '我知道了', onClick: function () { /* 仅关闭 */ } }]);
        return null;
      }
      try {
        var session = Session.createSession({
          kv: kv,
          refresh: function (refreshToken) {
            return Supabase.refreshSession({ config: config, fetchImpl: fetchImpl, refreshToken: refreshToken });
          }
        });
        return {
          session: session,
          http: Supabase.createHttp({ config: config, fetchImpl: fetchImpl }),
          auth: CloudAuth.createAuth({
            session: session,
            config: config,
            fetchImpl: fetchImpl,
            kv: cloudStorage()
          })
        };
      } catch (e2) {
        warn('danger', '云端模块初始化失败：' + (e2 && e2.message ? e2.message : '未知错误'),
          [{ label: '我知道了', onClick: function () { /* 仅关闭 */ } }]);
        return null;
      }
    }

    var cloudModules = (CloudDoc && CloudRecord && CloudClient && CloudAuth && Session && Supabase)
      ? buildCloudModules() : null;
    var session = cloudModules ? cloudModules.session : null;
    var http = cloudModules ? cloudModules.http : null;
    var cloudAuth = cloudModules ? cloudModules.auth : null;
    var deviceLabel = CloudRecord && typeof CloudRecord.deviceLabel === 'function'
      ? CloudRecord.deviceLabel(root.navigator ? root.navigator.userAgent : '')
      : '';

    var cloudClient = null;
    var cloudClientUid = null;

    function sessionUserId() {
      if (!session) return null;
      try { return session.getState() === 'signed-in' ? session.getUserId() : null; } catch (e) { return null; }
    }

    function accountScopeId(uid) { return 'user:' + uid; }

    function onAccountScope(uid) { return !!uid && store.getScopeId() === accountScopeId(uid); }

    function markerKey(uid) {
      return (StorageKeys && typeof StorageKeys.cloudRecordKey === 'function')
        ? StorageKeys.cloudRecordKey(uid) : 'dayplan.cloud.v1.' + uid;
    }

    function readMarker(uid) {
      var s = cloudStorage();
      if (!s || !uid) return null;
      try { return CloudRecord.parseRecord(s.getItem(markerKey(uid))); } catch (e) { return null; }
    }

    function writeMarker(uid, record) {
      var s = cloudStorage();
      if (!s || !uid) return;
      var json = CloudRecord.serializeRecord(record);
      if (!json) return;
      try { s.setItem(markerKey(uid), JSON.stringify(json)); } catch (e) { /* 下次多问一次而已 */ }
    }

    function clearMarker(uid) {
      var s = cloudStorage();
      if (!s || !uid) return;
      try { s.removeItem(markerKey(uid)); } catch (e) { /* 删不掉最多多问一次 */ }
    }

    function hashOfDoc(doc) {
      var H = root.DayPlan.docHash;
      if (!H || typeof H.contentHash !== 'function') return '';
      try { return H.contentHash(doc); } catch (e) { return ''; }
    }

    function localHash() { return hashOfDoc(store.getState()); }

    function ensureClient(uid) {
      if (!uid || !http || !session) return null;
      if (cloudClient && cloudClientUid === uid) return cloudClient;
      cloudClientUid = uid;
      cloudClient = CloudClient.createClient({
        http: http,
        uid: uid,
        withToken: function (fn) { return session.withToken(fn); },
        device: deviceLabel
      });
      return cloudClient;
    }

    /** 「保存」二字的颜色就是未保存提示：还没传到云端时变主色蓝，传上去回黑。 */
    function refreshSaveState() {
      if (!els.saveBtn) return;
      var uid = sessionUserId();
      /* 2026-10-30（用户口径）：保存只在登录后出现 —— 游客既没有云端可存，也不该看到一颗死键 */
      els.saveBtn.hidden = !uid;
      var unsaved = false;
      if (uid) {
        unsaved = CloudRecord.classify(readMarker(uid), localHash()) !== CloudRecord.KIND.CLEAN;
      }
      els.saveBtn.classList.toggle('is-unsaved', unsaved);
    }

    function sameContent(before, after) {
      var S = root.DayPlan && root.DayPlan.schema;
      if (!S || typeof S.sameDocumentContent !== 'function') return false;
      try { return S.sameDocumentContent(before, after); } catch (e) { return false; }
    }

    /**
     * 把 Store 的活动数据源切到某个作用域并重绘（契约 §2.2：activityDoc 由指针决定）。
     * 切换失败不抛：调用方要能继续走完并如实告知用户。
     * @returns {{ok:boolean, code?:string, id?:string}}
     */
    function switchStoreScope(scopeId, uid) {
      if (uid) store.setSessionUid(uid);
      var r = store.switchScope(scopeId, uid ? { sessionUid: uid } : undefined);
      if (r && r.ok) {
        onDataChanged();
        refreshSaveState();
        if (cloudSectionInst && typeof cloudSectionInst.render === 'function') {
          try { cloudSectionInst.render(); } catch (e) { /* 面板已关闭 */ }
        }
      }
      return r || { ok: false, code: 'E_SCOPE_SWITCH' };
    }

    /** 完成台条目属于文档数据：整份文档被替换后按 doc.finishDock 重建。 */
    function syncDockFromDoc(doc) {
      try {
        var dv = instances.day;
        var d = dv && typeof dv.finishDock === 'function' ? dv.finishDock() : null;
        if (d && typeof d.replace === 'function' && doc && Array.isArray(doc.finishDock)) {
          d.replace(doc.finishDock);
        }
      } catch (e) { /* 非关键状态：重建失败不影响文档应用 */ }
    }

    /** 云端内容写回内存后必须自己重绘视图（store.mutate 不驱动界面）。 */
    function applyDocFromCloud(doc) {
      var before = store.getState();
      store.mutate(function () { return doc; });
      syncDockFromDoc(doc);
      if (!sameContent(before, store.getState())) onDataChanged();
      refreshSaveState();
    }

    function saveErrorText(r) {
      var code = r && r.code ? r.code : '';
      if (code === 'E_CLOUD_SCHEMA') return r.message;
      if (code === 'E_EXPIRED') return '登录已过期，请重新登录';
      if (code === 'E_NETWORK' || code === 'E_TIMEOUT') return '连不上服务器，保存失败';
      if (code === 'E_CONFLICT') return '云端刚被其它设备保存过，请再点一次保存';
      if (code === 'E_BAD_ROW') return '云端数据无法识别，已停止覆盖';
      return '保存失败：' + ((r && r.message) || '未知错误');
    }

    function setSaveBusy(on) {
      if (!els.saveBtn) return;
      els.saveBtn.disabled = !!on;
      if (on) els.saveBtn.classList.add('is-busy');
      else els.saveBtn.classList.remove('is-busy');
    }

    /** §3：保存只做一件事——把本机当前内容上传成云端最新版本。 */
    function saveToCloud() {
      if (cloudBusy) return;
      var uid = sessionUserId();
      if (!uid) { M.toast('登录后才能保存到云端'); return; }
      if (!onAccountScope(uid)) { M.toast('账号数据还没载入，请稍后再试'); return; }
      var client = ensureClient(uid);
      if (!client) { M.toast('当前环境不支持云端保存'); return; }

      /* §7：本页被标记陈旧（另一个标签页刚写过）。点「保存」就是本页的保存动作——
         先用本页内容覆盖本机（对方那份存进 recover 备份），再照常上传。 */
      if (store.isStale()) {
        var resolved = store.resolveStale('overwrite');
        if (!resolved || !resolved.ok) { M.toast('保存失败：本机写入被占用，请刷新页面'); return; }
      }

      var converted = CloudDoc.toCloud(store.getState());
      if (!converted.ok) {
        M.toast('内容无法上传：' + ((converted.errors[0] && converted.errors[0].message) || '数据格式异常'));
        return;
      }
      var payload = converted.payload;
      var truncated = !!(converted.warnings && converted.warnings.length);
      var hash = hashOfDoc(payload);

      cloudBusy = true;
      setSaveBusy(true);
      client.save(payload).then(function (r) {
        cloudBusy = false;
        setSaveBusy(false);
        if (!r || !r.ok) { M.toast(saveErrorText(r)); return; }
        writeMarker(uid, {
          revision: r.row ? r.row.revision : null,
          savedAt: (r.row && r.row.updated_at) || new Date().toISOString(),
          device: deviceLabel,
          hash: hash
        });
        refreshSaveState();
        if (cloudSectionInst && typeof cloudSectionInst.render === 'function') {
          try { cloudSectionInst.render(); } catch (e) { /* 面板已关闭 */ }
        }
        M.toast(truncated ? '已保存到云端（超长内容按上限截断）' : '已保存到云端');
      }, function (err) {
        cloudBusy = false;
        setSaveBusy(false);
        M.toast(saveErrorText(err));
      });
    }

    function cloudUnusableText(code) {
      if (code === 'E_VERSION') return '云端数据来自更新版本的 DayLight，请先更新应用再载入云端。';
      return '云端数据无法识别（' + (code || 'E_UNKNOWN') + '），已保留本机内容。';
    }

    function refuseCloud(code) {
      if (loadRefused) return;
      loadRefused = true;
      warn('warn', cloudUnusableText(code), [{ label: '我知道了', onClick: function () { /* 仅关闭 */ } }]);
    }

    /** 云端某一行覆盖本机，并把标记更新成 clean。 */
    function adoptRow(uid, row) {
      var converted = CloudDoc.fromCloud(row.schedule_data, store.getState());
      if (!converted.ok) return converted;
      applyDocFromCloud(converted.doc);
      writeMarker(uid, {
        revision: typeof row.revision === 'number' ? row.revision : null,
        savedAt: row.updated_at || '',
        device: deviceLabel,
        hash: hashOfDoc(row.schedule_data)
      });
      return { ok: true };
    }

    /** 记下「保留本机」：同一云端版本不再问。 */
    function declineRow(uid, row, record) {
      var declined = record
        ? CloudRecord.withDeclined(record, row.revision)
        : CloudRecord.serializeRecord({
            revision: null, savedAt: '', device: '', hash: DECLINED_HASH, declinedRevision: row.revision
          });
      if (declined) writeMarker(uid, declined);
    }

    function clockText(iso) {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return D.pad2(d.getMonth() + 1) + '-' + D.pad2(d.getDate()) + ' ' +
        D.pad2(d.getHours()) + ':' + D.pad2(d.getMinutes());
    }

    /** §4.1 第 3 条：本机有未保存改动，云端那份也保存过 → 问一次。 */
    function askWhichSide(uid, row, record) {
      var when = clockText(row.updated_at);
      return M.confirm({
        title: '云端与这台设备不一致',
        message: '云端版本保存于 ' + (when || '未知时间') +
          (row.saved_by ? '（' + row.saved_by + '）' : '') + '，这台设备上的改动还没有传上去。',
        confirmLabel: '载入云端',
        cancelLabel: '保留本机'
      }).then(function (loadCloud) {
        if (!loadCloud) {
          declineRow(uid, row, record);
          return { ok: true, action: 'declined' };
        }
        var adopted = adoptRow(uid, row);
        if (!adopted.ok) { refuseCloud(adopted.code); return { ok: false, code: adopted.code }; }
        return { ok: true, action: 'loaded' };
      });
    }

    /**
     * §4.1：打开页面（启动 / 切回）时对齐云端。
     *   clean（本机内容 == 上次保存/载入的那份）→ 云端直接覆盖本机，完全静默；
     *   pending / unknown → 每个云端版本只问一次；
     *   读取失败 → 停在本地，不打扰。
     */
    function cloudOpenPass() {
      if (autoLoadBusy || cloudBusy) return Promise.resolve(null);
      var uid = sessionUserId();
      if (!uid || !onAccountScope(uid)) return Promise.resolve(null);
      var client = ensureClient(uid);
      if (!client) return Promise.resolve(null);

      autoLoadBusy = true;
      return client.read().then(function (r) {
        autoLoadBusy = false;
        if (!r || !r.ok) { refreshSaveState(); return r; }
        if (!r.row) { refreshSaveState(); return r; }

        var row = r.row;
        var record = readMarker(uid);
        if (CloudRecord.classify(record, localHash()) === CloudRecord.KIND.CLEAN) {
          var adopted = adoptRow(uid, row);
          if (!adopted.ok) refuseCloud(adopted.code);
          refreshSaveState();
          return { ok: true, action: 'replaced' };
        }

        var revision = typeof row.revision === 'number' ? row.revision : null;
        if (CloudRecord.isDeclined(record, revision)) return { ok: true, action: 'declined' };
        /* 先看谁更新：本机改动晚于云端那份 → 云端并不比本机新，不该问「载入云端」
           （典型：刚改完就刷新，用户看到弹窗会以为自己的改动被云端顶掉了）。 */
        if (CloudRecord.newerSide(store.getState(), row) === 'local') {
          refreshSaveState();
          return { ok: true, action: 'local-newer' };
        }
        var askedKey = uid + ':' + String(revision);
        if (revision !== null && askedRevisions[askedKey]) return { ok: true, action: 'asked' };
        if (revision !== null) askedRevisions[askedKey] = true;

        return askWhichSide(uid, row, record).then(function (acted) {
          refreshSaveState();
          return acted;
        });
      }, function () {
        autoLoadBusy = false;
        return { ok: false, code: 'E_NETWORK' };
      });
    }

    /**
     * §4.2：进入账号作用域。
     * 云端有内容 → 以云端为准建立/覆盖账号副本；云端为空 → 当前本机内容做起点。
     * 游客数据不动（始终留在 guest 作用域）。
     */
    function enterAccount(uid) {
      var client = ensureClient(uid);
      if (!client) return Promise.resolve({ ok: false, code: 'E_NO_CLOUD', message: '当前环境不支持云端' });
      return client.read().then(function (r) {
        if (!r.ok) {
          /* 断网：有账号副本就先用它（下次打开再对齐）；没有就无法进入账号。 */
          if (store.hasAccountCopy(uid)) {
            var sw = switchStoreScope(accountScopeId(uid), uid);
            return sw.ok ? { ok: true, offline: true } : { ok: false, code: sw.code, message: sw.message };
          }
          return { ok: false, code: r.code, message: '云端读取失败，请检查网络后重试' };
        }

        var row = r.row;
        var docToWrite = null;
        if (row) {
          var converted = CloudDoc.fromCloud(row.schedule_data, store.getState());
          if (!converted.ok) return { ok: false, code: converted.code, message: cloudUnusableText(converted.code) };
          docToWrite = converted.doc;
        } else if (!store.hasAccountCopy(uid)) {
          docToWrite = store.getState();
        }
        if (docToWrite) {
          var written = store.persistAccountCopy(uid, docToWrite, { sessionUid: uid });
          if (!written.ok) return { ok: false, code: written.code, message: written.message || '账号数据写入失败' };
        }

        var switched = switchStoreScope(accountScopeId(uid), uid);
        if (!switched.ok) return { ok: false, code: switched.code, message: switched.message || '切换账号数据失败' };

        if (row) {
          writeMarker(uid, {
            revision: typeof row.revision === 'number' ? row.revision : null,
            savedAt: row.updated_at || '',
            device: deviceLabel,
            hash: hashOfDoc(row.schedule_data)
          });
        } else {
          /* 云端为空：没有标记 = 本机这份还没传过（保存按钮亮着小红点）。 */
          clearMarker(uid);
        }
        refreshSaveState();
        return { ok: true, adopted: !!row };
      });
    }

    /** 登录 / 启动恢复后进入账号；失败时如实说一句，本页不会被切走。 */
    function enterAccountForSession(uid, quiet) {
      if (!uid) return Promise.resolve(null);
      store.setSessionUid(uid);
      if (onAccountScope(uid)) { refreshSaveState(); return Promise.resolve({ ok: true }); }
      return enterAccount(uid).then(function (res) {
        if (!res || !res.ok) {
          if (!quiet) M.toast((res && res.message) || '云端账号数据未能载入');
        }
        refreshSaveState();
        return res;
      }, function () {
        if (!quiet) M.toast('云端账号数据未能载入');
        refreshSaveState();
        return { ok: false, code: 'E_NETWORK' };
      });
    }

    function openSignInDialog() {
      if (!cloudAuth || !AccountDialogs) { M.toast('当前环境不支持登录'); return; }
      AccountDialogs.openSignIn({
        auth: cloudAuth,
        onSignedIn: function (r) { onSignedIn(r); },
        onDone: function () {
          if (cloudSectionInst && typeof cloudSectionInst.render === 'function') {
            try { cloudSectionInst.render(); } catch (e) { /* 面板已关闭 */ }
          }
        }
      });
    }

    function onSignedIn(r) {
      var uid = r && r.uid ? String(r.uid) : '';
      if (!uid) return;
      enterAccountForSession(uid, false).then(function (res) {
        if (res && res.ok && cloudSectionInst && typeof cloudSectionInst.render === 'function') {
          try { cloudSectionInst.render(); } catch (e) { /* 面板已关闭 */ }
        }
      });
    }

    /** §4.3：退出即回游客作用域；账号副本与云端标记都保留。 */
    function afterSignOut() {
      store.setSessionUid(null);
      cloudClient = null;
      cloudClientUid = null;
      if (store.getScopeId() !== 'guest') switchStoreScope('guest');
      syncDockFromDoc(store.getState());
      refreshSaveState();
    }

    function listVersions() {
      var uid = sessionUserId();
      if (!uid) return Promise.resolve({ ok: false, message: '未登录' });
      var client = ensureClient(uid);
      if (!client) return Promise.resolve({ ok: false, message: '云端未启用' });
      return client.read().then(function (r) {
        if (!r.ok) return { ok: false, code: r.code, message: r.message };
        if (!r.row) return { ok: true, current: null, older: [] };
        var ui = CloudVersions.listForUi(r.row);
        return { ok: true, current: ui.current, older: ui.older };
      }, function () {
        return { ok: false, message: '网络不可用' };
      });
    }

    /** §5：回溯 = 该版本先存成新的当前版本，成功后再替换本机内容。 */
    function restoreVersion(entry) {
      var uid = sessionUserId();
      if (!uid) return Promise.resolve({ ok: false, message: '未登录' });
      if (!onAccountScope(uid)) return Promise.resolve({ ok: false, message: '账号数据还没载入' });
      var client = ensureClient(uid);
      if (!client) return Promise.resolve({ ok: false, message: '云端未启用' });

      var converted = CloudDoc.fromCloud(entry && entry.doc, store.getState());
      if (!converted.ok) {
        return Promise.resolve({ ok: false, message: (converted.errors[0] && converted.errors[0].message) || '该版本无法载入' });
      }
      var convertedUp = CloudDoc.toCloud(converted.doc);
      if (!convertedUp.ok) return Promise.resolve({ ok: false, message: '该版本无法上传' });

      return client.restore(convertedUp.payload).then(function (r) {
        if (!r || !r.ok) return { ok: false, message: saveErrorText(r) };
        applyDocFromCloud(converted.doc);
        writeMarker(uid, {
          revision: r.row ? r.row.revision : null,
          savedAt: (r.row && r.row.updated_at) || new Date().toISOString(),
          device: deviceLabel,
          hash: hashOfDoc(convertedUp.payload)
        });
        refreshSaveState();
        return { ok: true };
      }, function (err) {
        return { ok: false, message: (err && err.message) || '网络不可用' };
      });
    }

    function maybeCloudOpenPass() {
      if (root.document && root.document.visibilityState === 'hidden') return;
      var now = Date.now();
      if (now - lastOpenPassAt < 30000) return;
      lastOpenPassAt = now;
      var uid = sessionUserId();
      if (!uid) return;
      if (!onAccountScope(uid)) { enterAccountForSession(uid, true); return; }
      cloudOpenPass();
    }

    if (root.document && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.visibilityState === 'visible') maybeCloudOpenPass();
      });
    }
    if (root.addEventListener) root.addEventListener('focus', maybeCloudOpenPass);

    /* 恢复上次的登录态，再按 §4.1 / §4.2 对齐云端。失败静默回到游客；
       断网但凭据还在时保持登录（离线刷新 defer），下次切回页面会自动再对齐。 */
    if (session) {
      Promise.resolve(session.restore()).then(function (r) {
        if (!(r && r.ok && r.state === 'signed-in')) {
          store.setSessionUid(null);
          if (store.getScopeId() !== 'guest') switchStoreScope('guest');
          refreshSaveState();
          return;
        }
        var uid = session.getUserId();
        lastOpenPassAt = Date.now();
        enterAccountForSession(uid, true).then(function () {
          if (onAccountScope(uid)) cloudOpenPass();
        });
      }, function () {
        store.setSessionUid(null);
        if (store.getScopeId() !== 'guest') switchStoreScope('guest');
        refreshSaveState();
      });
    }

    if (els.saveBtn) {
      els.saveBtn.addEventListener('click', function () { saveToCloud(); });
    }

    /* ---------------- 全局设置入口（迭代 4：侧栏月历已删除，见 S26 / ADR-26） ---------------- */

    settingsOpts = {
      store: store,
      onDataChanged: onDataChanged,
      cloud: {
        getSession: function () { return session; },
        getAccountName: function (uid) { return cloudAuth ? cloudAuth.accountName(uid) : ''; },
        openSignIn: openSignInDialog,
        signOut: function () {
          if (!session) return Promise.resolve({ ok: true });
          return Promise.resolve(session.signOut()).then(function (r) {
            afterSignOut();
            return r;
          });
        },
        listVersions: listVersions,
        restoreVersion: restoreVersion,
        onRestored: function () { refreshSaveState(); },
        onSignedOut: function () {
          refreshSaveState();
          if (cloudSectionInst && typeof cloudSectionInst.render === 'function') {
            try { cloudSectionInst.render(); } catch (e) { /* 面板已关闭 */ }
          }
        }
      },
      registerCloudSection: function (inst) { cloudSectionInst = inst; },
      /* 清空只影响当前作用域：云端那份不动，保存按钮的文字会变蓝提醒「还没传」。 */
      onDataCleared: function () { refreshSaveState(); },
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
          title: '关于 DayLight',
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
      /* 白块是绝对定位元素，坐标原点是轨道的 padding box；getBoundingClientRect 给的是
         border box，两者差一个边框宽 → 不扣掉会把胶囊整体推低/推右 1px（选中档看起来不居中）。 */
      function insetOffset() {
        var x = 0;
        var y = 0;
        if (typeof root.getComputedStyle !== 'function') return { x: 0, y: 0 };
        var cs = null;
        try { cs = root.getComputedStyle(sw); } catch (e) { cs = null; }
        if (!cs) return { x: 0, y: 0 };
        var bx = parseFloat(cs.borderLeftWidth);
        var by = parseFloat(cs.borderTopWidth);
        if (isFinite(bx)) x = bx;
        if (isFinite(by)) y = by;
        return { x: x, y: y };
      }
      function paint(btn) {
        var r = rectOf(btn);
        var sr = rectOf(sw);
        if (!r || !sr) return false;
        var off = insetOffset();
        thumb.style.width = r.width + 'px';
        thumb.style.height = r.height + 'px';
        thumb.style.transform = 'translate(' + (r.left - sr.left - off.x) + 'px,' +
          (r.top - sr.top - off.y) + 'px)';
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
        var off = insetOffset();
        var first = rectOf(list[0]);
        var last = rectOf(list[list.length - 1]);
        drag = {
          pointerId: e.pointerId,
          startX: Number(e.clientX),
          baseLeft: r.left - sr.left - off.x,
          baseTop: r.top - sr.top - off.y,
          width: r.width,
          minLeft: first ? first.left - sr.left - off.x : 0,
          maxLeft: last ? (last.left - sr.left - off.x + last.width - r.width) : (r.left - sr.left - off.x),
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
        var left = Math.max(drag.minLeft, Math.min(drag.maxLeft, drag.baseLeft + dx));
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

    /* 契约 §7：多标签页只做最低限度的保护——不弹窗、不提示、不合并。
       - 本页没有未落盘的改动 → 磁盘上那份就是最新真相，整份静默重载；
       - 本页有未落盘的改动 → 只标记陈旧（自动保存暂停），等本页「保存」或刷新。
       云端保存是显式动作：另一页改了本机，并不代表要碰云端。 */
    var reconcileTimer = null;
    var staleSeen = false;

    /* 与上次成功写入的基线比，而不是跟磁盘现状比——storage 事件到达时磁盘已经变了。 */
    function hasUnsavedLocal() {
      try {
        if (typeof store.hasPendingSave === 'function' && store.hasPendingSave()) return true;
      } catch (e) { return true; }
      try {
        var base = typeof store.getBaseline === 'function' ? store.getBaseline() : null;
        if (base === null || base === undefined) return true;
        return JSON.stringify(store.getState()) !== base;
      } catch (e) { return true; }
    }

    function reconcileExternal() {
      if (!store.isStale()) return;
      var before = store.getState();
      var r;
      try { r = store.resolveStale(hasUnsavedLocal() ? 'keep' : 'reload'); } catch (e) { r = { ok: false }; }
      if (!r || !r.ok || r.action !== 'reload') return;
      syncDockFromDoc(store.getState());
      if (!sameContent(before, store.getState())) onDataChanged();
      refreshSaveState();
    }

    function scheduleReconcile() {
      if (reconcileTimer !== null) return;
      reconcileTimer = setTimeout(function () {
        reconcileTimer = null;
        reconcileExternal();
      }, 0);
    }

    function onExternalChange(key) {
      if (!store.noteExternalChange(key)) return;
      staleSeen = true;
      scheduleReconcile();
    }

    window.addEventListener('storage', function (e) {
      if (!e || typeof e.key !== 'string') return;
      /* 另一个标签页保存到云端后只写标记键：本页的蓝字要跟着回黑。 */
      var uid = sessionUserId();
      if (uid && e.key === markerKey(uid)) { refreshSaveState(); return; }
      onExternalChange(e.key);
    });

    /* 检测点 3（写后回读不一致）不会触发 storage 事件——它是本页自己写坏的。
       处置与 storage 路径一致：干净页静默重载，有改动的页保持陈旧等本页保存。 */
    store.subscribe(function () {
      if (!store.isStale()) { staleSeen = false; return; }
      if (staleSeen) return;
      staleSeen = true;
      scheduleReconcile();
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
      /* 手动保存线的只读快照：排障时最想知道「登录了没、标记是什么、有没有在忙」。
         只读，不提供任何写入口。 */
      cloud: function () {
        var uid = sessionUserId();
        var marker = null;
        if (uid) { try { marker = readMarker(uid); } catch (e) { marker = null; } }
        return {
          signedIn: !!uid,
          uid: uid,
          scope: store.getScopeId(),
          kind: uid ? CloudRecord.classify(marker, localHash()) : null,
          marker: marker,
          busy: !!cloudBusy
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
