/**
 * DayPlan · 账号对话框（登录 / 注册 / 邮箱验证 / 找回密码）
 *
 * 契约：docs/spec/18-manual-cloud-save.md §4.2。
 *
 * 只负责界面与输入校验；网络与会话全部由 `auth`（src/cloud/auth.js）承担。
 * 成功后调用 `onSignedIn(result)`，由装配层决定切作用域与静默载入——
 * 本模块不碰 Store、不碰数据。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var M = root.DayPlan.modal;
  var el = M.el;

  function note(text) {
    return el('p', { class: 'hint', text: text });
  }

  function field(label, input) {
    return el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: label }),
      input
    ]);
  }

  /** 把登录错误码翻成用户能照着做的一句话。 */
  function loginErrorText(r) {
    var code = r && r.code ? r.code : '';
    if (code === 'E_INVALID_CREDENTIALS') return '账号或密码不正确';
    if (code === 'E_EMAIL_NOT_CONFIRMED') return '邮箱还没验证：输入邮箱里的验证码即可';
    if (code === 'E_RATE_LIMIT') return '尝试过于频繁，请等一会儿再试';
    if (code === 'E_NETWORK' || code === 'E_TIMEOUT') return '连不上服务器，检查网络后重试';
    if (code === 'E_PERSIST' || code === 'E_STORAGE') return '登录成功但凭据存不进本机存储';
    if (code === 'E_NOT_FOUND') return '账号不存在，先注册一个';
    return (r && r.message) || ('登录失败（' + (code || '未知错误') + '）');
  }

  function signedInToast(r) {
    var who = (r && r.username) || (r && r.email) || '';
    M.toast(who ? ('已登录：' + who) : '已登录');
  }

  function openSignIn(opts) {
    var auth = opts.auth;
    var accountIn = el('input', {
      class: 'input', type: 'text', placeholder: '用户名 / 邮箱',
      autocomplete: 'username'
    });
    var pwdIn = el('input', {
      class: 'input', type: 'password', placeholder: '密码',
      autocomplete: 'current-password'
    });

    var body = el('div', {}, [
      field('账号', accountIn),
      field('密码', pwdIn)
    ]);

    var busy = false;
    var ctx = M.open({
      title: '登录',
      body: body,
      showSubmit: false,
      showCancel: false,
      footer: [
        el('button', {
          class: 'btn btn-ghost', type: 'button', text: '注册新账号',
          onclick: function () {
            ctx.close('register');
            openRegister(opts);
          }
        }),
        el('button', {
          class: 'btn btn-ghost', type: 'button', text: '忘记密码',
          onclick: function () {
            ctx.close('forgot');
            openForgotPassword(opts);
          }
        }),
        el('button', {
          class: 'btn btn-ghost', type: 'button', text: '取消',
          onclick: function () { ctx.close('cancel'); }
        }),
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '登录',
          onclick: function () {
            if (busy) return;
            var account = String(accountIn.value || '').trim();
            var pwd = String(pwdIn.value || '');
            if (account === '' || pwd === '') {
              ctx.setError('请填写账号与密码');
              return;
            }
            busy = true;
            /* 邮箱直达密码登录；用户名先经 RPC 解析成邮箱 */
            var ready = account.indexOf('@') >= 0
              ? Promise.resolve({ ok: true, email: account.toLowerCase(), username: '' })
              : Promise.resolve(auth.lookupAccount(account));
            ready.then(function (lk) {
              if (!lk || !lk.ok) {
                busy = false;
                ctx.setError((lk && lk.message) || '账号不存在');
                return null;
              }
              return Promise.resolve(auth.signIn(lk.email, pwd, lk.username)).then(function (r) {
                busy = false;
                if (!r || !r.ok) {
                  if (r && r.code === 'E_EMAIL_NOT_CONFIRMED') {
                    ctx.close('verify');
                    openEmailCodeVerify({
                      auth: auth, email: lk.email, username: lk.username,
                      onSignedIn: opts.onSignedIn, onDone: opts.onDone
                    });
                    return;
                  }
                  ctx.setError(loginErrorText(r));
                  return;
                }
                ctx.close('done');
                signedInToast(r);
                if (opts.onSignedIn) opts.onSignedIn(r);
              });
            }).then(null, function (err) {
              busy = false;
              ctx.setError(loginErrorText(err));
            });
          }
        })
      ],
      onClose: function () { if (opts.onDone) opts.onDone(); }
    });
  }

  function openRegister(opts) {
    var auth = opts.auth;

    var usernameIn = el('input', {
      class: 'input', type: 'text', placeholder: '3-24 位小写字母、数字、_ 或 -',
      autocomplete: 'username'
    });
    var emailIn = el('input', {
      class: 'input', type: 'email', placeholder: '接收验证码与找回密码',
      autocomplete: 'email'
    });
    var pwdIn = el('input', {
      class: 'input', type: 'password', placeholder: '至少 8 位',
      autocomplete: 'new-password'
    });

    var body = el('div', {}, [
      note('注册后会给邮箱发一封验证码邮件，输入验证码即完成注册。'),
      field('用户名', usernameIn),
      field('邮箱', emailIn),
      field('密码', pwdIn)
    ]);

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
            openSignIn(opts);
          }
        }),
        el('button', {
          class: 'btn btn-primary', type: 'button', text: '注册',
          onclick: function () {
            if (busy) return;
            var username = String(usernameIn.value || '').trim().toLowerCase();
            var email = String(emailIn.value || '').trim().toLowerCase();
            var pwd = String(pwdIn.value || '');
            if (username === '' || email === '' || pwd === '') {
              ctx.setError('请填写全部字段');
              return;
            }
            busy = true;
            Promise.resolve(auth.registerAccount({ username: username, email: email, password: pwd }))
              .then(function (r) {
                busy = false;
                if (!r || !r.ok) {
                  ctx.setError((r && r.message) || (r && r.code) || '注册失败');
                  return;
                }
                if (r.needsVerification) {
                  ctx.close('verify');
                  openEmailCodeVerify({
                    auth: auth, email: r.email || email, username: r.username || username,
                    onSignedIn: opts.onSignedIn, onDone: opts.onDone
                  });
                  return;
                }
                ctx.close('done');
                signedInToast(r);
                if (opts.onSignedIn) opts.onSignedIn(r);
              }, function (err) {
                busy = false;
                ctx.setError(loginErrorText(err));
              });
          }
        })
      ],
      onClose: function () { if (opts.onDone) opts.onDone(); }
    });
  }

  /** 邮箱验证码确认（注册与登录补验证共用）。 */
  function openEmailCodeVerify(opts) {
    var auth = opts.auth;
    var email = String(opts.email || '').trim().toLowerCase();
    var username = String(opts.username || '');

    var codeIn = el('input', {
      class: 'input', type: 'text', placeholder: '邮件里的验证码', inputmode: 'numeric',
      maxlength: '10', autocomplete: 'one-time-code'
    });

    var resendBtn = el('button', {
      class: 'btn btn-ghost btn-sm', type: 'button', text: '重新发送验证码',
      onclick: function () {
        resendBtn.disabled = true;
        Promise.resolve(auth.resendEmailCode(email, 'signup')).then(function (r) {
          M.toast((r && r.ok) ? '验证码已重新发送' : ('发送失败：' + ((r && r.message) || '未知错误')));
          setTimeout(function () { resendBtn.disabled = false; }, 60000);
        }, function () {
          resendBtn.disabled = false;
          M.toast('发送失败，请检查网络');
        });
      }
    });

    var body = el('div', {}, [
      note('验证码已发送到 ' + email + '（若没收到请查看垃圾箱）。'),
      field('验证码', codeIn),
      resendBtn
    ]);

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
            Promise.resolve(auth.verifyEmailCode({ email: email, code: code, username: username }))
              .then(function (r) {
                busy = false;
                if (!r || !r.ok) {
                  ctx.setError((r && r.message) || (r && r.code) || '验证失败');
                  return;
                }
                ctx.close('done');
                signedInToast(r);
                if (opts.onSignedIn) opts.onSignedIn(r);
              }, function (err) {
                busy = false;
                ctx.setError(loginErrorText(err));
              });
          }
        })
      ],
      onClose: function () { if (opts.onDone) opts.onDone(); }
    });
  }

  /** 忘记密码：两步（发验证码 → 验证码 + 新密码）。 */
  function openForgotPassword(opts) {
    var auth = opts.auth;

    function step2(email) {
      var codeIn = el('input', {
        class: 'input', type: 'text', placeholder: '邮件里的验证码',
        inputmode: 'numeric', maxlength: '10'
      });
      var pwdIn = el('input', {
        class: 'input', type: 'password', placeholder: '新密码（至少 8 位）',
        autocomplete: 'new-password'
      });

      var resendBtn = el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', text: '重新发送验证码',
        onclick: function () {
          resendBtn.disabled = true;
          Promise.resolve(auth.resendEmailCode(email, 'recovery')).then(function (r) {
            M.toast((r && r.ok) ? '验证码已重新发送' : ('发送失败：' + ((r && r.message) || '未知错误')));
            setTimeout(function () { resendBtn.disabled = false; }, 60000);
          }, function () {
            resendBtn.disabled = false;
            M.toast('发送失败，请检查网络');
          });
        }
      });

      var body = el('div', {}, [
        note('验证码已发送到 ' + email + '（若没收到请查看垃圾箱）。'),
        field('验证码', codeIn),
        field('新密码', pwdIn),
        resendBtn
      ]);

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
              Promise.resolve(auth.resetPassword({ email: email, code: code, newPassword: pwd }))
                .then(function (r) {
                  busy = false;
                  if (!r || !r.ok) {
                    ctx2.setError((r && r.message) || (r && r.code) || '重置失败');
                    return;
                  }
                  ctx2.close('done');
                  M.toast('密码已更新，已登录');
                  if (opts.onSignedIn) opts.onSignedIn(r);
                }, function (err) {
                  busy = false;
                  ctx2.setError(loginErrorText(err));
                });
            }
          })
        ],
        onClose: function () { if (opts.onDone) opts.onDone(); }
      });
    }

    var emailIn = el('input', {
      class: 'input', type: 'email', placeholder: '注册邮箱',
      autocomplete: 'email'
    });

    var busy = false;
    var ctx = M.open({
      title: '忘记密码 · 1/2',
      body: el('div', {}, [
        note('输入注册时的邮箱，我们会发送一封验证码邮件。'),
        field('邮箱', emailIn)
      ]),
      showSubmit: false,
      showCancel: false,
      footer: [
        el('button', {
          class: 'btn btn-ghost', type: 'button', text: '返回登录',
          onclick: function () {
            ctx.close('back');
            openSignIn(opts);
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
            Promise.resolve(auth.requestPasswordReset(email)).then(function (r) {
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

  root.DayPlan.accountDialogs = {
    openSignIn: openSignIn,
    openRegister: openRegister,
    openEmailCodeVerify: openEmailCodeVerify,
    openForgotPassword: openForgotPassword,
    loginErrorText: loginErrorText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
