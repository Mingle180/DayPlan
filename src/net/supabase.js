/**
 * DayPlan · Supabase HTTP 封装（可注入 fetch，无外部库、无真实网络）
 *
 * 契约：docs/spec/13-sync-contract.md
 *   §6  认证库引入方式（Q-22：自写最小 fetch 封装，不引入 supabase-js、不走 CDN）
 *   §7  S-03（超时）、S-08（0 行更新 / 2xx 但不可验证 → 不得报成功）
 *   §9  云端结构与权限（public.schedules；revision 条件更新）
 *
 * 边界（刻意保守）：
 *   1. 本模块**不发任何请求**——fetchImpl 必须由调用方注入，缺则立即抛错。
 *      测试与离线构建因此不可能"不小心"连上真实项目。
 *   2. 令牌存储与四态**不在这里**，归 src/net/session.js（§6「唯一所有者」）。
 *      本模块只接收 accessToken 字符串，不读不写任何存储。
 *   3. 不写日志、不把令牌拼进任何 message（§6「泄露面」）。
 *   4. 不硬编码 URL / key：配置缺失即抛 E_CONFIG_MISSING，绝不回落到默认值。
 *   5. 失败一律 **resolve** `{ ok:false, code, ... }`，不 reject——调用方不必
 *      为「网络失败」和「断言抛错」写两套处理。只有配置错误（程序 bug）才同步抛。
 *
 * 已知待确认项（不在本轮擅自裁定）：
 *   · revision 的递增由调用方在 patch 体里显式给出（§9 的表定义无触发器，
 *     PostgREST 无法表达 revision = revision + 1），本模块不代算。
 *   · 未实现登录（密码 / 魔法链接）：那属于 Phase 2 的 UI 接入，本轮只做会话维持。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.supabase = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
  var HTTPS_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s?#]*)?$/;
  var LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  var DEFAULT_TIMEOUT_MS = 15000;

  function makeError(code, message) {
    var e = new TypeError(message);
    e.code = code;
    return e;
  }

  /** base64url 解码。不依赖 atob / Buffer，浏览器与 Node 走同一条实现。 */
  function b64urlDecode(str) {
    if (typeof str !== 'string' || str.length === 0) return null;
    var out = '';
    var acc = 0;
    var bits = 0;
    for (var i = 0; i < str.length; i++) {
      var v = B64URL.indexOf(str.charAt(i));
      if (v < 0) return null;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((acc >> bits) & 0xff);
        acc &= (1 << bits) - 1;
      }
    }
    return out;
  }

  /** 解析 JWT 的 payload；不是三段式或解不出来都返回 null。 */
  function decodeJwtPayload(token) {
    if (typeof token !== 'string') return null;
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    var raw = b64urlDecode(parts[1]);
    if (raw === null) return null;
    try {
      var obj = JSON.parse(raw);
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 校验 key 确实是"可公开"的那一把。三条红线（§6、计划 §7.2 永久红线）：
   *   · service_role（JWT 的 role 字段，或 sb_secret_ 前缀）→ 永不进入前端
   *   · sb_publishable_ 前缀视为公开 key（新版格式，非 JWT）
   *   · 无法识别的格式一律拒绝——无法证明它不是 secret 就不能放行
   */
  function assertPublicKey(key) {
    if (typeof key !== 'string' || key === '') {
      throw makeError('E_CONFIG_MISSING', '缺少 anon key');
    }
    if (key.indexOf('sb_secret_') === 0) {
      throw makeError('E_KEY_IS_SERVICE_ROLE', '检测到 secret key：永不进入前端（契约 §6）');
    }
    if (key.indexOf('sb_publishable_') === 0) return;
    var payload = decodeJwtPayload(key);
    if (!payload) {
      throw makeError('E_KEY_MALFORMED', 'anon key 既不是 publishable key 也不是合法 JWT');
    }
    if (payload.role === 'service_role') {
      throw makeError('E_KEY_IS_SERVICE_ROLE', '检测到 service_role key：永不进入前端（契约 §6）');
    }
    return;
  }

  /**
   * 构造并校验配置。缺项 / 形状不对一律同步抛（这是装配错误，不是运行期故障）。
   * @param {{url:string, anonKey:string, table?:string, timeoutMs?:number}} input
   */
  function createConfig(input) {
    if (!input || typeof input !== 'object') {
      throw makeError('E_CONFIG_MISSING', '缺少配置对象（url / anonKey）');
    }
    if (typeof input.url !== 'string' || input.url === '') {
      throw makeError('E_CONFIG_MISSING', '缺少项目 URL');
    }
    var url = input.url.replace(/\/+$/, '');
    if (!HTTPS_RE.test(url) && !LOCAL_RE.test(url)) {
      throw makeError('E_CONFIG_INVALID', '项目 URL 必须是 https（本地开发可用 http://localhost）');
    }
    assertPublicKey(input.anonKey);

    var table = input.table === undefined ? 'schedules' : input.table;
    if (typeof table !== 'string' || !TABLE_RE.test(table)) {
      throw makeError('E_CONFIG_INVALID', '表名必须是合法标识符（小写字母/数字/下划线）');
    }
    var timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
    if (typeof timeoutMs !== 'number' || !isFinite(timeoutMs) || timeoutMs < 0) {
      throw makeError('E_CONFIG_INVALID', 'timeoutMs 必须是非负有限数');
    }
    return Object.freeze({
      url: url,
      anonKey: input.anonKey,
      table: table,
      timeoutMs: timeoutMs
    });
  }

  /**
   * 建 HTTP 客户端。fetchImpl 必填——不提供任何默认实现，避免"忘了注入就偷偷联网"。
   * @param {{config:object, fetchImpl:Function, setTimeoutImpl?:Function, clearTimeoutImpl?:Function}} opts
   */
  function createHttp(opts) {
    if (!opts || typeof opts.fetchImpl !== 'function') {
      throw makeError('E_CONFIG_MISSING', 'createHttp 需要可注入的 fetchImpl');
    }
    var config = opts.config;
    if (!config || typeof config.url !== 'string' || typeof config.anonKey !== 'string') {
      throw makeError('E_CONFIG_MISSING', 'createHttp 需要 createConfig 的产物');
    }
    var fetchImpl = opts.fetchImpl;
    var setTimeoutImpl = opts.setTimeoutImpl || (typeof setTimeout === 'function' ? setTimeout : null);
    var clearTimeoutImpl = opts.clearTimeoutImpl || (typeof clearTimeout === 'function' ? clearTimeout : null);

    function fail(code, status, message) {
      return { ok: false, code: code, status: status || 0, message: message };
    }

    /** query 用数组 [['k','v'], ...]：键序可控，不依赖对象属性顺序。 */
    function buildUrl(query) {
      var base = config.url + '/rest/v1/' + config.table;
      if (!query || !query.length) return base;
      var parts = [];
      for (var i = 0; i < query.length; i++) {
        parts.push(encodeURIComponent(query[i][0]) + '=' + encodeURIComponent(query[i][1]));
      }
      return base + '?' + parts.join('&');
    }

    /**
     * 把 2xx 响应整形成 rows / row，并按 spec.expect 判定。
     *   expect='optional'  0 或 1 行都合法（select）
     *   expect='one'       必须恰好 1 行；0 行按 spec.zeroRows 归类
     *   expect='ignore'    不关心行数
     * 多行一律 E_UNVERIFIED：主键 / 条件查询出现多行说明查询条件或后端行为不对，
     * 此时"取第一行继续"正是静默覆盖的入口（§7 S-08）。
     */
    function shapeRows(parsed, spec, status) {
      var expect = spec.expect || 'optional';
      var rows;
      if (Array.isArray(parsed)) rows = parsed;
      else if (parsed === null || parsed === undefined) rows = [];
      else if (typeof parsed === 'object') rows = [parsed];
      else return fail('E_UNVERIFIED', status, '2xx 但响应结构不可验证');

      if (rows.length > 1) {
        return fail('E_UNVERIFIED', status, '2xx 但返回了 ' + rows.length + ' 行，结果不可验证');
      }
      if (expect === 'one' && rows.length === 0) {
        if (spec.zeroRows === 'unverified') {
          return fail('E_UNVERIFIED', status, '2xx 但写入未返回行，结果不可验证');
        }
        return fail('E_CONFLICT', status, '条件未命中（0 行），按冲突处理，不得当作成功');
      }
      return { ok: true, status: status, rows: rows, row: rows.length ? rows[0] : null };
    }

    function handleResponse(res, spec) {
      var status = res && typeof res.status === 'number' ? res.status : 0;
      var bodyPromise = (res && typeof res.text === 'function')
        ? Promise.resolve(res.text())
        : Promise.resolve('');

      return bodyPromise.then(function (text) {
        var parsed = null;
        var parseFailed = false;
        if (typeof text === 'string' && text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch (e) {
            parseFailed = true;
          }
        }

        if (status === 401) return fail('E_UNAUTHORIZED', status, '未授权（401）');
        if (status === 403) return fail('E_FORBIDDEN', status, '权限不足（403）');
        if (status === 409) return fail('E_CONFLICT', status, '行已存在或唯一约束冲突（409）');
        if (status >= 500) return fail('E_SERVER', status, '服务端错误（' + status + '）');
        if (status >= 400) {
          var msg = (parsed && (parsed.message || parsed.error_description || parsed.error)) || '';
          return fail('E_CLIENT', status, msg || ('客户端错误（' + status + '）'));
        }
        if (status < 200 || status >= 300) {
          return fail('E_BAD_RESPONSE', status, '非预期状态码（' + status + '）');
        }
        if (parseFailed) {
          return fail('E_BAD_RESPONSE', status, '2xx 但响应不是合法 JSON');
        }
        return shapeRows(parsed, spec, status);
      });
    }

    /**
     * @param {object} spec
     *   method       'GET' | 'POST' | 'PATCH' | 'DELETE'
     *   query        [['user_id','eq.<uid>'], ['revision','eq.3']]
     *   body         可 JSON 序列化的值；GET / DELETE 忽略
     *   accessToken  有则 Bearer，否则用 anon key
     *   prefer       例如 'return=representation'
     *   expect       'optional' | 'one' | 'ignore'
     *   zeroRows     'conflict' | 'unverified'（仅 expect='one' 时有意义）
     *   timeoutMs    覆盖配置
     * @returns {Promise<{ok:true,status:number,rows:Array,row:object|null}
     *                  |{ok:false,code:string,status:number,message:string}>}
     */
    function request(spec) {
      spec = spec || {};
      var method = typeof spec.method === 'string' ? spec.method.toUpperCase() : 'GET';
      var url = buildUrl(spec.query);
      var headers = {
        apikey: config.anonKey,
        Authorization: 'Bearer ' + (spec.accessToken || config.anonKey),
        Accept: 'application/json'
      };
      var body = null;
      if (spec.body !== undefined && method !== 'GET' && method !== 'DELETE') {
        body = JSON.stringify(spec.body);
        headers['Content-Type'] = 'application/json';
      }
      if (spec.prefer) headers.Prefer = spec.prefer;

      var timeoutMs = spec.timeoutMs === undefined ? config.timeoutMs : spec.timeoutMs;
      var localTimer = null;

      function stopTimer() {
        if (localTimer !== null && typeof clearTimeoutImpl === 'function') {
          clearTimeoutImpl(localTimer);
        }
        localTimer = null;
      }

      var call = Promise.resolve().then(function () {
        return fetchImpl(url, { method: method, headers: headers, body: body });
      });

      var guarded = call;
      if (timeoutMs > 0 && typeof setTimeoutImpl === 'function') {
        guarded = new Promise(function (resolve, reject) {
          localTimer = setTimeoutImpl(function () {
            localTimer = null;
            reject(makeError('E_TIMEOUT', '请求超时（' + timeoutMs + 'ms）'));
          }, timeoutMs);
          call.then(
            function (v) { resolve(v); },
            function (e) { reject(e); }
          );
        });
      }

      return guarded.then(
        function (res) {
          stopTimer();
          return handleResponse(res, spec);
        },
        function (err) {
          stopTimer();
          if (err && err.code === 'E_TIMEOUT') {
            return fail('E_TIMEOUT', 0, '请求超时（' + timeoutMs + 'ms）');
          }
          // fetch 的原始错误对象里可能带 URL 甚至请求细节，不向外透传（§6 泄露面）。
          return fail('E_NETWORK', 0, '网络请求失败');
        }
      );
    }

    /** 读当前用户的整行。0 行 = 合法（从未同步过）。 */
    function select(uid, accessToken, extra) {
      return request({
        method: 'GET',
        query: [
          ['select', 'schedule_data,revision,updated_at'],
          ['user_id', 'eq.' + uid]
        ],
        accessToken: accessToken,
        expect: 'optional',
        timeoutMs: extra && extra.timeoutMs
      });
    }

    /** 首次写入。唯一约束冲突 → E_CONFLICT（说明别的设备先建了行）。 */
    function insert(uid, payload, accessToken) {
      return request({
        method: 'POST',
        body: { user_id: uid, schedule_data: payload },
        accessToken: accessToken,
        prefer: 'return=representation',
        expect: 'one',
        zeroRows: 'unverified'
      });
    }

    /**
     * revision 条件更新。patchBody 由调用方给（含新 revision），本模块不代算。
     * 0 行 = 别人先改了或行被删 → E_CONFLICT，绝不报成功。
     */
    function updateConditional(uid, patchBody, expectedRevision, accessToken) {
      return request({
        method: 'PATCH',
        query: [
          ['user_id', 'eq.' + uid],
          ['revision', 'eq.' + expectedRevision]
        ],
        body: patchBody,
        accessToken: accessToken,
        prefer: 'return=representation',
        expect: 'one',
        zeroRows: 'conflict'
      });
    }

    /** 删除当前用户的行。0 行 = 行本就不存在。 */
    function remove(uid, accessToken) {
      return request({
        method: 'DELETE',
        query: [['user_id', 'eq.' + uid]],
        accessToken: accessToken,
        prefer: 'return=representation',
        expect: 'one',
        zeroRows: 'unverified'
      });
    }

    return {
      request: request,
      select: select,
      insert: insert,
      updateConditional: updateConditional,
      remove: remove
    };
  }

  /**
   * 用 refresh token 换新的一组令牌。
   * Supabase Auth 的失败语义在这里就转成稳定错误码，session.js 不必解析 HTTP 细节：
   *   invalid_grant（或 invalid_token / refresh_token_not_found）→ E_INVALID_GRANT（不可重试）
   *   其余 4xx → E_CLIENT；网络/超时 → E_NETWORK / E_TIMEOUT（可重试）
   *
   * @param {{config:object, fetchImpl:Function, refreshToken:string,
   *          now?:Function, timeoutMs?:number,
   *          setTimeoutImpl?:Function, clearTimeoutImpl?:Function}} opts
   * @returns {Promise<{ok:true, accessToken:string, refreshToken:string, expiresAt:number, userId:string}
   *                  |{ok:false, code:string, message:string}>}
   */
  function refreshSession(opts) {
    if (!opts || typeof opts.fetchImpl !== 'function') {
      throw makeError('E_CONFIG_MISSING', 'refreshSession 需要可注入的 fetchImpl');
    }
    var config = opts.config;
    if (!config || typeof config.url !== 'string') {
      throw makeError('E_CONFIG_MISSING', 'refreshSession 需要 createConfig 的产物');
    }
    if (typeof opts.refreshToken !== 'string' || opts.refreshToken === '') {
      throw makeError('E_CONFIG_MISSING', '缺少 refresh token');
    }
    var nowFn = opts.now || function () { return Date.now(); };
    var fetchImpl = opts.fetchImpl;
    var setTimeoutImpl = opts.setTimeoutImpl || (typeof setTimeout === 'function' ? setTimeout : null);
    var clearTimeoutImpl = opts.clearTimeoutImpl || (typeof clearTimeout === 'function' ? clearTimeout : null);
    var timeoutMs = opts.timeoutMs === undefined ? config.timeoutMs : opts.timeoutMs;

    var url = config.url + '/auth/v1/token?grant_type=refresh_token';
    var headers = {
      apikey: config.anonKey,
      Authorization: 'Bearer ' + config.anonKey,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    var body = JSON.stringify({ refresh_token: opts.refreshToken });

    var localTimer = null;
    function stopTimer() {
      if (localTimer !== null && typeof clearTimeoutImpl === 'function') clearTimeoutImpl(localTimer);
      localTimer = null;
    }

    var call = Promise.resolve().then(function () {
      return fetchImpl(url, { method: 'POST', headers: headers, body: body });
    });
    var guarded = call;
    if (timeoutMs > 0 && typeof setTimeoutImpl === 'function') {
      guarded = new Promise(function (resolve, reject) {
        localTimer = setTimeoutImpl(function () {
          localTimer = null;
          reject(makeError('E_TIMEOUT', '刷新超时（' + timeoutMs + 'ms）'));
        }, timeoutMs);
        call.then(
          function (v) { resolve(v); },
          function (e) { reject(e); }
        );
      });
    }

    return guarded.then(
      function (res) {
        stopTimer();
        var status = res && typeof res.status === 'number' ? res.status : 0;
        var bodyPromise = (res && typeof res.text === 'function')
          ? Promise.resolve(res.text())
          : Promise.resolve('');

        return bodyPromise.then(function (text) {
          var parsed = null;
          if (typeof text === 'string' && text.length > 0) {
            try {
              parsed = JSON.parse(text);
            } catch (e) {
              parsed = null;
            }
          }
          if (status === 401 || status === 403) {
            return { ok: false, code: 'E_INVALID_GRANT', message: '刷新令牌已失效' };
          }
          if (status >= 400 && status < 500) {
            var errCode = parsed && (parsed.error || parsed.error_code);
            if (errCode === 'invalid_grant' || errCode === 'invalid_token' ||
                errCode === 'refresh_token_not_found' || errCode === 'session_not_found') {
              return { ok: false, code: 'E_INVALID_GRANT', message: '刷新令牌已失效' };
            }
            /* 真实项目（2026-10-26 实测）返回的是：
                 400 {"code":400,"error_code":"validation_failed","msg":"Refresh token is not valid"}
               只按上面那组字面量分流会漏掉它，落进兜底的 E_CLIENT（可重试）——
               于是「刷新令牌永久失效」被当成网络抖动，会话永远进不了 expired，
               用户只会反复看到「刷新失败，可重试」。这里按「某个校验失败 + 文案指向
               刷新令牌」识别；其余 validation_failed 仍按可重试处理，不扩大误判面。 */
            var errMsg = parsed && (parsed.msg || parsed.message);
            if (errCode === 'validation_failed' && typeof errMsg === 'string' &&
                /refresh\s*token/i.test(errMsg)) {
              return { ok: false, code: 'E_INVALID_GRANT', message: '刷新令牌已失效' };
            }
            if (errCode === 'over_request_rate_limit' || status === 429) {
              return { ok: false, code: 'E_RATE_LIMIT', message: '请求过于频繁，可稍后重试' };
            }
            return { ok: false, code: 'E_CLIENT', message: '刷新被拒绝（' + status + '）' };
          }
          if (status < 200 || status >= 300) {
            return { ok: false, code: 'E_SERVER', message: '刷新失败（' + status + '）' };
          }
          if (!parsed || typeof parsed.access_token !== 'string' || parsed.access_token === '') {
            return { ok: false, code: 'E_BAD_RESPONSE', message: '刷新响应缺少 access_token' };
          }
          var expiresAt;
          if (typeof parsed.expires_at === 'number' && isFinite(parsed.expires_at)) {
            expiresAt = parsed.expires_at * 1000;
          } else if (typeof parsed.expires_in === 'number' && isFinite(parsed.expires_in)) {
            expiresAt = nowFn() + parsed.expires_in * 1000;
          } else {
            return { ok: false, code: 'E_BAD_RESPONSE', message: '刷新响应缺少有效期' };
          }
          var userId = parsed.user && typeof parsed.user.id === 'string' ? parsed.user.id : '';
          return {
            ok: true,
            accessToken: parsed.access_token,
            refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token !== ''
              ? parsed.refresh_token
              : opts.refreshToken,
            expiresAt: expiresAt,
            userId: userId
          };
        });
      },
      function (err) {
        stopTimer();
        if (err && err.code === 'E_TIMEOUT') {
          return { ok: false, code: 'E_TIMEOUT', message: '刷新超时' };
        }
        return { ok: false, code: 'E_NETWORK', message: '刷新时网络失败' };
      }
    );
  }

  /**
   * 密码登录（password grant）。**只做一次 HTTP + 语义归一，不碰任何存储。**
   * 落盘由 session.signIn 负责（§6：`dayplan.auth.v1` 只有 session 能写）。
   *
   * 失败分流比 refreshSession 更细，原因是这几类对用户意味着完全不同的下一步：
   *   E_INVALID_CREDENTIALS  密码或邮箱错  → 改输入，重试无意义
   *   E_EMAIL_NOT_CONFIRMED  邮箱未确认    → 去控制台确认或关掉 Confirm email
   *   E_RATE_LIMIT           被限流        → 等一会儿再试，可重试
   * 混成一个 E_CLIENT 只会让人对着同一句「登录失败」反复试。
   */
  function signInWithPassword(opts) {
    if (!opts || typeof opts.fetchImpl !== 'function') {
      throw makeError('E_CONFIG_MISSING', 'signInWithPassword 需要可注入的 fetchImpl');
    }
    var config = opts.config;
    if (!config || typeof config.url !== 'string' || typeof config.anonKey !== 'string') {
      throw makeError('E_CONFIG_MISSING', 'signInWithPassword 需要 createConfig 的产物');
    }
    var email = typeof opts.email === 'string' ? opts.email.trim() : '';
    var password = typeof opts.password === 'string' ? opts.password : '';
    if (email === '' || password === '') {
      throw makeError('E_CONFIG_MISSING', '登录需要邮箱与密码');
    }
    var nowFn = opts.now || function () { return Date.now(); };
    var fetchImpl = opts.fetchImpl;
    var setTimeoutImpl = opts.setTimeoutImpl || (typeof setTimeout === 'function' ? setTimeout : null);
    var clearTimeoutImpl = opts.clearTimeoutImpl || (typeof clearTimeout === 'function' ? clearTimeout : null);
    var timeoutMs = opts.timeoutMs === undefined ? config.timeoutMs : opts.timeoutMs;

    var url = config.url + '/auth/v1/token?grant_type=password';
    var headers = {
      apikey: config.anonKey,
      Authorization: 'Bearer ' + config.anonKey,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    // 密码只出现在这一次请求体里：不记录、不回传、不拼进错误信息
    var body = JSON.stringify({ email: email, password: password });

    var localTimer = null;
    function stopTimer() {
      if (localTimer !== null && typeof clearTimeoutImpl === 'function') clearTimeoutImpl(localTimer);
      localTimer = null;
    }

    var call = Promise.resolve().then(function () {
      return fetchImpl(url, { method: 'POST', headers: headers, body: body });
    });
    var guarded = call;
    if (timeoutMs > 0 && typeof setTimeoutImpl === 'function') {
      guarded = new Promise(function (resolve, reject) {
        localTimer = setTimeoutImpl(function () {
          localTimer = null;
          reject(makeError('E_TIMEOUT', '登录超时（' + timeoutMs + 'ms）'));
        }, timeoutMs);
        call.then(
          function (v) { resolve(v); },
          function (e) { reject(e); }
        );
      });
    }

    return guarded.then(
      function (res) {
        stopTimer();
        var status = res && typeof res.status === 'number' ? res.status : 0;
        var bodyPromise = (res && typeof res.text === 'function')
          ? Promise.resolve(res.text())
          : Promise.resolve('');

        return bodyPromise.then(function (text) {
          var parsed = null;
          if (typeof text === 'string' && text.length > 0) {
            try {
              parsed = JSON.parse(text);
            } catch (e) {
              parsed = null;
            }
          }
          var errCode = parsed && (parsed.error || parsed.error_code);

          if (status === 400 || status === 401 || status === 403 || status === 422) {
            if (errCode === 'email_not_confirmed') {
              return {
                ok: false, code: 'E_EMAIL_NOT_CONFIRMED', status: status, retryable: false,
                message: '邮箱尚未验证：输入注册确认邮件里的 6 位验证码即可完成'
              };
            }
            if (errCode === 'invalid_credentials' || errCode === 'invalid_grant' ||
                errCode === 'user_not_found' || status === 401) {
              return {
                ok: false, code: 'E_INVALID_CREDENTIALS', status: status, retryable: false,
                message: '账号或密码不正确'
              };
            }
            if (errCode === 'over_request_rate_limit' || errCode === 'too_many_requests') {
              return {
                ok: false, code: 'E_RATE_LIMIT', status: status, retryable: true,
                message: '尝试过于频繁，请稍后再试'
              };
            }
            return {
              ok: false, code: 'E_CLIENT', status: status, retryable: false,
              message: '登录被拒绝（' + status + '）'
            };
          }
          if (status === 429) {
            return {
              ok: false, code: 'E_RATE_LIMIT', status: status, retryable: true,
              message: '尝试过于频繁，请稍后再试'
            };
          }
          if (status < 200 || status >= 300) {
            return {
              ok: false, code: 'E_SERVER', status: status, retryable: true,
              message: '登录失败（' + status + '）'
            };
          }
          if (!parsed || typeof parsed.access_token !== 'string' || parsed.access_token === '') {
            return { ok: false, code: 'E_BAD_RESPONSE', status: status, retryable: false, message: '登录响应缺少 access_token' };
          }
          // 没有 refresh_token 就是「一次性登录」：一小时后必然掉线且无法续期。
          // 与其让它以「用着用着突然退出」的方式暴露，不如现在拒绝。
          if (typeof parsed.refresh_token !== 'string' || parsed.refresh_token === '') {
            return { ok: false, code: 'E_BAD_RESPONSE', status: status, retryable: false, message: '登录响应缺少 refresh_token' };
          }
          var expiresAt;
          if (typeof parsed.expires_at === 'number' && isFinite(parsed.expires_at)) {
            expiresAt = parsed.expires_at * 1000;
          } else if (typeof parsed.expires_in === 'number' && isFinite(parsed.expires_in)) {
            expiresAt = nowFn() + parsed.expires_in * 1000;
          } else {
            return { ok: false, code: 'E_BAD_RESPONSE', status: status, retryable: false, message: '登录响应缺少有效期' };
          }
          var userId = parsed.user && typeof parsed.user.id === 'string' ? parsed.user.id : '';
          if (userId === '') {
            // userId 决定切哪个账号作用域；空值会让后续拿到「合法令牌但不知属于谁」
            return { ok: false, code: 'E_BAD_RESPONSE', status: status, retryable: false, message: '登录响应缺少 user.id' };
          }
          return {
            ok: true,
            accessToken: parsed.access_token,
            refreshToken: parsed.refresh_token,
            expiresAt: expiresAt,
            userId: userId,
            email: parsed.user && typeof parsed.user.email === 'string' ? parsed.user.email : email
          };
        });
      },
      function (err) {
        stopTimer();
        if (err && err.code === 'E_TIMEOUT') {
          return { ok: false, code: 'E_TIMEOUT', retryable: true, message: '登录超时' };
        }
        // 不透传原始 message：fetch 的错误串里常带完整 URL
        return { ok: false, code: 'E_NETWORK', retryable: true, message: '登录时网络失败' };
      }
    );
  }

  /**
   * 注册（D13 起语义修订）：POST /auth/v1/signup，email + password + user_metadata。
   * 成功形态两种：
   *   ① session 直接下发（项目关闭了「Confirm email」）→ ok + 凭据；
   *   ② 需要邮箱确认（session 为 null）→ ok + needsVerification:true——
   *      这是**预期流程**（注册邮箱收到 6 位验证码，走 verifyEmailOtp 完成登录），
   *      不是错误。落盘仍由 session.signIn 负责，此处不碰任何存储。
   */
  function signUpWithPassword(opts) {
    if (!opts || typeof opts.fetchImpl !== 'function') {
      throw makeError('E_CONFIG_MISSING', 'signUpWithPassword 需要可注入的 fetchImpl');
    }
    var config = opts.config;
    if (!config || typeof config.url !== 'string' || typeof config.anonKey !== 'string') {
      throw makeError('E_CONFIG_MISSING', 'signUpWithPassword 需要 createConfig 的产物');
    }
    var email = typeof opts.email === 'string' ? opts.email.trim() : '';
    var password = typeof opts.password === 'string' ? opts.password : '';
    if (email === '' || password === '') {
      throw makeError('E_CONFIG_MISSING', '注册需要邮箱与密码');
    }
    var nowFn = opts.now || function () { return Date.now(); };
    var fetchImpl = opts.fetchImpl;
    var setTimeoutImpl = opts.setTimeoutImpl || (typeof setTimeout === 'function' ? setTimeout : null);
    var clearTimeoutImpl = opts.clearTimeoutImpl || (typeof clearTimeout === 'function' ? clearTimeout : null);
    var timeoutMs = opts.timeoutMs === undefined ? config.timeoutMs : opts.timeoutMs;

    var bodyObj = { email: email, password: password };
    if (opts.data && typeof opts.data === 'object') bodyObj.data = opts.data;

    var url = config.url + '/auth/v1/signup';
    var headers = {
      apikey: config.anonKey,
      Authorization: 'Bearer ' + config.anonKey,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    var body = JSON.stringify(bodyObj);

    var localTimer = null;
    function stopTimer() {
      if (localTimer !== null && typeof clearTimeoutImpl === 'function') clearTimeoutImpl(localTimer);
      localTimer = null;
    }

    var call = Promise.resolve().then(function () {
      return fetchImpl(url, { method: 'POST', headers: headers, body: body });
    });
    var guarded = call;
    if (timeoutMs > 0 && typeof setTimeoutImpl === 'function') {
      guarded = new Promise(function (resolve, reject) {
        localTimer = setTimeoutImpl(function () {
          localTimer = null;
          reject(makeError('E_TIMEOUT', '注册超时（' + timeoutMs + 'ms）'));
        }, timeoutMs);
        call.then(
          function (v) { resolve(v); },
          function (e) { reject(e); }
        );
      });
    }

    function credsFrom(parsed, fallbackEmail) {
      if (!parsed || typeof parsed.access_token !== 'string' || parsed.access_token === '') return null;
      if (typeof parsed.refresh_token !== 'string' || parsed.refresh_token === '') return null;
      var expiresAt;
      if (typeof parsed.expires_at === 'number' && isFinite(parsed.expires_at)) {
        expiresAt = parsed.expires_at * 1000;
      } else if (typeof parsed.expires_in === 'number' && isFinite(parsed.expires_in)) {
        expiresAt = nowFn() + parsed.expires_in * 1000;
      } else {
        return null;
      }
      var userId = parsed.user && typeof parsed.user.id === 'string' ? parsed.user.id : '';
      if (userId === '') return null;
      return {
        ok: true,
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token,
        expiresAt: expiresAt,
        userId: userId,
        email: parsed.user && typeof parsed.user.email === 'string' ? parsed.user.email : fallbackEmail
      };
    }

    return guarded.then(
      function (res) {
        stopTimer();
        var status = res && typeof res.status === 'number' ? res.status : 0;
        var bodyPromise = (res && typeof res.text === 'function')
          ? Promise.resolve(res.text())
          : Promise.resolve('');
        return bodyPromise.then(function (text) {
          var parsed = null;
          if (typeof text === 'string' && text.length > 0) {
            try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
          }
          var errCode = parsed && (parsed.error || parsed.error_code) || null;

          if (status === 400 || status === 401 || status === 403 || status === 422) {
            // GoTrue 的重复注册会给出 user_already_exists / "User already registered"
            var msg = parsed && typeof parsed.msg === 'string' ? parsed.msg : '';
            if (errCode === 'user_already_exists' || /already (registered|exists)/i.test(msg)) {
              return {
                ok: false, code: 'E_ACCOUNT_EXISTS', status: status, retryable: false,
                message: '该邮箱已注册过账号，直接登录即可'
              };
            }
            if (errCode === 'over_request_rate_limit' || errCode === 'too_many_requests' || status === 429) {
              return { ok: false, code: 'E_RATE_LIMIT', status: status, retryable: true, message: '尝试过于频繁，请稍后再试' };
            }
            if (/password.*\b(\d+)\b.*character/i.test(msg) || errCode === 'weak_password') {
              return { ok: false, code: 'E_WEAK_PASSWORD', status: status, retryable: false, message: '密码太弱：' + msg };
            }
            /* 2026-10-27：服务端拒绝注册时必须让用户看到**服务端给的理由**。
               之前这里只显示「注册被拒绝（400）」，掩盖了真实原因（邮箱域名被拒、
               注册被管理员关闭、密码超长……），排查只能靠猜。GoTrue 的 msg 是
               英文，但具体到可行动；没有任何 msg 时才退回笼统文案。 */
            if (msg) {
              return {
                ok: false, code: 'E_CLIENT', status: status, retryable: false,
                message: '注册被拒绝：' + (msg.length > 160 ? msg.slice(0, 160) + '…' : msg)
              };
            }
            return { ok: false, code: 'E_CLIENT', status: status, retryable: false, message: '注册被拒绝（' + status + '）' };
          }
          if (status === 429) {
            return { ok: false, code: 'E_RATE_LIMIT', status: status, retryable: true, message: '尝试过于频繁，请稍后再试' };
          }
          if (status < 200 || status >= 300) {
            return { ok: false, code: 'E_SERVER', status: status, retryable: true, message: '注册失败（' + status + '）' };
          }

          var creds = credsFrom(parsed, email);
          if (creds) return creds;
          // 200 但没有 session：项目开着「Confirm email」——真实邮箱注册的预期路径。
          // 邮件里带 6 位验证码（模板 {{ .Token }}），由 verifyEmailOtp 完成确认 + 登录。
          // GoTrue 的响应有两种形态都要认：
          //   包裹式 { user: {...}, session: null }；直接式——顶层就是 user 对象
          //   （id/email/confirmation_sent_at…，2026-10-28 实测出现，曾误判为缺会话）。
          var userObj = null;
          if (parsed && typeof parsed === 'object') {
            if (parsed.user && typeof parsed.user === 'object') userObj = parsed.user;
            else if (typeof parsed.id === 'string' && typeof parsed.email === 'string') userObj = parsed;
          }
          if (userObj && !parsed.session) {
            return { ok: true, needsVerification: true, status: status, email: email };
          }
          return { ok: false, code: 'E_BAD_RESPONSE', status: status, retryable: false, message: '注册响应缺少会话' };
        });
      },
      function (err) {
        stopTimer();
        if (err && err.code === 'E_TIMEOUT') {
          return { ok: false, code: 'E_TIMEOUT', retryable: true, message: '注册超时' };
        }
        return { ok: false, code: 'E_NETWORK', retryable: true, message: '注册时网络失败' };
      }
    );
  }

  /**
   * PostgREST 匿名 / 带令牌的通用查询（2026-10-27）：注册查重用。
   * 只开放 GET；写路径（insert）单独走 restInsert，便于约束表与列。
   */
  function restQuery(opts) {
    if (!opts || typeof opts.fetchImpl !== 'function') {
      throw makeError('E_CONFIG_MISSING', 'restQuery 需要可注入的 fetchImpl');
    }
    var config = opts.config;
    if (!config || typeof config.url !== 'string' || typeof config.anonKey !== 'string') {
      throw makeError('E_CONFIG_MISSING', 'restQuery 需要 createConfig 的产物');
    }
    var table = typeof opts.table === 'string' && /^[A-Za-z0-9_.]+$/.test(opts.table) ? opts.table : '';
    if (table === '') throw makeError('E_CONFIG_MISSING', 'restQuery 需要合法表名');
    var search = typeof opts.search === 'string' ? opts.search : '';
    if (search.indexOf('?') !== 0) search = '?' + search;

    var headers = { apikey: config.anonKey, Accept: 'application/json' };
    if (typeof opts.accessToken === 'string' && opts.accessToken !== '') {
      headers.Authorization = 'Bearer ' + opts.accessToken;
    }
    var fetchImpl = opts.fetchImpl;

    return Promise.resolve().then(function () {
      return fetchImpl(config.url + '/rest/v1/' + table + search, { method: 'GET', headers: headers });
    }).then(function (res) {
      var status = res && typeof res.status === 'number' ? res.status : 0;
      var bodyPromise = (res && typeof res.text === 'function')
        ? Promise.resolve(res.text())
        : Promise.resolve('');
      return bodyPromise.then(function (text) {
        if (status < 200 || status >= 300) {
          return { ok: false, code: status === 401 ? 'E_UNAUTHORIZED' : 'E_QUERY', status: status, message: '查询失败（' + status + '）' };
        }
        var rows = null;
        try { rows = JSON.parse(text); } catch (e) { rows = null; }
        if (!Array.isArray(rows)) {
          return { ok: false, code: 'E_BAD_RESPONSE', status: status, message: '查询响应不是数组' };
        }
        return { ok: true, status: status, rows: rows };
      });
    }, function () {
      return { ok: false, code: 'E_NETWORK', retryable: true, message: '查询时网络失败' };
    });
  }

  /**
   * PostgREST 插入（2026-10-27）：注册成功后写 profiles 行。
   * 唯一约束冲突（23505）必须单独返回 E_DUPLICATE——并发注册同名用户名时
   * 只有这一处能真正拦住（先查后插的窗口期靠它兜底）。
   */
  function restInsert(opts) {
    if (!opts || typeof opts.fetchImpl !== 'function') {
      throw makeError('E_CONFIG_MISSING', 'restInsert 需要可注入的 fetchImpl');
    }
    var config = opts.config;
    if (!config || typeof config.url !== 'string' || typeof config.anonKey !== 'string') {
      throw makeError('E_CONFIG_MISSING', 'restInsert 需要 createConfig 的产物');
    }
    if (typeof opts.accessToken !== 'string' || opts.accessToken === '') {
      throw makeError('E_CONFIG_MISSING', 'restInsert 需要登录后的 accessToken');
    }
    var table = typeof opts.table === 'string' && /^[A-Za-z0-9_.]+$/.test(opts.table) ? opts.table : '';
    if (table === '') throw makeError('E_CONFIG_MISSING', 'restInsert 需要合法表名');
    var row = opts.row && typeof opts.row === 'object' ? opts.row : null;
    if (!row) throw makeError('E_CONFIG_MISSING', 'restInsert 需要行数据');

    var headers = {
      apikey: config.anonKey,
      Authorization: 'Bearer ' + opts.accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=minimal'
    };
    var fetchImpl = opts.fetchImpl;

    return Promise.resolve().then(function () {
      return fetchImpl(config.url + '/rest/v1/' + table, {
        method: 'POST', headers: headers, body: JSON.stringify(row)
      });
    }).then(function (res) {
      var status = res && typeof res.status === 'number' ? res.status : 0;
      var bodyPromise = (res && typeof res.text === 'function')
        ? Promise.resolve(res.text())
        : Promise.resolve('');
      return bodyPromise.then(function (text) {
        var parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
        var pgCode = parsed && parsed.message && parsed.code ? parsed.code : null;
        if (status >= 200 && status < 300) return { ok: true, status: status };
        if (status === 409 || pgCode === '23505' ||
          (parsed && typeof parsed.message === 'string' && /duplicate key/i.test(parsed.message))) {
          return { ok: false, code: 'E_DUPLICATE', status: status, retryable: false, message: '用户名已被占用' };
        }
        return { ok: false, code: 'E_INSERT', status: status, retryable: false, message: '写入失败（' + status + '）' };
      });
    }, function () {
      return { ok: false, code: 'E_NETWORK', retryable: true, message: '写入时网络失败' };
    });
  }

  /* ---------------- Auth 通用请求壳（D13，2026-10-27） ----------------
     邮箱验证码时代新增的四个端点（verify / recover / resend / user）都是
     「单次请求 + 同一套超时与错误分类」，把骨架收在一个函数里，
     各端点只写自己的响应分类逻辑。 */

  /**
   * 单次 Auth/REST 请求的公共骨架。
   * @returns {Promise<{status:number, parsed:object|null}>} 网络错误在 raw 内不上抛，
   *   由调用方拿到 null 后自行归一（保持各函数错误码语义独立）。
   */
  function rawAuthCall(opts, method, path, bodyObj, bearerOverride) {
    if (!opts || typeof opts.fetchImpl !== 'function') {
      throw makeError('E_CONFIG_MISSING', 'auth 请求需要可注入的 fetchImpl');
    }
    var config = opts.config;
    if (!config || typeof config.url !== 'string' || typeof config.anonKey !== 'string') {
      throw makeError('E_CONFIG_MISSING', 'auth 请求需要 createConfig 的产物');
    }
    var nowFn = opts.now || function () { return Date.now(); };
    var fetchImpl = opts.fetchImpl;
    var setTimeoutImpl = opts.setTimeoutImpl || (typeof setTimeout === 'function' ? setTimeout : null);
    var clearTimeoutImpl = opts.clearTimeoutImpl || (typeof clearTimeout === 'function' ? clearTimeout : null);
    var timeoutMs = opts.timeoutMs === undefined ? config.timeoutMs : opts.timeoutMs;

    var headers = {
      apikey: config.anonKey,
      Authorization: 'Bearer ' + (bearerOverride || config.anonKey),
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    var body = bodyObj === undefined || bodyObj === null ? null : JSON.stringify(bodyObj);
    var url = config.url + path;

    var localTimer = null;
    function stopTimer() {
      if (localTimer !== null && typeof clearTimeoutImpl === 'function') clearTimeoutImpl(localTimer);
      localTimer = null;
    }

    var call = Promise.resolve().then(function () {
      return fetchImpl(url, { method: method, headers: headers, body: body });
    });
    var guarded = call;
    if (timeoutMs > 0 && typeof setTimeoutImpl === 'function') {
      guarded = new Promise(function (resolve, reject) {
        localTimer = setTimeoutImpl(function () {
          localTimer = null;
          reject(makeError('E_TIMEOUT', '请求超时（' + timeoutMs + 'ms）'));
        }, timeoutMs);
        call.then(
          function (v) { resolve(v); },
          function (e) { reject(e); }
        );
      });
    }

    return guarded.then(
      function (res) {
        stopTimer();
        var status = res && typeof res.status === 'number' ? res.status : 0;
        var bodyPromise = (res && typeof res.text === 'function')
          ? Promise.resolve(res.text())
          : Promise.resolve('');
        return bodyPromise.then(function (text) {
          var parsed = null;
          if (typeof text === 'string' && text.length > 0) {
            try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
          }
          return { status: status, parsed: parsed };
        });
      },
      function (err) {
        stopTimer();
        return { status: 0, parsed: null, networkError: err };
      }
    );
  }

  /** 从会话响应里提取凭据；缺 access/refresh/user.id 一律 null（调用方报 E_BAD_RESPONSE）。 */
  function parseAuthCreds(parsed, nowFn, fallbackEmail) {
    if (!parsed || typeof parsed.access_token !== 'string' || parsed.access_token === '') return null;
    if (typeof parsed.refresh_token !== 'string' || parsed.refresh_token === '') return null;
    var expiresAt;
    if (typeof parsed.expires_at === 'number' && isFinite(parsed.expires_at)) {
      expiresAt = parsed.expires_at * 1000;
    } else if (typeof parsed.expires_in === 'number' && isFinite(parsed.expires_in)) {
      expiresAt = nowFn() + parsed.expires_in * 1000;
    } else {
      return null;
    }
    var userId = parsed.user && typeof parsed.user.id === 'string' ? parsed.user.id : '';
    if (userId === '') return null;
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt: expiresAt,
      userId: userId,
      email: parsed.user && typeof parsed.user.email === 'string' ? parsed.user.email : fallbackEmail
    };
  }

  /** Auth 4xx 的通用分类：验证码无效 / 限流 / 其余透出服务端 msg。 */
  function classifyAuth4xx(status, parsed, fallbackMessage) {
    var errCode = parsed && (parsed.error || parsed.error_code) || null;
    var msg = parsed && (typeof parsed.msg === 'string' ? parsed.msg : (parsed.message || '')) || '';
    if (errCode === 'otp_expired' || /otp|token.*expired|invalid.*otp/i.test(msg) ||
        /link is invalid/i.test(msg)) {
      return { ok: false, code: 'E_CODE_INVALID', status: status, retryable: false,
        message: '验证码无效或已过期，请重新获取' };
    }
    if (errCode === 'over_request_rate_limit' || errCode === 'too_many_requests' || status === 429) {
      return { ok: false, code: 'E_RATE_LIMIT', status: status, retryable: true,
        message: '请求过于频繁，请稍后再试' };
    }
    if (errCode === 'user_not_found' || /user not found/i.test(msg)) {
      return { ok: false, code: 'E_NOT_FOUND', status: status, retryable: false,
        message: '该邮箱尚未注册' };
    }
    return {
      ok: false, code: 'E_CLIENT', status: status, retryable: false,
      message: fallbackMessage + (msg ? ('：' + (msg.length > 160 ? msg.slice(0, 160) + '…' : msg)) : ('（' + status + '）'))
    };
  }

  /**
   * 6 位邮箱验证码 → 会话（D13）。POST /auth/v1/verify。
   * type='signup'   注册确认邮件里的码：一步完成「确认邮箱 + 建立会话」；
   * type='recovery' 忘记密码邮件里的码：建立会话后由调用方再改密。
   */
  function verifyEmailOtp(opts) {
    var email = typeof opts.email === 'string' ? opts.email.trim() : '';
    var token = typeof opts.token === 'string' ? opts.token.trim() : '';
    var type = opts.type === 'recovery' ? 'recovery' : 'signup';
    if (email === '' || token === '') {
      throw makeError('E_CONFIG_MISSING', 'verifyEmailOtp 需要邮箱与验证码');
    }
    var nowFn = opts.now || function () { return Date.now(); };
    return rawAuthCall(opts, 'POST', '/auth/v1/verify',
      { type: type, email: email, token: token }).then(function (raw) {
      if (raw.networkError) {
        return { ok: false, code: 'E_NETWORK', retryable: true, message: '验证时网络失败' };
      }
      var status = raw.status;
      var parsed = raw.parsed;
      if (status >= 200 && status < 300) {
        var creds = parseAuthCreds(parsed, nowFn, email);
        if (!creds) {
          return { ok: false, code: 'E_BAD_RESPONSE', status: status, retryable: false, message: '验证响应缺少会话' };
        }
        return { ok: true, accessToken: creds.accessToken, refreshToken: creds.refreshToken,
          expiresAt: creds.expiresAt, userId: creds.userId, email: creds.email };
      }
      if (status >= 400 && status < 500) {
        return classifyAuth4xx(status, parsed, '验证被拒绝');
      }
      return { ok: false, code: status >= 500 ? 'E_SERVER' : 'E_BAD_RESPONSE', status: status,
        retryable: status >= 500, message: '验证失败（' + status + '）' };
    });
  }

  /**
   * 重发注册确认邮件（D13）。POST /auth/v1/resend，type='signup'。
   * 邮件模板（Supabase 控制台）里放 {{ .Token }}，重发的就是新的 6 位码。
   */
  function resendSignupEmail(opts) {
    var email = typeof opts.email === 'string' ? opts.email.trim() : '';
    if (email === '') throw makeError('E_CONFIG_MISSING', 'resendSignupEmail 需要邮箱');
    return rawAuthCall(opts, 'POST', '/auth/v1/resend',
      { type: 'signup', email: email }).then(function (raw) {
      if (raw.networkError) {
        return { ok: false, code: 'E_NETWORK', retryable: true, message: '发送时网络失败' };
      }
      var status = raw.status;
      if (status >= 200 && status < 300) return { ok: true, status: status };
      if (status >= 400 && status < 500) return classifyAuth4xx(status, raw.parsed, '发送被拒绝');
      return { ok: false, code: status >= 500 ? 'E_SERVER' : 'E_BAD_RESPONSE', status: status,
        retryable: status >= 500, message: '发送失败（' + status + '）' };
    });
  }

  /**
   * 请求「忘记密码」邮件（D13）。POST /auth/v1/recover。
   * 无论邮箱是否存在都返回 200（防枚举），因此 ok 不代表账号存在——
   * 文案必须写「如果该邮箱已注册」。
   */
  function requestPasswordReset(opts) {
    var email = typeof opts.email === 'string' ? opts.email.trim() : '';
    if (email === '') throw makeError('E_CONFIG_MISSING', 'requestPasswordReset 需要邮箱');
    return rawAuthCall(opts, 'POST', '/auth/v1/recover',
      { email: email }).then(function (raw) {
      if (raw.networkError) {
        return { ok: false, code: 'E_NETWORK', retryable: true, message: '发送时网络失败' };
      }
      var status = raw.status;
      if (status >= 200 && status < 300) return { ok: true, status: status };
      if (status >= 400 && status < 500) return classifyAuth4xx(status, raw.parsed, '发送被拒绝');
      return { ok: false, code: status >= 500 ? 'E_SERVER' : 'E_BAD_RESPONSE', status: status,
        retryable: status >= 500, message: '发送失败（' + status + '）' };
    });
  }

  /**
   * 修改当前用户密码（D13）。PUT /auth/v1/user，需要 verifyEmailOtp(recovery)
   * 建立会话后的 accessToken。
   */
  function updateUserPassword(opts) {
    var password = typeof opts.password === 'string' ? opts.password : '';
    if (password === '') throw makeError('E_CONFIG_MISSING', 'updateUserPassword 需要新密码');
    if (typeof opts.accessToken !== 'string' || opts.accessToken === '') {
      throw makeError('E_CONFIG_MISSING', 'updateUserPassword 需要会话 accessToken');
    }
    return rawAuthCall(opts, 'PUT', '/auth/v1/user',
      { password: password }, opts.accessToken).then(function (raw) {
      if (raw.networkError) {
        return { ok: false, code: 'E_NETWORK', retryable: true, message: '修改时网络失败' };
      }
      var status = raw.status;
      if (status >= 200 && status < 300) {
        var userId = raw.parsed && typeof raw.parsed.id === 'string' ? raw.parsed.id : '';
        return { ok: true, status: status, userId: userId };
      }
      if (status === 401 || status === 403) {
        return { ok: false, code: 'E_UNAUTHORIZED', status: status, retryable: false,
          message: '验证会话已失效，请重新走一遍「忘记密码」' };
      }
      if (status >= 400 && status < 500) return classifyAuth4xx(status, raw.parsed, '修改被拒绝');
      return { ok: false, code: status >= 500 ? 'E_SERVER' : 'E_BAD_RESPONSE', status: status,
        retryable: status >= 500, message: '修改失败（' + status + '）' };
    });
  }

  /**
   * PostgREST RPC 调用（D13）：用户名/邮箱 → 登录邮箱的解析走
   * security definer 函数（resolve_login），避免把全量邮箱暴露成可查的公开视图。
   */
  function rpcCall(opts) {
    var fnName = typeof opts.fn === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(opts.fn) ? opts.fn : '';
    if (fnName === '') throw makeError('E_CONFIG_MISSING', 'rpcCall 需要合法函数名');
    var params = opts.params && typeof opts.params === 'object' ? opts.params : {};
    return rawAuthCall(opts, 'POST', '/rest/v1/rpc/' + fnName, params,
      typeof opts.accessToken === 'string' ? opts.accessToken : undefined).then(function (raw) {
      if (raw.networkError) {
        return { ok: false, code: 'E_NETWORK', retryable: true, message: '查询时网络失败' };
      }
      var status = raw.status;
      if (status >= 200 && status < 300) {
        var v = raw.parsed;
        return { ok: true, status: status, rows: Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]) };
      }
      if (status >= 400 && status < 500) return classifyAuth4xx(status, raw.parsed, '查询被拒绝');
      return { ok: false, code: status >= 500 ? 'E_SERVER' : 'E_BAD_RESPONSE', status: status,
        retryable: status >= 500, message: '查询失败（' + status + '）' };
    });
  }

  return {
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    b64urlDecode: b64urlDecode,
    decodeJwtPayload: decodeJwtPayload,
    assertPublicKey: assertPublicKey,
    createConfig: createConfig,
    createHttp: createHttp,
    refreshSession: refreshSession,
    signInWithPassword: signInWithPassword,
    signUpWithPassword: signUpWithPassword,
    verifyEmailOtp: verifyEmailOtp,
    resendSignupEmail: resendSignupEmail,
    requestPasswordReset: requestPasswordReset,
    updateUserPassword: updateUserPassword,
    rpcCall: rpcCall,
    restQuery: restQuery,
    restInsert: restInsert
  };
});
