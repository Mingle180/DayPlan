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
        if (!row) return { ok: true, row: null };
        var normalized = normalizeRow(row);
        if (!normalized) return fail('E_BAD_ROW', '云端行结构不可识别，已拒绝使用');
        return { ok: true, row: normalized };
      });
    }

    /** 一次写入尝试：内部完成「读 → 算版本栈 → insert / 条件 PATCH」。 */
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
            if (res && res.ok) return { ok: true, row: normalizeRow(rowOf(res)) };
            if (res && res.code === 'E_CONFLICT') return { ok: false, retry: true };
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
          if (res && res.ok) return { ok: true, row: normalizeRow(rowOf(res)) };
          if (res && res.code === 'E_CONFLICT') return { ok: false, retry: true };
          return mapWriteError(fail((res && res.code) || 'E_BAD_RESPONSE', (res && res.message) || '保存失败'));
        });
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
        return attempt(payload).then(function (res) {
          if (res.ok) return { ok: true, row: res.row, attempts: n };
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
