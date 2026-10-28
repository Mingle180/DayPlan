/**
 * DayPlan · 同步装配层（唯一决定「用哪个后端」的地方）
 *
 * 为什么需要这一层：引擎（src/sync/engine.js）与会话（src/net/session.js）
 * 都只认注入进来的接口，不认识 fetch，也不认识 localStorage。装配层是
 * 把「本机存储 + 后端实现 + 令牌来源」接在一起的唯一位置。
 *
 * 三个模式，语义互斥，**不得静默降级**：
 *   'off'  默认。不建 session、不建 engine、不建 http。UI 只显示「本机模式」。
 *   'mock' 演示。后端是内存行（src/dev/mock-backend.js），零网络请求。
 *          用于在没有 Supabase 项目时开发与目视 UI，**不是**同步功能上线。
 *   'real' 真实远端。必须显式给出 config（url / anonKey）与 fetchImpl，
 *          缺任何一项直接抛 E_NOT_CONFIGURED —— 绝不退回 mock，
 *          否则「以为在同步、其实在本地演示」是最危险的一类静默失败。
 *
 * 已知边界：
 *   · real 模式的 revision 采用 expectedRevision + 1（supabase.js 不代算）。
 *     这一点**未在真实 Supabase 上验证**，属于 Phase 2 待验项。
 *   · 本层不做租约、不做多标签仲裁；那是引擎与 §5 的职责。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(
    isNode ? require('../core/sync-keys.js') : root.DayPlan.syncKeys,
    isNode ? require('../net/session.js') : root.DayPlan.session,
    isNode ? require('../net/supabase.js') : (root.DayPlan && root.DayPlan.supabase),
    isNode ? require('../sync/engine.js') : (root.DayPlan && root.DayPlan.syncEngine),
    isNode ? require('../dev/mock-backend.js') : (root.DayPlan && root.DayPlan.mockBackend)
  );
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.syncWiring = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this,
function (K, session, supabase, syncEngine, mockBackend) {
  'use strict';

  var MODES = { off: 'off', mock: 'mock', real: 'real' };
  var DEMO_TTL_MS = 3600 * 1000;

  function makeError(code, message, cause) {
    var e = new Error(message);
    e.code = code;
    if (cause) e.cause = cause;
    return e;
  }

  /**
   * 把 localStorage 风格的 storage 适配成引擎/会话要的 kv（get/set/remove）。
   * 键名**原样透传**：sync-keys 定的键名是契约的一部分，适配层不得改写成自己的命名空间。
   */
  function adaptKv(storage) {
    if (!storage || typeof storage.getItem !== 'function' ||
        typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
      throw new TypeError('adaptKv 需要 getItem / setItem / removeItem');
    }
    return {
      get: function (key) { return storage.getItem(key); },
      set: function (key, value) { storage.setItem(key, value); },
      remove: function (key) { storage.removeItem(key); }
    };
  }

  /**
   * 把 supabase http 客户端映射成引擎要的 backend：read(uid) / write(uid, payload, expectedRevision)。
   *
   * 形状差异全部收在这里：
   *   远端列名 schedule_data / updated_at  ↔  引擎的 payload / updatedAt
   *   远端 select 0 行                      →  { ok:true, row:null }（合法：从未同步过）
   *   expectedRevision === null             →  insert
   *   expectedRevision 是数字               →  条件更新，revision 传 +1
   *
   * @param {object} http  supabase.createHttp 的产物
   * @param {object|function} auth  有 withToken(fn) 的会话对象；或 () => token 的函数（仅测试用）
   */
  function createRemoteBackend(http, auth) {
    if (!http || typeof http.select !== 'function' ||
        typeof http.insert !== 'function' || typeof http.updateConditional !== 'function') {
      throw new TypeError('createRemoteBackend 需要 select / insert / updateConditional');
    }
    var withToken;
    if (auth && typeof auth.withToken === 'function') {
      withToken = function (fn) { return auth.withToken(fn); };
    } else if (typeof auth === 'function') {
      withToken = function (fn) {
        return Promise.resolve(auth()).then(function (token) { return fn(token); });
      };
    } else {
      throw new TypeError('createRemoteBackend 需要 withToken 或取令牌的函数');
    }

    function pickRow(res) {
      if (!res) return null;
      if (res.row) return res.row;
      if (Array.isArray(res.rows) && res.rows.length) return res.rows[0];
      return null;
    }

    function read(uid) {
      return withToken(function (token) {
        return http.select(uid, token);
      }).then(function (res) {
        if (!res || !res.ok) {
          return res && res.code
            ? res
            : { ok: false, code: 'E_BAD_RESPONSE', message: '读取云端无有效响应' };
        }
        var row = pickRow(res);
        if (!row) return { ok: true, row: null };
        return {
          ok: true,
          row: {
            revision: row.revision,
            payload: row.schedule_data,
            updatedAt: row.updated_at
          }
        };
      });
    }

    function write(uid, payload, expectedRevision) {
      var expected = expectedRevision === undefined ? null : expectedRevision;
      return withToken(function (token) {
        if (expected === null) {
          return http.insert(uid, payload, token);
        }
        return http.updateConditional(
          uid,
          { schedule_data: payload, revision: expected + 1 },
          expected,
          token
        );
      }).then(function (res) {
        if (!res || !res.ok) {
          return res && res.code
            ? res
            : { ok: false, code: 'E_BAD_RESPONSE', message: '写入云端无有效响应' };
        }
        var row = pickRow(res);
        if (!row || typeof row.revision !== 'number') {
          return { ok: false, code: 'E_UNVERIFIABLE', message: '写入成功但未返回 revision，结果不可验证' };
        }
        /* 条件更新必须回到 n+1（契约 §5.5）。若服务端回了别的数字，说明双方对
           「下一次 revision」的理解已经分叉——可能是并发写入抢先、也可能是列被
           触发器改过。此时当成功会把锚点带到错误的数值，下一次推送必然莫名冲突，
           所以一律判不可验证，由上层转 paused-error 重新检查。 */
        if (expected !== null && row.revision !== expected + 1) {
          return {
            ok: false,
            code: 'E_UNVERIFIABLE',
            message: '服务端返回 revision=' + row.revision + '，不是期望的 ' + (expected + 1) + '，结果不可验证'
          };
        }
        return { ok: true, revision: row.revision };
      });
    }

    /**
     * 删除当前用户的行（§2.3「删除云端数据」）。
     * 0 行在服务端被记为 `unverified`（见 supabase.remove），这里原样透传：
     * 「本来就没有这一行」与「删掉了」对调用方是同一个结果，
     * 但「服务端没给出可验证的响应」不能当成删除成功——否则用户会以为云端已清空。
     */
    function remove(uid) {
      return withToken(function (token) {
        return http.remove(uid, token);
      }).then(function (res) {
        if (!res || !res.ok) {
          return res && res.code
            ? res
            : { ok: false, code: 'E_BAD_RESPONSE', message: '删除云端数据无有效响应' };
        }
        return { ok: true };
      });
    }

    return { read: read, write: write, remove: remove };
  }

  /**
   * 纯内存 kv。mock（演示）模式默认用它，**不碰 localStorage**。
   * 理由：演示会写账号副本与同步记录，若落进真实 storage，刷新后 mock 后端的内存行没了，
   * 记录却还在（active + 指针指向该账号），下次登录会 resume 到 syncing 然后撞 E_CONFLICT——
   * 留下一堆指向「不存在的云端行」的脏记录。演示必须与真实数据完全隔离。
   */
  function memoryKv() {
    var map = Object.create(null);
    return {
      get: function (key) {
        return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
      },
      set: function (key, value) { map[key] = value; },
      remove: function (key) { delete map[key]; }
    };
  }

  /** mock 模式的刷新：造一份结构合法、永不过期的凭据，不发任何请求。 */
  function makeMockRefresh(cfg) {
    var nowMs = cfg.nowMs || function () { return Date.now(); };
    var uid = cfg.uid || 'demo-user';
    return function (refreshToken) {
      return Promise.resolve({
        ok: true,
        accessToken: 'mock-access-' + uid,
        refreshToken: typeof refreshToken === 'string' && refreshToken !== ''
          ? refreshToken
          : 'mock-refresh-' + uid,
        expiresAt: nowMs() + DEMO_TTL_MS,
        userId: uid
      });
    };
  }

  /**
   * @param {{
   *   mode?: 'off'|'mock'|'real',
   *   kv?: object, storage?: object,
   *   getLocalDoc?: function():object, setLocalDoc?: function(object):void,
   *   config?: {url:string, anonKey:string, table?:string},
   *   fetchImpl?: Function, nowMs?: function():number, now?: function():string,
   *   persistMock?: boolean  强制 mock 也写 storage（默认 false：演示用纯内存 kv）
   * }} cfg
   */
  function createWiring(cfg) {
    cfg = cfg || {};
    var mode = cfg.mode === undefined ? MODES.off : cfg.mode;
    if (!MODES[mode]) {
      throw makeError('E_BAD_MODE', '未知的同步模式：' + String(mode));
    }

    var nowMs = typeof cfg.nowMs === 'function' ? cfg.nowMs : function () { return Date.now(); };
    var nowIso = typeof cfg.now === 'function' ? cfg.now : function () { return new Date(nowMs()).toISOString(); };

    if (mode === MODES.off) {
      return {
        getMode: function () { return mode; },
        getEngine: function () { return null; },
        getSession: function () { return null; },
        getHttp: function () { return null; },
        getLease: function () { return null; },
        noteLocalStale: function () { return { ok: false, code: 'E_OFF' }; },
        restore: function () { return Promise.resolve({ ok: false, code: 'E_OFF', state: 'off' }); },
        resume: function () { return Promise.resolve({ ok: false, code: 'E_OFF', action: 'skip' }); },
        resolveRecovery: function () { return Promise.resolve({ ok: false, code: 'E_OFF' }); },
        applyLossy: function () { return Promise.resolve({ ok: false, code: 'E_OFF' }); },
        confirmLossyPush: function () { return Promise.resolve({ ok: false, code: 'E_OFF' }); },
        stopAfterLossy: function () { return Promise.resolve({ ok: false, code: 'E_OFF' }); },
        closeSync: function () { return Promise.resolve({ ok: false, code: 'E_OFF' }); },
        reopen: function () { return Promise.resolve({ ok: false, code: 'E_OFF' }); },
        confirmReopenUpload: function () { return Promise.resolve({ ok: false, code: 'E_OFF' }); },
        deleteRemote: function () { return Promise.resolve({ ok: false, code: 'E_OFF' }); },
        noteLocalCleared: function () { return Promise.resolve({ ok: false, code: 'E_OFF' }); },
        getLossy: function () { return null; },
        getLossyPayload: function () { return null; },
        describe: function () { return { mode: mode, configured: true }; }
      };
    }

    var kv;
    if (cfg.kv) {
      kv = cfg.kv;
    } else if (mode === MODES.mock && !cfg.persistMock) {
      kv = memoryKv();
    } else {
      try {
        kv = adaptKv(cfg.storage);
      } catch (e) {
        throw makeError('E_NOT_CONFIGURED', '真实模式需要 kv 或 storage', e && e.message);
      }
    }
    if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function' || typeof kv.remove !== 'function') {
      throw makeError('E_NOT_CONFIGURED', '缺少 kv（或 storage），无法建立同步存储');
    }
    if (typeof cfg.getLocalDoc !== 'function') {
      throw makeError('E_NOT_CONFIGURED', '缺少 getLocalDoc，无法读取本机文档');
    }
    var setLocalDoc = typeof cfg.setLocalDoc === 'function' ? cfg.setLocalDoc : function () {};

    var http = null;
    var backend = null;
    var refresh = null;
    var realConfig = null;
    var realFetch = null;

    if (mode === MODES.mock) {
      if (!mockBackend || typeof mockBackend.createMockBackend !== 'function') {
        throw makeError('E_NOT_CONFIGURED', 'mock 后端未加载');
      }
      backend = mockBackend.createMockBackend({ now: nowIso });
      refresh = makeMockRefresh({ uid: cfg.demoUid, nowMs: nowMs });
    } else {
      // real：缺一项都不许走，绝不回退到 mock。
      if (!supabase || typeof supabase.createConfig !== 'function') {
        throw makeError('E_NOT_CONFIGURED', '网络层未加载');
      }
      var fetchImpl = cfg.fetchImpl;
      if (typeof fetchImpl !== 'function') {
        fetchImpl = typeof fetch === 'function' ? fetch : null;
      }
      if (!cfg.config || typeof fetchImpl !== 'function') {
        throw makeError('E_NOT_CONFIGURED', '真实模式需要 config（url / anonKey）与可用的 fetch');
      }
      var config;
      try {
        config = supabase.createConfig(cfg.config);
      } catch (e) {
        throw makeError('E_NOT_CONFIGURED', '同步配置无效：' + (e && e.message ? e.message : ''), e && e.code);
      }
      try {
        http = supabase.createHttp({ config: config, fetchImpl: fetchImpl });
      } catch (e) {
        throw makeError('E_NOT_CONFIGURED', '网络客户端创建失败：' + (e && e.message ? e.message : ''), e && e.code);
      }
      refresh = function (refreshToken) {
        return supabase.refreshSession({
          config: config,
          refreshToken: refreshToken,
          fetchImpl: fetchImpl,
          now: nowMs
        });
      };
      realConfig = config;
      realFetch = fetchImpl;
    }

    var s = session.createSession({ kv: kv, refresh: refresh, now: nowMs });
    if (mode === MODES.real) {
      backend = createRemoteBackend(http, s);
    }

    /* ---------------- 账号显示名缓存（D12，2026-10-27） ----------------
       面板的「账号」行要展示用户名，而不是对用户毫无意义的 UUID。用户名只在
       登录（lookupAccount）/ 注册那一次请求里拿得到；刷新页面、恢复会话之后
       只能读本机缓存。写失败不阻断登录——显示名缺失时面板回落脱敏 uid。 */
    var ACCOUNT_NAME_PREFIX = 'dayplan.account-name.v1.';

    function accountNameKey(uid) {
      return ACCOUNT_NAME_PREFIX + uid;
    }

    function rememberAccountName(uid, name) {
      var n = String(name || '').trim();
      if (!uid || !n) return;
      try { kv.set(accountNameKey(uid), n); } catch (e) { /* 只是显示问题，不阻断 */ }
    }

    function readAccountName(uid) {
      if (!uid) return '';
      try { return String(kv.get(accountNameKey(uid)) || ''); } catch (e) { return ''; }
    }

    var engine = syncEngine.createEngine({
      kv: kv,
      backend: backend,
      getLocalDoc: cfg.getLocalDoc,
      setLocalDoc: setLocalDoc,
      now: nowIso,
      /* 切源通知由调用方（装配到 Store 的那一层）提供；本层只负责透传，
         不猜「确认成功后该切到哪个作用域」——那是引擎第⑤步的产物。 */
      onScopeChanged: cfg.onScopeChanged,
      /* 账号副本被四象限写入后的通知：界面若正停在该账号要跟着换内容。 */
      onDocApplied: cfg.onDocApplied,
      /* 租约（§5.4）默认开启：关掉它就只剩 §5.2 与 §5.5 兜底，多标签会白白多撞几次。
         只有测试要「完全没有租约」的旧路径时才显式传 false。 */
      lease: cfg.lease === false ? null : (cfg.lease || {})
    });

    /**
     * 演示登录：只在 mock 模式可用。真实模式下一律拒绝，
     * 避免 UI 把「点了就有登录态」的演示行为带到线上。
     */
    function signInDemo(uid) {
      if (mode !== MODES.mock) {
        return Promise.reject(makeError('E_NOT_MOCK', '演示登录仅在 mock 模式可用'));
      }
      var id = typeof uid === 'string' && uid !== '' ? uid : 'demo-user';
      return s.signIn({
        accessToken: 'mock-access-' + id,
        refreshToken: 'mock-refresh-' + id,
        expiresAt: nowMs() + DEMO_TTL_MS,
        userId: id
      }).then(function (r) {
        if (!r.ok) return r;
        var signed = engine.signIn(id);
        rememberAccountName(id, id);
        return { ok: true, uid: id, state: signed.state, needsCheck: !!signed.needsCheck };
      });
    }

    /**
     * 真实登录（邮箱 + 密码）。只在 real 模式可用。
     *
     * 顺序不能反：先拿凭据，再写 `dayplan.auth.v1`（session.signIn 是唯一写者），
     * 最后才让引擎切账号作用域。任何一步失败都不得留下「登录态已建立」的假象：
     * 凭据没拿到就绝不调 session.signIn，session 没进去绝不调 engine.signIn——
     * 否则会出现「令牌是空的但引擎已经在按 uid 存取」的半截状态。
     *
     * @param {string} [displayName] 登录框解析出的用户名（lookupAccount 的结果）；
     *   邮箱直登的老用户没有——显示名缺失时面板回落脱敏 uid。
     */
    function signIn(email, password, displayName) {
      if (mode !== MODES.real) {
        return Promise.reject(makeError('E_NOT_REAL', '真实登录仅在 real 模式可用'));
      }
      return supabase.signInWithPassword({
        config: realConfig,
        fetchImpl: realFetch,
        email: email,
        password: password,
        now: nowMs
      }).then(function (r) {
        if (!r || !r.ok) return r;
        return s.signIn({
          accessToken: r.accessToken,
          refreshToken: r.refreshToken,
          expiresAt: r.expiresAt,
          userId: r.userId
        }).then(function (w) {
          if (!w.ok) return w;
          var signed = engine.signIn(r.userId);
          /* 显示名：用户名登录时由面板传入；邮箱直登没有——回落脱敏 uid。 */
          rememberAccountName(r.userId, String(displayName || '').trim());
          return {
            ok: true,
            uid: r.userId,
            email: r.email,
            state: signed.state,
            needsCheck: !!signed.needsCheck
          };
        });
      });
    }

    function signOut() {
      // 退出登录只清凭据，不动任何数据键；引擎回到 local，不删本机内容。
      // 引擎自己会顺手释放租约（§6「退出登录：只删 dayplan.auth.v1 与租约」）。
      return Promise.resolve(s.signOut()).then(function (r) {
        engine.signOut();
        return r;
      });
    }

    /**
     * 本机数据被其他标签页改动 → 暂停云端写入（§5.2「冲突处理」第 3 条）。
     * 引擎若不在同步态只是空操作，不必在界面上区分。
     */
    function noteLocalStale(message) {
      if (!engine || typeof engine.noteLocalStale !== 'function') {
        return { ok: false, code: 'E_UNSUPPORTED' };
      }
      return engine.noteLocalStale(message);
    }

    /* ---------------- 注册、登录与邮箱验证（D13，2026-10-27） ----------------
       身份模型：Supabase Auth 的真正身份是**真实邮箱**（一个邮箱一个账号由
       Auth 唯一性兜底）；用户名是 profiles 表上的唯一别名，登录时经
       security definer 的 RPC `resolve_login` 解析回邮箱——不把全量邮箱
       暴露成 anon 可查的公开视图。手机号通道已整体裁剪。

       邮箱验证码（6 位，{{ .Token }}）：
         注册确认邮件 → verifyEmailOtp(type='signup') 一步完成「确认邮箱 + 登录」；
         忘记密码邮件 → verifyEmailOtp(type='recovery') 登录后再 updateUserPassword。
       profile 行（username 别名）在**验证成功拿到会话后**才写——注册时还没有凭据。 */

    var USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    /**
     * 用户名或邮箱 → 登录信息（email / username）。走 RPC（不暴露邮箱列表）。
     * 输入是邮箱时调用方可以直接登录，不必走这里。
     */
    function lookupAccount(input) {
      if (mode !== MODES.real) {
        return Promise.resolve({ ok: false, code: 'E_NOT_REAL', message: '账号查找仅在 real 模式可用' });
      }
      var key = String(input || '').trim();
      if (key === '' || (key.indexOf('@') < 0 && !USERNAME_RE.test(key))) {
        return Promise.resolve({ ok: false, code: 'E_BAD_ACCOUNT', message: '请输入用户名（3-24 位小写字母/数字）或邮箱' });
      }
      return supabase.rpcCall({
        config: realConfig,
        fetchImpl: realFetch,
        fn: 'resolve_login',
        params: { p_key: key }
      }).then(function (r) {
        if (!r.ok) return { ok: false, code: r.code || 'E_QUERY', message: r.message || '查询失败' };
        if (!r.rows.length || !r.rows[0] || !r.rows[0].email) {
          return { ok: false, code: 'E_NOT_FOUND', message: '该用户名尚未注册' };
        }
        var row = r.rows[0];
        return {
          ok: true,
          email: row.email,
          username: typeof row.username === 'string' ? row.username : ''
        };
      });
    }

    /** 注册（用户名 + 真实邮箱 + 密码）。成功只是「账号已建」：验证码在邮箱里，
        由调用方接着走 verifyEmailCode。唯一性：邮箱在 Auth、用户名在 profiles。 */
    function registerAccount(input) {
      if (mode !== MODES.real) {
        return Promise.resolve({ ok: false, code: 'E_NOT_REAL', message: '注册仅在 real 模式可用' });
      }
      var username = String(input && input.username || '').trim().toLowerCase();
      var email = String(input && input.email || '').trim().toLowerCase();
      var password = String(input && input.password || '');
      if (!USERNAME_RE.test(username)) {
        return Promise.resolve({ ok: false, code: 'E_BAD_USERNAME', message: '用户名需 3-24 位小写字母、数字、下划线或连字符' });
      }
      if (!EMAIL_RE.test(email)) {
        return Promise.resolve({ ok: false, code: 'E_BAD_EMAIL', message: '请输入有效的邮箱地址' });
      }
      if (password.length < 8) {
        return Promise.resolve({ ok: false, code: 'E_BAD_PASSWORD', message: '密码至少 8 位' });
      }
      // 用户名先查重（体验层）；并发拦截在 profiles 的 UNIQUE 约束（23505 → E_DUPLICATE）
      return supabase.restQuery({
        config: realConfig,
        fetchImpl: realFetch,
        table: 'public_profiles',
        search: '?username=eq.' + encodeURIComponent(username) + '&select=username&limit=1'
      }).then(function (r) {
        if (r.ok && r.rows.length) {
          return { ok: false, code: 'E_ACCOUNT_EXISTS', retryable: false, message: '用户名已被占用' };
        }
        return supabase.signUpWithPassword({
          config: realConfig,
          fetchImpl: realFetch,
          email: email,
          password: password,
          data: { username: username },
          now: nowMs
        }).then(function (sr) {
          if (!sr.ok) return sr;
          if (sr.needsVerification) {
            // 确认邮件已发出（含 6 位码）；此时还没有会话，不写 profiles、不切作用域。
            return { ok: true, needsVerification: true, email: email, username: username };
          }
          /* 项目若关掉了 Confirm email，signUp 直接下发会话——同样要写别名再切作用域。 */
          return s.signIn({
            accessToken: sr.accessToken,
            refreshToken: sr.refreshToken,
            expiresAt: sr.expiresAt,
            userId: sr.userId
          }).then(function (w2) {
            if (!w2.ok) return w2;
            return supabase.restInsert({
              config: realConfig,
              fetchImpl: realFetch,
              accessToken: sr.accessToken,
              table: 'profiles',
              row: { user_id: sr.userId, username: username }
            }).then(function (ir) {
              if (!ir.ok) {
                s.signOut();
                engine.signOut();
                if (ir.code === 'E_DUPLICATE') {
                  return { ok: false, code: 'E_ACCOUNT_EXISTS', message: '用户名已被占用' };
                }
                return ir;
              }
              var signed = engine.signIn(sr.userId);
              rememberAccountName(sr.userId, username);
              return {
                ok: true,
                uid: sr.userId,
                username: username,
                email: sr.email || email,
                state: signed.state,
                needsCheck: !!signed.needsCheck
              };
            });
          });
        });
      });
    }

    /**
     * 注册验证码确认（D13）：verifyOtp(signup) 一步完成「邮箱确认 + 登录」，
     * 成功后补写 profiles 别名并切账号作用域。
     * @param {{email:string, code:string, username?:string}} input
     *   username 只在「刚注册」的流程里传（别名尚未写）；老账号补验证时不传。
     */
    function verifyEmailCode(input) {
      if (mode !== MODES.real) {
        return Promise.resolve({ ok: false, code: 'E_NOT_REAL', message: '邮箱验证仅在 real 模式可用' });
      }
      var email = String(input && input.email || '').trim().toLowerCase();
      var code = String(input && input.code || '').trim();
      var username = String(input && input.username || '').trim().toLowerCase();
      if (email === '' || code === '') {
        return Promise.resolve({ ok: false, code: 'E_BAD_INPUT', message: '请输入邮箱与验证码' });
      }
      return supabase.verifyEmailOtp({
        config: realConfig,
        fetchImpl: realFetch,
        email: email,
        token: code,
        type: 'signup',
        now: nowMs
      }).then(function (vr) {
        if (!vr.ok) return vr;
        return s.signIn({
          accessToken: vr.accessToken,
          refreshToken: vr.refreshToken,
          expiresAt: vr.expiresAt,
          userId: vr.userId
        }).then(function (w2) {
          if (!w2.ok) return w2;
          var finish = function () {
            var signed = engine.signIn(vr.userId);
            if (username) rememberAccountName(vr.userId, username);
            return {
              ok: true,
              uid: vr.userId,
              email: vr.email || email,
              username: username || '',
              state: signed.state,
              needsCheck: !!signed.needsCheck
            };
          };
          if (username === '') return finish();   // 老账号补验证：别名已在
          return supabase.restInsert({
            config: realConfig,
            fetchImpl: realFetch,
            accessToken: vr.accessToken,
            table: 'profiles',
            row: { user_id: vr.userId, username: username }
          }).then(function (ir) {
            if (!ir.ok) {
              // 别名没写进去不留半截登录态；重名是唯一可预期原因
              s.signOut();
              engine.signOut();
              if (ir.code === 'E_DUPLICATE') {
                return { ok: false, code: 'E_ACCOUNT_EXISTS', message: '用户名刚被占用，请返回换一个用户名重新注册' };
              }
              return { ok: false, code: ir.code || 'E_INSERT', message: ir.message || '别名写入失败，请稍后重试' };
            }
            return finish();
          });
        });
      });
    }

    /**
     * 忘记密码第一步：发重置邮件（含 6 位码）。防枚举：无论邮箱是否存在都 ok。
     */
    function requestPasswordReset(email) {
      if (mode !== MODES.real) {
        return Promise.resolve({ ok: false, code: 'E_NOT_REAL', message: '密码重置仅在 real 模式可用' });
      }
      var mail = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(mail)) {
        return Promise.resolve({ ok: false, code: 'E_BAD_EMAIL', message: '请输入有效的邮箱地址' });
      }
      return supabase.requestPasswordReset({
        config: realConfig,
        fetchImpl: realFetch,
        email: mail
      });
    }

    /**
     * 忘记密码第二步：验证码 + 新密码。verifyOtp(recovery) 建立会话后改密，
     * 成功即处于登录态（调用方照常通知装配层挂稳态）。
     */
    function resetPassword(input) {
      if (mode !== MODES.real) {
        return Promise.resolve({ ok: false, code: 'E_NOT_REAL', message: '密码重置仅在 real 模式可用' });
      }
      var email = String(input && input.email || '').trim().toLowerCase();
      var code = String(input && input.code || '').trim();
      var password = String(input && input.newPassword || '');
      if (email === '' || code === '') {
        return Promise.resolve({ ok: false, code: 'E_BAD_INPUT', message: '请输入邮箱与验证码' });
      }
      if (password.length < 8) {
        return Promise.resolve({ ok: false, code: 'E_BAD_PASSWORD', message: '密码至少 8 位' });
      }
      return supabase.verifyEmailOtp({
        config: realConfig,
        fetchImpl: realFetch,
        email: email,
        token: code,
        type: 'recovery',
        now: nowMs
      }).then(function (vr) {
        if (!vr.ok) return vr;
        return s.signIn({
          accessToken: vr.accessToken,
          refreshToken: vr.refreshToken,
          expiresAt: vr.expiresAt,
          userId: vr.userId
        }).then(function (w2) {
          if (!w2.ok) return w2;
          var signed = engine.signIn(vr.userId);
          return supabase.updateUserPassword({
            config: realConfig,
            fetchImpl: realFetch,
            accessToken: vr.accessToken,
            password: password
          }).then(function (ur) {
            if (!ur.ok) {
              // 改密失败不留「拿着重置会话却没改掉」的错觉：退出，让用户重来
              s.signOut();
              engine.signOut();
              return ur;
            }
            return {
              ok: true,
              uid: vr.userId,
              email: vr.email || email,
              state: signed.state,
              needsCheck: !!signed.needsCheck,
              passwordReset: true
            };
          });
        });
      });
    }

    /** 重发验证码：注册确认邮件走 resend；忘记密码邮件直接再 recover 一次。 */
    function resendEmailCode(email, kind) {
      if (mode !== MODES.real) {
        return Promise.resolve({ ok: false, code: 'E_NOT_REAL', message: '重发仅在 real 模式可用' });
      }
      var mail = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(mail)) {
        return Promise.resolve({ ok: false, code: 'E_BAD_EMAIL', message: '请输入有效的邮箱地址' });
      }
      if (kind === 'recovery') {
        return supabase.requestPasswordReset({ config: realConfig, fetchImpl: realFetch, email: mail });
      }
      return supabase.resendSignupEmail({ config: realConfig, fetchImpl: realFetch, email: mail });
    }

    /**
     * 启动恢复：把磁盘上的凭据重新装回 session，并让引擎回到对应账号作用域。
     *
     * 不做这一步，真实模式下「刷新页面 = 掉线」—— 令牌明明还在 localStorage 里，
     * 内存里却是 signed-out，用户会以为同步坏了。
     *
     * 本函数**只恢复会话**，不做四象限：那要读一次云端，而启动路径不该被网络
     * 拖住。引擎若检测到有效 `active` 记录会把状态摆到 `checking` 并通过
     * `needsCheck` 告诉调用方，由调用方决定何时跑 `resume()`（Q-28）。
     *
     * 返回值的 `ok` 只表示**会话**恢复成功；同步是否可用看 `needsCheck` 与
     * 随后 `resume()` 的结果。
     */
    function restore() {
      return Promise.resolve(s.restore()).then(function (r) {
        var uid = s.getUserId();
        if (!r || !r.ok || !uid) {
          return { ok: false, code: (r && r.code) || 'E_NO_SESSION', state: (r && r.state) || 'signed-out' };
        }
        var signed = engine.signIn(uid);
        var boot = null;
        try { boot = engine.getBoot ? engine.getBoot() : null; } catch (e) { boot = null; }
        return {
          ok: true,
          uid: uid,
          state: r.state,
          engineState: signed.state,
          needsCheck: !!signed.needsCheck,
          /* 分类结果要给调用方：recovery 与 blocked 都「不需要四象限」，
             但两者都不该挂稳态同步，而且提示文案完全不同。 */
          bootKind: boot ? boot.kind : null
        };
      });
    }

    /**
     * 四象限（契约 §1.9 / §4.6）：把 `checking` 推进到某个确定状态。
     *
     * 引擎只负责判定与数据动作，界面表现交给调用方——`action` 是给上层的语义：
     *   'none' | 'pulled' | 'pushed' → 可以挂稳态同步
     *   'conflict'                    → 必须让用户选，不得自动合并
     *   'skip'                        → 没有 active 记录，无需判定
     * 失败时（`ok:false`）引擎已经进 `paused-error`，调用方只需展示与重试。
     */
    function resume() {
      if (!engine || typeof engine.resume !== 'function') {
        return Promise.resolve({ ok: false, code: 'E_UNSUPPORTED', action: 'skip' });
      }
      /* 用 then 包一层再调：引擎若**同步**抛（而不是返回 rejected Promise），
         直接写 `Promise.resolve(engine.resume())` 会在进入 promise 链之前就炸，
         启动路径因此整个断掉。 */
      return Promise.resolve().then(function () {
        return engine.resume();
      }).then(function (r) {
        return r || { ok: false, code: 'E_BAD_RESPONSE', action: 'skip' };
      }, function (e) {
        return {
          ok: false,
          code: 'E_RESUME_THREW',
          action: 'skip',
          message: String(e && e.message || e)
        };
      });
    }

    /**
     * §4.7 三选一的落点（remote / local / pause）。
     *
     * 与 `resume()` 同样包一层：引擎若同步抛错，绝不能让它漏进界面的事件回调里
     * （抛到 onclick 里就变成「点了没反应」，连错误都看不见）。
     */
    function resolveRecovery(choice) {
      if (!engine || typeof engine.resolveRecovery !== 'function') {
        return Promise.resolve({ ok: false, code: 'E_UNSUPPORTED' });
      }
      return Promise.resolve().then(function () {
        return engine.resolveRecovery(choice);
      }).then(function (r) {
        return r || { ok: false, code: 'E_BAD_RESPONSE' };
      }, function (e) {
        return {
          ok: false,
          code: 'E_RECOVERY_THREW',
          message: String(e && e.message || e)
        };
      });
    }

    /**
     * 把「引擎可能有、也可能还没有」的方法包一层：同步抛错统一归一成结构化失败。
     * 引擎方法抛错漏进 onclick 就是「点了没反应」，连原因都看不到。
     */
    function callEngine(name, args, failCode) {
      if (!engine || typeof engine[name] !== 'function') {
        return Promise.resolve({ ok: false, code: 'E_UNSUPPORTED', action: name });
      }
      return Promise.resolve().then(function () {
        return engine[name].apply(engine, args || []);
      }).then(function (r) {
        return r || { ok: false, code: 'E_BAD_RESPONSE', action: name };
      }, function (e) {
        return { ok: false, code: failCode, action: name, message: String(e && e.message || e) };
      });
    }

    return {
      getMode: function () { return mode; },
      getEngine: function () { return engine; },
      getSession: function () { return s; },
      getHttp: function () { return http; },
      getLease: function () {
        return engine && typeof engine.getLease === 'function' ? engine.getLease() : null;
      },
      noteLocalStale: noteLocalStale,
      lookupAccount: lookupAccount,
      registerAccount: registerAccount,
      verifyEmailCode: verifyEmailCode,
      requestPasswordReset: requestPasswordReset,
      resetPassword: resetPassword,
      resendEmailCode: resendEmailCode,
      signInDemo: signInDemo,
      signIn: signIn,
      signOut: signOut,
      restore: restore,
      resume: resume,
      resolveRecovery: resolveRecovery,
      /* 生命周期与有损修复（§1.8、§2.3）。一律包一层，别让异常漏进界面回调。 */
      applyLossy: function (ack) { return callEngine('applyLossy', [ack], 'E_LOSSY_THREW'); },
      confirmLossyPush: function () { return callEngine('confirmLossyPush', [], 'E_LOSSY_THREW'); },
      stopAfterLossy: function () { return callEngine('stopAfterLossy', [], 'E_LOSSY_THREW'); },
      closeSync: function () { return callEngine('closeSync', [], 'E_CLOSE_THREW'); },
      reopen: function () { return callEngine('reopen', [], 'E_REOPEN_THREW'); },
      confirmReopenUpload: function () { return callEngine('confirmReopenUpload', [], 'E_REOPEN_THREW'); },
      deleteRemote: function (ack) { return callEngine('deleteRemote', [ack], 'E_DELETE_THREW'); },
      noteLocalCleared: function () { return callEngine('noteLocalCleared', [], 'E_CLEAR_THREW'); },
      getLossy: function () {
        try { return engine && engine.getLossy ? engine.getLossy() : null; } catch (e) { return null; }
      },
      getLossyPayload: function () {
        try { return engine && engine.getLossyPayload ? engine.getLossyPayload() : null; } catch (e) { return null; }
      },
      describe: function () {
        var snap = s.snapshot();
        var err = engine.getError();
        var boot = null;
        try { boot = engine.getBoot ? engine.getBoot() : null; } catch (e) { boot = null; }
        var lease = null;
        try {
          var l = engine.getLease ? engine.getLease() : null;
          lease = l ? l.describe() : null;
        } catch (e) { lease = null; }
        var lossy = null;
        try { lossy = engine.getLossy ? engine.getLossy() : null; } catch (e) { lossy = null; }
        return {
          mode: mode,
          configured: true,
          uid: snap.userId,
          accountName: readAccountName(snap.userId),
          sessionState: snap.state,
          engineState: engine.getState(),
          bootKind: boot ? boot.kind : null,
          lease: lease,
          lossy: lossy,
          error: err ? { code: err.code, message: err.message } : null
        };
      }
    };
  }

  return {
    MODES: MODES,
    adaptKv: adaptKv,
    createRemoteBackend: createRemoteBackend,
    createWiring: createWiring
  };
});
