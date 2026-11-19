/**
 * DayPlan · 云端读写（手动保存）
 *
 * 契约：docs/spec/18-manual-cloud-save.md §3 / §5 / §6。
 *
 * 本模块只做「读一行 / 写一行」，不碰本地存储、不改界面：
 *   · read()   读当前账号的云端行（0 行合法）
 *   · save()   把 payload 写成最新版本；覆盖前把旧版本压进 versions
 *   · restore() 与 save 完全同义（回溯 = 立刻存成新版本），保留名字只是为了让调用处可读
 *
 * 并发模型：每次写都先读当前 revision，再用 `revision=eq.<读到的值>` 条件更新。
 * 0 行命中 = 别的端刚保存过 → 重读、重算 versions、重试（最多 maxAttempts 轮）。
 * **不合并**：最后点保存的人赢，这是手动保存的显式语义。
 *
 * 令牌：调用方注入 session.withToken（刷新一次 + 401 重试一次在 session 层）。
 * 云端的错误原样透传，只有「缺 versions/saved_by 列」改成可照做的提示。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(isNode ? require('../core/cloud-versions.js') : root.DayPlan.cloudVersions);
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.cloudClient = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (V) {
  'use strict';

  var DEFAULT_ATTEMPTS = 3;

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function fail(code, message, extra) {
    var out = { ok: false, code: code, message: message };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  /** 云端行只保留契约用到的列；结构不认识就返回 null，由调用方拒绝写入。 */
  function normalizeRow(row) {
    if (!isPlainObject(row) || !isPlainObject(row.schedule_data)) return null;
    return {
      schedule_data: row.schedule_data,
      revision: typeof row.revision === 'number' && isFinite(row.revision) ? row.revision : null,
      updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
      saved_by: typeof row.saved_by === 'string' ? row.saved_by : '',
      versions: Array.isArray(row.versions) ? row.versions : []
    };
  }

  function rowOf(res) {
    if (!res) return null;
    if (res.row !== undefined) return res.row;
    return Array.isArray(res.rows) && res.rows.length ? res.rows[0] : null;
  }

  /** 建列之前写入会 400；把 PostgREST 的原话翻成用户能照做的一句话。 */
  function mapWriteError(res) {
    if (!res || res.ok) return res;
    if (res.code === 'E_CLIENT' && /versions|saved_by/i.test(String(res.message || ''))) {
      return fail('E_CLOUD_SCHEMA',
        '云端缺少 versions / saved_by 列：请在 Supabase SQL Editor 执行 docs/spec/18-manual-cloud-save.md §8 的语句',
        { status: res.status, attempts: res.attempts });
    }
    return res;
  }

  /**
   * @param {object} opts
   * @param {object} opts.http       supabase.createHttp 的产物（select / insert / updateConditional）
   * @param {string} opts.uid        当前账号 uid
   * @param {Function} opts.withToken session.withToken：(fn(accessToken)) => Promise
   * @param {string} [opts.device]   设备标签（写入 saved_by）
   * @param {number} [opts.maxAttempts] 写冲突重试上限，默认 3
   * @param {Function} [opts.rpc]    (fnName, params, token) => Promise；注入则优先走 save_schedule RPC
   * @returns {{read:Function, save:Function, restore:Function}}
   */
  function createClient(opts) {
    opts = opts || {};
    var http = opts.http;
    var uid = opts.uid;
    var withToken = opts.withToken;
    var device = typeof opts.device === 'string' ? opts.device.slice(0, 40) : '';
    var maxAttempts = typeof opts.maxAttempts === 'number' && opts.maxAttempts > 0
      ? Math.floor(opts.maxAttempts)
      : DEFAULT_ATTEMPTS;

    if (!http || !uid || typeof withToken !== 'function') {
      throw new TypeError('createClient 需要 http / uid / withToken');
    }

    /* F-111 乐观写：缓存上次见过的云端整行。read/save 成功与采纳后更新；
       任何写冲突即清空（缓存 revision 已陈旧），下一轮退回读改写。
       有缓存时保存省掉「保存前整段 GET」，直接本地算版本栈 + 条件 PATCH。 */
    var lastRow = null;

    /* F-111.2 服务端 RPC：注入了 opts.rpc 才尝试 save_schedule（一次 RPC 完成
       读+算栈+条件写，行锁串行化）。函数不存在（未部署 / 404 PGRST202）即永久
       关闭 RPC，回退到已验证的乐观写 / 读改写——因此 SQL 部署前上线本代码也安全。 */
    var rpcAvailable = typeof opts.rpc === 'function';

    /**
     * 把「同步抛 / Promise 拒绝」统一成失败结果：调用方只处理一种形状。
     * session.withToken 会用拒绝表达「登录过期」，所以带 code 的拒绝原样透传——
     * 一律改写成 E_NETWORK 会让用户看到「网络不可用」而不是「请重新登录」。
     */
    function callNetwork(fn, message) {
      return Promise.resolve().then(fn).then(null, function (err) {
        var code = err && typeof err.code === 'string' ? err.code : 'E_NETWORK';
        return fail(code, (err && typeof err.message === 'string' && err.message) || message);
      });
    }

    function read() {
      return callNetwork(function () {
        return withToken(function (token) { return http.select(uid, token); });
      }, '读取云端失败').then(function (res) {
        if (!res || !res.ok) {
          return fail((res && res.code) || 'E_BAD_RESPONSE', (res && res.message) || '读取云端失败');
        }
        var row = rowOf(res);
        if (!row) { lastRow = null; return { ok: true, row: null }; }
        var normalized = normalizeRow(row);
        if (!normalized) return fail('E_BAD_ROW', '云端行结构不可识别，已拒绝使用');
        lastRow = normalized;
        return { ok: true, row: normalized };
      });
    }

    /** 一次写入尝试（回退路径）：内部完成「读 → 算版本栈 → insert / 条件 PATCH」。 */
    function attempt(payload) {
      return read().then(function (r) {
        if (!r.ok) return r;
        var prev = r.row;
        var versions = prev ? V.nextVersions(prev) : [];

        if (!prev) {
          return callNetwork(function () {
            return withToken(function (token) {
              return http.insert(uid, payload, token, {
                revision: 1,
                versions: versions,
                saved_by: device
              });
            });
          }, '保存失败：网络不可用').then(function (res) {
            if (res && res.ok) { lastRow = normalizeRow(rowOf(res)); return { ok: true, row: lastRow }; }
            if (res && res.code === 'E_CONFLICT') { lastRow = null; return { ok: false, retry: true }; }
            return mapWriteError(fail((res && res.code) || 'E_BAD_RESPONSE', (res && res.message) || '保存失败'));
          });
        }

        if (typeof prev.revision !== 'number') {
          return fail('E_BAD_ROW', '云端行缺少 revision，拒绝覆盖');
        }
        return callNetwork(function () {
          return withToken(function (token) {
            return http.updateConditional(uid, {
              schedule_data: payload,
              versions: versions,
              saved_by: device,
              revision: prev.revision + 1
            }, prev.revision, token);
          });
        }, '保存失败：网络不可用').then(function (res) {
          if (res && res.ok) { lastRow = normalizeRow(rowOf(res)); return { ok: true, row: lastRow }; }
          if (res && res.code === 'E_CONFLICT') { lastRow = null; return { ok: false, retry: true }; }
          return mapWriteError(fail((res && res.code) || 'E_BAD_RESPONSE', (res && res.message) || '保存失败'));
        });
      });
    }

    /** F-111 乐观写：用缓存整行本地算版本栈，直接条件 PATCH（省掉保存前 GET），
        响应裁成 revision,updated_at；成功后用「发出的 payload+版本栈 + 返回列」重建缓存。
        冲突即清缓存退回读改写。条件 PATCH 仍守 revision，0 行绝不报成功。 */
    function attemptOptimistic(payload) {
      var prev = lastRow;
      var versions = V.nextVersions(prev);
      return callNetwork(function () {
        return withToken(function (token) {
          return http.updateConditional(uid, {
            schedule_data: payload,
            versions: versions,
            saved_by: device,
            revision: prev.revision + 1
          }, prev.revision, token, { select: 'revision,updated_at' });
        });
      }, '保存失败：网络不可用').then(function (res) {
        if (res && res.ok) {
          var ret = res.row || {};
          lastRow = {
            schedule_data: payload,
            revision: typeof ret.revision === 'number' && isFinite(ret.revision) ? ret.revision : prev.revision + 1,
            updated_at: typeof ret.updated_at === 'string' ? ret.updated_at : '',
            saved_by: device,
            versions: versions
          };
          return { ok: true, row: lastRow };
        }
        if (res && res.code === 'E_CONFLICT') { lastRow = null; return { ok: false, retry: true }; }
        return mapWriteError(fail((res && res.code) || 'E_BAD_RESPONSE', (res && res.message) || '保存失败'));
      });
    }

    /** F-111.2 服务端 RPC：一次 save_schedule 完成读+算栈+条件写（行锁串行化）。
        函数未部署（404 / PGRST202）→ 关闭 RPC 并回退；服务端报 conflict → 清缓存重试；
        成功用返回的整行（含服务端算好的 versions）重建缓存，供回退路径继续使用。 */
    function attemptRpc(payload) {
      return callNetwork(function () {
        return withToken(function (token) {
          return opts.rpc('save_schedule', { p_data: payload, p_device: device }, token);
        });
      }, '保存失败：网络不可用').then(function (res) {
        if (!res || !res.ok) {
          if (res && (res.status === 404 || /PGRST202|Could not find the function/i.test(String(res.message || '')))) {
            rpcAvailable = false;
            return { ok: false, fallback: true };
          }
          return mapWriteError(fail((res && res.code) || 'E_BAD_RESPONSE', (res && res.message) || '保存失败'));
        }
        var r = Array.isArray(res.rows) && res.rows.length ? res.rows[0] : null;
        if (!isPlainObject(r)) return fail('E_BAD_RESPONSE', '保存响应不可验证');
        if (r.ok === false && r.code === 'conflict') { lastRow = null; return { ok: false, retry: true }; }
        if (r.ok !== true || typeof r.revision !== 'number' || !isFinite(r.revision)) {
          return fail('E_BAD_RESPONSE', '保存响应不可验证');
        }
        lastRow = {
          schedule_data: payload,
          revision: r.revision,
          updated_at: typeof r.updated_at === 'string' ? r.updated_at : '',
          saved_by: typeof r.saved_by === 'string' ? r.saved_by : device,
          versions: Array.isArray(r.versions) ? r.versions : []
        };
        return { ok: true, row: lastRow };
      });
    }

    /**
     * @param {object} payload cloudDoc.toCloud 的产物
     * @returns {Promise<{ok:true,row:(object|null),attempts:number}
     *                  |{ok:false,code:string,message:string,attempts?:number}>}
     */
    function save(payload) {
      if (!isPlainObject(payload)) {
        return Promise.resolve(fail('E_SHAPE', '要保存的内容必须是对象'));
      }
      var n = 0;
      function loop() {
        n += 1;
        var p;
        if (rpcAvailable && typeof opts.rpc === 'function') {
          p = attemptRpc(payload);
        } else if (lastRow && typeof lastRow.revision === 'number') {
          p = attemptOptimistic(payload);
        } else {
          p = attempt(payload);
        }
        return p.then(function (res) {
          if (res.ok) return { ok: true, row: res.row, attempts: n };
          if (res.fallback) { n -= 1; return loop(); }  // RPC 未部署：不消耗重试轮次
          if (res.retry && n < maxAttempts) return loop();
          if (res.retry) {
            return fail('E_CONFLICT', '云端刚被其它设备保存过，请再点一次保存', { attempts: n });
          }
          res.attempts = n;
          return res;
        });
      }
      return loop();
    }

    return {
      read: read,
      save: save,
      restore: save
    };
  }

  return {
    DEFAULT_ATTEMPTS: DEFAULT_ATTEMPTS,
    normalizeRow: normalizeRow,
    createClient: createClient
  };
});
