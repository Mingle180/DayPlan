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
      seedFactory: function () { return Seed.createDemoDocument(); }
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
        /* 日视图内的「‹ / 今天 / ›」改的是视图自己的 state.date，必须回写到共享 state.viewDate 并落盘。
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
    function setViewDate(iso) {
      if (!D.isValidDate(iso)) return;
      state.viewDate = iso;
      if (instances.day) instances.day.setDate(iso, { notify: false });
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

    /* 视图模块（日 / 周）在事件回调里取：模块加载顺序早于 app，不能在它们顶层捕获。 */
    root.DayPlan.motion = { slidePanel: slideDatePanel };

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

    /* ---------------- 全局设置入口（迭代 4：侧栏月历已删除，见 S26 / ADR-26） ---------------- */

    settingsOpts = {
      store: store,
      onDataChanged: onDataChanged,
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
      setViewDate(D.addDays(state.viewDate, days));
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
      openSettings: function () { SettingsView.openSettings(settingsOpts); }
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
