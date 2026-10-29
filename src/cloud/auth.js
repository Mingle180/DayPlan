/**
 * DayPlan · 账号服务（注册 / 登录 / 邮箱验证 / 找回密码）
 *
 * 契约：docs/spec/18-manual-cloud-save.md §4.2。
 *
 * 边界：
 *   · 本模块只做「网络请求 + 写会话 + 缓存显示名」；
 *     **不切作用域、不读写数据、不碰界面**——切到哪个账号副本由装配层按返回值决定。
 *   · `dayplan.auth.v1` 的唯一写者是 session；本模块只调用 session.signIn / signOut。
 *   · 密码只在这一次请求里用，不落盘、不写日志、不回显。
 *
 * 身份模型（沿用 D13）：Supabase Auth 的身份是真实邮箱；用户名是 profiles 上的
 * 别名，登录时经 RPC `resolve_login` 解析回邮箱。邮箱验证码（{{ .Token }}）
 * 一次完成「确认邮箱 + 登录」；忘记密码同样走验证码。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(isNode ? require('../net/supabase.js') : root.DayPlan.supabase);
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.cloudAuth = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (supabase) {
  'use strict';

  var USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var NAME_PREFIX = 'dayplan.account-name.v1.';
  var MIN_PASSWORD = 8;

  function bad(code, message) {
    return { ok: false, code: code, message: message };
  }

  /** kv 只用于显示名缓存：没有也照常登录，只是面板回落脱敏 uid。 */
  function safeGet(kv, key) {
    if (!kv || typeof kv.getItem !== 'function') return '';
    try {
      var v = kv.getItem(key);
      return typeof v === 'string' ? v : '';
    } catch (e) {
      return '';
    }
  }

  function safeSet(kv, key, value) {
    if (!kv || typeof kv.setItem !== 'function') return;
    try { kv.setItem(key, value); } catch (e) { /* 只是显示问题，不阻断登录 */ }
  }

  /**
   * @param {object} opts
   * @param {object} opts.session  session.createSession 的产物（唯一凭据写者）
   * @param {object} opts.config   supabase.createConfig 的产物
   * @param {Function} opts.fetchImpl  fetch 实现（可注入，测试用假实现）
   * @param {object} [opts.kv]     { getItem, setItem }，仅用于用户名缓存
   * @param {Function} [opts.now]  () => 毫秒
   */
  function createAuth(opts) {
    opts = opts || {};
    var session = opts.session;
    var config = opts.config;
    var fetchImpl = opts.fetchImpl;
    var kv = opts.kv || null;
    var nowFn = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };

    if (!session || typeof session.signIn !== 'function') {
      throw new TypeError('createAuth 需要 session');
    }
    if (!config || typeof config.url !== 'string') {
      throw new TypeError('createAuth 需要 supabase 配置');
    }
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('createAuth 需要 fetchImpl');
    }

    function rememberName(uid, name) {
      var n = String(name || '').trim();
      if (!uid || !n) return;
      safeSet(kv, NAME_PREFIX + uid, n);
    }

    function accountName(uid) {
      return uid ? String(safeGet(kv, NAME_PREFIX + uid) || '').trim() : '';
    }

    /** 网络模块直接抛也算失败：调用方只处理结果对象。 */
    function call(fn) {
      return Promise.resolve().then(fn).then(null, function (err) {
        return bad((err && err.code) || 'E_NETWORK', (err && err.message) || '连不上服务器');
      });
    }

    /** 把 auth 模块下发的凭据装进会话；返回 {ok, uid, email, username}。 */
    function adoptCreds(r, fallbackEmail, username) {
      return session.signIn({
        accessToken: r.accessToken,
        refreshToken: r.refreshToken,
        expiresAt: r.expiresAt,
        userId: r.userId
      }).then(function (w) {
        if (!w || !w.ok) return w || bad('E_PERSIST', '登录凭据写入失败');
        rememberName(r.userId, username);
        return {
          ok: true,
          uid: r.userId,
          email: r.email || fallbackEmail || '',
          username: username || ''
        };
      });
    }

    /** 用户名或邮箱 → {email, username}。走 RPC，不暴露邮箱列表。 */
    function lookupAccount(input) {
      var key = String(input || '').trim();
      if (key === '' || (key.indexOf('@') < 0 && !USERNAME_RE.test(key))) {
        return Promise.resolve(bad('E_BAD_ACCOUNT', '请输入用户名（3-24 位小写字母/数字）或邮箱'));
      }
      return call(function () {
        return supabase.rpcCall({
          config: config, fetchImpl: fetchImpl,
          fn: 'resolve_login', params: { p_key: key }
        });
      }).then(function (r) {
        if (!r.ok) return { ok: false, code: r.code || 'E_QUERY', message: r.message || '查询失败' };
        if (!r.rows.length || !r.rows[0] || !r.rows[0].email) {
          return bad('E_NOT_FOUND', '该用户名尚未注册');
        }
        var row = r.rows[0];
        return {
          ok: true,
          email: row.email,
          username: typeof row.username === 'string' ? row.username : ''
        };
      });
    }

    /**
     * 邮箱 + 密码登录。邮箱未验证时返回 E_EMAIL_NOT_CONFIRMED，由界面转验证码视图。
     * @param {string} [displayName] 登录框解析出的用户名（邮箱直登没有）
     */
    function signIn(email, password, displayName) {
      var mail = String(email || '').trim().toLowerCase();
      var pwd = String(password || '');
      if (mail === '' || pwd === '') return Promise.resolve(bad('E_BAD_INPUT', '请填写账号与密码'));
      return call(function () {
        return supabase.signInWithPassword({
          config: config, fetchImpl: fetchImpl, email: mail, password: pwd, now: nowFn
        });
      }).then(function (r) {
        if (!r.ok) return r;
        return adoptCreds(r, mail, String(displayName || '').trim());
      });
    }

    /** 注册：用户名 + 邮箱 + 密码。成功只是「账号已建」，验证码在邮箱里。 */
    function registerAccount(input) {
      var username = String(input && input.username || '').trim().toLowerCase();
      var email = String(input && input.email || '').trim().toLowerCase();
      var password = String(input && input.password || '');
      if (!USERNAME_RE.test(username)) {
        return Promise.resolve(bad('E_BAD_USERNAME', '用户名需 3-24 位小写字母、数字、下划线或连字符'));
      }
      if (!EMAIL_RE.test(email)) return Promise.resolve(bad('E_BAD_EMAIL', '请输入有效的邮箱地址'));
      if (password.length < MIN_PASSWORD) {
        return Promise.resolve(bad('E_BAD_PASSWORD', '密码至少 ' + MIN_PASSWORD + ' 位'));
      }
      // 用户名先查重（体验层）；并发拦截在 profiles 的 UNIQUE 约束
      return call(function () {
        return supabase.restQuery({
          config: config, fetchImpl: fetchImpl,
          table: 'public_profiles',
          search: '?username=eq.' + encodeURIComponent(username) + '&select=username&limit=1'
        });
      }).then(function (r) {
        if (r.ok && r.rows.length) {
          return bad('E_ACCOUNT_EXISTS', '用户名已被占用');
        }
        return call(function () {
          return supabase.signUpWithPassword({
            config: config, fetchImpl: fetchImpl,
            email: email, password: password,
            data: { username: username }, now: nowFn
          });
        });
      }).then(function (sr) {
        if (!sr.ok) return sr;
        if (sr.needsVerification) {
          // 确认邮件已发出（含验证码）；此时还没有会话，不写 profiles
          return { ok: true, needsVerification: true, email: email, username: username };
        }
        /* 项目关掉了 Confirm email：signUp 直接下发会话，同样要写别名 */
        return session.signIn({
          accessToken: sr.accessToken,
          refreshToken: sr.refreshToken,
          expiresAt: sr.expiresAt,
          userId: sr.userId
        }).then(function (w) {
          if (!w || !w.ok) return w || bad('E_PERSIST', '登录凭据写入失败');
          return supabase.restInsert({
            config: config, fetchImpl: fetchImpl,
            accessToken: sr.accessToken,
            table: 'profiles',
            row: { user_id: sr.userId, username: username }
          }).then(function (ir) {
            if (!ir.ok) {
              // 别名没写进去就不留半截登录态
              session.signOut();
              if (ir.code === 'E_DUPLICATE') return bad('E_ACCOUNT_EXISTS', '用户名已被占用');
              return bad(ir.code || 'E_INSERT', ir.message || '注册失败，请稍后重试');
            }
            rememberName(sr.userId, username);
            return {
              ok: true, uid: sr.userId,
              email: sr.email || email, username: username
            };
          });
        });
      });
    }

    /**
     * 注册验证码确认：verifyOtp(signup) 一步完成「邮箱确认 + 登录」。
     * @param {{email, code, username?}} input username 只在刚注册时传（别名尚未写）
     */
    function verifyEmailCode(input) {
      var email = String(input && input.email || '').trim().toLowerCase();
      var code = String(input && input.code || '').trim();
      var username = String(input && input.username || '').trim().toLowerCase();
      if (email === '' || code === '') return Promise.resolve(bad('E_BAD_INPUT', '请输入邮箱与验证码'));
      return call(function () {
        return supabase.verifyEmailOtp({
          config: config, fetchImpl: fetchImpl,
          email: email, token: code, type: 'signup', now: nowFn
        });
      }).then(function (vr) {
        if (!vr.ok) return vr;
        return session.signIn({
          accessToken: vr.accessToken,
          refreshToken: vr.refreshToken,
          expiresAt: vr.expiresAt,
          userId: vr.userId
        }).then(function (w) {
          if (!w || !w.ok) return w || bad('E_PERSIST', '登录凭据写入失败');
          var finish = function () {
            rememberName(vr.userId, username);
            return {
              ok: true, uid: vr.userId,
              email: vr.email || email, username: username
            };
          };
          if (username === '') return finish();  // 老账号补验证：别名已在
          return supabase.restInsert({
            config: config, fetchImpl: fetchImpl,
            accessToken: vr.accessToken,
            table: 'profiles',
            row: { user_id: vr.userId, username: username }
          }).then(function (ir) {
            if (!ir.ok) {
              session.signOut();
              if (ir.code === 'E_DUPLICATE') {
                return bad('E_ACCOUNT_EXISTS', '用户名刚被占用，请返回换一个用户名重新注册');
              }
              return bad(ir.code || 'E_INSERT', ir.message || '用户名写入失败，请稍后重试');
            }
            return finish();
          });
        });
      });
    }

    /** 忘记密码第一步：发重置邮件。防枚举：邮箱不存在也 ok。 */
    function requestPasswordReset(email) {
      var mail = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(mail)) return Promise.resolve(bad('E_BAD_EMAIL', '请输入有效的邮箱地址'));
      return call(function () {
        return supabase.requestPasswordReset({ config: config, fetchImpl: fetchImpl, email: mail });
      });
    }

    /** 忘记密码第二步：验证码 + 新密码。验证通过即处于登录态。 */
    function resetPassword(input) {
      var email = String(input && input.email || '').trim().toLowerCase();
      var code = String(input && input.code || '').trim();
      var password = String(input && input.newPassword || '');
      if (email === '' || code === '') return Promise.resolve(bad('E_BAD_INPUT', '请输入邮箱与验证码'));
      if (password.length < MIN_PASSWORD) {
        return Promise.resolve(bad('E_BAD_PASSWORD', '密码至少 ' + MIN_PASSWORD + ' 位'));
      }
      return call(function () {
        return supabase.verifyEmailOtp({
          config: config, fetchImpl: fetchImpl,
          email: email, token: code, type: 'recovery', now: nowFn
        });
      }).then(function (vr) {
        if (!vr.ok) return vr;
        return session.signIn({
          accessToken: vr.accessToken,
          refreshToken: vr.refreshToken,
          expiresAt: vr.expiresAt,
          userId: vr.userId
        }).then(function (w) {
          if (!w || !w.ok) return w || bad('E_PERSIST', '登录凭据写入失败');
          return supabase.updateUserPassword({
            config: config, fetchImpl: fetchImpl,
            accessToken: vr.accessToken, password: password
          }).then(function (ur) {
            if (!ur.ok) {
              // 拿着重置会话却没改掉密：退出，让用户重来
              session.signOut();
              return ur;
            }
            return {
              ok: true, uid: vr.userId,
              email: vr.email || email, passwordReset: true
            };
          });
        });
      });
    }

    /** 重发验证码：注册确认走 resend；忘记密码再 recover 一次。 */
    function resendEmailCode(email, kind) {
      var mail = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(mail)) return Promise.resolve(bad('E_BAD_EMAIL', '请输入有效的邮箱地址'));
      return call(function () {
        if (kind === 'recovery') {
          return supabase.requestPasswordReset({ config: config, fetchImpl: fetchImpl, email: mail });
        }
        return supabase.resendSignupEmail({ config: config, fetchImpl: fetchImpl, email: mail });
      });
    }

    function signOut() {
      return Promise.resolve(session.signOut());
    }

    return {
      lookupAccount: lookupAccount,
      signIn: signIn,
      signOut: signOut,
      registerAccount: registerAccount,
      verifyEmailCode: verifyEmailCode,
      requestPasswordReset: requestPasswordReset,
      resetPassword: resetPassword,
      resendEmailCode: resendEmailCode,
      accountName: accountName
    };
  }

  return {
    createAuth: createAuth,
    NAME_PREFIX: NAME_PREFIX
  };
});
