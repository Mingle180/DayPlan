/**
 * DayPlan · 同步引擎（骨架版，只跑 mock 后端）
 *
 * 契约：docs/spec/13-sync-contract.md §4.1（六状态）、§4.2（五种情况）、
 *       §4.3（确认与提交顺序）、§5.5（revision 条件更新）。
 *
 * 本文件**不接任何真实远端**：所有网络动作都经由注入的 backend 接口完成，
 * 测试时传 mockBackend，生产接入前必须另行实现 src/net/ 并重新验收。
 *
 * 首次同步的写入顺序（§4.3，顺序不可交换）：
 *   ① 检查阶段零写入 —— 远端只进内存，不改本机、不写账号副本
 *   ② 用户确认（唯一写入门槛）
 *   ③ 写账号副本并回读校验
 *   ④ 条件推送（revision 不匹配即失败，不静默覆盖）
 *   ⑤ 提交三步：history → sync 记录（active）→ 切活动指针
 * 任一步失败：删除刚写的账号副本、不写记录、不切指针，状态置 paused-error。
 *
 * 已知简化（必须在接真实远端前处理）：
 *   · 未接入 seed-classify 的 PURE_DEMO / MIXED 分类，"本地有内容"用字段非空判定。
 *     由于 C 情况一律要求用户确认，本简化不会导致静默上传演示数据。
 *   · 租约（§5.4）只协调云端写，不做跨标签的原子互斥；Web Locks 未引入（§5.6）。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(
    isNode ? require('../core/sync-keys.js') : root.DayPlan.syncKeys,
    isNode ? require('../core/sync-record.js') : root.DayPlan.syncRecord,
    isNode ? require('../core/remote-doc.js') : root.DayPlan.remoteDoc,
    isNode ? require('../core/remote-apply.js') : root.DayPlan.remoteApply,
    isNode ? require('../core/sync-hash.js') : root.DayPlan.syncHash,
    isNode ? require('../core/sync-boot.js') : root.DayPlan.syncBoot,
    isNode ? require('./lease.js') : (root.DayPlan && root.DayPlan.syncLease),
    isNode ? require('../core/lossy-gate.js') : (root.DayPlan && root.DayPlan.lossyGate),
    isNode ? require('../core/seed.js') : (root.DayPlan && root.DayPlan.seed)
  );
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.syncEngine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this,
function (K, R, remoteDoc, remoteApply, H, S, L, LZ, SD) {
  'use strict';

  var STATES = {
    local: 'local',
    signedIn: 'signed-in',
    checking: 'checking',
    awaitingChoice: 'awaiting-choice',
    syncing: 'syncing',
    pausedError: 'paused-error'
  };

  var CONTENT_FIELDS = ['items', 'notes', 'weekNotes', 'monthPlans', 'countdowns', 'finishDock'];

  function hasContent(doc) {
    if (!doc || typeof doc !== 'object') return false;
    return CONTENT_FIELDS.some(function (k) {
      return Array.isArray(doc[k]) && doc[k].length > 0;
    });
  }

  /** kv 读值统一成对象；解析失败按缺失处理（与 parseSyncRecord 的容错一致）。 */
  function readKv(kv, key) {
    var raw = kv.get(key);
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeKv(kv, key, value) {
    kv.set(key, JSON.stringify(value));
  }

  /**
   * 读某个作用域的数据文档。
   *
   * 「键缺失」与「读出来是坏的」必须分开：前者是「这份副本不存在」（账号候选缺失，
   * §4.6.5 / §4.7 保守恢复要用户处理），后者是「副本损坏」。合成一个错误码会让
   * 上层只能一律暂停，救不回来也没法给出准确提示。
   */
  function readDocKey(kv, key) {
    var raw = kv.get(key);
    if (raw === undefined || raw === null || raw === '') {
      return { ok: false, code: 'E_CANDIDATE_MISSING', message: '账号副本不存在', detail: { key: key } };
    }
    var doc = raw;
    if (typeof raw === 'string') {
      try {
        doc = JSON.parse(raw);
      } catch (e) {
        return { ok: false, code: 'E_CANDIDATE_CORRUPT', message: '账号副本无法解析', detail: { key: key } };
      }
    }
    if (!doc || typeof doc !== 'object') {
      return { ok: false, code: 'E_CANDIDATE_CORRUPT', message: '账号副本形状非法', detail: { key: key } };
    }
    return { ok: true, doc: doc };
  }

  /**
   * 写作用域文档并**回读校验**（契约 §4.6.3：不得把活动 store 的隐式 `saveNow()`
   * 当成账号目标提交成功）。配额写满、隐私模式、序列化丢字段都会在这里暴露。
   */
  function writeDocKey(kv, key, doc) {
    var raw;
    try {
      raw = JSON.stringify(doc);
    } catch (e) {
      return { ok: false, code: 'E_CANDIDATE_WRITE', message: '账号副本序列化失败', detail: { reason: String(e && e.message || e) } };
    }
    kv.set(key, raw);
    if (kv.get(key) !== raw) {
      return { ok: false, code: 'E_CANDIDATE_WRITE', message: '账号副本写入后回读不一致', detail: { key: key } };
    }
    return { ok: true };
  }

  /**
   * 算内容哈希，失败一律归一成 `{ok:false}`。
   *
   * `crypto.subtle` 缺失（`file://`、非安全上下文、被策略禁用）时 sync-hash 会抛。
   * 若让它抛出去，调用方拿到的是 rejected Promise 而不是失败结果——引擎的契约是
   * 「所有动作都返回 {ok:false, code}」，抛异常会让上层（如 steady）把它当成
   * 未知异常，而 §4.8 要求的是**明确暂停且零写入**。
   */
  async function safeHash(doc) {
    try {
      return { ok: true, hash: await H.contentHash(doc) };
    } catch (e) {
      return {
        ok: false,
        code: 'E_NO_HASH',
        message: '无法计算内容哈希（当前环境没有 SHA-256），本次不同步',
        detail: { reason: (e && e.message) || String(e) }
      };
    }
  }

  /**
   * @param {{
   *   kv: {get:function(string):*, set:function(string,*):void, remove:function(string):void},
   *   backend: {read:function(string):(object|Promise<object>),
   *             write:function(string,object,(number|null)):(object|Promise<object>)},
   *   getLocalDoc: function():object,
   *   setLocalDoc: function(object):void,
   *   now?: function():string
   * }} cfg
   */
  function createEngine(cfg) {
    if (!cfg || !cfg.kv || !cfg.backend || typeof cfg.getLocalDoc !== 'function') {
      throw new TypeError('createEngine 需要 kv / backend / getLocalDoc');
    }
    var kv = cfg.kv;
    var backend = cfg.backend;
    var getLocalDoc = cfg.getLocalDoc;
    var setLocalDoc = typeof cfg.setLocalDoc === 'function' ? cfg.setLocalDoc : function () {};
    /* 切源回调：装配层用它把「活动数据源」真正切到账号（契约 §2.2：activityDoc 由
       指针决定）。不提供时保持旧行为（单文档：指针 + setLocalDoc 就地替换），
       Node 层的引擎用例与 mock 演示走这条老路。 */
    var onScopeChanged = typeof cfg.onScopeChanged === 'function' ? cfg.onScopeChanged : null;
    /* 账号副本被写入后的通知。用户为它做两件事：若界面正停在该账号，换成新内容；
       否则什么都不做（指针还是 guest 时，界面必须继续显示游客数据，§4.6.6）。 */
    var onDocApplied = typeof cfg.onDocApplied === 'function' ? cfg.onDocApplied : null;
    var now = cfg.now || function () { return new Date().toISOString(); };
    /* 租约（§5.4）：给了配置才启用。生产装配层必须给——不给等于放弃多标签协调，
       只能靠 §5.2 与 §5.5 兜底（结构守卫 UI-07 盯着这一点）。 */
    var leaseCfg = cfg.lease || null;
    var lease = null;

    var state = STATES.local;
    var uid = null;
    var lastError = null;
    var lastCheck = null;
    /* 最近一次启动分类结果（§1.9）。界面用它区分「从未同步」与「记录丢了」——
       两者都停在 signed-in/checking，但该给的出路完全不同。 */
    var bootInfo = null;

    /* 待确认的有损应用（§1.8.1：保留本地与原远端 payload，只在内存里）。
       绝不落盘：用户没确认之前，磁盘上不该出现「差一点就被丢掉」的中间态。 */
    var pendingLossy = null;

    var MSG = {
      recovery: '本机的同步记录丢失或损坏了。为了不让两边互相覆盖，需要你确认保留哪一边。',
      blocked: '本机的同步记录形状无法判定（既不是有效记录，也不像是损坏）。为安全起见暂停同步，请导出本机数据后重新登录。',
      remoteMissing: '云端已经没有这个账号的数据了（可能是在别的设备上删掉了）。本机还保留着一份，需要你确认是否重新上传。',
      lossy: '云端这份数据里有超出当前版本上限的条目，正在自动修复（覆盖前已原样快照，可找回）。',
      lossyPush: '修复后的数据正在自动写回云端。',
      lossyStopped: '已停止与云端的同步。本机的修复结果与云端的原始内容都保持原样，两边不再互相同步；再次开启同步时会问你本机改动要不要上传。',
      resetReopen: '同步曾经关闭过，或者云端/本机被清空过。需要重新检查一次云端，不能沿用旧锚点。',
      localCleared: '本机数据已清空，云端那份仍然保留。需要时点「开始检查」重新读取云端。'
    };

    function fail(code, message, detail) {
      lastError = { code: code, message: message, detail: detail || null };
      state = STATES.pausedError;
      return { ok: false, code: code, message: message, detail: detail || null };
    }

    /* D18（2026-10-28 用户口径「登录后不该有任何需要额外操作的地方」）：
       网络抖动 / 超时 / 5xx / 限流不是「故障」。以前它们和真正的数据问题一样走
       fail() 把引擎按进 paused-error 死状态，界面上就是「同步已暂停 + 点开始检查」——
       手机上 Wi-Fi 切 4G 的瞬间就够触发一次。现在分两种情况处理：
         · 已在稳态（syncing）→ 状态不动，调度层按退避自动重试；
         · 需要重新对齐的阶段（check / resume / 恢复）→ 只能停，但 lastError
           带 retryable，界面会定时自愈（连上网/切回页面即自动重跑），
           同样不需要用户点任何按钮。 */
    var TRANSIENT_CODES = {
      E_NETWORK: 1, E_TIMEOUT: 1, E_SERVER: 1, E_RATE_LIMIT: 1,
      E_BAD_RESPONSE: 1, E_PERSIST: 1
    };

    function isTransient(code) {
      return !!(code && TRANSIENT_CODES[code]);
    }

    function transientFail(code, message, detail) {
      lastError = { code: code, message: message || '', detail: detail || null, retryable: true };
      if (state !== STATES.syncing) state = STATES.pausedError;
      return { ok: false, code: code, message: message || '', detail: detail || null, retryable: true };
    }

    function getState() {
      return state;
    }

    function getError() {
      return lastError;
    }

    function getCheck() {
      return lastCheck;
    }

    function getBoot() {
      return bootInfo;
    }

    /** 懒建租约对象：没有配置就返回 null，调用方一律按「无租约保护」处理。 */
    function getLease() {
      if (!leaseCfg || !L) return null;
      if (!lease) {
        var opts = Object.assign({}, leaseCfg);
        opts.kv = kv;
        lease = L.createLease(opts);
      }
      return lease;
    }

    /**
     * 云端写之前的租约门禁（§5.4）。
     *
     * 三种结果必须分开，混成一个「失败」会让行为走偏：
     *   held        → 继续写；
     *   BUSY/LOST   → **不写**，但这是可重试的排队，不是故障：状态不进 paused-error
     *                 （那是死状态，会把「等另一个标签页」变成「只能退出登录」）；
     *   UNAVAILABLE → **照写**。§5.4 明写「写入失败：不阻断，仅依赖 §5.2 与 §5.5」。
     *
     * 也就是说：租约永远不能成为新的单点故障。
     */
    async function guardLease() {
      var l = getLease();
      if (!l) return { ok: true, leased: false };
      var r;
      try {
        r = await l.acquire(uid);
      } catch (e) {
        return { ok: true, leased: false, warning: { code: 'E_LEASE_THREW', message: '租约异常，本次没有租约保护' } };
      }
      if (r && r.ok && r.held) return { ok: true, leased: true };

      var code = (r && r.code) || 'E_LEASE_UNAVAILABLE';
      if (code === 'E_LEASE_BUSY' || code === 'E_LEASE_LOST') {
        return {
          ok: false,
          code: code,
          retryable: true,
          holder: (r && r.holder) || null,
          message: code === 'E_LEASE_BUSY'
            ? '另一个标签页正在同步，这次改动没有上传（本地已保存）'
            : '另一个标签页抢先开始了同步，这次改动没有上传（本地已保存）'
        };
      }
      return {
        ok: true,
        leased: false,
        warning: { code: code, held: false, leased: false, message: '本次没有租约保护（租约不可用），仍按 revision 条件更新' }
      };
    }

    /**
     * 现算一次启动分类（§1.9）。**每次判定都重算**，不用内存缓存：
     * 记录是别的标签页也可能写的，缓存一份就会拿旧分类去决定新动作。
     */
    function bootNow() {
      if (!uid) return null;
      bootInfo = S.classifyBoot({
        record: kv.get(K.syncRecordKey(uid)),
        history: kv.get(K.syncHistoryKey(uid))
      });
      return bootInfo;
    }

    /** 两端摘要：只给用户看「条目数 / 最后修改时间 / revision」，不参与判定。 */
    function summarizeDoc(doc) {
      if (!doc || typeof doc !== 'object') return null;
      var counts = {};
      var total = 0;
      CONTENT_FIELDS.forEach(function (k) {
        var n = Array.isArray(doc[k]) ? doc[k].length : 0;
        counts[k] = n;
        total += n;
      });
      var updatedAt = doc.meta && doc.meta.updatedAt ? doc.meta.updatedAt : (doc.updatedAt || null);
      return { total: total, items: counts.items, counts: counts, updatedAt: updatedAt };
    }

    function summarizeRemote(row) {
      if (!row) return null;
      var s = summarizeDoc(row.payload) || { total: 0, items: 0, counts: {}, updatedAt: null };
      s.exists = true;
      s.revision = row.revision;
      s.updatedAt = row.updatedAt || s.updatedAt;
      return s;
    }

    /** 进入「等用户选」的确定状态，并把两端摘要交出去。零写入。 */
    function enterChoice(p) {
      state = STATES.awaitingChoice;
      lastError = null;
      lastCheck = {
        ok: true,
        kind: p.kind,
        action: 'recovery',
        reason: p.reason,
        remote: p.remote || null,
        remoteValid: !!p.remoteValid,
        remoteErrors: p.remoteErrors || [],
        remoteSummary: p.remoteSummary || summarizeRemote(p.remote),
        local: p.local,
        options: p.options
      };
      return lastCheck;
    }

    /**
     * §1.7 / §1.8 的闸门：远端文档在**落盘之前**必须先过归一审计。
     *
     * 为什么要放在这里而不是校验层：G2–G5 只判「结构是否合法」，
     * `validateMonthPlans` 并不校验单月条数上限，而 `sanitizeDocument` 会截断。
     * 于是「通过校验」与「不丢数据」是两件事 —— 直接应用就会静默丢条目，
     * 而且因为锚点已经前移，丢掉的再也找不回来。
     *
     * @returns {{lossy:boolean, doc:object, preview:object}} 审计结果；**不做任何写入**
     */
    function auditRemote(payload) {
      return LZ.inspect(payload);
    }

    /**
     * D19（2026-10-28）：**推送载荷必须先归一**。
     *
     * 以前这里直接 `payloadProjection(getLocalDoc())`，等于默认「本机数据一定合法」。
     * 实际上本机文档允许存在云端校验会拒绝的内容：旧版本产生的超长标题/备注、
     * 完成台或单月计划累积过多、月份键来自早期版本……这些内容一旦被推上云，
     * **任何设备**再拉取时 `validateRemoteDocument` 都会失败，同步永久卡在
     * paused-error，界面上没有任何按钮能恢复（用户看到的只是「一直在下载备份、
     * 就是同步不上」）。
     *
     * 归一在这里是「保证云端永远是一份所有设备都吃得下的文档」，不是丢数据的理由：
     * 超过上限的条目会按上限截断/丢弃，但这件事会以有损审计的形式如实上报，
     * 不会静默发生（归一的 audit 由调用方决定要不要提示）。
     */
    /* ------------------------------------------------------------------ *
     * D20：合并基线（三向合并的共同祖先）
     * ------------------------------------------------------------------ */

    /**
     * 读「上次同步成功时两端共同的内容」。
     *
     * 唯一的用途是让合并能分辨「对端新增」与「我方删除」——这两个情况在数据上
     * 完全一样（本机没有这条）。基线缺失（老记录 / 新装配）一律返回 null，
     * 合并退化为二向并集：宁可把删掉的条目复活，也不能因为判不出来就丢数据。
     */
    function readBase() {
      if (!uid || typeof K.syncBaseKey !== 'function') return null;
      var raw;
      try {
        raw = readKv(kv, K.syncBaseKey(uid));
      } catch (e) {
        return null;
      }
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    }

    /** 记录本次同步后两端的共同内容。基线只影响删除判定，写失败不影响同步本身。 */
    function writeBase(doc) {
      if (!uid || !doc || typeof K.syncBaseKey !== 'function') return;
      try {
        var proj = H.payloadProjection(doc);
        if (proj) writeKv(kv, K.syncBaseKey(uid), proj);
      } catch (e) { /* 基线丢了只是删除判定退化，不报错、不阻塞同步 */ }
    }

    function buildPushPayload(doc) {
      try {
        var norm = remoteApply.normalizeAndAudit(doc);
        if (norm && norm.doc) return H.payloadProjection(norm.doc);
      } catch (e) { /* 归一失败就退回原样，交给后端/校验去拒 */ }
      return H.payloadProjection(doc);
    }

    /**
     * 读云端后的审计入口：**严格校验失败不等于无解**。
     *
     * 先按严格校验判；不过就尝试归一——历史上限更宽松时产生的数据（或旧客户端
     * 推上来的数据）归一后往往是合法的。归一后合法就当作「有损数据」交给有损
     * 闸门（界面会自动修复并写回，D16/D17 已有这条路径），只有归一也救不了
     * 才判 E_REMOTE_INVALID。
     */
    /** 这些路径上的错误属于「身份 / 版本 / 结构」，不是内容超限——归一不能救。 */
    var HARD_PATHS = ['$', '$.app', '$.schemaVersion', '$.items', '$.categories',
      '$.notes', '$.weekNotes', '$.monthPlans', '$.countdowns', '$.finishDock'];

    function auditIncoming(payload) {
      var v = remoteDoc.validateRemoteDocument(payload);
      if (v.ok) {
        return { ok: true, strict: true, recovered: false, insp: LZ.inspect(payload) };
      }
      /* ① 硬伤先拦：不是 DayPlan 的数据、版本比本机高、顶层结构性错误——
         这些不是「内容超限」，硬修等于把别人的数据当成自己的应用。
         归一前后 app / schemaVersion 被改写，同样算硬伤。 */
      var hard = !!v.versionStatus && v.versionStatus === 'higher';
      if (!hard) {
        hard = (v.errors || []).some(function (e) {
          return HARD_PATHS.indexOf(String((e && e.path) || '')) !== -1;
        });
      }
      if (hard) {
        return {
          ok: false, code: 'E_REMOTE_INVALID',
          message: '远端文档未通过严格校验，拒绝应用', errors: v.errors
        };
      }
      /* ② 内容层面的超限（标题/备注过长、完成台或月计划过多、非法月份键）：
         归一后合法就当作有损数据处理，交给有损闸门自动修复。 */
      var insp = LZ.inspect(payload);
      var clean = insp && insp.doc ? H.payloadProjection(insp.doc) : null;
      if (clean && (clean.app !== payload.app || clean.schemaVersion !== payload.schemaVersion)) {
        return {
          ok: false, code: 'E_REMOTE_INVALID',
          message: '远端文档的身份/版本被归一改写，拒绝应用', errors: v.errors
        };
      }
      var v2 = clean ? remoteDoc.validateRemoteDocument(clean) : { ok: false };
      if (!v2.ok) {
        return {
          ok: false, code: 'E_REMOTE_INVALID',
          message: '远端文档未通过严格校验，拒绝应用', errors: v.errors
        };
      }
      return { ok: true, strict: false, recovered: true, insp: insp, errors: v.errors };
    }

    /** 被有损闸门拦下时进入「等确认」，内存里留一份原始 payload（§1.8.1）。 */
    /**
     * D23（2026-10-29 用户裁定「删掉所有不让同步的限制」）：有损不再是一个
     * 「等用户点」的状态。旧行为：进 awaiting-choice 摆对话框，等界面自动/手动
     * 应用——链路只要断一环（面板没开、confirm 失败一次）就永远停在这。
     * 新行为：**原样快照进快照环 → 返回可重试结果（调用方照常退避）→
     * 后台微任务里自动应用修复并自动写回**。状态机不再经过 awaiting-choice。
     */
    function enterLossy(insp, source, row) {
      pendingLossy = {
        source: source,
        revision: row ? row.revision : null,
        payload: row ? row.payload : null,
        doc: insp.doc,
        preview: insp.preview,
        at: now()
      };
      lastCheck = {
        ok: false,
        action: 'lossy',
        kind: 'lossy',
        source: source,
        revision: row ? row.revision : null,
        preview: insp.preview,
        warnings: insp.warnings.slice(0, LZ.WARN_MAX),
        required: { confirm: false, downloads: [] }
      };
      /* 快照的是被替换的远端原始行（拉取路径）或本机文档（覆盖路径）。 */
      snapshotRing('lossy-' + source, row ? row.payload : undefined);
      var myPending = pendingLossy;
      Promise.resolve().then(async function () {
        console.error('[heal] start');
        var applied = await applyLossyCore(myPending);
        console.error('[heal] applied:', JSON.stringify(applied && {ok:applied.ok, code:applied.code, action:applied.action}));
        if (!applied || !applied.ok) {
          transientFail('E_LOSSY_HEAL', (applied && applied.message) || '自动修复失败，稍后自动重试');
          return;
        }
        console.error('[heal] calling clp');
        var pushedBack = await confirmLossyPush();
        console.error('[heal] clp:', JSON.stringify(pushedBack && {ok:pushedBack.ok, code:pushedBack.code}));
        if (!pushedBack || !pushedBack.ok) {
          /* 写回失败不致命：记录里留着 pendingPushAfterLossyApply，
             app.js 的 lossy-push-pending 自动补推会接手。 */
          transientFail('E_LOSSY_PUSH', (pushedBack && pushedBack.message) || '修复结果写回失败，稍后自动重试');
        }
      });
      return {
        ok: false,
        code: 'E_LOSSY',
        auto: true,
        retryable: true,
        action: 'lossy',
        kind: 'lossy',
        message: MSG.lossy,
        revision: row ? row.revision : null,
        preview: insp.preview,
        warnings: lastCheck.warnings,
        required: lastCheck.required
      };
    }

    /** applyLossy 的核心（D23 抽出）：归一合并 → 哈希 → 落盘 → commitLossy。 */
    async function applyLossyCore(pending) {
      console.error('[core] enter');
      var scope = K.userScope(uid);
      var dbKey = K.dbKeyForScope(scope);
      var fresh = readDocKey(kv, dbKey);
      var baseDoc = fresh.ok ? fresh.doc : { meta: {}, settings: {} };

      var merged = remoteApply.mergeRemote(pending.doc, baseDoc, { now: now(), prev: readBase() });
      if (!merged.ok) return fail('E_MERGE_FAILED', '有损修复的应用失败', merged.errors);

      var h = await safeHash(merged.doc);
      if (!h.ok) return fail(h.code, h.message, h.detail);

      var w = writeDocKey(kv, dbKey, merged.doc);
      console.error('[core] written, commitLossy next, rev=', pending.revision);
      if (!w.ok) return fail(w.code, w.message, w.detail);

      var cl = commitLossy(pending.revision, h.hash, merged.doc);
      console.error('[core] commitLossy:', JSON.stringify(cl && {ok:cl.ok, code:cl.code}));
      return cl;
    }

    /**
     * D23：自动覆盖前的快照环（环形 3 份，存 kv）。引擎层兜底——以前快照
     * 依赖界面的 snapshotBackup，界面没开就没有快照。
     */
    function snapshotRing(reason, payload) {
      try {
        var KEY = 'dayplan.sync.snapshot.autos.v1';
        var arr = [];
        try { arr = JSON.parse(kv.get(KEY) || '[]') || []; } catch (e) { arr = []; }
        if (!Array.isArray(arr)) arr = [];
        var doc = payload !== undefined && payload !== null
          ? payload
          : (typeof getLocalDoc === 'function' ? getLocalDoc() : null);
        arr.push({ at: now(), reason: reason, doc: doc });
        while (arr.length > 3) arr.shift();
        kv.set(KEY, JSON.stringify(arr));
      } catch (e) { /* 快照失败不阻塞同步 */ }
    }

    /**
     * 「可以重试的拒绝」：不改状态、不写 lastError。
     *
     * 与 fail() 的区别很重要：fail() 会进 paused-error，那是个死状态（只能退出登录）。
     * 用户少勾一个框、少下载一份文件，都是他再点一次就能解决的事，
     * 把它变成死状态等于惩罚用户按了取消。
     */
    function rejectLossy(code, message) {
      return { ok: false, code: code, message: message, action: 'lossy' };
    }

    /**
     * 登录。**不写任何数据，也不发请求**——这里只表达身份。
     *
     * 走哪条路由 §1.9 的启动分类决定，**不在这里即兴判断**：
     *   有效 active  → `checking`，等调用方跑 `resume()` 做四象限（Q-28）；
     *   记录丢失/损坏 → `checking`，等调用方跑 `resume()` 做只有读的保守恢复；
     *   reset/closed → `signed-in`，不自动读账号副本（§4.6.7）；
     *   无法判定     → `paused-error`，两侧都不许有动作。
     *
     * 以前这里只认「有效 active」一种情况，其余一律 signed-in——那会把
     * 「曾同步过但记录丢了」静默降级成「从未同步」，用户点一次「开始检查」
     * 就能用游客文档覆盖云端（§1.9、T-H09）。
     */
    function signIn(nextUid) {
      K.userScope(nextUid);
      uid = nextUid;
      lastError = null;
      lastCheck = null;

      var boot = bootNow();
      if (boot.kind === 'blocked') {
        state = STATES.pausedError;
        lastError = { code: 'E_BOOT_BLOCKED', message: MSG.blocked, detail: boot.detail };
        return { ok: true, uid: uid, state: state, needsCheck: false, boot: boot };
      }
      if (boot.needsCheck) {
        state = STATES.checking;
        return { ok: true, uid: uid, state: state, needsCheck: true, boot: boot };
      }
      state = STATES.signedIn;
      return { ok: true, uid: uid, state: state, needsCheck: false, boot: boot };
    }

    function signOut() {
      /* 退出登录必须释放租约（§6）：留着它到过期之前，别的标签页会一直以为
         「有人在同步」，而那个账号其实已经没人管了。 */
      var l = getLease();
      if (l) l.release();
      uid = null;
      lastError = null;
      lastCheck = null;
      bootInfo = null;
      state = STATES.local;
      return { ok: true, state: state };
    }

    /**
     * 本机数据被其他标签页改动（契约 §5.2「冲突处理」第 3 条：未解决前同步保持
     * `paused-error`）。由界面在 storage 事件 / 写后回读失败时调用。
     *
     * 只在**本来在同步**时才有意义：`local` / `signed-in` 下没有云端写入可暂停，
     * 硬把它改成 paused-error 只会平白多出一个错误横幅。
     */
    function noteLocalStale(message) {
      var msg = message || '其他页面改动了本地数据，同步已暂停';
      if (state === STATES.syncing || state === STATES.checking) {
        /* 停了云端写就不该继续占着协调权：租约是「我要写云端」的声明，
           抱着它不放会让别的标签页一直以为有人在同步，直到本页关闭。 */
        var l = getLease();
        if (l) l.release();
        return fail('E_STALE_LOCAL', msg);
      }
      return { ok: false, code: 'E_STALE_LOCAL', message: msg, state: state, ignored: true };
    }

    /**
     * 检查阶段（§4.2）：只读，不写本机、不写账号副本、不写记录。
     * @returns {Promise<{ok:boolean, case:('A'|'B'|'C'|'D'), remote:object|null,
     *                    remoteValid:boolean, localHasContent:boolean, errors:Array}>}
     */
    async function check() {
      if (!uid) {
        state = STATES.local;
        return { ok: false, code: 'E_NOT_SIGNED_IN', message: '未登录' };
      }
      /* 启动分类说了算：记录丢失/损坏（或形状无法判定）时，这里**必须拒绝**。
         check() 按「活动文档」判 A/B/C/D，而恢复场景下活动文档还是游客文档——
         放它过去，界面就会给出「以本机为准」，那个「本机」根本不是要恢复的
         那份账号副本（§4.7.2、T-H09）。 */
      var boot = bootNow();
      if (boot.kind === 'recovery') {
        return {
          ok: false,
          code: 'E_NEEDS_RECOVERY',
          action: 'recovery',
          message: MSG.recovery,
          boot: boot
        };
      }
      if (boot.kind === 'blocked') {
        return { ok: false, code: 'E_BOOT_BLOCKED', action: 'blocked', message: MSG.blocked, boot: boot };
      }

      state = STATES.checking;
      lastError = null;

      var res = await backend.read(uid);
      if (!res.ok) {
        /* D18：网络/超时/5xx/限流只暂停并标记可重试，界面会自愈（不要求点「开始检查」）。 */
        return isTransient(res.code)
          ? transientFail(res.code, res.message || '读取云端失败')
          : fail(res.code, res.message || '读取云端失败');
      }

      var remote = res.row || null;
      var remoteValid = true;
      var errors = [];
      if (remote) {
        var inc = auditIncoming(remote.payload);
        remoteValid = inc.ok;      // D19：归一后可救不再算「不可用」
        errors = inc.errors || [];
      }

      var localDoc = getLocalDoc();
      var localHas = hasContent(localDoc);

      var kind;
      if (remote && localHas) kind = 'C';
      else if (remote && !localHas) kind = 'B';
      else if (!remote && localHas) kind = 'A';
      else kind = 'D';

      /* D9.1（2026-10-27）：C 的一个特例——两边内容**完全一致**（内容哈希相同，
         updatedAt 不参与投影，所以只差 meta 时间戳也算一致）。这种情况下选哪边
         都不会丢任何数据，弹「首次同步」询问只是在没有信息量地打断用户。
         哈希算不出来（无 crypto.subtle 等）一律按 false 处理，退回询问。 */
      var sameContent = false;
      if (kind === 'C' && remoteValid) {
        try {
          sameContent = (await H.contentHash(localDoc)) === (await H.contentHash(remote.payload));
        } catch (eHash) { sameContent = false; }
      }

      /* D9.2（2026-10-27）：C 的另一种特例——本机只是**原封未动的演示内容**
         （新设备首次启动注入的那份，没有一行用户数据）。云端是账号真数据时，
         「以云端为准」不丢任何用户数据；把这个判定交给界面自动做，
         新设备登录从此不再被「两边都有内容」拦一次。判定失败按 false 处理。 */
      var localIsDemo = false;
      if (kind === 'C' && remoteValid) {
        try {
          localIsDemo = !!(SD && typeof SD.isPristineDemoDoc === 'function'
            && SD.isPristineDemoDoc(localDoc));
        } catch (eSeed) { localIsDemo = false; }
      }

      state = STATES.awaitingChoice;
      lastCheck = {
        ok: true,
        case: kind,
        remote: remote,
        remoteValid: remoteValid,
        localHasContent: localHas,
        sameContent: sameContent,
        localIsDemo: localIsDemo,
        errors: errors
      };
      return lastCheck;
    }

    /**
     * 提交（§4.3 的 ③④⑤）。只有在 check 之后、且用户已明确选择时才调用。
     * @param {('local'|'remote')} choice 以本机为准 / 以云端为准
     */
    async function confirm(choice) {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      if (!lastCheck) return fail('E_NO_CHECK', '必须先执行 check');
      if (state !== STATES.awaitingChoice) {
        return fail('E_BAD_STATE', '当前状态不允许提交：' + state);
      }
      if (choice !== 'local' && choice !== 'remote') {
        return fail('E_BAD_CHOICE', 'choice 必须是 local 或 remote');
      }
      if (choice === 'remote' && !lastCheck.remote) {
        return fail('E_NO_REMOTE', '云端没有可用文档，不能选择以云端为准');
      }
      if (choice === 'remote' && !lastCheck.remoteValid) {
        return fail('E_REMOTE_INVALID', '远端文档未通过严格校验，拒绝应用', lastCheck.errors);
      }

      /* 云端写之前先过租约（§5.4）。位置刻意放在「写账号副本」之前：先写副本
         再被挡，等于把本机数据换掉一次却什么都没提交（T-C05 要求零写入）。 */
      var gate = { ok: true, leased: false };
      if (choice === 'local') {
        gate = await guardLease();
        if (!gate.ok) {
          /* 停在 awaiting-choice：这次什么都没发生，用户再点一次就行。 */
          return {
            ok: false, code: gate.code, message: gate.message,
            action: 'leased', retryable: true, holder: gate.holder
          };
        }
      }

      var scope = K.userScope(uid);
      var dbKey = K.dbKeyForScope(scope);
      var recKey = K.syncRecordKey(uid);
      var histKey = K.syncHistoryKey(uid);
      var localDoc = getLocalDoc();
      var targetDoc = localDoc;
      var expectedRevision = lastCheck.remote ? lastCheck.remote.revision : null;

      if (choice === 'remote') {
        /* §1.7/§1.8：先把归一会丢的东西摆到台面上，再谈合并。
           位置刻意在「写账号副本」之前 —— 有损时**一个字节都不能落盘**（T-V10）。
           D20：这是用户显式选的「以云端为准」，整份应用，不参与合并 ——
           否则本机旧条目会以「本机新增」的名义留下来，与用户的选择相反。 */
        var insp = auditRemote(lastCheck.remote.payload);
        if (insp.lossy) {
          return enterLossy(insp, 'confirm', lastCheck.remote);
        }
        var merged = remoteApply.mergeRemote(insp.doc, localDoc, {
          now: now(), prev: readBase(), replace: true
        });
        if (!merged.ok) {
          return fail('E_MERGE_FAILED', '远端文档合并失败', merged.errors);
        }
        targetDoc = merged.doc;
      }

      // ③ 写账号副本并回读校验
      writeKv(kv, dbKey, targetDoc);
      var back = readKv(kv, dbKey);
      if (!back || H.canonicalJson(back) !== H.canonicalJson(targetDoc)) {
        kv.remove(dbKey);
        return fail('E_WRITE_VERIFY', '账号副本回读不一致，已撤销');
      }

      // ④ 条件推送。以云端为准时本机不产生新内容，跳过推送。
      var revision = expectedRevision;
      var hash = null;
      /* 哈希要在推送**之前**能算出来：算不出来就不该动云端，
         否则会出现「云端已写入、本机却没有锚点」的不可恢复状态。 */
      var h = await safeHash(targetDoc);
      if (!h.ok) {
        kv.remove(dbKey);
        return fail(h.code, h.message, h.detail);
      }
      if (choice === 'local') {
        /* D19：推送前归一，云端永远是一份所有设备都吃得下的文档。 */
      var payload = buildPushPayload(targetDoc);
        var pushed = await backend.write(uid, payload, expectedRevision);
        /* D10：检查与提交之间云端又被人改了 → 不再判失败回滚，
           按「本机胜出」读到当前行无条件覆盖写（本机选择已经发生）。 */
        if (!pushed.ok && pushed.code === 'E_CONFLICT') {
          pushed = await forceOverwrite(payload);
        }
        if (!pushed.ok) {
          kv.remove(dbKey);
          /* D18：网络类写入失败同样标可重试——界面会自愈重跑检查并自动重传，
             不需要用户再点一次。 */
          return isTransient(pushed.code)
            ? transientFail(pushed.code, pushed.message || '云端写入失败', { rolledBack: true })
            : fail(pushed.code, pushed.message || '云端写入失败', { rolledBack: true });
        }
        revision = pushed.revision;
        hash = h.hash;
      } else {
        hash = h.hash;
      }

      // ⑤ 提交三步：history → 记录 → 指针（顺序不可交换）
      if (!readKv(kv, histKey)) {
        writeKv(kv, histKey, R.buildHistoryMarker(now()));
      }

      var at = now();
      var record = {
        v: R.RECORD_VERSION,
        state: 'active',
        enabled: true,
        enabledAt: at,
        closedAt: null,
        lastKnownRevision: revision,
        hashMethod: 'sha256',
        lastSyncedHash: hash,
        lastSyncedAt: at,
        pendingPushAfterLossyApply: false
      };
      var recCheck = R.validateSyncRecord(record);
      if (!recCheck.ok) {
        kv.remove(dbKey);
        return fail('E_RECORD_INVALID', '同步记录形状非法，未写入', recCheck.errors);
      }
      writeKv(kv, recKey, record);

      /* D20：这次提交完成后两端内容一致，把它记为下次三向合并的基线 ——
         没有基线就分不清「对端删了」和「对端还没有」，删除永远不会生效。 */
      writeBase(targetDoc);

      /* 远端文档落到哪里：有切源回调时，activityDoc 由装配层在切源后从**账号副本**
         读回（那份就是 targetDoc）。此时若再 setLocalDoc，写的是切换前的作用域——
         等于把云端内容灌进游客文档，而游客数据并不在这次覆盖范围内。 */
      if (choice === 'remote' && !onScopeChanged) {
        setLocalDoc(targetDoc);
      }
      kv.set(K.KEYS.active, K.scopeId(scope));

      state = STATES.syncing;
      lastError = null;

      /* 指针已经指向账号，界面的读写目标必须立刻跟上（Q-29：不做这一步，后续编辑
         会写游客键，账号副本零更新，下次推送还会把游客内容推到云端 uid 行）。
         回调失败**不能**把这次确认判成失败：云端已写、账号副本与记录都已落盘，
         判失败会诱使用户重试同一次提交，而重试用旧 revision 必撞二次冲突。
         正确做法是继续前进到 syncing，并把失败如实回传给界面提示重新加载。 */
      var scopeSwitch = null;
      if (onScopeChanged) {
        try {
          var switched = onScopeChanged(K.scopeId(scope));
          scopeSwitch = (switched && typeof switched === 'object') ? switched : { ok: true };
        } catch (e) {
          scopeSwitch = {
            ok: false,
            code: 'E_SCOPE_HOOK_THREW',
            message: e && e.message ? e.message : String(e)
          };
        }
      }

      /* 记录已经写成 active：分类快照必须跟着更新，否则 describe() 会一直
         报「first-sync」，排查时看不出「其实已经建好了」。 */
      bootInfo = bootNow();

      return {
        ok: true,
        state: state,
        revision: revision,
        hash: hash,
        record: record,
        scopeSwitch: scopeSwitch,
        lease: gate.warning || null
      };
    }
    /**
     * 增量推送：本机内容哈希与记录锚点不同才推。
     * 条件更新用记录里的 lastKnownRevision；0 行即冲突，不静默覆盖。
     */
    async function push() {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      /* 有损修复刚落地时状态刻意停在 awaiting-choice（§1.8.5），
         所以这条守卫必须**先于**状态检查，否则用户看到的是「同步未启用」
         而不是「还差一次确认」——那是两个完全不同的下一步。 */
      if (lastCheck && lastCheck.kind === 'lossy-applied') {
        return {
          ok: false, code: 'E_PENDING_LOSSY_PUSH', action: 'lossy-push-pending',
          message: MSG.lossyPush,
          preview: lastCheck.preview || null
        };
      }
      if (state !== STATES.syncing) return fail('E_BAD_STATE', '同步未启用：' + state);

      var recKey = K.syncRecordKey(uid);
      var parsed = R.parseSyncRecord(readKv(kv, recKey));
      if (!parsed.ok || parsed.state !== 'active') {
        return fail('E_RECORD_MISSING', '同步记录缺失或状态非 active');
      }
      var record = parsed.record;
      /* §1.8.5：有损修复的结果与云端原始内容不同，**不得自动回写**。
         一次普通编辑就会走到这里，若不在这里拦住，修复结果会静默覆盖云端。 */
      if (record.pendingPushAfterLossyApply) {
        return {
          ok: false, code: 'E_PENDING_LOSSY_PUSH', action: 'lossy-push-pending',
          message: MSG.lossyPush,
          preview: lastCheck && lastCheck.preview ? lastCheck.preview : null
        };
      }
      var doc = getLocalDoc();
      var h = await safeHash(doc);
      if (!h.ok) return fail(h.code, h.message, h.detail);   // 零写入、零请求
      var hash = h.hash;
      if (hash === record.lastSyncedHash) {
        return { ok: true, skipped: true, reason: 'no-change', revision: record.lastKnownRevision };
      }

      /* 到这里才真正要写云端：先确认这次轮得到我（§5.4）。
         懒续期的位置也在这里——「写之前租约还有效」正是唯一需要它的时刻。 */
      var gate = await guardLease();
      if (!gate.ok) {
        /* 不改状态、不动记录、不发请求。本地照旧可用，调度层按 retryable 稍后重试。 */
        return {
          ok: false, code: gate.code, message: gate.message,
          action: 'leased', retryable: true, holder: gate.holder
        };
      }

      var payload = buildPushPayload(doc);
      var pushed = await backend.write(uid, payload, record.lastKnownRevision);
      /* D20（2026-10-28）：远端在这期间被别的设备改过 —— 先合并再推。
         以前这里是无条件覆盖（D10 的「后写入者胜」），代价是对方那次编辑消失：
         两台设备各自编辑，谁后保存谁把对方的内容抹掉，用户感受就是「只能有一台为主」。
         合并只保留真正冲突的那一条（同 id 同字段）的让步，互不相干的新增全都留住。 */
      if (!pushed.ok && pushed.code === 'E_CONFLICT') {
        var pulled = await backend.read(uid);
        if (!pulled.ok) {
          return isTransient(pulled.code)
            ? transientFail(pulled.code, pulled.message || '读取云端失败')
            : fail(pulled.code, pulled.message || '读取云端失败');
        }
        if (!pulled.row) {
          /* 云端行被删了：不凭空重建（T-R06），交给上层决定是否重新上传。 */
          return fail('E_REMOTE_MISSING', '云端行已不存在，本次推送中止');
        }
        return mergeAndPush(record, doc, hash, pulled.row);
      }
      if (!pushed.ok) {
        /* D18：写失败若是网络/超时/5xx/限流，保持 syncing，交给稳态退避重试——
           绝不把一次手机网络抖动变成「同步已暂停」要用户点「开始检查」。 */
        return isTransient(pushed.code)
          ? transientFail(pushed.code, pushed.message || '推送失败')
          : fail(pushed.code, pushed.message || '推送失败');
      }

      var at = now();
      var next = Object.assign({}, record, {
        lastKnownRevision: pushed.revision,
        lastSyncedHash: hash,
        lastSyncedAt: at
      });
      writeKv(kv, recKey, next);
      /* D20：稳态推送成功也要更新基线 —— 这是最频繁的一条路，漏了它基线会长期
         停在上一次四象限的时刻，删除判定就永远慢一拍。刚推上去的这份就是共同内容。 */
      writeBase(doc);
      var out = { ok: true, skipped: false, revision: pushed.revision, hash: hash };
      if (gate.warning) out.lease = gate.warning;
      return out;
    }

    /**
     * D10：无条件覆盖写（最后写入者胜）。
     * 读云端当前行拿最新 revision，用它做条件写——效果等价于「无视分歧直接覆盖」，
     * 但仍走后端的原子条件更新，不会把并发写打成双行。连续被人抢先 3 轮才放弃
     * （放弃也只报 retryable，调度层稍后自动重试；不进 paused-error）。
     * 云端没有行（被删过）时按插入重建——行没了这件事本身也是「远端状态」。
     */
    async function forceOverwrite(payload) {
      for (var attempt = 0; attempt < 3; attempt++) {
        var res = await backend.read(uid);
        if (!res.ok) {
          return { ok: false, code: res.code, message: res.message || '读取云端失败' };
        }
        var w = await backend.write(uid, payload, res.row ? res.row.revision : null);
        if (w.ok) return w;
        if (w.code !== 'E_CONFLICT') return w;
      }
      return {
        ok: false, code: 'E_PUSH_RACED', message: '连续多次被其他设备抢先写入，稍后会自动重试',
        retryable: true
      };
    }

    /**
     * 增量拉取：远端 revision 大于锚点才拉；拉到的文档必须通过严格校验。
     */
    async function pull() {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      if (state !== STATES.syncing) return fail('E_BAD_STATE', '同步未启用：' + state);

      var recKey = K.syncRecordKey(uid);
      var parsed = R.parseSyncRecord(readKv(kv, recKey));
      if (!parsed.ok || parsed.state !== 'active') {
        return fail('E_RECORD_MISSING', '同步记录缺失或状态非 active');
      }
      var record = parsed.record;

      var res = await backend.read(uid);
      if (!res.ok) {
        /* D18：稳态拉取遇到网络问题不换状态，轮询下一拍会再试。 */
        return isTransient(res.code)
          ? transientFail(res.code, res.message || '读取失败')
          : fail(res.code, res.message || '读取失败');
      }
      if (!res.row) {
        return fail('E_NO_REMOTE', '云端没有该用户的行');
      }
      if (res.row.revision <= record.lastKnownRevision) {
        return { ok: true, skipped: true, reason: 'up-to-date', revision: res.row.revision };
      }

      var inc = auditIncoming(res.row.payload);
      if (!inc.ok) return fail(inc.code, inc.message, inc.errors);
      /* 稳态拉取同样过有损闸门：这条路径以前是最容易被忽略的一条，
         因为它「平时都好好的」，直到某天云端出现一份超限文档。 */
      var insp = inc.insp;
      if (insp.lossy) return enterLossy(insp, 'pull', res.row);
      var merged = remoteApply.mergeRemote(insp.doc, getLocalDoc(), { now: now(), prev: readBase() });
      if (!merged.ok) {
        return fail('E_MERGE_FAILED', '合并失败', merged.errors);
      }

      /* 先算哈希再落本地：反过来一旦算不出来，本机已经被远端内容替换、
         锚点却没跟上，下次推送就会用一个错的锚点去撞冲突。 */
      var h = await safeHash(merged.doc);
      if (!h.ok) return fail(h.code, h.message, h.detail);

      setLocalDoc(merged.doc);
      var at = now();
      var hash = h.hash;
      writeKv(kv, recKey, Object.assign({}, record, {
        lastKnownRevision: res.row.revision,
        lastSyncedHash: hash,
        lastSyncedAt: at
      }));
      return { ok: true, skipped: false, revision: res.row.revision, hash: hash };
    }

    /**
     * 重新登录 / 刷新后的四象限（契约 §1.9 真值表、§4.4 第 2 条、§4.6）。
     *
     *   localChanged  = contentHash(账号副本) !== record.lastSyncedHash
     *   remoteChanged = remoteRevision         !== record.lastKnownRevision
     *
     *   false/false → syncing（无操作）      false/true → 拉取应用 → syncing
     *   true/false  → 条件推送 → syncing     true/true  → awaiting-choice（冲突）
     *
     * `opts.forceUpload`（Q-32）把 localChanged 视为 true：有损修复应用后本地内容与
     * 记录里的基线可能恰好相等，但那份内容从没上传过，不能据此判定「两端一致」。
     * 它只由 `reopen()` 在读到 closed 记录上的待回写标记时传入，其它路径不传。
     *
     * 三个约束，缺一个就会出事故：
     *   1. **候选一律账号副本**（§4.6.2）。此刻指针可能还是 `guest`，拿活动文档
     *      当候选就是把游客内容推到云端 uid 行。
     *   2. **先算哈希再落盘**。反过来一旦哈希算不出来，账号副本已被换掉、锚点没跟上。
     *   3. **落盘回读校验**。写 `localStorage` 可能静默失败（配额满 / 隐私模式），
     *      没回读就写记录，等于给一份没写进去的内容盖了「已同步」的章。
     */
    async function resume(opts) {
      opts = opts || {};
      if (!uid) {
        /* 未登录是空操作，不是故障：不得进 paused-error，否则启动时面板会
           报一个「暂停」错误，而用户只是还没登录。 */
        state = STATES.local;
        return { ok: false, code: 'E_NOT_SIGNED_IN', message: '未登录', action: 'skip' };
      }

      var boot = bootNow();
      if (boot.kind === 'recovery') {
        /* 只读检查：读云端、算账号副本哈希、列出两端摘要，**不写任何东西**。 */
        return inspectRecovery();
      }
      if (boot.kind === 'blocked') {
        return fail('E_BOOT_BLOCKED', MSG.blocked, boot.detail);
      }
      if (boot.kind !== 'active') {
        state = STATES.signedIn;
        lastError = null;
        return {
          ok: false,
          code: 'E_NOT_ACTIVE',
          message: '当前记录不需要四象限（' + boot.kind + '）',
          action: 'skip',
          boot: boot.kind
        };
      }

      state = STATES.checking;
      lastError = null;
      lastCheck = null;

      var parsed = R.parseSyncRecord(readKv(kv, K.syncRecordKey(uid)));
      var record = parsed.record;

      /* §1.8.5 的守卫：修复结果与云端内容不同，回写必须由用户再确认一次。
         这里放在读云端之前 —— 连请求都不用发，因为结论已经确定了。 */
      if (record.pendingPushAfterLossyApply) {
        state = STATES.awaitingChoice;
        lastError = null;
        lastCheck = {
          ok: false, action: 'lossy-push-pending', kind: 'lossy-applied',
          code: 'E_PENDING_LOSSY_PUSH', message: MSG.lossyPush
        };
        return {
          ok: false, code: 'E_PENDING_LOSSY_PUSH', action: 'lossy-push-pending',
          message: MSG.lossyPush
        };
      }

      var scope = K.userScope(uid);
      var dbKey = K.dbKeyForScope(scope);

      var cand = readDocKey(kv, dbKey);
      if (!cand.ok) return fail(cand.code, cand.message, cand.detail);

      var h = await safeHash(cand.doc);
      if (!h.ok) return fail(h.code, h.message, h.detail);
      var localChanged = h.hash !== record.lastSyncedHash;
      /* Q-32：从「暂不写回」断链处重开的记录，内容哈希可能恰好等于记录里的基线
         （有损应用写的就是修复后的哈希），光比哈希会判成「两端都没变」而什么都不问。
         forceUpload 把它按「本地有未同步的改动」对待——重开必须问一次，这是
         「暂不写回」这个选法的全部安全感所在。 */
      var forced = opts && opts.forceUpload === true;

      var res = await backend.read(uid);
      if (!res.ok) {
        /* Q-26：读不到云端 ≠ 从未同步。直接暂停，零写入、零本地改动。
           D18：网络类失败标 retryable，界面会自愈重跑，不要求点「开始检查」。 */
        return isTransient(res.code)
          ? transientFail(res.code, res.message || '读取云端失败')
          : fail(res.code, res.message || '读取云端失败');
      }
      if (!res.row) {
        /* D23：记录说同步过、云端却没有行——只可能是被删或换了项目。
           旧行为是摆三选一等人点；新行为：云端空无一物，用本机原样重建，
           没有任何东西会被覆盖，无需询问、无需快照。 */
        var gateRebuild = await guardLease();
        if (!gateRebuild.ok) {
          return {
            ok: false, code: gateRebuild.code, message: gateRebuild.message,
            action: 'leased', retryable: true, holder: gateRebuild.holder
          };
        }
        var rebuilt = await backend.write(uid, buildPushPayload(cand.doc), null);
        if (!rebuilt.ok) {
          return isTransient(rebuilt.code)
            ? transientFail(rebuilt.code, rebuilt.message || '重建云端数据失败')
            : fail(rebuilt.code, rebuilt.message || '重建云端数据失败');
        }
        return commitRecovery(rebuilt.revision, h.hash, { scopeId: K.scopeId(scope), applied: null });
      }
      var remoteChanged = res.row.revision !== record.lastKnownRevision;

      if (!localChanged && !remoteChanged && !forced) {
        return settle('none', { revision: res.row.revision, hash: h.hash });
      }
      if (!localChanged && remoteChanged && !forced) {
        return pullInto(record, res.row);
      }
      if (!remoteChanged && (localChanged || forced)) {
        /* §4.5.3：关闭同步期间攒下的改动，重新开启时**必须显式确认上传**。
           这条路与「重新登录」共用四象限，唯一的区别就在这里 —— 不能合并成一个
           分支，否则「重开同步」会变成「一开就静默覆盖云端」。 */
        /* D23：重开的「是否上传」确认退场——关闭期间攒下的改动自动上传。
           冲突走 pushOut 内部的合并自愈（D22c），不会覆盖云端的新改动。 */
        return pushOut(record, cand.doc, h.hash);
      }

      /* D20（2026-10-28）替代 D10 的「本机无条件覆盖云端」：两边都改过时先合并再推。
         覆盖是排他的，必然有一方的编辑消失；合并把两边的改动都留住，推上去的是并集，
         随后两台设备看到同一份内容 —— 这才是「两台设备都能以本机为主」。
         覆盖前的账号候选备份仍由界面层负责（首次同步与四象限入口都有 exportBackup）。
         **例外**：关闭记录的重新开启（uploadNeedsConfirm）维持 Q-31/Q-32 的
         显式确认——那是用户亲手关掉的同步，重开是另一条受保护的路。 */
      /* D23：两边都改的重开确认也退场——与常规路径一样走三向合并。 */
      return mergeAndPush(record, cand.doc, h.hash, res.row);
    }

    /**
     * §4.7 保守恢复：**只读**检查。
     *
     * 能做与不能做：
     *   能——读云端行（revision + payload）并严格校验，读账号副本并算哈希；
     *   不能——写云端、写账号副本、写记录、切指针。任何一样在用户选择前都不许发生。
     *
     * 候选文档固定为**账号副本**（§4.7.2）。账号副本不存在时只展示云端摘要，
     * 并且不提供「以本机为准」——绝不拿游客文档冒充（那是把游客内容推到账号行的经典事故）。
     */
    async function inspectRecovery() {
      if (!uid) {
        state = STATES.local;
        return { ok: false, code: 'E_NOT_SIGNED_IN', message: '未登录', action: 'skip' };
      }
      var boot = bootNow();
      if (boot.kind !== 'recovery') {
        return {
          ok: false,
          code: 'E_NOT_RECOVERY',
          message: '当前记录不需要保守恢复（' + boot.kind + '）',
          action: 'skip',
          boot: boot.kind
        };
      }

      state = STATES.checking;
      lastError = null;
      lastCheck = null;

      var res = await backend.read(uid);
      if (!res.ok) {
        /* Q-26 同样适用：读不到云端不等于两端一致，也不等于从未同步。
           D18：网络类失败标 retryable，由界面定时自愈。 */
        return isTransient(res.code)
          ? transientFail(res.code, res.message || '读取云端失败')
          : fail(res.code, res.message || '读取云端失败');
      }
      var row = res.row || null;
      var remoteValid = true;
      var errors = [];
      if (row) {
        var inc2 = auditIncoming(row.payload);
        remoteValid = inc2.ok;    // D19：归一后可救即视为可用
        errors = inc2.errors || [];
      }

      var dbKey = K.dbKeyForScope(K.userScope(uid));
      var cand = readDocKey(kv, dbKey);
      var local = {
        available: !!cand.ok,
        code: cand.ok ? null : cand.code,
        hash: null,
        summary: null
      };
      if (cand.ok) {
        var h = await safeHash(cand.doc);
        if (!h.ok) return fail(h.code, h.message, h.detail);
        local.hash = h.hash;
        local.summary = summarizeDoc(cand.doc);
      }

      var chk = enterChoice({
        kind: 'recovery',
        reason: boot.reason,
        remote: row,
        remoteValid: remoteValid,
        remoteErrors: errors,
        local: local,
        options: {
          remote: !!(row && remoteValid),
          local: !!cand.ok,
          pause: true
        }
      });
      /* D23：恢复不再问人。云端合法 → 整份取云端；云端没有或非法 →
         本机可读就用本机重建/接管（覆盖前先快照）；两边都空 → 原样返回。 */
      if (chk.remoteValid) {
        snapshotRing('recovery-remote');
        return resolveRecovery('remote');
      }
      if (local.available) {
        snapshotRing('recovery-local');
        return resolveRecovery('local');
      }
      return chk;
    }

    /**
     * §4.7 三选一的落点。
     *
     * 共同顺序（§4.7.3/§4.7.4，不可交换）：远端动作 → 账号副本落盘并回读 →
     * 历史标记 → 同步记录 → 活动指针。任何一步失败都**不切源、不报成功**。
     * 「以本机为准」的强制导出不在这里：引擎没有导出通道，那是界面在调用前
     * 必须做完的事（§4.2 C、§4.7.3）；引擎这边的保证是「没有账号副本就拒绝上传」。
     *
     * @param {('remote'|'local'|'pause')} choice
     */
    async function resolveRecovery(choice) {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      if (state !== STATES.awaitingChoice || !lastCheck ||
          (lastCheck.kind !== 'recovery' && lastCheck.kind !== 'remote-missing')) {
        return fail('E_BAD_STATE', '当前没有待恢复的判定结果');
      }
      var ck = lastCheck;

      if (choice === 'pause') {
        /* 用户明确选择先不同步：零写入，但要让界面知道这不是「同步成功」。 */
        state = STATES.pausedError;
        lastError = { code: 'E_PAUSED', message: MSG.recovery, detail: { kind: ck.kind } };
        return { ok: false, code: 'E_PAUSED', action: 'paused', state: state };
      }
      if (choice !== 'remote' && choice !== 'local') {
        return fail('E_BAD_CHOICE', 'choice 必须是 remote / local / pause');
      }

      var scope = K.userScope(uid);
      var dbKey = K.dbKeyForScope(scope);
      var rev = ck.remote ? ck.remote.revision : null;

      if (choice === 'remote') {
        if (!ck.remote || !ck.remoteValid) {
          return fail('E_NO_REMOTE', '云端没有可用文档，不能以云端为准');
        }
        /* 重读账号副本：lastCheck 只是快照，两次点击之间用户可能又编辑过。
           合并的 settings/meta 取自这份「现在」的副本，不是那份快照。 */
        var fresh = readDocKey(kv, dbKey);
        var baseDoc = fresh.ok ? fresh.doc : { meta: {}, settings: {} };
        /* 恢复里的「以云端为准」也是往本机写远端内容，同样要过有损闸门。
           D20：这是用户显式选的「听云端的」，必须整份应用 —— 不能合并，
           否则账号副本里的旧条目会以「本机新增」的名义留下来，与用户的选择相反。 */
        var insp = auditRemote(ck.remote.payload);
        if (insp.lossy) return enterLossy(insp, 'recovery', ck.remote);
        var merged = remoteApply.mergeRemote(insp.doc, baseDoc, {
          now: now(), prev: readBase(), replace: true
        });
        if (!merged.ok) return fail('E_MERGE_FAILED', '远端文档合并失败', merged.errors);

        /* 先算哈希再落盘：反过来一旦算不出来，账号副本已被换掉、锚点没跟上。 */
        var rh = await safeHash(merged.doc);
        if (!rh.ok) return fail(rh.code, rh.message, rh.detail);
        var w = writeDocKey(kv, dbKey, merged.doc);
        if (!w.ok) return fail(w.code, w.message, w.detail);

        return commitRecovery(rev, rh.hash, { scopeId: K.scopeId(scope), applied: merged.doc });
      }

      /* 以本机为准 */
      if (!ck.local || !ck.local.available) {
        return fail('E_CANDIDATE_MISSING', '账号副本不存在或不可读，不能以本机为准');
      }
      var cand = readDocKey(kv, dbKey);
      if (!cand.ok) return fail(cand.code, cand.message, cand.detail);
      var lh = await safeHash(cand.doc);
      if (!lh.ok) return fail(lh.code, lh.message, lh.detail);

      /* 恢复里的「以本机为准」同样是云端写，同样要过租约（§5.4）。被挡住时停在
         awaiting-choice，用户稍后再点即可——这里不能 fail，否则一个可重试的排队
         会变成 paused-error 死状态。 */
      var gate = await guardLease();
      if (!gate.ok) {
        return {
          ok: false, code: gate.code, message: gate.message,
          action: 'leased', retryable: true, holder: gate.holder
        };
      }

      /* 用**刚读到的** revision 做条件更新（§5.5）。云端无行时传 null 走插入——
         那是用户明确选择的「重新上传」，不是自动重建。 */
      var pushed = await backend.write(uid, buildPushPayload(cand.doc), rev);
      if (!pushed.ok) {
        return isTransient(pushed.code)
          ? transientFail(pushed.code, pushed.message || '推送失败')
          : fail(pushed.code, pushed.message || '推送失败');
      }
      return commitRecovery(pushed.revision, lh.hash, { scopeId: K.scopeId(scope), applied: null });
    }

    /** 恢复成功后的收尾：历史标记 → 同步记录 → 活动指针。顺序即契约 §4.7.4。 */
    function commitRecovery(revision, hash, opts) {
      var histKey = K.syncHistoryKey(uid);
      var hist = readKv(kv, histKey);
      if (!hist || !R.validateHistoryMarker(hist).ok) {
        writeKv(kv, histKey, R.buildHistoryMarker(now()));
      }

      var at = now();
      var record = {
        v: R.RECORD_VERSION,
        state: 'active',
        enabled: true,
        enabledAt: at,
        closedAt: null,
        lastKnownRevision: revision,
        hashMethod: 'sha256',
        lastSyncedHash: hash,
        lastSyncedAt: at,
        pendingPushAfterLossyApply: false
      };
      var recCheck = R.validateSyncRecord(record);
      if (!recCheck.ok) return fail('E_RECORD_INVALID', '同步记录形状非法，未写入', recCheck.errors);

      var recKey = K.syncRecordKey(uid);
      writeKv(kv, recKey, record);
      /* 记录也必须回读：配额满时 localStorage 会静默失败，而这条记录是下次启动
         唯一的判据——写没进去却切了指针，下次启动就会以为「从未同步」。 */
      var back = readKv(kv, recKey);
      if (!back || H.canonicalJson(back) !== H.canonicalJson(record)) {
        return fail('E_RECORD_WRITE', '同步记录写入后回读不一致', { key: recKey });
      }

      kv.set(K.KEYS.active, opts.scopeId);
      var scopeSwitch = null;
      if (onScopeChanged) {
        try {
          var r = onScopeChanged(opts.scopeId);
          scopeSwitch = (r && typeof r === 'object') ? r : { ok: true, id: opts.scopeId };
        } catch (e) {
          scopeSwitch = { ok: false, code: 'E_SCOPE_HOOK_THREW', message: String(e && e.message || e) };
        }
      }
      if (opts.applied && onDocApplied) {
        try { onDocApplied(opts.scopeId, opts.applied); } catch (e) { /* 刷新界面失败不影响数据正确性 */ }
      }

      state = STATES.syncing;
      lastError = null;
      var out = {
        ok: true,
        state: state,
        action: 'recovered',
        revision: revision,
        hash: hash,
        record: record
      };
      if (scopeSwitch) out.scopeSwitch = scopeSwitch;
      bootInfo = bootNow();
      lastCheck = out;
      return out;
    }

    /* ------------------------------------------------------------------ *
     * §1.8 有损修复：确认、应用、二次确认回写
     * ------------------------------------------------------------------ */

    /** 当前待确认的有损结果（诊断与界面用；不含原始 payload）。 */
    function getLossy() {
      if (!pendingLossy) return null;
      return {
        source: pendingLossy.source,
        revision: pendingLossy.revision,
        preview: pendingLossy.preview,
        at: pendingLossy.at
      };
    }

    /**
     * 待确认时那份**云端原始 payload** 的副本。
     *
     * 只给「导出 remote-raw.json」用（§1.8.3）。深拷贝是刻意的：调用方拿到的是
     * 一份可以随便序列化的快照，动它不会污染待确认状态——否则用户点两次导出，
     * 第二次拿到的可能是被上一次改过的内容。
     */
    function getLossyPayload() {
      if (!pendingLossy || !pendingLossy.payload) return null;
      try {
        return JSON.parse(JSON.stringify(pendingLossy.payload));
      } catch (e) {
        return null;
      }
    }

    /**
     * 应用已确认的有损修复（§1.8.4）。
     *
     * 两个前置条件缺一不可：**勾选**与**两份 JSON 都已下载成功**。
     * 引擎管不到下载，只核对界面递上来的凭据——但这一点必须由引擎把关，
     * 因为「覆盖前先下载过」是用户唯一还能把数据找回来的凭据。
     *
     * 应用之后**刻意不进 syncing**：修复结果与云端原始内容不同，
     * 回写要单独确认（§1.8.5）。留在 awaiting-choice 才能让下一次编辑不偷偷上云。
     */
    async function applyLossy(ack) {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      if (!pendingLossy || !lastCheck || lastCheck.kind !== 'lossy') {
        return rejectLossy('E_NO_LOSSY', '当前没有待确认的有损修复结果');
      }
      if (!ack || ack.confirmed !== true) {
        return rejectLossy('E_LOSSY_UNCONFIRMED', '需要先勾选确认才能继续');
      }
      /* D16（2026-10-28 用户裁定「记录丢失时默认以云端为准」）：自动路径放行
         下载门槛——手机浏览器的程序化下载经常被拦，硬性要求会把用户卡死在
         点不动的对话框上。auto 标记只由界面自动路径传入（先静默导出备份，
         尽力而为）；人工对话框路径仍强制两份 JSON，契约 §4.6.5 不变。 */
      if (!ack.auto) {
        var downloads = Array.isArray(ack.downloads) ? ack.downloads : [];
        var missing = LZ.REQUIRED_DOWNLOADS.filter(function (n) {
          return downloads.indexOf(n) === -1;
        });
        if (missing.length) {
          return rejectLossy('E_LOSSY_DOWNLOADS',
            '必须先成功下载两份 JSON 才能继续，缺少：' + missing.join('、'));
        }
      }

      return applyLossyCore(pendingLossy);
    }

    /** 有损修复的收尾。与 commitRecovery 的差别只有一处：pendingPushAfterLossyApply=true。 */
    function commitLossy(revision, hash, applied) {
      var scope = K.userScope(uid);
      var histKey = K.syncHistoryKey(uid);
      var hist = readKv(kv, histKey);
      if (!hist || !R.validateHistoryMarker(hist).ok) {
        writeKv(kv, histKey, R.buildHistoryMarker(now()));
      }

      var at = now();
      var record = {
        v: R.RECORD_VERSION,
        state: 'active',
        enabled: true,
        enabledAt: at,
        closedAt: null,
        lastKnownRevision: revision,
        hashMethod: 'sha256',
        lastSyncedHash: hash,
        lastSyncedAt: at,
        pendingPushAfterLossyApply: true
      };
      var recCheck = R.validateSyncRecord(record);
      if (!recCheck.ok) return fail('E_RECORD_INVALID', '同步记录形状非法，未写入', recCheck.errors);

      var recKey = K.syncRecordKey(uid);
      writeKv(kv, recKey, record);
      var back = readKv(kv, recKey);
      if (!back || H.canonicalJson(back) !== H.canonicalJson(record)) {
        return fail('E_RECORD_WRITE', '同步记录写入后回读不一致', { key: recKey });
      }

      var scopeId = K.scopeId(scope);
      kv.set(K.KEYS.active, scopeId);
      var scopeSwitch = null;
      if (onScopeChanged) {
        try {
          var r = onScopeChanged(scopeId);
          scopeSwitch = (r && typeof r === 'object') ? r : { ok: true, id: scopeId };
        } catch (e) {
          scopeSwitch = { ok: false, code: 'E_SCOPE_HOOK_THREW', message: String(e && e.message || e) };
        }
      }
      if (applied && onDocApplied) {
        try { onDocApplied(scopeId, applied); } catch (e) { /* 刷新界面失败不影响数据正确性 */ }
      } else if (applied && !onScopeChanged) {
        setLocalDoc(applied);
      }

      state = STATES.awaitingChoice;
      lastError = null;
      pendingLossy = null;
      lastCheck = {
        ok: true,
        action: 'lossy-applied',
        kind: 'lossy-applied',
        revision: revision,
        hash: hash,
        requires: 'confirm-push',
        message: MSG.lossyPush
      };
      bootInfo = bootNow();

      var out = {
        ok: true,
        action: 'lossy-applied',
        state: state,
        revision: revision,
        hash: hash,
        requires: 'confirm-push',
        message: MSG.lossyPush,
        record: record
      };
      if (scopeSwitch) out.scopeSwitch = scopeSwitch;
      return out;
    }

    /**
     * §1.8.5 的第二次确认：把修复后的数据写回云端。
     * 只有这里才允许清掉 pendingPushAfterLossyApply —— 别的路径一律不许碰它。
     */
    async function confirmLossyPush() {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      var recKey = K.syncRecordKey(uid);
      var parsed = R.parseSyncRecord(readKv(kv, recKey));
      if (!parsed.ok || parsed.state !== 'active' || !parsed.record.pendingPushAfterLossyApply) {
        return rejectLossy('E_NO_LOSSY', '当前没有待回写的修复结果');
      }
      var record = parsed.record;
      var cand = readDocKey(kv, K.dbKeyForScope(K.userScope(uid)));
      if (!cand.ok) return fail(cand.code, cand.message, cand.detail);

      var h = await safeHash(cand.doc);
      if (!h.ok) return fail(h.code, h.message, h.detail);

      var gate = await guardLease();
      if (!gate.ok) {
        return {
          ok: false, code: gate.code, message: gate.message,
          action: 'leased', retryable: true, holder: gate.holder
        };
      }

      var pushed = await backend.write(uid, buildPushPayload(cand.doc), record.lastKnownRevision);
      if (!pushed.ok) {
        return isTransient(pushed.code)
          ? transientFail(pushed.code, pushed.message || '推送失败')
          : fail(pushed.code, pushed.message || '推送失败');
      }

      var next = Object.assign({}, record, {
        lastKnownRevision: pushed.revision,
        lastSyncedHash: h.hash,
        lastSyncedAt: now(),
        pendingPushAfterLossyApply: false
      });
      writeKv(kv, recKey, next);
      var back = readKv(kv, recKey);
      if (!back || H.canonicalJson(back) !== H.canonicalJson(next)) {
        return fail('E_RECORD_WRITE', '同步记录写入后回读不一致', { key: recKey });
      }

      state = STATES.syncing;
      lastError = null;
      lastCheck = { ok: true, action: 'lossy-pushed', revision: pushed.revision, hash: h.hash };
      bootInfo = bootNow();
      var out = {
        ok: true,
        action: 'lossy-pushed',
        state: state,
        revision: pushed.revision,
        hash: h.hash,
        record: next
      };
      if (gate.warning) out.lease = gate.warning;
      return out;
    }

    /**
     * D19 兜底出口：**用本机数据覆盖云端**（云端数据连归一都救不了时）。
     */
    async function overwriteRemoteWithLocal() {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      if (state === STATES.checking) return fail('E_BAD_STATE', '正在检查，请稍后再试');
      var parsed = R.parseSyncRecord(readKv(kv, K.syncRecordKey(uid)));
      if (!parsed.ok || parsed.state !== 'active') {
        return fail('E_RECORD_MISSING', '同步记录缺失或状态非 active，不能覆盖云端');
      }
      var chk = await check();
      if (chk && chk.action === 'recovery') return chk;
      if (state !== STATES.awaitingChoice) {
        return { ok: true, skipped: true, reason: 'nothing-to-overwrite', state: state };
      }
      return confirm('local');
    }

    /**
     * Q-32 的第二个出口：用户在有损回写确认里选「暂不写回」。
     *
     * 为什么不是「把对话框关掉就算了」：那样标记永远留着，用户从此推不上去，
     * 而界面上只有一个「写回」按钮，看起来就是坏了；更糟的是他一个月后在另一台
     * 设备上才发现这段时间的改动全都不在云里——本地一切正常，所以发现得极晚。
     *
     * 这里转 `closed`，诚实承认这条链路断了。三件事：
     *   ① 记录转 closed、**保留锚点**（重开时才分得清本地改没改）；
     *   ② **刻意保留 `pendingPushAfterLossyApply: true`**：它在这里不再是推送守卫
     *      （closed 下本来就不推送），而是「还欠用户一次确认」的持久信号；
     *   ③ 释放租约、状态回 `signed-in`，观感与主动关闭同步完全一致。
     *
     * 重开时 `reopen()` 读到这个标记 → 清掉它并强制走一次上传确认（resume 的
     * `forceUpload`）。所以「暂不写回」不会退化成「静默停止上传」。
     */
    function stopAfterLossy() {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      var recKey = K.syncRecordKey(uid);
      var parsed = R.parseSyncRecord(readKv(kv, recKey));
      if (!parsed.ok || parsed.state !== 'active' || !parsed.record.pendingPushAfterLossyApply) {
        return rejectLossy('E_NO_LOSSY', '当前没有待处理的修复结果');
      }

      var next = Object.assign({}, parsed.record, {
        state: 'closed',
        enabled: false,
        closedAt: now(),
        pendingPushAfterLossyApply: true
      });
      var check = R.validateSyncRecord(next);
      if (!check.ok) return fail('E_RECORD_INVALID', '停止同步后的记录形状非法，未写入', check.errors);

      writeKv(kv, recKey, next);
      var back = readKv(kv, recKey);
      if (!back || H.canonicalJson(back) !== H.canonicalJson(next)) {
        return fail('E_RECORD_WRITE', '停止同步：记录写入后回读不一致', { key: recKey });
      }

      var lease = getLease();
      if (lease) lease.release();

      state = STATES.signedIn;
      lastError = null;
      lastCheck = null;
      pendingLossy = null;
      bootInfo = bootNow();
      return {
        ok: true,
        action: 'closed-after-lossy',
        state: state,
        message: MSG.lossyStopped,
        record: next
      };
    }

    /** 只远端变：校验 → 有损审计 → 合并 → 写账号副本 → 回读 → 更新记录 → 切指针。 */
    /**
     * D20（2026-10-28）：两端都有未同步改动时的收口 —— 先合并，再推合并结果。
     *
     * 以前这里是 `pushOut(record, cand.doc, h.hash, { force: true })`：本机无条件
     * 覆盖云端。代价是对方的编辑被无声抹掉，两台设备永远只有一台的内容能活下来，
     * 用户感受到的就是「只能有一台以本机为主」。
     *
     * 覆盖是排他的，合并不是：按 id / 日期键取并集、同 id 取较新者，两边的新增与
     * 编辑都留下来，推上去的是并集，随后两台设备看到同一份内容。只有「同一字段
     * 在同一秒被两边改成不同值」这种真冲突才需要一方让步（updatedAt 较新者赢）。
     *
     * 合并结果必须先落本机再推：推成功而本机没写，界面就还是旧内容，用户一编辑
     * 又把旧内容推回去（Q-29 的翻版）。
     */
    async function mergeAndPush(record, localDoc, localHash, row) {
      var inc = auditIncoming(row.payload);
      if (!inc.ok) return fail(inc.code, inc.message, inc.errors);

      /* 远端有损：不在这里硬合 —— 交给有损闸门先修再合，它会走同一条合并路径。 */
      if (inc.insp && inc.insp.lossy) return enterLossy(inc.insp, 'merge-push', row);

      var merged = remoteApply.mergeRemote(inc.insp.doc, localDoc, {
        now: now(), prev: readBase()
      });
      if (!merged.ok) return fail('E_MERGE_FAILED', '合并失败', merged.errors);

      var h = await safeHash(merged.doc);
      if (!h.ok) return fail(h.code, h.message, h.detail);

      var w = writeDocKey(kv, K.dbKeyForScope(K.userScope(uid)), merged.doc);
      if (!w.ok) return fail(w.code, w.message, w.detail);

      if (onDocApplied) {
        try { onDocApplied(K.scopeId(K.userScope(uid)), merged.doc); } catch (e) { /* 刷新界面失败不影响数据正确性 */ }
      }

      /* 合并基于刚读到的最新 revision，条件推送必然对不上（远端 revision 已前进），
         所以这里显式 force：内容已经并进去了，覆盖是安全的。 */
      return pushOut(record, merged.doc, h.hash, { force: true, merged: true, baseHash: localHash });
    }

    async function pullInto(record, row) {
      var inc = auditIncoming(row.payload);
      if (!inc.ok) return fail(inc.code, inc.message, inc.errors);

      var insp = inc.insp;
      if (insp.lossy) return enterLossy(insp, 'pull-into', row);

      var cand = readDocKey(kv, K.dbKeyForScope(K.userScope(uid)));
      if (!cand.ok) return fail(cand.code, cand.message, cand.detail);

      /* D20：本机自上次同步后没动过（哈希 == 锚点）→ 远端就是唯一真相，整份应用；
         本机也有未同步改动 → 三方合并，两边的编辑都留住。
         判不出来（哈希算不了）时按「有改动」处理，走合并这条保守的路。 */
      var localH = await safeHash(cand.doc);
      var localDirty = !localH.ok || localH.hash !== record.lastSyncedHash;

      var merged = remoteApply.mergeRemote(insp.doc, cand.doc, {
        now: now(), prev: readBase(), replace: !localDirty
      });
      if (!merged.ok) return fail('E_MERGE_FAILED', '合并失败', merged.errors);

      var h = await safeHash(merged.doc);
      if (!h.ok) return fail(h.code, h.message, h.detail);

      var w = writeDocKey(kv, K.dbKeyForScope(K.userScope(uid)), merged.doc);
      if (!w.ok) return fail(w.code, w.message, w.detail);

      writeKv(kv, K.syncRecordKey(uid), Object.assign({}, record, {
        lastKnownRevision: row.revision,
        lastSyncedHash: h.hash,
        lastSyncedAt: now()
      }));

      /* 界面若正停在这个账号，必须跟着换：否则磁盘新了、界面还是旧的，
         用户随手一编辑就把旧内容写回去（Q-29 的翻版）。 */
      if (onDocApplied) {
        try { onDocApplied(K.scopeId(K.userScope(uid)), merged.doc); } catch (e) { /* 刷新界面失败不影响数据正确性 */ }
      }
      return settle('pulled', { revision: row.revision, hash: h.hash });
    }

    /** 只本地变：条件推送（revision 不匹配即失败，不静默覆盖）。 */
    async function pushOut(record, candDoc, hash, opts2) {
      opts2 = opts2 || {};
      if (record.pendingPushAfterLossyApply) {
        state = STATES.awaitingChoice;
        lastError = null;
        lastCheck = {
          ok: false, action: 'lossy-push-pending', kind: 'lossy-applied',
          code: 'E_PENDING_LOSSY_PUSH', message: MSG.lossyPush
        };
        return {
          ok: false, code: 'E_PENDING_LOSSY_PUSH', action: 'lossy-push-pending',
          message: MSG.lossyPush
        };
      }
      var gate = await guardLease();
      if (!gate.ok) {
        /* 四象限这一步走不下去，但同步本身是「开着」的。状态摆回 syncing，让调度层
           接得上并在防抖后自动重试；留在 checking 的话 steady 会认为「没在同步」，
           这次改动就永远上不了云。 */
        state = STATES.syncing;
        lastError = null;
        return {
          ok: false, code: gate.code, message: gate.message,
          action: 'leased', retryable: true, holder: gate.holder
        };
      }
      var payload = buildPushPayload(candDoc);
      var pushed = await backend.write(uid, payload, record.lastKnownRevision);
      /* D22c（2026-10-29）：条件推送撞上 revision 分歧不再区不区分 force 一律自愈。
         以前非 force（resume 的「本机干净」分支、confirmReopenUpload）撞 E_CONFLICT
         直接 fail() → paused-error 死状态，「点开始检查选择保留哪一边」——而这恰是
         两台设备同时开始同步时的高概率竞态：read 与 write 之间对方插进一次推送。
         现在：force → 无条件覆盖（合并结果本来就基于最新 revision）；非 force →
         读当前行走 mergeAndPush（D20 三向合并），两边编辑都留住。 */
      if (!pushed.ok && pushed.code === 'E_CONFLICT') {
        if (opts2 && opts2.force) {
          pushed = await forceOverwrite(payload);
        }
        /* force 覆盖期间对方又推了一次（或本来就没带 force）：落回三向合并。
           mergeAndPush 的推送带 force，最坏情况循环到这里也只会再读一次最新行。 */
        if (!pushed.ok && pushed.code === 'E_CONFLICT') {
          var clash = await backend.read(uid);
          if (!clash.ok) {
            return isTransient(clash.code)
              ? transientFail(clash.code, clash.message || '读取云端失败')
              : fail(clash.code, clash.message || '读取云端失败');
          }
          if (!clash.row) {
            return fail('E_REMOTE_MISSING', '云端行已不存在，本次推送中止');
          }
          return mergeAndPush(record, candDoc, hash, clash.row);
        }
      }
      if (!pushed.ok) {
        return isTransient(pushed.code)
          ? transientFail(pushed.code, pushed.message || '推送失败')
          : fail(pushed.code, pushed.message || '推送失败');
      }
      writeKv(kv, K.syncRecordKey(uid), Object.assign({}, record, {
        lastKnownRevision: pushed.revision,
        lastSyncedHash: hash,
        lastSyncedAt: now()
      }));
      return settle('pushed', { revision: pushed.revision, hash: hash, lease: gate.warning || null });
    }

    /**
     * 四象限成功后统一收尾：进 `syncing`，必要时写指针并通知装配层重绑。
     *
     * 顺序不能反（§4.6.4）：候选落盘、记录写完，最后才切指针。指针本来就对时
     * 不做多余动作——刷新后每次启动都白切一次 store，会让界面无谓重绘。
     */
    function settle(action, extra) {
      state = STATES.syncing;
      lastError = null;

      var want = K.scopeId(K.userScope(uid));
      var ptr = K.parseActivePointer(kv.get(K.KEYS.active));
      var scopeSwitch = null;
      if (!ptr.ok || ptr.id !== want) {
        kv.set(K.KEYS.active, want);
        if (onScopeChanged) {
          try {
            var r = onScopeChanged(want);
            scopeSwitch = (r && typeof r === 'object') ? r : { ok: true, id: want };
          } catch (e) {
            scopeSwitch = { ok: false, code: 'E_SCOPE_HOOK_THREW', message: String(e && e.message || e) };
          }
        }
      }

      var out = { ok: true, state: state, action: action };
      Object.assign(out, extra || {});

      /* D20：把「本次同步后两端的共同内容」记为下次三向合并的共同祖先。
         读盘时机有讲究：pushOut 不写盘（本机早就是待推的那份内容），pullInto 与
         mergeAndPush 都先写盘再 settle —— 两种情况读到的都是刚同步完的内容。 */
      if (uid) {
        try {
          var baseDoc = readDocKey(kv, K.dbKeyForScope(K.userScope(uid)));
          if (baseDoc.ok) writeBase(baseDoc.doc);
        } catch (e) { /* 基线写不进去只影响删除判定，不影响数据本身 */ }
      }
      if (scopeSwitch) out.scopeSwitch = scopeSwitch;
      bootInfo = bootNow();
      lastCheck = out;
      return out;
    }

    /* ------------------------------------------------------------------ *
     * §2.3 生命周期：关闭 / 重新开启 / 删除云端 / 清空本机
     * ------------------------------------------------------------------ */

    /**
     * 关闭同步（§4.5.1、T-R01）。
     *
     * 只做三件事：记录转 `closed`、释放租约、停止后续请求。
     * **不动云端、不动本机数据、不删记录** —— 锚点必须保留，
     * 否则重开时就分不清「本地改没改」，只能退回首次同步的 C 情况让用户重选。
     */
    function closeSync() {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      var recKey = K.syncRecordKey(uid);
      var parsed = R.parseSyncRecord(readKv(kv, recKey));
      if (!parsed.ok || parsed.state !== 'active') {
        return fail('E_NOT_ACTIVE', '当前没有进行中的同步可关闭（' + parsed.status + '）');
      }

      var next = Object.assign({}, parsed.record, {
        state: 'closed',
        enabled: false,
        closedAt: now()
      });
      var check = R.validateSyncRecord(next);
      if (!check.ok) return fail('E_RECORD_INVALID', '关闭后的记录形状非法，未写入', check.errors);

      writeKv(kv, recKey, next);
      var back = readKv(kv, recKey);
      if (!back || H.canonicalJson(back) !== H.canonicalJson(next)) {
        return fail('E_RECORD_WRITE', '关闭同步：记录写入后回读不一致', { key: recKey });
      }

      var l = getLease();
      if (l) l.release();

      state = STATES.signedIn;
      lastError = null;
      lastCheck = null;
      pendingLossy = null;
      bootInfo = bootNow();
      return { ok: true, action: 'closed', state: state, record: next };
    }

    /**
     * 重新开启同步（§4.5、§2.3、T-F09 / T-F12）。
     *
     * 两种记录形状，两条完全不同的路：
     *   closed → 记录回到 active，然后照四象限走一遍，**但「本地有改动」要显式确认**；
     *   reset  → 没有可用锚点，保持 reset 不动，请调用方重新 `check()`
     *            （A/A′/B/C/D 由当前云端实际状态决定，不得假定云端为空）。
     *
     * 为什么 reset 不在这里直接改记录：§2.3 明令「保持 reset 直到远端操作成功」。
     * 提前写 active 就等于拿一个不存在的锚点去比较，那是最容易造成覆盖的顺序。
     */
    async function reopen() {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      var boot = bootNow();

      if (boot.kind === 'reset') {
        state = STATES.signedIn;
        lastError = null;
        lastCheck = null;
        return {
          ok: true,
          action: 'needs-check',
          state: state,
          boot: 'reset',
          message: MSG.resetReopen
        };
      }
      if (boot.kind !== 'closed') {
        return fail('E_NOT_CLOSED', '当前同步记录不是 closed 状态（' + boot.kind + '），无需重开');
      }

      var recKey = K.syncRecordKey(uid);
      var parsed = R.parseSyncRecord(readKv(kv, recKey));
      if (!parsed.ok || parsed.state !== 'closed') {
        return fail('E_NOT_CLOSED', '同步记录已变化，请刷新后再试');
      }

      /* Q-32：因「暂不写回」而断链的记录，closed 里留着 pendingPushAfterLossyApply。
         这里**必须清掉它**——不清的话 resume 开头的守卫会当成「还在等写回」，
         用户就又回到那个只有一个按钮的界面；但清掉之后也不能当成「两端一致」，
         所以用 forceUpload 让四象限即便内容哈希相同也问一次。 */
      var lostPush = parsed.record.pendingPushAfterLossyApply === true;

      var next = Object.assign({}, parsed.record, {
        state: 'active',
        enabled: true,
        closedAt: null,
        pendingPushAfterLossyApply: false
      });
      var check = R.validateSyncRecord(next);
      if (!check.ok) return fail('E_RECORD_INVALID', '重开后的记录形状非法，未写入', check.errors);

      writeKv(kv, recKey, next);
      var back = readKv(kv, recKey);
      if (!back || H.canonicalJson(back) !== H.canonicalJson(next)) {
        return fail('E_RECORD_WRITE', '重新开启：记录写入后回读不一致', { key: recKey });
      }
      bootInfo = bootNow();

      return resume({ uploadNeedsConfirm: true, forceUpload: lostPush });
    }

    /** §4.5.3 的确认：关闭期间攒下的改动，用户点头之后才推。 */
    async function confirmReopenUpload() {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      if (state !== STATES.awaitingChoice || !lastCheck || lastCheck.kind !== 'reopen-upload') {
        return { ok: false, code: 'E_NO_UPLOAD_CONFIRM', action: 'upload-confirm', message: '当前没有待确认的上传' };
      }
      var parsed = R.parseSyncRecord(readKv(kv, K.syncRecordKey(uid)));
      if (!parsed.ok || parsed.state !== 'active') {
        return fail('E_NOT_ACTIVE', '同步记录状态已变化，请重新检查');
      }
      var cand = readDocKey(kv, K.dbKeyForScope(K.userScope(uid)));
      if (!cand.ok) return fail(cand.code, cand.message, cand.detail);
      var h = await safeHash(cand.doc);
      if (!h.ok) return fail(h.code, h.message, h.detail);
      return pushOut(parsed.record, cand.doc, h.hash);
    }

    /**
     * 删除云端数据（§2.3、T-R02 / T-R07）。
     *
     * 门槛是两道：**二次确认**与**已成功导出**。任何一道缺失都中止——
     * 云端那一行删掉之后，本机这份就是唯一的一份，没有导出等于没有退路。
     *
     * 删除成功后写完整 reset 记录（锚点全 null、hashMethod null），保留历史标记：
     * 下次启动因此判为「合法 reset」而不是「记录损坏」（T-R07 / S-44）。
     */
    async function deleteRemote(ack) {
      if (!uid) return fail('E_NOT_SIGNED_IN', '未登录');
      if (!ack || ack.confirmed !== true) {
        return {
          ok: false, code: 'E_DELETE_UNCONFIRMED', action: 'delete-remote',
          message: '删除云端数据需要二次确认'
        };
      }
      if (ack.exported !== true) {
        return {
          ok: false, code: 'E_DELETE_NOT_EXPORTED', action: 'delete-remote',
          message: '必须先成功导出本机数据，导出失败即中止'
        };
      }
      var recKey = K.syncRecordKey(uid);
      var parsed = R.parseSyncRecord(readKv(kv, recKey));
      if (!parsed.ok || parsed.state !== 'active') {
        return fail('E_NOT_ACTIVE', '当前没有进行中的同步可删除云端数据');
      }
      if (typeof backend.remove !== 'function') {
        return fail('E_NO_BACKEND_REMOVE', '当前后端不支持删除云端数据');
      }

      /* 删除也是云端写：先过租约，避免与另一个标签页的推送互相踩踏。 */
      var gate = await guardLease();
      if (!gate.ok) {
        return {
          ok: false, code: gate.code, message: gate.message,
          action: 'leased', retryable: true, holder: gate.holder
        };
      }

      var res = await backend.remove(uid);
      if (!res || !res.ok) {
        return fail((res && res.code) || 'E_DELETE_FAILED', (res && res.message) || '删除云端数据失败');
      }

      /* 历史标记：原本没有（例如删除前的记录是首次同步失败留下的）也要补一个——
         它表示「曾经同步过」，正是下次启动判 reset 而不是判「从未同步」的依据。 */
      var histKey = K.syncHistoryKey(uid);
      var hist = readKv(kv, histKey);
      if (!hist || !R.validateHistoryMarker(hist).ok) {
        writeKv(kv, histKey, R.buildHistoryMarker(now()));
      }

      var reset = R.buildResetRecord({
        enabledAt: parsed.record.enabledAt,
        closedAt: now(),
        now: now()
      });
      var resetCheck = R.validateSyncRecord(reset);
      if (!resetCheck.ok) return fail('E_RECORD_INVALID', 'reset 记录形状非法，未写入', resetCheck.errors);

      writeKv(kv, recKey, reset);
      /* D20：云端行了没了，旧基线不再代表任何共同内容 —— 留着会让下一次合并
         拿一份早已不存在的历史去判删除。 */
      if (typeof K.syncBaseKey === 'function') kv.remove(K.syncBaseKey(uid));
      var back = readKv(kv, recKey);
      if (!back || H.canonicalJson(back) !== H.canonicalJson(reset)) {
        return fail('E_RECORD_WRITE', '删除云端后：reset 记录回读不一致', { key: recKey });
      }

      var l = getLease();
      if (l) l.release();

      state = STATES.signedIn;
      lastError = null;
      lastCheck = null;
      pendingLossy = null;
      bootInfo = bootNow();
      var out = { ok: true, action: 'remote-deleted', state: state, record: reset };
      if (gate.warning) out.lease = gate.warning;
      return out;
    }

    /**
     * 本机数据已被清空（§2.3、T-R03）。
     *
     * 清空动作本身由 store/scope-storage 完成（它负责写 reset 记录、只清当前作用域）。
     * 引擎这边只做一件事：**停下来并说清楚云端还在**。
     * 不做这一步的话，下一次编辑会走 push()——把一份空文档推上云端，
     * 而用户以为自己只是「清空了本机」。
     */
    function noteLocalCleared() {
      var l = getLease();
      if (l) l.release();
      /* D20：本机已空，旧基线不再代表共同内容（云端那份还在，但用户明确选了清本机）。 */
      if (uid && typeof K.syncBaseKey === 'function') {
        try { kv.remove(K.syncBaseKey(uid)); } catch (e) { /* 清不掉只影响删除判定 */ }
      }
      lastCheck = null;
      pendingLossy = null;
      state = STATES.pausedError;
      lastError = { code: 'E_LOCAL_CLEARED', message: MSG.localCleared };
      bootInfo = uid ? bootNow() : null;
      return { ok: true, action: 'cleared', state: state, message: MSG.localCleared };
    }

    return {
      STATES: STATES,
      getState: getState,
      getError: getError,
      getCheck: getCheck,
      getBoot: getBoot,
      getUid: function () { return uid; },
      signIn: signIn,
      signOut: signOut,
      check: check,
      confirm: confirm,
      resume: resume,
      inspectRecovery: inspectRecovery,
      resolveRecovery: resolveRecovery,
      noteLocalStale: noteLocalStale,
      getLease: getLease,
      getLossy: getLossy,
      getLossyPayload: getLossyPayload,
      applyLossy: applyLossy,
      confirmLossyPush: confirmLossyPush,
      stopAfterLossy: stopAfterLossy,
      closeSync: closeSync,
      reopen: reopen,
      confirmReopenUpload: confirmReopenUpload,
      deleteRemote: deleteRemote,
      overwriteRemoteWithLocal: overwriteRemoteWithLocal,
      noteLocalCleared: noteLocalCleared,
      push: push,
      pull: pull
    };
  }

  return {
    STATES: STATES,
    createEngine: createEngine,
    hasContent: hasContent
  };
});
