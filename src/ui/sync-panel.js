/**
 * DayPlan · 同步面板（设置页分组 + 登录 + 首次同步确认）
 *
 * 边界：本模块**只做界面**。所有状态判断来自 `wiring.describe()` 与
 * `engine.check()` 的返回值，不自己推断「是否已同步」。这一条是刻意的：
 * UI 一旦开始猜状态，就会和引擎打架，最后两边都不对。
 *
 * 三种 wiring 模式对应三种界面，互不伪装（D11 精简后的口径）：
 *   off   显示「本机模式」+「登录并同步」（内置云服务是唯一入口）
 *   mock  显示「演示模式」并**明写不联网**；登录是演示登录（仅 DAYPLAN_SYNC 注入时可达）
 *   real  显示状态与真实登录（用户名/邮箱 + 密码 + 邮箱验证码），走 Supabase Auth
 *
 * 另有一条与上面三者正交的分支：当前是 `file://` 入口时（契约 §10），
 * 即便 wiring 为 off 也**不给**「登录并同步」——那类入口下同步必然失败，
 * 只留「该入口暂不支持云端同步」的说明与本机模式的其余内容。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var M = root.DayPlan.modal;
  var el = M.el;

  var STATE_TEXT = {
    'local': '本机模式，未开启同步',
    'signed-in': '已登录，同步未开启',
    'checking': '正在检查云端…',
    'awaiting-choice': '等待你选择处理方式',
    'syncing': '同步已开启',
    'paused-error': '同步已暂停'
  };

  /**
   * 错误码 → 一句人话 + 该做什么。
   * 引擎返回的是给开发看的（如「条件未命中（0 行）」），直接摆给用户等于没说。
   */
  var ERROR_TEXT = {
    E_CONFLICT: '云端已被另一台设备改过，这次改动没有上传。点「开始检查」选择保留哪一边。',
    E_NETWORK: '连不上云端（网络问题）。改动还在本机，网络恢复后会再试。',
    E_TIMEOUT: '云端响应超时。改动还在本机，稍后会再试。',
    E_UNAUTHORIZED: '登录已过期，需要重新登录。',
    E_SESSION_EXPIRED: '登录已过期，需要重新登录。',
    E_EXPIRED: '登录已过期，需要重新登录。',
    E_INVALID_CREDENTIALS: '邮箱或密码不正确。',
    E_EMAIL_NOT_CONFIRMED: '这个账号的邮箱还没确认。去 Supabase 控制台关闭 Confirm email，或手动确认该账号。',
    E_RATE_LIMIT: '请求太频繁，被服务器限流了。等一会儿再试。',
    E_NOT_CONFIGURED: '连接配置不完整，无法同步。',
    E_PAUSED: '同步已暂停，改动只留在本机。点「开始检查」继续。',
    E_RECORD_MISSING: '同步记录丢失了，需要重新检查一次云端。',
    /* 下面三条都表示「本机记录的状态不对」，而不是网络或凭据问题。
       文案不能写成「重试」——重试解决不了记录丢失，只会让用户多撞几次。 */
    E_NEEDS_RECOVERY: '本机的同步记录丢失或损坏了。点「开始检查」后会列出两端的内容，由你决定保留哪一边。',
    E_BOOT_BLOCKED: '本机的同步记录形状无法判定，已停止同步以避免覆盖。建议先导出本机数据，再退出登录重新开始。',
    E_REMOTE_MISSING: '云端已经没有这个账号的数据了（可能是在别的设备上删掉了）。本机这一份还在，需要你确认是否重新上传。',
    E_CANDIDATE_MISSING: '这台设备上没有该账号的数据副本，无法以本机为准。',
    /* 租约（§5.4）：这不是失败，是「排队」。文案必须让用户知道改动没丢、会自己重试，
       否则他会以为同步坏了而反复手点。 */
    E_LEASE_BUSY: '另一个标签页正在同步，这次的改动还在本机，稍后会自动重试。',
    E_LEASE_LOST: '另一个标签页抢先开始了同步，这次的改动还在本机，稍后会自动重试。',
    E_LEASE_UNAVAILABLE: '本机存储写不了租约（配额或隐私模式），这次没有多标签保护，仍会按云端版本号校验。',
    E_STALE_LOCAL: '另一个标签页更新了本地数据，正在自动载入最新内容。',
    /* 有损修复（§1.8）：这三条都不是「坏了」，而是「停在一个必须由人决定的路口」。
       写成「重试」会误导——重试一千次也还是同一份会丢条目的文档。 */
    E_LOSSY: '云端这份数据里有会被丢弃或改写的条目，这次没有应用。请查看预览后决定。',
    E_LOSSY_UNCONFIRMED: '需要先勾选确认才能继续。',
    E_LOSSY_DOWNLOADS: '两份 JSON 都要下载成功才能继续（那是万一后悔时唯一的退路）。',
    E_PENDING_LOSSY_PUSH: '修复后的数据还没写回云端。写回会覆盖云端那一份，需要你确认。',
    E_UPLOAD_CONFIRM_REQUIRED: '关闭同步期间本机有改动，重新开启需要确认是否上传。',
    E_LOCAL_CLEARED: '本机数据已清空，云端那份仍然保留。点「开始检查」可重新读取云端。',
    E_NOT_CLOSED: '当前同步记录不是「已关闭」状态，无需重新开启。',
    E_NOT_ACTIVE: '当前没有进行中的同步。'
  };

  function describeError(err) {
    if (!err) return '';
    var human = ERROR_TEXT[err.code];
    if (human) return human;
    return (err.message || '未知错误') + (err.code ? '（' + err.code + '）' : '');
  }

  var CASE_TEXT = {
    A: { title: '本机有内容，云端是空的', desc: '这台设备上的数据还没有上传过。' },
    B: { title: '本机是空的，云端有内容', desc: '这台设备没有数据，云端有之前同步过的内容。' },
    C: { title: '两边都有内容', desc: '本机与云端都有数据，需要你选一边。不做自动合并。' },
    D: { title: '两边都是空的', desc: '没有需要合并的内容，直接开始同步即可。' }
  };

  function note(text) {
    return el('p', { class: 'field', text: text });
  }

  function row(children) {
    return el('div', { class: 'inline' }, children);
  }

  /**
   * 当前是不是「本地文件」入口（`file://`）。
   *
   * 为什么要判：契约 §10 规定桌面版（`file://`）的登录与云端同步**不作可用承诺**。
   * 这类入口下 `crypto.subtle` 通常不存在，`contentHash` 无从计算（§4.8 只能转
   * `paused-error`）——也就是说「连接 → 登录 → 检查」走到底必然停在暂停态。
   * 与其给一个注定失败的入口，不如在入口处就说清。
   *
   * 不读 `location` 之外的东西：冒烟与单测里没有完整 `location` 时必须安全回落。
   */
  function fileEntry() {
    try {
      var loc = (typeof window !== 'undefined' && window.location) || null;
      if (!loc) return false;
      return String(loc.protocol || '') === 'file:';
    } catch (e) {
      return false;
    }
  }

  /** 把调度层的状态对象翻成一句人话。用户不需要看见 E_NO_CHANGE。 */
  function describeStatus(st) {
    if (!st) return '还没有同步动作（改动数据后会自动上传）';
    var when = '';
    if (typeof st.at === 'string' && st.at !== '') {
      var d = new Date(st.at);
      if (!isNaN(d.getTime())) {
        when = ' · ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }
    }
    if (st.kind === 'push') {
      if (st.ok && st.skipped) return '没有变化，已跳过' + when;
      if (st.ok) return '已上传到云端' + when;
      /* D18：可重试失败（网络/超时/5xx/限流）正在按退避自动重试，
         不需要用户做任何事——只陈述事实，不写成「上传失败」。 */
      if (st.retryable) return '网络不稳，稍后自动重试（改动已在本机）' + when;
      /* 暂停期间的变更没有发请求，带错误码说「上传失败」会误导（像是网络问题）。
         这里只说事实：改动在本机。 */
      if (st.code === 'E_PAUSED') return (st.message || '同步已暂停，改动只留在本机') + when;
      /* 租约被占不是「上传失败」：请求根本没发出去，而且会自动重试。 */
      if (st.code === 'E_LEASE_BUSY' || st.code === 'E_LEASE_LOST') {
        return (st.message || '另一个标签页正在同步，稍后自动重试') + when;
      }
      return '上传失败：' + (st.message || st.code) + (st.code ? '（' + st.code + '）' : '') + when;
    }
    if (st.kind === 'pull') {
      if (st.ok && st.skipped) return '云端没有更新' + when;
      if (st.ok) return '已从云端拉取' + when;
      if (st.retryable) return '网络不稳，稍后自动重试' + when;
      return '拉取失败：' + (st.message || st.code) + (st.code ? '（' + st.code + '）' : '') + when;
    }
    return (st.ok ? '完成' : '失败') + when;
  }

  /**
   * 设置页里的「同步」分组。
   * @param {{getWiring:function():object, getConn?:function():object,
   *          getSteady?:function():object, onEnableDemo?:function(),
   *          onSessionChanged?:function(boolean), onDataChanged?:function()}} opts
   */
  function createSyncSection(opts) {
    opts = opts || {};
    var wrap = el('section', { class: 'settings-section' });

    function getWiring() {
      return typeof opts.getWiring === 'function' ? opts.getWiring() : null;
    }

    /** 重新开启同步（§4.5 / §2.3）：closed 走四象限但要先确认上传；reset 先重新检查。 */
    function reopenHere() {
      w.reopen().then(function (r) {
        if (!r || !r.ok) {
          if (r && r.action === 'upload-confirm') {
            openUploadConfirm({
              wiring: w, check: r,
              onDone: function () {
                if (typeof opts.onSessionChanged === 'function') opts.onSessionChanged(true);
                if (typeof opts.onDataChanged === 'function') opts.onDataChanged();
                render();
              }
            });
            return;
          }
          M.toast('未能重新开启：' + ((r && (r.message || r.code)) || '未知错误'));
          render();
          return;
        }
        if (r.action === 'needs-check') {
          /* reset：没有可用锚点，只能重新读一次云端再判（A/A′/B/C/D）。 */
          M.toast('需要重新检查一次云端');
          runCheck(w, render);
          return;
        }
        if (r.action === 'conflict') {
          /* 两边都改过：交给首次同步的选择框（它就是为「两边都有内容」设计的）。 */
          runCheck(w, render);
          return;
        }
        if (r.action === 'lossy') {
          openLossy({
            wiring: w, check: r,
            downloadJson: opts.downloadJson,
            exportDocument: opts.exportDocument,
            onDone: function () { render(); }
          });
          return;
        }
        M.toast(r.action === 'pulled' ? '已重新开启，并下载了云端的更新' : '已重新开启同步');
        if (typeof opts.onSessionChanged === 'function') opts.onSessionChanged(true);
        if (typeof opts.onDataChanged === 'function') opts.onDataChanged();
        render();
      });
    }

  /** 页面加载后恢复会话的一次性自动检查（D15：免点「开始检查」）。
      D14 已把登录 / 验证 / 重置三个出口挂上 autoCheck；这里补的是「刷新 / 重开页面」：
      引擎从本机恢复会话后停在 signed-in（等待首次检查），以前要用户手点。
      只触发一次（防止后续每次 render 重复跑）；closed / reset（重新开启语义，
      Q-31 的确认链路）与 blocked（记录形状无法判定，检查必败）不自动跑，
      按钮保留作手动恢复入口。 */
  var restoreAutoCheckDone = false;
  function maybeRestoreAutoCheck(w, d) {
    if (restoreAutoCheckDone) return;
    if (!d || d.mode !== 'real') return;
    /* D16：awaiting-choice（上次的选择没做完）也重跑一次检查——
       检查会拿到全新结果，D16 的自动定向直接把它解套，无需用户手点。 */
    if (d.engineState !== 'signed-in' && d.engineState !== 'awaiting-choice') return;
    var bk = d.bootKind || null;
    if (bk === 'closed' || bk === 'reset' || bk === 'blocked') return;
    restoreAutoCheckDone = true;
    setTimeout(function () {
      /* 延迟期间可能已被登录出口的 autoCheck 抢先：状态已离开就不重复 */
      var cur = null;
      try { cur = w.describe(); } catch (e) { cur = null; }
      if (cur && (cur.engineState === 'signed-in' || cur.engineState === 'awaiting-choice')) {
        runCheck(w, null);
      }
    }, 0);
  }

  function render() {
    wrap.textContent = '';
    wrap.appendChild(el('h3', { text: '同步' }));

      var w = getWiring();

      if (!w) {
        /* 契约 §10 三入口能力矩阵：桌面版（`file://`）的「登录 / 云端同步」两行是
           **不作可用承诺**，实测前必须明写「该入口暂不支持云端同步」。
           这里挡在「连接 Supabase…」之前：给一个点下去必定失败（`file://` 下没有
           `crypto.subtle`，见 §4.8）的入口，比不给入口更糟——用户会以为是自己填错了。
           注意判据是协议而不是「是不是桌面版」：网页版挂在 https 子路径下同样走这条。 */
        if (fileEntry()) {
          wrap.appendChild(note('当前为本机模式：数据只保存在这台设备上，不会上传。'));
          wrap.appendChild(note('该入口暂不支持云端同步：用本地文件打开时，浏览器不提供同步所需的加密接口，'
            + '登录与云端同步暂不可用。需要同步请用网页版。'));
          wrap.appendChild(row([
            el('button', {
              class: 'btn btn-sm btn-ghost', type: 'button', text: '两者有什么区别',
              title: '网页版可以登录并同步；本地文件打开的这个版本只在本机保存数据',
              onclick: function () {
                M.open({
                  title: '本地文件版与网页版的区别',
                  body: el('div', {}, [
                    note('网页版：在浏览器里打开网址使用，可以登录账号，数据在设备之间同步。'),
                    note('本地文件版：直接打开一个 HTML 文件使用，数据只存在这台设备的这个文件所在域里，'
                      + '换一台电脑或换一个浏览器都看不到。'),
                    note('把本地文件版的数据搬到网页版：在本地文件版的设置页「数据」里导出 JSON，'
                      + '再到网页版同样位置导入。')
                  ])
                });
              }
            })
        ]));
        return;
      }
        wrap.appendChild(note('当前为本机模式：数据只保存在这台设备上，不会上传。'));
        wrap.appendChild(row([
          /* 2026-10-27 所有者口径（D11 精简）：登录不该要求用户理解 Project URL /
             publishable key，也不再提供「接自己的项目」通道——内置云服务是唯一入口。
             「连接 Supabase…」「启用演示同步」按钮已按裁定移除。 */
          el('button', {
            class: 'btn btn-sm btn-primary', type: 'button', text: '登录并同步',
            title: '登录后数据自动在本设备与云端之间同步',
            onclick: function () {
              if (typeof opts.getDefaultConn !== 'function' || typeof opts.onConnectReal !== 'function') {
                M.toast('当前版本没有内置云服务');
                return;
              }
              var w2 = null;
              try { w2 = opts.onConnectReal(opts.getDefaultConn()); } catch (e) { w2 = null; }
              if (!w2) { M.toast('同步未能启用，请稍后重试'); return; }
              openSignInHere(w2);
            }
          })
        ]));
        return;
      }

      var d = w.describe();
      var mode = d.mode;
      /* 启动分类（§1.9）决定「这条路还能不能走」：
         recovery / blocked 都停在 paused-error 或 awaiting-choice，
         但它们的下一步完全不是「重试」——重试解决不了记录丢失。 */
      var bootKind = d.bootKind || null;
      var inRecovery = bootKind === 'recovery';
      var bootBlocked = bootKind === 'blocked';

      /* D15：恢复会话的自动检查（刷新 / 重开页面后免点「开始检查」）。 */
      maybeRestoreAutoCheck(w, d);

      if (mode === 'mock') {
        wrap.appendChild(note('演示模式：数据写进内存，**不联网、不写云端**。刷新页面后回到本机模式。'));
      }

      if (mode === 'real') {
        /* D11 精简：不再展示原始项目 URL（内置云服务，用户不需要知道地址）。 */
        wrap.appendChild(note('已开启同步：数据保存在本设备与云端，'
          + '登录同一账号的设备之间自动互相同步，无需任何操作。'));
      }

      /* ---------- D11 极简排版：状态 / 账号 / 最近一次同步合并成一个紧凑信息块 ---------- */
      var metaRows = [];
      /* D18：可重试的失败（网络/超时/5xx/限流）不再写成「同步已暂停」——
         那句话读起来像坏了、要人处理。实际上界面正在自动重试，用户什么都不用做。 */
      var stateText = STATE_TEXT[d.engineState] || d.engineState;
      if (d.engineState === 'paused-error' && d.error && d.error.retryable) {
        stateText = '网络不稳，正在自动重试…';
      }
      metaRows.push({ label: '状态', value: stateText, error: false });

      if (d.uid) {
        /* D12（2026-10-27）：账号行优先显示用户名（登录/注册时由装配层缓存），
           缓存缺失（老会话刷新前、直登邮箱等）才回落脱敏 uid。 */
        var nameText = String(d.accountName || '').trim();
        if (nameText === '') {
          var uidText = String(d.uid);
          if (uidText.length > 16) uidText = uidText.slice(0, 8) + '…' + uidText.slice(-6);
          nameText = uidText;
        }
        metaRows.push({ label: '账号', value: nameText, error: false });
      }

      /* 稳态同步状态（只有真正在同步时才显示）：回答「刚才那次编辑上去了没有」。
         paused-error 也要显示——不显示的话用户会以为改动已经上云。 */
      var steady = typeof opts.getSteady === 'function' ? opts.getSteady() : null;
      if (steady && typeof steady.getStatus === 'function') {
        var st = steady.getStatus();
        if (d.engineState === 'syncing' || d.engineState === 'paused-error') {
          metaRows.push({
            label: '最近同步',
            value: describeStatus(st),
            /* D18：可重试的失败不算「错误」（正在自动重试），不上红字。 */
            error: !!(st && st.ok === false && !st.retryable)
          });
        }
      }

      wrap.appendChild(el('div', { class: 'sync-meta' }, metaRows.map(function (r) {
        return el('div', { class: 'sync-meta-row' }, [
          el('span', { class: 'sync-meta-label', text: r.label }),
          el('span', { class: r.error ? 'sync-meta-value field-error' : 'sync-meta-value', text: r.value })
        ]);
      })));

      if (d.error) {
        wrap.appendChild(note('上次失败：' + describeError(d.error)));
      }

      if (bootBlocked) {
        wrap.appendChild(note('本机保存的同步记录无法识别（既不是有效记录，也不像单纯损坏）。'
          + '为避免覆盖任何一边，同步已停止。建议先导出备份，再退出登录重新开始。'));
      }

      var buttons = [];

      /* 登录面板的唯一入口。所有「登录 / 重新登录」都必须走这里——
         三个调用参数（wiring / onSessionChanged / onDone）漏一个都是静默故障：
         漏 onSessionChanged 会「登录成功但界面什么都不做」（装配层收不到通知，
         不 setSessionUid、不跑四象限、不挂稳态）。2026-10-27 探针实测过这个洞：
         以前靠确认框的 onDone 顺带通知掩盖了它，Q-28 之后登录不再必然弹确认框，
         重新登录就会停在 checking 再也出不来。 */
      function openSignInHere(wiringOverride) {
        openSignIn({
          wiring: wiringOverride || w,
          onSessionChanged: opts.onSessionChanged,
          onDataChanged: opts.onDataChanged,
          exportBackup: opts.exportBackup,
          autoCheck: function () { runCheck(w, null); },
          onDone: function () { render(); }
        });
      }

      /* 会话过期时唯一的出路是重新登录：此时 getToken() 一律返回 E_EXPIRED，
         「开始检查」只会再失败一次然后回到 paused-error，是个绕不出去的循环。
         这也是死路的一种形态——状态停住了，却没有对应的出口。 */
      var sessionExpired = d.sessionState === 'expired';
      if (sessionExpired) {
        wrap.appendChild(note('登录已过期，需要重新登录。本机数据没有任何改动，重新登录后会自动接着同步。'));
      }

      if (sessionExpired) {
        buttons.push(el('button', {
          class: 'btn btn-sm btn-primary', type: 'button', text: '重新登录',
          /* 不把 openSignInHere 直接当 handler：DOM 事件对象会作为第一个参数进来，
             而它的第一个形参是 wiringOverride（2026-10-27 SC-133 抓到）。 */
          onclick: function () { openSignInHere(); }
        }));
      } else if (d.engineState === 'local' || !d.uid) {
        buttons.push(el('button', {
          class: 'btn btn-sm btn-primary', type: 'button', text: '登录',
          onclick: function () { openSignInHere(); }
        }));
      } else {
        /* 关闭/重置之后的第一件事是「重新开启」，不是「开始检查」。
           直接给「开始检查」会走首次同步的 A/B/C/D 判定——而 closed 记录
           还有效锚点、reset 记录根本没有锚点，两者都不该按首次同步处理
           （§4.5、§2.3；T-F09 / T-F12）。 */
        var needsReopen = bootKind === 'closed' || bootKind === 'reset';
        if (needsReopen) {
          buttons.push(el('button', {
            class: 'btn btn-sm btn-primary', type: 'button', text: '重新开启同步',
            title: bootKind === 'reset'
              ? '上次同步被关闭或清空过，需要重新检查云端'
              : '重新检查之后才会开始写入；关闭期间的改动会先问你',
            onclick: function () { reopenHere(); }
          }));
        }
        if (!needsReopen && (d.engineState === 'signed-in' || d.engineState === 'paused-error')) {
          /* blocked 不给「开始检查」：记录形状无法判定，检查只会再拒一次，
             点下去是个绕不出去的圈。给它的是「重新登录」（唯一能重建记录的路）。
             D18：可重试的暂停（网络/超时/5xx/限流）也不给——界面正在自动重试，
             放一个按钮只会让用户以为「必须点一下才会恢复」。 */
          var autoHealing = d.engineState === 'paused-error' && d.error && d.error.retryable;
          if (!bootBlocked && !autoHealing) {
            buttons.push(el('button', {
              class: 'btn btn-sm btn-primary', type: 'button', text: '开始检查',
              onclick: function () { runCheck(w, render); }
            }));
          }
          /* D19 兜底出口：云端数据连归一都救不了（不是 DayPlan 的数据 / 版本更高 /
             结构损坏）。继续点「开始检查」只会再失败一次，是个绕不出去的圈。
             这时唯一能走通的路是「以本机覆盖云端」——必须由人点，因为云端那份
             会被替换掉（本机覆盖前已自动写快照）。 */
          if (d.engineState === 'paused-error' && d.error && d.error.code === 'E_REMOTE_INVALID') {
            buttons.push(el('button', {
              class: 'btn btn-sm btn-primary', type: 'button', text: '用本机数据覆盖云端',
              title: '云端这份数据无法读取（不是本应用的数据、版本更高或已损坏）。用本机这份替换它',
              onclick: function () {
                M.confirm({
                  title: '用本机数据覆盖云端？',
                  message: '云端这份数据读不出来（可能来自更新版本，或已经损坏）。'
                    + '覆盖后云端将变成这台设备当前的内容，云端原来那份不再保留；'
                    + '本机内容不会改变。',
                  confirmLabel: '覆盖云端',
                  danger: true
                }).then(function (ok) {
                  if (!ok) return;
                  Promise.resolve(w.getEngine().overwriteRemoteWithLocal()).then(function (res) {
                    if (!res || !res.ok) {
                      M.toast('覆盖失败：' + ((res && (res.message || res.code)) || '未知错误'));
                      render();
                      return;
                    }
                    M.toast('已用本机数据覆盖云端，同步恢复');
                    if (typeof opts.onDataChanged === 'function') opts.onDataChanged();
                    render();
                    var steady = typeof opts.getSteady === 'function' ? opts.getSteady() : null;
                    if (steady && typeof steady.schedule === 'function') steady.schedule();
                  }, function (err) {
                    M.toast('覆盖失败：' + (err && err.message ? err.message : '未知错误'));
                    render();
                  });
                });
              }
            }));
          }
        }
        /* 检查完把确认框关掉（点「暂不处理」或点遮罩）会停在 awaiting-choice。
           这是流程中停住的第三种状态，必须留一条回到选择的回路——
           否则用户只剩「退出登录」，等于把已经读到的云端状态白白扔掉。 */
        if (d.engineState === 'awaiting-choice') {
          buttons.push(el('button', {
            class: 'btn btn-sm btn-primary', type: 'button', text: '继续选择',
            title: '上次的检查结果还在，接着选保留哪一边',
            onclick: function () {
              var engine = w.getEngine();
              var chk = engine && typeof engine.getCheck === 'function' ? engine.getCheck() : null;
              if (!chk) { runCheck(w, render); return; }
              openChoiceFor(w, chk, opts.exportBackup, function () {
                if (typeof opts.onSessionChanged === 'function') opts.onSessionChanged(true);
                if (typeof opts.onDataChanged === 'function') opts.onDataChanged();
                render();
              });
            }
          }));
        }
        /* D12（2026-10-27 裁定）：「立即同步」按钮已移除——稳态同步（3s 轮询 +
            0.8s 防抖）本身就是即时的，手动推送入口只会制造「自动同步不可靠」的
            错觉。steady.pushNow 引擎能力保留给测试与极端排障。 */
        buttons.push(el('button', {
          class: 'btn btn-sm', type: 'button', text: '退出登录',
          title: '只清登录凭据，不动本机任何数据',
          onclick: function () {
            w.signOut().then(function () {
              if (typeof opts.onSessionChanged === 'function') opts.onSessionChanged(false);
              render();
            });
          }
        }));
      }

      if (buttons.length) wrap.appendChild(row(buttons));

      /* D11（2026-10-27 裁定）：「删除云端数据」「断开连接」按钮已移除——
         内置云服务下用户没有「自己的项目」可断开；云端删除属运维操作，不进日常界面。
         D12（2026-10-27 裁定）：「关闭同步」按钮一并移除——登录后的同步就是常态，
         不该提供一个让用户误停数据通道的日常开关；引擎的 closeSync 保留
         （Q-31 重开确认链路、验收 T-R01 仍依赖），仅不再有界面入口。 */

      if (mode === 'mock') {
        wrap.appendChild(row([
          el('button', {
            class: 'btn btn-sm btn-ghost', type: 'button', text: '关闭演示同步',
            onclick: function () {
              if (typeof opts.onDisable === 'function') opts.onDisable();
              render();
            }
          })
        ]));
      }
    }

    /**
     * 检查 → 需要选择时弹确认框；提交成功后通知外部刷新视图。
     *
     * 两个入口共用这里，但**走的不是同一条路**：首次同步看 case（A/B/C/D），
     * 保守恢复看 kind（recovery / remote-missing）。走错路的后果很具体：
     * 拿首次同步的框去处理恢复，会把游客文档当成「本机」摆给用户选。
     */
    function runCheck(w, after) {
      var engine = w.getEngine();
      var boot = engine && typeof engine.getBoot === 'function' ? engine.getBoot() : null;
      if (boot && boot.kind === 'recovery') {
        runRecoveryCheck(w, after);
        return;
      }
      M.toast('正在检查云端…');
      engine.check().then(function (chk) {
        if (!chk || !chk.ok) {
          M.toast('检查失败：' + ((chk && chk.message) || '未知错误'));
          if (after) after();
          return;
        }
        openChoiceFor(w, chk, opts.exportBackup, function () {
          if (typeof opts.onSessionChanged === 'function') opts.onSessionChanged(true);
          if (typeof opts.onDataChanged === 'function') opts.onDataChanged();
          if (after) after();
        });
      }, function (err) {
        M.toast('检查失败：' + (err && err.message ? err.message : '未知错误'));
        if (after) after();
      });
    }

    /** §4.7 的只读检查：只读云端与账号副本，读完再摆选择。 */
    function runRecoveryCheck(w, after) {
      var engine = w.getEngine();
      M.toast('正在读取云端…');
      Promise.resolve(engine.inspectRecovery()).then(function (chk) {
        if (!chk || !chk.ok) {
          M.toast('读取失败：' + ((chk && chk.message) || '未知错误'));
          if (after) after();
          return;
        }
        openChoiceFor(w, chk, opts.exportBackup, function () {
          if (typeof opts.onSessionChanged === 'function') opts.onSessionChanged(true);
          if (typeof opts.onDataChanged === 'function') opts.onDataChanged();
          if (after) after();
        });
      }, function (err) {
        M.toast('读取失败：' + (err && err.message ? err.message : '未知错误'));
        if (after) after();
      });
    }

    /** 按判定结果选对话框：首次同步 / 保守恢复 / 有损修复 / 重开确认。 */
    /** D9 的 onlyVersionLower 已提升为模块级（D21：autoChoiceFor 也要用它）。 */

    function openChoiceFor(w, chk, exportBackup, onDone) {
      /* D21：定向与提交统一走模块级 autoResolveChoice（app.js 的自愈循环也用它）。
         这里只剩「必须人工」的分支：按 manual 的 kind 打开对应对话框。 */
      autoResolveChoice(w, {
        snapshotBackup: opts.snapshotBackup,
        onSessionChanged: opts.onSessionChanged,
        onDataChanged: opts.onDataChanged
      }, function (r) {
        if (!r) { if (onDone) onDone(r); return; }
        if (r.manual) {
          if (r.kind === 'reopen-upload') {
            return openUploadConfirm({ wiring: w, check: chk, onDone: onDone });
          }
          if (r.kind === 'recovery' || r.kind === 'remote-missing') {
            return openRecovery({ wiring: w, check: chk, exportBackup: exportBackup, onDone: onDone });
          }
          return openFirstSync({ wiring: w, check: chk, exportBackup: exportBackup, onDone: onDone });
        }
        if (onDone) onDone(r);
      });
    }

    render();
    return { element: wrap, render: render };
  }

  /**
   * 登录面板。
   * mock：演示账号登录，不发请求。
   * real：用户名或邮箱 + 密码（D13：真实邮箱是 Auth 身份，用户名经装配层解析）。
   *       密码只在这一次请求里用，不落盘、不写日志、不回显。
   *       邮箱未验证（E_EMAIL_NOT_CONFIRMED）→ 转入验证码确认视图，不把人卡死。
   */
  function openSignIn(opts) {
    var w = opts.wiring;
    var mode = w.getMode();
    var body = el('div', {});

    if (mode === 'real') {
      body.appendChild(note('用用户名或邮箱 + 密码登录。密码不会保存在这台设备上，'
        + '保存的只有登录后拿到的令牌。还没有账号？点下面「注册新账号」。'));

      var accountIn = el('input', {
        class: 'input', type: 'text', placeholder: '用户名 / 邮箱',
        autocomplete: 'username'
      });
      var pwdIn = el('input', {
        class: 'input', type: 'password', placeholder: '密码',
        autocomplete: 'current-password'
      });
      body.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '账号' }),
        accountIn
      ]));
      body.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '密码' }),
        pwdIn
      ]));

      function goVerify(r, username) {
        var email = (r && (r.email || (r.message && ''))) || '';
        realCtx.close('verify');
        openEmailCodeVerify({
          wiring: w,
          email: String(email || accountIn.value || '').trim().toLowerCase(),
          username: username || '',
          onSessionChanged: opts.onSessionChanged,
          autoCheck: opts.autoCheck,
          onDone: opts.onDone
        });
      }

      var busy = false;
      var realCtx = M.open({
        title: '登录',
        body: body,
        showSubmit: false,
        showCancel: false,
        footer: [
          el('button', {
            class: 'btn btn-ghost', type: 'button', text: '注册新账号',
            onclick: function () {
              realCtx.close('register');
              openRegister({
                wiring: w,
                onSessionChanged: opts.onSessionChanged,
                autoCheck: opts.autoCheck,
                onDone: opts.onDone
              });
            }
          }),
          el('button', {
            class: 'btn btn-ghost', type: 'button', text: '忘记密码？',
            onclick: function () {
              realCtx.close('forgot');
              openForgotPassword({
                wiring: w,
                onSessionChanged: opts.onSessionChanged,
                autoCheck: opts.autoCheck,
                onDone: opts.onDone
              });
            }
          }),
          el('button', {
            class: 'btn btn-ghost', type: 'button', text: '取消',
            onclick: function () { realCtx.close('cancel'); }
          }),
          el('button', {
            class: 'btn btn-primary', type: 'button', text: '登录',
            onclick: function () {
              if (busy) return; // 双击会发两次请求，第二次必被限流
              var account = String(accountIn.value || '').trim();
              var pwd = String(pwdIn.value || '');
              if (account === '' || pwd === '') {
                realCtx.setError('请填写账号与密码');
                return;
              }
              busy = true;
              /* 邮箱输入直达 password grant；用户名先经 RPC 解析成邮箱（D13）。 */
              var ready = account.indexOf('@') >= 0
                ? Promise.resolve({ ok: true, email: account.toLowerCase(), username: '' })
                : Promise.resolve(w.lookupAccount(account));
              ready.then(function (lk) {
                if (!lk || !lk.ok) {
                  busy = false;
                  realCtx.setError((lk && lk.message) || '账号不存在');
                  return null;
                }
                return w.signIn(lk.email, pwd, lk.username).then(function (r) {
                  busy = false;
                  if (!r || !r.ok) {
                    if (r && r.code === 'E_EMAIL_NOT_CONFIRMED') {
                      goVerify(r, lk.username);
                      return;
                    }
                    realCtx.setError(loginErrorText(r));
                    return;
                  }
                  realCtx.close('done');
                  if (typeof opts.onSessionChanged === 'function') opts.onSessionChanged(true);
                  M.toast('已登录' + (lk.username ? ('：' + lk.username) : ('：' + (r.email || lk.email))));
                  scheduleAutoCheck(opts);
                }, function (err) {
                  busy = false;
                  realCtx.setError('登录失败：' + (err && err.code ? err.code : '未知错误'));
                });
              }, function (err) {
                busy = false;
                realCtx.setError('查找账号失败：' + (err && err.code ? err.code : '未知错误'));
              });
            }
          })
        ],
        onClose: function () { if (opts.onDone) opts.onDone(); }
      });
      return;
    }

    if (mode !== 'mock') {
      body.appendChild(note('当前模式不支持登录。'));
      M.open({
        title: '登录',
        body: body,
        showSubmit: false,
        cancelLabel: '关闭',
        onClose: function () { if (opts.onDone) opts.onDone(); }
      });
      return;
    }

    body.appendChild(note('演示登录：只为把界面流程走通，不会连接任何服务器，凭据是假的。'));

    var input = el('input', {
      class: 'input', type: 'text', value: 'demo-user',
      placeholder: '演示账号 id（字母/数字/下划线/连字符）'
    });
    body.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '演示账号' }),
      input
    ]));

    var ctx = M.open({
      title: '登录（演示）',
      body: body,
      showSubmit: false,
      showCancel: false,
      footer: [
        el('button', {
          class: 'btn btn-ghost', type: 'button', text: '取消',
          onclick: function () { ctx.close('cancel'); }
        }),
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '演示登录',
          onclick: function () {
            var uid = String(input.value || '').trim();
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
              ctx.setError('账号只能是字母、数字、下划线或连字符，且不超过 128 位');
              return;
            }
            w.signInDemo(uid).then(function (r) {
              if (!r || !r.ok) {
                ctx.setError('登录失败：' + ((r && r.code) || '未知错误'));
                return;
              }
              ctx.close('done');
              if (typeof opts.onSessionChanged === 'function') opts.onSessionChanged(true);
              M.toast('已登录（演示）：' + uid);
            }, function (err) {
              ctx.setError('登录失败：' + (err && err.message ? err.message : '未知错误'));
            });
          }
        })
      ],
      onClose: function () { if (opts.onDone) opts.onDone(); }
    });
  }

  /**
   * 首次同步确认（§4.3 的唯一写入门槛）。
   * 检查阶段已经保证零写入，这里才允许选边。
   */
  /** 登录 / 验证 / 重置成功后自动跑一次引擎检查（D14：免点「开始检查」）。
      只在装配层把 autoCheck 传进来时生效；失败时面板的「开始检查」仍在。 */
  function scheduleAutoCheck(opts) {
    if (opts && typeof opts.autoCheck === 'function') setTimeout(opts.autoCheck, 0);
  }

  /** 把登录错误码翻成用户能照着做的一句话。 */
  function loginErrorText(r) {
    var code = r && r.code ? r.code : '';
    if (code === 'E_INVALID_CREDENTIALS') return '账号或密码不正确';
    if (code === 'E_EMAIL_NOT_CONFIRMED') return '邮箱还没验证：输入邮箱里的验证码即可';
    if (code === 'E_RATE_LIMIT') return '尝试过于频繁，请等一会儿再试';
    if (code === 'E_NETWORK' || code === 'E_TIMEOUT') return '连不上服务器，检查网络后重试';
    if (code === 'E_PERSIST') return '登录成功但凭据存不进本机存储，可能是存储被禁用或已满';
    if (code === 'E_NOT_FOUND') return '账号不存在，先注册一个';
    return '登录失败（' + (code || '未知错误') + '）';
  }

  /**
   * 注册（D13，2026-10-27 用户裁定）：用户名 + 真实邮箱 + 密码。
   * 一个邮箱一个账号由 Supabase Auth 唯一性兜底；用户名唯一在 profiles。
   * 成功后走邮箱验证码（openEmailCodeVerify）：确认邮件本身就是验证邮件。
   * 手机号通道已整体裁剪（数据库列与 SQL 指南同步清理）。
   */
  function openRegister(opts) {
    var w = opts.wiring;

    var usernameIn = el('input', {
      class: 'input', type: 'text', placeholder: '3-24 位小写字母、数字、_ 或 -',
      autocomplete: 'username'
    });
    var emailIn = el('input', {
      class: 'input', type: 'email', placeholder: '用于接收验证码和找回密码',
      autocomplete: 'email'
    });
    var pwdIn = el('input', {
      class: 'input', type: 'password', placeholder: '至少 8 位',
      autocomplete: 'new-password'
    });

    var body = el('div', {});
    body.appendChild(note('注册后会给这个邮箱发一封验证码确认邮件，输入验证码即完成注册。'
      + '一个邮箱只能注册一个账号。'));
    body.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '用户名' }), usernameIn
    ]));
    body.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '邮箱' }), emailIn
    ]));
    body.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '密码' }), pwdIn
    ]));

    function localValidate() {
      var username = String(usernameIn.value || '').trim().toLowerCase();
      var email = String(emailIn.value || '').trim().toLowerCase();
      var pwd = String(pwdIn.value || '');
      if (username === '' || email === '' || pwd === '') return '请填写全部字段';
      if (!/^[a-z0-9_-]{3,24}$/.test(username)) return '用户名需 3-24 位小写字母、数字、下划线或连字符';
      if (email.indexOf('@') < 0 || email.indexOf('.') < 0) return '邮箱格式不对';
      if (pwd.length < 8) return '密码至少 8 位';
      return null;
    }

    var busy = false;
    var ctx = M.open({
      title: '注册新账号',
      body: body,
      showSubmit: false,
      showCancel: false,
      footer: [
        el('button', {
          class: 'btn btn-ghost', type: 'button', text: '返回登录',
          onclick: function () {
            ctx.close('back');
            openSignIn({ wiring: w, onSessionChanged: opts.onSessionChanged, onDone: opts.onDone });
          }
        }),
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '注册',
          onclick: function () {
            if (busy) return;
            var bad = localValidate();
            if (bad) { ctx.setError(bad); return; }
            busy = true;
            var username = String(usernameIn.value || '').trim().toLowerCase();
            var email = String(emailIn.value || '').trim().toLowerCase();
            w.registerAccount({
              username: username,
              email: email,
              password: String(pwdIn.value || '')
            }).then(function (r) {
              busy = false;
              if (!r || !r.ok) {
                ctx.setError((r && r.message) || (r && r.code) || '注册失败');
                return;
              }
              if (r.needsVerification) {
                // 预期路径：确认邮件（含验证码）已发出，转验证码视图
                ctx.close('verify');
                openEmailCodeVerify({
                  wiring: w,
                  email: r.email || email,
                  username: r.username || username,
                  onSessionChanged: opts.onSessionChanged,
                  autoCheck: opts.autoCheck,
                  onDone: opts.onDone
                });
                return;
              }
              /* 项目关掉了 Confirm email 的少见配置：直接拿到会话，照常进入。 */
              ctx.close('done');
              if (typeof opts.onSessionChanged === 'function') opts.onSessionChanged(true);
              M.toast('注册成功，已登录：' + (r.username || username));
              scheduleAutoCheck(opts);
            }, function (err) {
              busy = false;
              ctx.setError('注册失败：' + (err && err.code ? err.code : '未知错误'));
            });
          }
        })
      ],
      onClose: function () { if (opts.onDone) opts.onDone(); }
    });
  }

  /**
   * 邮箱验证码确认（D13，注册与登录补验证共用）。
   * 码来自注册确认邮件（模板 {{ .Token }}，6~10 位数字，位数由 Supabase OTP 设置决定）；重发走 /auth/v1/resend。
   * username 只在「刚注册」时传——profiles 别名要等验证成功拿到会话才补写。
   */
  function openEmailCodeVerify(opts) {
    var w = opts.wiring;
    var email = String(opts.email || '').trim().toLowerCase();
    var username = String(opts.username || '');

    var body = el('div', {});
    body.appendChild(note('验证码已发送到 ' + email + '（注册确认邮件，若没收到请看垃圾箱）。'
      + '输入邮件里的验证码完成验证，之后即可正常登录。'));

    var codeIn = el('input', {
      class: 'input', type: 'text', placeholder: '邮箱里的验证码', inputmode: 'numeric',
      maxlength: '10', autocomplete: 'one-time-code'
    });
    body.appendChild(el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: '验证码' }), codeIn
    ]));

    var resendBtn = el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', text: '重新发送验证码',
      onclick: function () {
        resendBtn.disabled = true;
        w.resendEmailCode(email, 'signup').then(function (r) {
          M.toast((r && r.ok) ? '验证码已重新发送' : '发送失败：' + ((r && r.message) || '未知错误'));
          if (typeof setTimeout === 'function') {
            setTimeout(function () { resendBtn.disabled = false; }, 60000);
          } else {
            resendBtn.disabled = false;
          }
        }, function () {
          resendBtn.disabled = false;
          M.toast('发送失败，请检查网络');
        });
      }
    });
    body.appendChild(resendBtn);

    var busy = false;
    var ctx = M.open({
      title: '验证邮箱',
      body: body,
      showSubmit: false,
      showCancel: false,
      footer: [
        el('button', {
          class: 'btn btn-ghost', type: 'button', text: '取消',
          onclick: function () { ctx.close('cancel'); }
        }),
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '验证并登录',
          onclick: function () {
            if (busy) return;
            var code = String(codeIn.value || '').trim();
            if (code === '') { ctx.setError('请输入验证码'); return; }
            busy = true;
            w.verifyEmailCode({ email: email, code: code, username: username }).then(function (r) {
              busy = false;
              if (!r || !r.ok) {
                ctx.setError((r && r.message) || (r && r.code) || '验证失败');
                return;
              }
              ctx.close('done');
              if (typeof opts.onSessionChanged === 'function') opts.onSessionChanged(true);
              M.toast('邮箱验证完成，已登录' + (username ? ('：' + username) : ''));
              scheduleAutoCheck(opts);
            }, function (err) {
              busy = false;
              ctx.setError('验证失败：' + (err && err.code ? err.code : '未知错误'));
            });
          }
        })
      ],
      onClose: function () { if (opts.onDone) opts.onDone(); }
    });
  }

  /**
   * 忘记密码（D13）：两步对话框。
   * 第一步输邮箱发重置邮件（防枚举：邮箱不存在也提示已发送）；
   * 第二步输邮件里的 6 位码 + 新密码，验证通过即改密并直接登录。
   * footer 回调只会由用户点击触发，那时 `var ctx = M.open(...)` 已完成赋值，
   * 所以闭包里引用 ctx 是安全的（与 openSignIn 同一模式）。
   */
  function openForgotPassword(opts) {
    var w = opts.wiring;

    function step2(email) {
      var body = el('div', {});
      body.appendChild(note('验证码已发送到 ' + email + '（重置密码邮件，若没收到请看垃圾箱）。'));
      var codeIn = el('input', {
        class: 'input', type: 'text', placeholder: '邮箱里的验证码', inputmode: 'numeric', maxlength: '10'
      });
      var pwdIn = el('input', {
        class: 'input', type: 'password', placeholder: '新密码（至少 8 位）',
        autocomplete: 'new-password'
      });
      body.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '验证码' }), codeIn
      ]));
      body.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '新密码' }), pwdIn
      ]));

      var resendBtn = el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', text: '重新发送验证码',
        onclick: function () {
          resendBtn.disabled = true;
          w.resendEmailCode(email, 'recovery').then(function (r) {
            M.toast((r && r.ok) ? '验证码已重新发送' : '发送失败：' + ((r && r.message) || '未知错误'));
            if (typeof setTimeout === 'function') {
              setTimeout(function () { resendBtn.disabled = false; }, 60000);
            } else {
              resendBtn.disabled = false;
            }
          }, function () {
            resendBtn.disabled = false;
            M.toast('发送失败，请检查网络');
          });
        }
      });
      body.appendChild(resendBtn);

      var busy = false;
      var ctx2 = M.open({
        title: '忘记密码 · 2/2',
        body: body,
        showSubmit: false,
        showCancel: false,
        footer: [
          el('button', {
            class: 'btn btn-ghost', type: 'button', text: '取消',
            onclick: function () { ctx2.close('cancel'); }
          }),
          el('button', {
            class: 'btn btn-primary', type: 'button', text: '重置密码并登录',
            onclick: function () {
              if (busy) return;
              var code = String(codeIn.value || '').trim();
              var pwd = String(pwdIn.value || '');
              if (code === '') { ctx2.setError('请输入验证码'); return; }
              if (pwd.length < 8) { ctx2.setError('密码至少 8 位'); return; }
              busy = true;
              w.resetPassword({ email: email, code: code, newPassword: pwd }).then(function (r) {
                busy = false;
                if (!r || !r.ok) {
                  ctx2.setError((r && r.message) || (r && r.code) || '重置失败');
                  return;
                }
                ctx2.close('done');
                if (typeof opts.onSessionChanged === 'function') opts.onSessionChanged(true);
                M.toast('密码已更新，已登录');
                scheduleAutoCheck(opts);
              }, function (err) {
                busy = false;
                ctx2.setError('重置失败：' + (err && err.code ? err.code : '未知错误'));
              });
            }
          })
        ],
        onClose: function () { if (opts.onDone) opts.onDone(); }
      });
    }

    function step1() {
      var body = el('div', {});
      body.appendChild(note('输入注册时的邮箱，我们会发送一封验证码邮件。'
        + '出于安全考虑，即使邮箱不存在也会提示已发送——请以是否收到邮件为准。'));
      var emailIn = el('input', {
        class: 'input', type: 'email', placeholder: '注册邮箱',
        autocomplete: 'email'
      });
      body.appendChild(el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: '邮箱' }), emailIn
      ]));

      var busy = false;
      var ctx = M.open({
        title: '忘记密码 · 1/2',
        body: body,
        showSubmit: false,
        showCancel: false,
        footer: [
          el('button', {
            class: 'btn btn-ghost', type: 'button', text: '返回登录',
            onclick: function () {
              ctx.close('back');
              openSignIn({ wiring: w, onSessionChanged: opts.onSessionChanged, onDone: opts.onDone });
            }
          }),
          el('button', {
            class: 'btn btn-primary', type: 'button', text: '发送验证码',
            onclick: function () {
              if (busy) return;
              var email = String(emailIn.value || '').trim().toLowerCase();
              if (email === '' || email.indexOf('@') < 0) {
                ctx.setError('请输入有效的邮箱地址');
                return;
              }
              busy = true;
              w.requestPasswordReset(email).then(function (r) {
                busy = false;
                if (!r || !r.ok) {
                  ctx.setError((r && r.message) || '发送失败');
                  return;
                }
                ctx.close('sent');
                step2(email);
              }, function () {
                busy = false;
                ctx.setError('发送失败，请检查网络');
              });
            }
          })
        ],
        onClose: function () { if (opts.onDone) opts.onDone(); }
      });
    }

    step1();
  }

  /* D11（2026-10-27 裁定）：openConnect（「连接 Supabase…」URL/key 弹窗）已随
     自建项目通道整体移除——内置云服务是唯一入口，describeKeyError 一并下线。 */

  function openFirstSync(opts) {
    var w = opts.wiring;
    var chk = opts.check;
    var engine = w.getEngine();
    var kind = chk.case;
    var info = CASE_TEXT[kind] || { title: '云端状态未知', desc: '' };

    var body = el('div', {});
    body.appendChild(el('div', { class: 'field-label', text: info.title }));
    if (info.desc) body.appendChild(note(info.desc));

    if (kind === 'C') {
      body.appendChild(note('以本机为准会覆盖云端的那一份；以云端为准会替换本机。'
        + '无论选哪边，提交前都会先自动导出一份本机 JSON 备份；导出失败就不覆盖。'));
    }
    if (kind === 'B' || kind === 'C') {
      if (chk.remote && !chk.remoteValid) {
        body.appendChild(note('云端这份数据没通过校验，不能选「以云端为准」。'));
      }
    }

    /**
     * 覆盖前的强制导出（契约 §4.2 C「任一覆盖前必须导出本地 JSON」、
     * §4.7「先强制导出账号候选 JSON」）。
     *
     * 为什么必须拦在这里：C 情况两个按钮都会造成不可逆覆盖——选「以本机为准」
     * 抹掉云端那一份，选「以云端为准」抹掉本机这一份。没有导出，之前那句
     * 「选错了要靠备份恢复」就是空话。导出失败一律不提交：宁可这次不同步，
     * 也不要在用户不知情的时候把一边的数据去掉。
     */
    function exportBeforeOverwrite() {
      if (typeof opts.exportBackup !== 'function') {
        // 没有导出能力就不许覆盖（fail closed），与「导出失败」同等对待。
        throw new Error('当前没有可用的导出通道');
      }
      opts.exportBackup();
    }

    function commit(choice) {
      if (kind === 'C') {
        try {
          exportBeforeOverwrite();
        } catch (e) {
          ctx.setError('导出备份失败，已取消覆盖（两边数据都还在）：'
            + (e && e.message ? e.message : '未知原因'));
          return;
        }
      }
      engine.confirm(choice).then(function (res) {
        if (!res || !res.ok) {
          M.toast('同步失败：' + ((res && res.message) || (res && res.code) || '未知错误'));
          ctx.close('failed');
          return;
        }
        ctx.close('done');
        M.toast(choice === 'remote' ? '已以云端为准' : '已上传本机数据');
      }, function (err) {
        M.toast('同步失败：' + (err && err.message ? err.message : '未知错误'));
        ctx.close('failed');
      });
    }

    var footer = [];
    var canRemote = !!(chk.remote && chk.remoteValid);

    if (kind === 'A') {
      footer.push(el('button', {
        class: 'btn btn-ghost', type: 'button', text: '暂不上传',
        onclick: function () { ctx.close('cancel'); }
      }));
      footer.push(el('button', {
        class: 'btn btn-primary', type: 'button', text: '上传本机数据',
        onclick: function () { commit('local'); }
      }));
    } else if (kind === 'B') {
      footer.push(el('button', {
        class: 'btn btn-ghost', type: 'button', text: '保持本机为空',
        onclick: function () { ctx.close('cancel'); }
      }));
      footer.push(el('button', {
        class: 'btn btn-primary', type: 'button', text: '以云端为准',
        disabled: !canRemote,
        onclick: function () { if (canRemote) commit('remote'); }
      }));
    } else if (kind === 'C') {
      footer.push(el('button', {
        class: 'btn btn-ghost', type: 'button', text: '暂不处理',
        onclick: function () { ctx.close('cancel'); }
      }));
      footer.push(el('button', {
        class: 'btn', type: 'button', text: '以云端为准',
        disabled: !canRemote,
        onclick: function () { if (canRemote) commit('remote'); }
      }));
      footer.push(el('button', {
        class: 'btn btn-primary', type: 'button', text: '以本机为准（覆盖云端）',
        onclick: function () { commit('local'); }
      }));
    } else {
      footer.push(el('button', {
        class: 'btn btn-ghost', type: 'button', text: '暂不开启',
        onclick: function () { ctx.close('cancel'); }
      }));
      footer.push(el('button', {
        class: 'btn btn-primary', type: 'button', text: '开始同步',
        onclick: function () { commit('local'); }
      }));
    }

    var ctx = M.open({
      title: '首次同步',
      choice: true, /* D22d：决策框标记（自愈循环让路） */
      body: body,
      showSubmit: false,
      showCancel: false,
      footer: footer,
      onClose: function () { if (opts.onDone) opts.onDone(); }
    });
  }

  /**
   * §4.7 保守恢复：记录丢失/损坏，或者云端行已经不在。
   *
   * 只有三个选项，且必须说清「这次没有自动合并、也没有自动上传」——
   * 用户此刻最需要知道的是：两边数据都还在，什么都还没被覆盖。
   *
   * 两种覆盖都不可逆（以本机为准抹掉云端那份，以云端为准抹掉本机那份），
   * 所以和首次同步的 C 情况一样，提交前**强制导出**，导出失败就取消（fail closed）。
   * 没有账号副本时不给「以本机为准」：游客数据不参与同步，拿它冒充候选
   * 就是把游客内容推到账号行（§4.7.3）。
   */
  function openRecovery(opts) {
    var w = opts.wiring;
    var chk = opts.check;
    var engine = w.getEngine();
    var missing = chk.kind === 'remote-missing';
    var body = el('div', {});

    function pad2(n) { return String(n).padStart(2, '0'); }
    function fmtWhen(iso) {
      if (!iso) return '';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    function summaryText(s, emptyText) {
      if (!s) return emptyText;
      var parts = ['条目 ' + s.items];
      var extra = s.total - s.items;
      if (extra > 0) parts.push('另有 ' + extra + ' 项其他内容');
      if (typeof s.revision === 'number') parts.push('云端版本 ' + s.revision);
      if (s.updatedAt) parts.push('最后修改 ' + fmtWhen(s.updatedAt));
      return parts.join(' · ');
    }

    body.appendChild(el('div', {
      class: 'field-label',
      text: missing ? '云端已经没有这份数据了' : '本机的同步记录丢失或损坏了'
    }));
    body.appendChild(note(missing
      ? '云端这个账号下已经没有数据了（可能是在另一台设备上删掉了）。本机还保留着一份，'
        + '是否重新上传由你决定，不会自动重建。'
      : '这台设备曾经同步过，但本机保存的同步记录丢失或损坏了。既然不知道上次同步到哪一步，'
        + '这次不会自动合并、也不会自动上传。'));

    body.appendChild(el('div', { class: 'field' }, [
      el('div', { class: 'field-label', text: '云端' }),
      el('div', { text: summaryText(chk.remoteSummary, '没有数据') })
    ]));
    body.appendChild(el('div', { class: 'field' }, [
      el('div', { class: 'field-label', text: '本机（该账号的数据副本）' }),
      el('div', {
        text: summaryText(chk.local && chk.local.summary, '这台设备上没有该账号的数据副本')
      })
    ]));

    if (chk.remote && !chk.remoteValid) {
      body.appendChild(note('云端这份数据没通过校验，不能选「以云端为准」。'));
    }
    if (!(chk.local && chk.local.available)) {
      body.appendChild(note('没有账号副本，所以不能选「以本机为准」。游客数据不参与同步，也不会被上传。'));
    }
    body.appendChild(note('两个覆盖选项都会替换掉其中一边，提交前会先自动导出一份本机 JSON；'
      + '导出失败就取消，两边数据都保留。'));

    function commit(choice) {
      /* 导出拦在最前面：导出不了就不许覆盖，宁可这次不同步。 */
      if (typeof opts.exportBackup !== 'function') {
        ctx.setError('当前没有可用的导出通道，已取消覆盖（两边数据都还在）');
        return;
      }
      try {
        opts.exportBackup();
      } catch (e) {
        ctx.setError('导出备份失败，已取消覆盖（两边数据都还在）：'
          + (e && e.message ? e.message : '未知原因'));
        return;
      }
      Promise.resolve(engine.resolveRecovery(choice)).then(function (res) {
        if (!res || !res.ok) {
          M.toast('未能完成：' + ((res && res.message) || (res && res.code) || '未知错误'));
          ctx.close('failed');
          return;
        }
        ctx.close('done');
        M.toast(choice === 'remote' ? '已以云端为准' : '已上传本机数据');
      }, function (err) {
        M.toast('未能完成：' + (err && err.message ? err.message : '未知错误'));
        ctx.close('failed');
      });
    }

    var canRemote = !!(chk.options && chk.options.remote);
    var canLocal = !!(chk.options && chk.options.local);

    var footer = [
      el('button', {
        class: 'btn btn-ghost', type: 'button', text: '暂停同步',
        title: '本机继续使用，云端不做任何改动',
        onclick: function () {
          Promise.resolve(engine.resolveRecovery('pause')).then(function () {
            ctx.close('paused');
            M.toast('已暂停同步，本机数据照常使用');
          });
        }
      }),
      el('button', {
        class: 'btn', type: 'button', text: '以云端为准',
        disabled: !canRemote,
        onclick: function () { if (canRemote) commit('remote'); }
      }),
      el('button', {
        class: 'btn btn-primary', type: 'button', text: '以本机为准（覆盖云端）',
        disabled: !canLocal,
        onclick: function () { if (canLocal) commit('local'); }
      })
    ];

    var ctx = M.open({
      title: '恢复同步',
      choice: true, /* D22d：决策框标记（自愈循环让路） */
      body: body,
      showSubmit: false,
      showCancel: false,
      footer: footer,
      onClose: function () { if (opts.onDone) opts.onDone(); }
    });
  }

  /**
   * §1.8 有损修复预览与确认。
   *
   * 两个硬条件（缺一不可）：勾选 + **两份指定文件名的 JSON 都已下载**。
   * 界面这边唯一能做的诚实保证是「文件真的被递给了浏览器」；
   * 引擎那边核对的是同一份清单，所以改名必须两边一起改（见 lossyGate.REQUIRED_DOWNLOADS）。
   */
  function openLossy(opts) {
    var w = opts.wiring;
    var engine = w.getEngine();
    var chk = opts.check || {};
    var pv = chk.preview || {};
    var counts = pv.counts || {};
    var raw = typeof engine.getLossyPayload === 'function' ? engine.getLossyPayload() : null;
    var body = el('div', {});

    body.appendChild(el('div', { class: 'field-label', text: '云端这份数据需要先修复才能应用' }));
    body.appendChild(note('修复会丢弃或改写下面这些内容。这次没有应用，本机一个字节都没动。'
      + '继续之前必须先下载两份 JSON —— 那是万一后悔时唯一的退路。'));

    var parts = [];
    function add(label, n) { if (n > 0) parts.push(label + ' ' + n); }
    add('丢弃事项', counts.items);
    add('丢弃类别', counts.categories);
    add('改变类别引用', counts.categoryRefs);
    add('清空时段', counts.times);
    add('截断文本', counts.texts);
    add('丢弃重复规则', counts.exceptions);
    add('丢弃日记录', counts.notes);
    add('丢弃周记录', counts.weekNotes);
    add('丢弃月计划', counts.monthPlans);
    add('其他警告', counts.warnings);

    body.appendChild(el('div', { class: 'field' }, [
      el('div', { class: 'field-label', text: '会被影响的内容' }),
      el('div', { text: parts.length ? parts.join(' · ') : '（没有统计到具体条目）' })
    ]));

    if (pv.titles && pv.titles.length) {
      body.appendChild(el('div', { class: 'field' }, [
        el('div', { class: 'field-label', text: '前几条会消失的' }),
        el('div', { text: pv.titles.join('、') })
      ]));
    }
    if (chk.warnings && chk.warnings.length) {
      body.appendChild(note('修复时的提示：'
        + chk.warnings.slice(0, 5).map(function (x) { return x.message; }).join('；')));
    }
    if (!raw) {
      /* 预览只存在内存里：页面刷新过就没了。此时绝不能让「继续」可用——
         没有原始 payload 就没有 remote-raw.json，等于没有退路。 */
      body.appendChild(note('这份预览已经失效（页面刷新过）。请点「开始检查」重新读取云端。'));
    }

    var downloaded = { 'remote-raw.json': false, 'local-current.json': false };
    var confirmed = false;

    var goBtn = el('button', {
      class: 'btn btn-primary', type: 'button', text: '继续应用', disabled: true,
      onclick: function () { commit(); }
    });

    function refresh() {
      var ready = confirmed && downloaded['remote-raw.json'] && downloaded['local-current.json'];
      goBtn.disabled = !ready;
      goBtn.title = ready ? '' : '需要先勾选，并成功下载两份 JSON';
      if (ready) goBtn.removeAttribute('title');
    }

    function doDownload(name, payload) {
      if (typeof opts.downloadJson !== 'function') {
        ctx.setError('当前没有可用的下载通道，已取消（两边数据都还在）');
        return;
      }
      try {
        opts.downloadJson(name, payload);
        downloaded[name] = true;
      } catch (e) {
        downloaded[name] = false;
        ctx.setError('下载 ' + name + ' 失败，已取消：「继续应用」不会解锁');
      }
      refresh();
      if (downloaded[name]) M.toast('已下载 ' + name);
    }

    var box = el('input', { type: 'checkbox' });
    box.addEventListener('change', function () { confirmed = !!box.checked; refresh(); });

    var dlRow = row([
      el('button', {
        class: 'btn btn-sm', type: 'button', text: '下载 remote-raw.json',
        disabled: !raw,
        onclick: function () { doDownload('remote-raw.json', engine.getLossyPayload()); }
      }),
      el('button', {
        class: 'btn btn-sm', type: 'button', text: '下载 local-current.json',
        disabled: typeof opts.exportDocument !== 'function',
        onclick: function () {
          var doc = null;
          try { doc = opts.exportDocument(); } catch (e) { doc = null; }
          if (!doc) { ctx.setError('读取本机数据失败，无法导出'); return; }
          doDownload('local-current.json', doc);
        }
      })
    ]);
    body.appendChild(dlRow);
    body.appendChild(el('label', { class: 'inline' }, [box, el('span', { text: '我确认要丢弃上面这些内容' })]));

    function commit() {
      if (goBtn.disabled) return;
      var have = [];
      if (downloaded['remote-raw.json']) have.push('remote-raw.json');
      if (downloaded['local-current.json']) have.push('local-current.json');
      Promise.resolve(engine.applyLossy({ confirmed: true, downloads: have })).then(function (res) {
        if (!res || !res.ok) {
          ctx.setError('未能应用：' + ((res && (res.message || res.code)) || '未知错误'));
          return;
        }
        ctx.close('applied');
        if (res.requires === 'confirm-push') {
          openLossyPush({ wiring: w, onDone: opts.onDone });
        } else if (opts.onDone) {
          opts.onDone();
        }
      }, function (err) {
        ctx.setError('未能应用：' + (err && err.message ? err.message : '未知错误'));
      });
    }

    var ctx = M.open({
      title: '有损修复预览',
      choice: true, /* D22d：决策框标记（自愈循环让路） */
      body: body,
      showSubmit: false,
      showCancel: false,
      footer: [
        el('button', {
          class: 'btn btn-ghost', type: 'button', text: '暂不应用',
          title: '本机与云端都保持原样',
          onclick: function () { ctx.close('cancel'); }
        }),
        goBtn
      ],
      onClose: function () { if (opts.onDone) opts.onDone(); }
    });
  }

  /**
   * D16 自动恢复：本机同步记录丢失时以云端为准。
   *
   * D19（2026-10-28）修正：**自动路径不再向浏览器下载任何文件**。
   * 以前这里会「静默备份」＝真的触发一次文件下载，而这段逻辑可能在每次刷新、
   * 每次自动检查时重跑，用户看到的就是「一直在下载各种备份，就是同步不上」。
   * 现在备份只写进本机 localStorage（环形保留最近 3 份），要文件的人可以在
   * 设置里手动导出；不给用户的，就一个字节也不下载。
   */
  function autoRecoveryRemote(w, helpers, onDone) {
    if (typeof helpers === 'function') { onDone = helpers; helpers = {}; }
    helpers = helpers || {};
    var engine = w.getEngine();
    try { if (typeof helpers.snapshotBackup === 'function') helpers.snapshotBackup('recovery'); } catch (eBak) { /* 自动路径不被备份失败卡住 */ }
    Promise.resolve(engine.resolveRecovery('remote')).then(function (res) {
      if (!res || !res.ok) {
        M.toast('未能自动恢复：' + ((res && (res.message || res.code)) || '未知错误') + '，可点「继续选择」手动处理');
      } else {
        M.toast('已以云端为准恢复同步');
      }
      if (typeof helpers.onSessionChanged === 'function') helpers.onSessionChanged(true);
      if (typeof helpers.onDataChanged === 'function') helpers.onDataChanged();
      if (onDone) onDone();
    }, function (err) {
      M.toast('未能自动恢复：' + (err && err.message ? err.message : '未知错误'));
      if (onDone) onDone();
    });
  }

  /**
   * D16 自动有损修复：应用修复后的云端数据并写回，全程不弹框。
   * 备份两份（本机账号副本 + 云端原始 payload）都尽力而为；
   * 下载在手机上常被拦，所以引擎按 auto 标记放行下载门槛（契约 §4.6.5 例外）。
   * D17：提到模块级并显式收 helpers，app.js 的启动/登录恢复路径同样复用。
   */
  function autoLossyApply(w, helpers, onDone) {
    if (typeof helpers === 'function') { onDone = helpers; helpers = {}; }
    helpers = helpers || {};
    var engine = w.getEngine();
    /* D19：自动修复同样**不下载**任何文件（见 autoRecoveryRemote 的注释）。
       云端原始 payload 与本机副本都只写进 localStorage 快照，留给需要时查看。 */
    try {
      if (typeof helpers.snapshotBackup === 'function') {
        helpers.snapshotBackup('lossy', typeof engine.getLossyPayload === 'function'
          ? engine.getLossyPayload() : null);
      }
    } catch (eBak) { /* 快照失败不阻塞自动修复 */ }
    Promise.resolve(engine.applyLossy({ confirmed: true, downloads: [], auto: true })).then(function (res) {
      if (!res || !res.ok) {
        M.toast('云端数据未能自动修复：' + ((res && (res.message || res.code)) || '未知错误') + '，两端数据都还在');
        if (onDone) onDone();
        return;
      }
      if (res.requires === 'confirm-push') {
        /* 修复已落到本机，写回云端按同一裁定自动完成 */
        Promise.resolve(engine.confirmLossyPush()).then(function (r2) {
          M.toast((r2 && r2.ok) ? '云端数据已自动修复并写回' : '修复已应用，写回云端失败（可稍后重试）');
          if (onDone) onDone();
        }, function () {
          M.toast('修复已应用，写回云端失败（可稍后重试）');
          if (onDone) onDone();
        });
        return;
      }
      M.toast('云端数据已自动修复并应用');
      if (onDone) onDone();
    }, function (err) {
      M.toast('云端数据未能自动修复：' + (err && err.message ? err.message : '未知错误'));
      if (onDone) onDone();
    });
  }

  /**
   * D19（2026-10-28）：修复结果**自动写回云端**，不再弹第二次确认。
   *
   * 为什么改：用户口径是「登录后不要有任何需要额外操作的地方」。有损修复是
   * 系统自己判定的（云端数据需要归一），却要人再点一次「写回」，这正是他
   * 最反感的那种多余步骤。写回失败（网络）时保持记录里的 pending 标记，
   * 由自愈循环自动重试——不是让同步永久停在那里。
   */
  function autoLossyPush(w, helpers, onDone) {
    if (typeof helpers === 'function') { onDone = helpers; helpers = {}; }
    helpers = helpers || {};
    var engine = w.getEngine();
    Promise.resolve(engine.confirmLossyPush()).then(function (res) {
      if (res && res.ok) {
        M.toast('已自动修复云端数据');
      } else {
        M.toast('修复结果待写回，稍后自动重试');
      }
      if (typeof helpers.onDataChanged === 'function') helpers.onDataChanged();
      if (onDone) onDone();
    }, function () {
      M.toast('修复结果待写回，稍后自动重试');
      if (onDone) onDone();
    });
  }

  /**
   * D21：检查结果的**自动定向判定**（从 openChoiceFor 提炼，独立于面板存在）。
   * 返回 'local' | 'remote' | null；null = 这类结果必须由人决定，不许自动。
   * 判定顺序与 openChoiceFor 一致：A/D 无条件本机；B 必须云端合法才取云端；
   * C 依次为「云端仅版本低 → 本机接管」「本机是演示内容 → 取云端」「内容相同 → 本机」
   * 「两边都有真实内容 → 本机（LWW）」；都不匹配才落回人工。
   */
  function onlyVersionLower(chk) {
    var errs = (chk && chk.errors) || [];
    if (!errs.length) return false;
    return errs.every(function (e) {
      return !!e && e.path === '$.schemaVersion'
        && String(e.message || '').indexOf('版本较低') !== -1;
    });
  }

  function autoChoiceFor(chk) {
    if (!chk) return null;
    if (chk.case === 'A' || chk.case === 'D') return 'local';
    if (chk.case === 'B') {
      return (chk.remote && chk.remoteValid) ? 'remote' : null;
    }
    if (chk.case === 'C') {
      if (chk.remote && !chk.remoteValid && onlyVersionLower(chk)) return 'local';
      if (chk.remoteValid && chk.localIsDemo) return 'remote';
      if (chk.remoteValid && chk.sameContent) return 'local';
      if (chk.remoteValid) return 'local';
      return null;
    }
    return null;
  }

  /**
   * D21（2026-10-29）：检查结果的**自动定向 + 提交**，不再依赖设置面板打开。
   *
   * 为什么要独立成模块级函数：D16~D20 已把 A/B/C/D、lossy、recovery 全部裁定为
   * 自动路径，但执行体一直住在设置面板里——面板没打开（或用户从不点设置）时
   * 没有任何人执行它们。自动 confirm 一旦失败（一次网络抖动就够），引擎停在
   * awaiting-choice 或 signed-in，而自愈循环只认 paused-error+retryable、
   * engine.resume 对无记录的 signed-in 只回 E_NOT_ACTIVE skip——从此整条同步
   * 链死寂，直到用户碰巧再点开设置。用户看到的就是「每次点设置都在检查云端、
   * 都有继续选择」，而云端从来没收到过数据。
   *
   * @returns {Promise<{ok:boolean, manual?:boolean, kind?:string, code?, message?}>}
   *   manual=true → 必须人工（reopen-upload / remote-missing / 恢复对话框 / 未识别），
   *                 调用方决定是否打开面板；ok=true 已提交；ok=false 提交失败。
   */
  function autoResolveChoice(w, helpers, onDone) {
    if (typeof helpers === 'function') { onDone = helpers; helpers = {}; }
    helpers = helpers || {};

    function finish(r) {
      if (onDone) onDone(r);
      return Promise.resolve(r);
    }
    var engine = w && typeof w.getEngine === 'function' ? w.getEngine() : null;
    if (!engine) return finish({ ok: false, code: 'E_NO_ENGINE', message: '同步引擎不可用' });
    var chk = typeof engine.getCheck === 'function' ? engine.getCheck() : null;
    if (!chk) return finish({ ok: false, code: 'E_NO_CHECK', message: '没有可用的检查结果' });

    var kind = chk.kind;
    /* 这三个分支的执行体（autoLossyApply 等）不返回 promise、只回调 onDone——
       用 promise 包住回调，保证 autoResolveChoice 的返回值等到真正完成才 resolve。 */
    if (kind === 'lossy') {
      return new Promise(function (res) {
        autoLossyApply(w, helpers, function () { res({ ok: true, kind: 'lossy' }); });
      }).then(finish);
    }
    if (kind === 'recovery' && chk.options && chk.options.remote) {
      return new Promise(function (res) {
        autoRecoveryRemote(w, helpers, function () { res({ ok: true, kind: 'recovery' }); });
      }).then(finish);
    }
    if (kind === 'lossy-applied') {
      return new Promise(function (res) {
        autoLossyPush(w, helpers, function () { res({ ok: true, kind: 'lossy-applied' }); });
      }).then(finish);
    }
    /* 这些必须人来：重开上传确认（违背删除意图的关闭期上传）、云端行丢失、
       恢复对话框里「以云端为准」不可用（缺远端候选）——自动做任何一个都越权。 */
    if (kind === 'reopen-upload' || kind === 'recovery' || kind === 'remote-missing') {
      return finish({ ok: true, manual: true, kind: kind });
    }

    var choice = autoChoiceFor(chk);
    if (!choice) {
      return finish({ ok: true, manual: true, kind: 'first-sync' });
    }
    /* 覆盖方向才需要快照：C 类选本机会替换云端那份；B 取云端替换本机演示内容。
       A/D（云端为空）不覆盖任何已存在数据，不需要。 */
    if (typeof helpers.snapshotBackup === 'function'
        && (chk.case === 'C' || (chk.case === 'B' && choice === 'remote'))) {
      try { helpers.snapshotBackup('auto'); } catch (eBak) { /* 备份失败不阻塞定向 */ }
    }
    return Promise.resolve(engine.confirm(choice)).then(function (res) {
      if (!res || !res.ok) {
        return finish({
          ok: false,
          code: (res && res.code) || 'E_CONFIRM_FAILED',
          message: (res && res.message) || '自动提交失败',
          retryable: !!(res && res.retryable),
          choice: choice
        });
      }
      M.toast(choice === 'remote' ? '已下载云端数据' : '已开启同步');
      if (typeof helpers.onSessionChanged === 'function') helpers.onSessionChanged(true);
      if (typeof helpers.onDataChanged === 'function') helpers.onDataChanged();
      return finish({ ok: true, kind: 'first-sync', choice: choice });
    }, function (err) {
      return finish({
        ok: false,
        code: (err && err.code) || 'E_CONFIRM_FAILED',
        message: (err && err.message) || '自动提交失败',
        retryable: !!(err && err.retryable),
        choice: choice
      });
    });
  }

  /**
   * §1.8.5 + Q-32：修复结果**不自动回写云端**，这里问第二次。
   *
   * 两个出口都合法，但性质不同：
   *   写回云端 → 云端换成修复后的内容，标记清掉，回到稳态同步；
   *   不写回   → 停止同步（记录转 closed）。**不能只是关掉对话框**：那样标记
   *              一直挂着，用户从此刻起再也推不上去，界面上却只有一个「写回」
   *              按钮，看起来就是坏了；而且本机一切正常，通常一个多月后换设备
   *              才发现这段时间的改动全不在云里。
   */
  function openLossyPush(opts) {
    var w = opts.wiring;
    var engine = w.getEngine();
    var body = el('div', {});
    body.appendChild(el('div', { class: 'field-label', text: '修复已应用到本机' }));
    body.appendChild(note('云端那一份还是原始内容。写回会用修复后的数据覆盖它。'));
    body.appendChild(note('不写回也没关系，但会停止与云端的同步：本机与云端各自保留原样，'
      + '此后本机的改动不再上传。想恢复时点「重新开启同步」，那里会再问你一次要不要上传。'));

    function push() {
      Promise.resolve(engine.confirmLossyPush()).then(function (r) {
        if (!r || !r.ok) {
          M.toast('写回失败：' + ((r && (r.message || r.code)) || '未知错误'));
          ctx.close('failed');
          return;
        }
        ctx.close('pushed');
        M.toast('已写回云端');
        if (typeof opts.onDone === 'function') opts.onDone();
      }, function (err) {
        M.toast('写回失败：' + (err && err.message ? err.message : '未知错误'));
        ctx.close('failed');
      });
    }

    /* Q-32：这不是「关掉对话框」，而是把记录转成 closed —— 必须显式落一步，
       否则标记一直挂着，用户从此刻起永远推不上去，却看不出任何异常。 */
    function stop() {
      Promise.resolve(engine.stopAfterLossy()).then(function (r) {
        if (!r || !r.ok) {
          M.toast('操作失败：' + ((r && (r.message || r.code)) || '未知错误'));
          ctx.close('failed');
          return;
        }
        ctx.close('stopped');
        M.toast('已停止与云端的同步，两端都保留原样');
        if (typeof opts.onDone === 'function') opts.onDone();
      }, function (err) {
        M.toast('操作失败：' + (err && err.message ? err.message : '未知错误'));
        ctx.close('failed');
      });
    }

    var ctx = M.open({
      title: '是否写回云端',
      choice: true, /* D22d：决策框标记（自愈循环让路） */
      body: body,
      showSubmit: false,
      showCancel: false,
      footer: [
        el('button', {
          class: 'btn btn-ghost', type: 'button', text: '不写回，停止同步',
          title: '本机与云端都保留原样；此后不再自动同步，可随时重新开启',
          onclick: stop
        }),
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '写回云端',
          onclick: push
        })
      ],
      onClose: function () { if (opts.onDone) opts.onDone(); }
    });
  }

  /** §4.5.3：关闭期间本机改过，重新开启要显式确认上传。 */
  function openUploadConfirm(opts) {
    var w = opts.wiring;
    var chk = opts.check || {};
    var body = el('div', {});
    body.appendChild(el('div', { class: 'field-label', text: '关闭同步期间，本机有改动' }));
    body.appendChild(note('重新开启同步不会自动上传这些改动。上传会用本机的数据覆盖云端那一份，'
      + '需要你先确认。'));

    function summary(s, emptyText) {
      if (!s) return emptyText;
      var parts = ['条目 ' + s.items];
      if (typeof s.revision === 'number') parts.push('云端版本 ' + s.revision);
      return parts.join(' · ');
    }
    body.appendChild(el('div', { class: 'field' }, [
      el('div', { class: 'field-label', text: '本机（该账号的数据副本）' }),
      el('div', { text: summary(chk.localSummary, '—') })
    ]));
    body.appendChild(el('div', { class: 'field' }, [
      el('div', { class: 'field-label', text: '云端' }),
      el('div', { text: summary(chk.remoteSummary, '没有数据') })
    ]));

    function upload() {
      Promise.resolve(w.confirmReopenUpload()).then(function (r) {
        if (!r || !r.ok) {
          M.toast('上传失败：' + ((r && (r.message || r.code)) || '未知错误'));
          ctx.close('failed');
          return;
        }
        ctx.close('uploaded');
        M.toast('已上传本机改动');
        if (typeof opts.onDone === 'function') opts.onDone();
      }, function (err) {
        M.toast('上传失败：' + (err && err.message ? err.message : '未知错误'));
        ctx.close('failed');
      });
    }

    var ctx = M.open({
      title: '重新开启同步',
      choice: true, /* D22d：决策框标记（自愈循环让路） */
      body: body,
      showSubmit: false,
      showCancel: false,
      footer: [
        el('button', {
          class: 'btn btn-ghost', type: 'button', text: '暂不上传',
          title: '同步保持关闭，本机改动继续保留',
          onclick: function () { ctx.close('later'); }
        }),
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '上传本机改动',
          onclick: upload
        })
      ],
      onClose: function () { if (opts.onDone) opts.onDone(); }
    });
  }

  root.DayPlan.syncPanel = {
    createSyncSection: createSyncSection,
    openSignIn: openSignIn,
    openFirstSync: openFirstSync,
    openRecovery: openRecovery,
    autoLossyPush: autoLossyPush,
    openLossy: openLossy,
    openLossyPush: openLossyPush,
    openUploadConfirm: openUploadConfirm,
    autoRecoveryRemote: autoRecoveryRemote,
    autoLossyApply: autoLossyApply,
    autoResolveChoice: autoResolveChoice,
    autoChoiceFor: autoChoiceFor,
    STATE_TEXT: STATE_TEXT,
    CASE_TEXT: CASE_TEXT
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
