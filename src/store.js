/**
 * DayPlan · 状态容器（唯一写入口）
 *
 * 契约见 docs/spec/04-system-design.md §2.5/§2.9、02-functional-spec.md F-03/F-09/F-11/F-28、
 * 迭代 4 见 docs/spec/07-iteration-4-delta.md（DM-18 紧急类别 / BR-38~41）。
 *
 * 设计要点：
 * - 所有写操作走 mutate()：先克隆 -> 应用变更 -> 校验 -> 提交 -> 通知 -> 节流落盘。
 * - 校验失败抛 StoreError，且**不改变内存状态**（避免半截写入）。
 * - storage 可注入（localStorage / 内存），便于测试与隐私模式降级。
 * - 数据作用域（Phase 1B）：默认游客；`options.scope` 可显式指定账号作用域，
 *   否则启动时按 `dayplan.active.v1` 解析。所有落盘只写当前作用域的数据键。
 * - 账号副本只能通过 `persistAccountCopy` 写入；切换作用域不会复制游客数据。
 * - `toggleStarred` 保留为内部兼容（迭代 3 数据迁移输入），迭代 4 起视图一律用 `toggleUrgent`。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(
    isNode ? require('./core/datetime.js') : root.DayPlan.datetime,
    isNode ? require('./core/schema.js') : root.DayPlan.schema,
    isNode ? require('./core/id.js') : root.DayPlan.id,
    isNode ? require('./core/scope-storage.js') : root.DayPlan.scopeStorage,
    isNode ? require('./core/sync-keys.js') : root.DayPlan.syncKeys
  );
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.store = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dt, schema, idgen, scopeStorage, K) {
  'use strict';

  var DB_KEY = 'dayplan.db.v1';
  var BACKUP_KEY = 'dayplan.db.backup.last';
  var UI_KEY = 'dayplan.ui.v1';
  var SEED_KEY = 'dayplan.seed.v1';
  var CORRUPT_PREFIX = 'dayplan.db.corrupt.';
  var MAX_CORRUPT_BACKUPS = 3;
  var SAVE_THROTTLE_MS = 300;

  /* ------------------------------------------------------------------ *
   * 错误
   * ------------------------------------------------------------------ */

  function StoreError(code, message, detail) {
    var e = new Error(message);
    e.name = 'StoreError';
    e.code = code;
    e.detail = detail || null;
    return e;
  }

  /* ------------------------------------------------------------------ *
   * 存储后端
   * ------------------------------------------------------------------ */

  /** localStorage 包装：不可用时（隐私模式）回退内存实现，并标记 degraded */
  function createStorage(preferred) {
    var backing = preferred || null;
    var degraded = false;
    var memory = {};
    var self = {
      get degraded() { return degraded; },
      getItem: function (k) {
        try {
          return backing ? backing.getItem(k) : (k in memory ? memory[k] : null);
        } catch (e) {
          return k in memory ? memory[k] : null;
        }
      },
      setItem: function (k, v) {
        if (degraded || !backing) { memory[k] = v; return; }
        try {
          backing.setItem(k, v);
        } catch (e) {
          if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014)) {
            throw StoreError('E_QUOTA', '浏览器存储空间不足，保存失败', e);
          }
          // 其他异常（如 Safari 隐私模式）：降级为内存并抛出可见错误
          degraded = true;
          memory[k] = v;
          throw StoreError('E_STORAGE', '浏览器存储不可用，已切换为临时内存模式（本次修改不会被保存）', e);
        }
      },
      removeItem: function (k) {
        delete memory[k];
        if (degraded || !backing) return;
        try {
          backing.removeItem(k);
        } catch (e) { /* 忽略：删除失败不影响内存状态 */ }
      },
      keys: function () {
        if (backing && !degraded) {
          try {
            var out = [];
            for (var i = 0; i < backing.length; i++) out.push(backing.key(i));
            return out;
          } catch (e) { /* 落到内存分支 */ }
        }
        return Object.keys(memory);
      }
    };
    return self;
  }

  /** 内存存储（测试用） */
  function createMemoryStorage(initial) {
    var data = {};
    if (initial) Object.keys(initial).forEach(function (k) { data[k] = initial[k]; });
    return {
      data: data,
      getItem: function (k) { return k in data ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; },
      key: function (i) { return Object.keys(data)[i]; },
      get length() { return Object.keys(data).length; }
    };
  }

  /* ------------------------------------------------------------------ *
   * Store
   * ------------------------------------------------------------------ */

  /**
   * @param {object} options
   *   - storage: localStorage 兼容对象（缺省自动探测）
   *   - seedFactory: () => Document，演示数据工厂（缺省 null，不注入）
   *   - now: () => string ISO 时间戳（可注入便于测试）
   *   - autoSave: boolean，默认 true
   */
  function createStore(options) {
    options = options || {};
    var storage = createStorage(options.storage !== undefined ? options.storage : detectLocalStorage());
    var now = options.now || function () { return new Date().toISOString(); };
    var seedFactory = options.seedFactory || null;
    var autoSave = options.autoSave !== false;

    var state = schema.createEmptyDocument();
    var listeners = [];
    var saveTimer = null;
    var lastError = null;
    var lastWarnings = [];
    var seeded = false;
    var storageDegraded = false;

    var sessionUid = typeof options.sessionUid === 'string' ? options.sessionUid : null;
    var scope;
    var scopeInfo;
    if (options.scope !== undefined && options.scope !== null) {
      scope = normalizeScope(options.scope);
      scopeInfo = { scope: scope, id: K.scopeId(scope), repaired: false, reason: 'explicit-scope', pointerWrite: null };
    } else {
      var boot = scopeStorage.resolveBootScope(storage, sessionUid);
      scope = boot.scope;
      scopeInfo = boot;
    }
    var dbKey = K.dbKeyForScope(scope);
    var seedKey = K.seedKeyForScope(scope);

    function normalizeScope(raw) {
      if (typeof raw === 'string') {
        var parsed = K.parseScopeId(raw);
        if (!parsed.ok) throw StoreError('E_INVALID_SCOPE', '无法解析数据作用域：' + raw);
        return parsed.scope;
      }
      if (!K.isValidScope(raw)) throw StoreError('E_INVALID_SCOPE', '数据作用域必须是 guest 或 user:<合法 uid>');
      return raw.kind === 'guest' ? K.guestScope() : K.userScope(raw.uid);
    }

    function detectLocalStorage() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
      } catch (e) { /* 隐私模式访问即抛 */ }
      return null;
    }

    // ---------------- 读取 / 保存 ----------------

    /**
     * 解析一段数据键内容，不修改内存状态。
     * @returns {{ok:boolean, doc:(object|null), warnings:Array, recovered?:boolean,
     *            code?:string, error?:string, errors?:Array}}
     */
    function parseDocument(raw, opts) {
      opts = opts || {};
      var parsed = null;
      var parseError = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parseError = e;
      }

      if (parseError) {
        if (opts.backup !== false) backupCorrupt(raw, 'JSON 解析失败：' + parseError.message);
        return { ok: false, doc: null, recovered: false, code: 'E_PARSE', error: parseError.message, warnings: [] };
      }

      // 版本高于当前应用：不猜测、不降级写入，走损坏流程（保留原始串备份）
      if (parsed && typeof parsed === 'object' && typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > schema.SCHEMA_VERSION) {
        if (opts.backup !== false) {
          backupCorrupt(raw, '数据版本 ' + parsed.schemaVersion + ' 高于当前应用支持的 ' + schema.SCHEMA_VERSION);
        }
        return {
          ok: false, doc: null, recovered: false, code: 'E_INVALID',
          errors: [{ path: '$.schemaVersion', message: '数据版本高于当前应用支持' }],
          warnings: []
        };
      }

      // DM-12 / DM-20：链式迁移（纯函数）；无法迁移 → 损坏流程（F-09.1）
      // 迁移告警（如 E_MIGRATE_URGENT）写入 versionWarnings，随 load 结果一并上报，不吞掉
      var versionWarnings = [];
      var sv = (parsed && typeof parsed === 'object') ? parsed.schemaVersion : undefined;
      var badVersionType = sv !== undefined && sv !== null && typeof sv !== 'number';
      var migrated;
      if (badVersionType) {
        // 版本字段类型非法：不当作可迁移数据，交由 validateDocument 报 E_INVALID
        migrated = parsed;
      } else {
        migrated = schema.migrateDocument(parsed, versionWarnings);
      }
      if (!migrated) {
        if (opts.backup !== false) backupCorrupt(raw, '数据迁移失败：结构无法修复');
        return {
          ok: false, doc: null, recovered: false, code: 'E_MIGRATE',
          errors: [{ path: '$', message: '数据无法迁移到当前版本' }],
          warnings: []
        };
      }

      var fromVersion = (parsed && typeof parsed === 'object' && typeof parsed.schemaVersion === 'number')
        ? parsed.schemaVersion : 1;
      if (!badVersionType && fromVersion !== migrated.schemaVersion) {
        versionWarnings.push({ path: '$.schemaVersion', message: '数据已从 v' + fromVersion + ' 迁移到 v' + migrated.schemaVersion });
      }

      var validation = schema.validateDocument(migrated);
      var sanitized = schema.sanitizeDocument(migrated);
      var fatal = validation.errors.filter(function (e) {
        return e.path === '$.schemaVersion' || e.path === '$.categories' || e.path === '$.items';
      });
      if (fatal.length) {
        if (opts.backup !== false) {
          backupCorrupt(raw, '结构校验失败：' + fatal.map(function (e) { return e.path + ' ' + e.message; }).join('; '));
        }
        return { ok: false, doc: null, recovered: false, code: 'E_INVALID', errors: validation.errors, warnings: versionWarnings };
      }

      var warnings = versionWarnings.concat(sanitized.warnings);
      return { ok: true, doc: sanitized.doc, recovered: warnings.length > 0, warnings: warnings };
    }

    function load() {
      lastWarnings = [];
      var raw = null;
      try {
        raw = storage.getItem(dbKey);
      } catch (e) {
        raw = null;
      }

      if (raw === null || raw === undefined || raw === '') {
        // 首次运行：按 BR-15 决定是否注入演示数据。
        // 账号副本绝不注入演示数据（契约 §2.2：登录不得写入账号副本）。
        var seedDone = false;
        try { seedDone = storage.getItem(seedKey) === 'done'; } catch (e) { seedDone = false; }
        if (K.isGuestScope(scope) && seedFactory && !seedDone) {
          try {
            var seededDoc = seedFactory();
            var sres = schema.sanitizeDocument(seededDoc);
            state = sres.doc;
            seeded = true;
            lastWarnings = lastWarnings.concat(sres.warnings);
            // 演示数据必须立即落盘：否则用户注入后马上关闭页面就会丢失
            commit(false);
            saveNow();
          } catch (e) {
            lastWarnings.push({ path: '$', message: '演示数据注入失败：' + e.message });
            state = schema.createEmptyDocument();
          }
        } else {
          state = schema.createEmptyDocument();
        }
        return { ok: true, seeded: seeded, warnings: lastWarnings.slice(), recovered: false, scope: K.scopeId(scope) };
      }

      var parsedDoc = parseDocument(raw);
      if (!parsedDoc.ok) {
        state = schema.createEmptyDocument();
        lastWarnings = parsedDoc.warnings.slice();
        var failure = {
          ok: false, seeded: false, recovered: false, code: parsedDoc.code,
          warnings: lastWarnings.slice(), scope: K.scopeId(scope)
        };
        if (parsedDoc.error) failure.error = parsedDoc.error;
        if (parsedDoc.errors) failure.errors = parsedDoc.errors;
        return failure;
      }

      state = parsedDoc.doc;
      lastWarnings = parsedDoc.warnings;
      // 归一过程中修复了内容则回写，保证磁盘与内存一致
      if (lastWarnings.length) commit(false);
      return {
        ok: true, seeded: false, recovered: lastWarnings.length > 0,
        warnings: lastWarnings.slice(), scope: K.scopeId(scope)
      };
    }

    function backupCorrupt(raw, reason) {
      var stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        storage.setItem(CORRUPT_PREFIX + stamp, raw);
      } catch (e) { /* 备份失败不阻塞启动 */ }
      lastError = StoreError('E_CORRUPT', '本地数据损坏，已备份并以空数据启动。原因：' + reason);
      // 只保留最近 3 份损坏备份
      try {
        var corruptKeys = storage.keys().filter(function (k) { return k.indexOf(CORRUPT_PREFIX) === 0; }).sort();
        while (corruptKeys.length > MAX_CORRUPT_BACKUPS) {
          storage.removeItem(corruptKeys.shift());
        }
      } catch (e) { /* 清理失败无妨 */ }
    }

    function serialize() {
      return JSON.stringify(state);
    }

    /** 立即落盘 */
    function saveNow() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      try {
        storage.setItem(dbKey, serialize());
        storageDegraded = storage.degraded;
        lastError = null;
        return { ok: true };
      } catch (e) {
        lastError = e && e.code ? e : StoreError('E_STORAGE', '保存失败：' + (e && e.message ? e.message : '未知错误'), e);
        storageDegraded = storage.degraded;
        return { ok: false, code: lastError.code, error: lastError.message };
      }
    }

    /** 是否有待写入的节流保存 */
    function hasPendingSave() {
      return !!saveTimer;
    }

    /** 只冲刷待写入内容：无待写入时不做多余 IO；返回是否执行了写入 */
    function flush() {
      if (!saveTimer) return false;
      saveNow();
      return true;
    }

    /** 节流落盘 */
    function scheduleSave() {
      if (!autoSave) return;
      if (saveTimer) return;
      saveTimer = setTimeout(function () {
        saveTimer = null;
        saveNow();
      }, SAVE_THROTTLE_MS);
      if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref();
    }

    /** 写入并通知；persist=false 时只更新内存（用于 load 归一后的回写） */
    function commit(persist) {
      state.meta.updatedAt = now();
      if (persist !== false) scheduleSave();
      notify();
    }

    function notify() {
      var snapshot = getState();
      listeners.slice().forEach(function (fn) {
        try {
          fn(snapshot);
        } catch (e) {
          if (typeof console !== 'undefined') console.error('[DayPlan] 订阅者异常：', e);
        }
      });
    }

    /**
     * 通用变更入口。
     * @param {function(object): (object|undefined)} fn 接收克隆后的文档，返回新文档（或就地修改克隆并返回 undefined）
     * @param {{validate?: boolean}} [opts]
     */
    function mutate(fn, opts) {
      opts = opts || {};
      var draft = clone(state);
      var result = fn(draft);
      var next = result === undefined ? draft : result;
      if (opts.validate !== false) {
        var v = schema.validateDocument(next);
        if (!v.ok) {
          throw StoreError('E_VALIDATION', '数据校验失败：' + v.errors.map(function (e) { return e.path + ' ' + e.message; }).join('；'), v.errors);
        }
      }
      state = next;
      commit(true);
      return getState();
    }

    function clone(obj) {
      return JSON.parse(JSON.stringify(obj));
    }

    function getState() {
      return clone(state);
    }

    function subscribe(fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function unsubscribe() {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }

    // ---------------- 查询辅助 ----------------

    function findIndexById(list, id) {
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
      return -1;
    }

    function getItem(id) {
      var i = findIndexById(state.items, id);
      return i < 0 ? null : clone(state.items[i]);
    }

    function getCategory(id) {
      var i = findIndexById(state.categories, id);
      return i < 0 ? null : clone(state.categories[i]);
    }

    function nextOrderFor(draft, date) {
      var max = -1;
      draft.items.forEach(function (it) {
        if (it.kind === 'single' && it.date === date) max = Math.max(max, it.order || 0);
        if (it.kind === 'series' && it.repeat && it.repeat.startDate === date) max = Math.max(max, it.order || 0);
      });
      return max + 1;
    }

    // ---------------- 事项 ----------------

    function addItem(input) {
      var item = clone(input);
      if (!item.id) item.id = idgen.itemId();
      if (!item.createdAt) item.createdAt = now();
      item.updatedAt = item.createdAt;
      if (item.done === undefined) item.done = false;
      if (item.starred === undefined) item.starred = false; // DM-4.5 缺省 false
      if (item.note === undefined) item.note = '';
      if (item.time === undefined) item.time = null;
      mutate(function (draft) {
        if (typeof item.order !== 'number' || !isFinite(item.order)) {
          var anchor = item.kind === 'single' ? item.date : (item.repeat && item.repeat.startDate);
          item.order = nextOrderFor(draft, anchor);
        }
        draft.items.push(item);
      });
      return item.id;
    }

    function updateItem(id, patch) {
      mutate(function (draft) {
        var i = findIndexById(draft.items, id);
        if (i < 0) throw StoreError('E_NOT_FOUND', '事项不存在：' + id);
        var next = draft.items[i];
        var prevCategoryId = next.categoryId;
        Object.keys(patch).forEach(function (k) {
          if (k === 'id' || k === 'createdAt') return; // 不可改
          next[k] = patch[k];
        });
        // 迭代 4（BR-38）：只传 categoryId 的视图（表单）也能正确维护 meta.previousCategoryId
        if (next.categoryId === URGENT_ID && prevCategoryId !== URGENT_ID) {
          var provided = patch.meta && patch.meta.previousCategoryId;
          if (!schema.isPlainObject(next.meta)) next.meta = {};
          next.meta.previousCategoryId = provided || prevCategoryId;
        } else if (prevCategoryId === URGENT_ID && next.categoryId !== URGENT_ID) {
          if (schema.isPlainObject(next.meta)) delete next.meta.previousCategoryId;
        }
        next.updatedAt = now();
        draft.items[i] = next;
      });
      return getItem(id);
    }

    function removeItem(id) {
      mutate(function (draft) {
        var i = findIndexById(draft.items, id);
        if (i < 0) throw StoreError('E_NOT_FOUND', '事项不存在：' + id);
        draft.items.splice(i, 1);
      });
      return true;
    }

    /**
     * 为重复序列的某次发生写入例外覆盖。
     * @param {string} seriesId
     * @param {string} dateISO 发生日期
     * @param {object} patch {time?, title?, note?, categoryId?, done?, deleted?} null 值表示显式覆盖为空
     */
    function addSeriesException(seriesId, dateISO, patch) {
      if (!dt.isValidDate(dateISO)) throw StoreError('E_INVALID_DATE', '非法日期：' + dateISO);
      mutate(function (draft) {
        var i = findIndexById(draft.items, seriesId);
        if (i < 0) throw StoreError('E_NOT_FOUND', '序列不存在：' + seriesId);
        var it = draft.items[i];
        if (it.kind !== 'series') throw StoreError('E_NOT_SERIES', '该事项不是重复事项：' + seriesId);
        it.exceptions = it.exceptions || {};
        var cur = it.exceptions[dateISO] || {};
        if (patch.deleted) {
          it.exceptions[dateISO] = { deleted: true };
        } else {
          var next = { deleted: undefined };
          delete next.deleted;
          Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
          Object.keys(patch).forEach(function (k) {
            if (k === 'deleted') return;
            if (patch[k] === undefined) return;
            next[k] = patch[k];
          });
          next.updatedAt = now();
          it.exceptions[dateISO] = next;
        }
        it.updatedAt = now();
        draft.items[i] = it;
      });
      return true;
    }

    /** 移除某次发生的例外（恢复为规则默认） */
    /**
     * 迭代 7（F-45 第 6 条 / 用户裁定 R-23）：该次发生的改动是否**不只是**「紧急 / 取消紧急」。
     * 只有「仅此次」的紧急切换（例外里除 categoryId 外没有任何覆盖）时不提供「恢复默认」。
     * 读纯函数：不修改任何状态。
     * @param {object} occ 发生（DM-5）
     * @returns {boolean}
     */
    var NON_URGENT_OVERRIDE_KEYS = ['time', 'title', 'note', 'done', 'starred'];

    function hasNonUrgentOverride(occ) {
      if (!occ || occ.dirty !== true) return false;
      var items = (state && state.items) || [];
      var i;
      for (i = 0; i < items.length; i += 1) {
        if (items[i] && items[i].id === occ.seriesId) {
          var ex = items[i].exceptions && items[i].exceptions[occ.date];
          if (!ex) return false;
          for (var k = 0; k < NON_URGENT_OVERRIDE_KEYS.length; k += 1) {
            if (Object.prototype.hasOwnProperty.call(ex, NON_URGENT_OVERRIDE_KEYS[k])) return true;
          }
          return false;
        }
      }
      return false;
    }

    function removeSeriesException(seriesId, dateISO) {
      mutate(function (draft) {
        var i = findIndexById(draft.items, seriesId);
        if (i < 0) throw StoreError('E_NOT_FOUND', '序列不存在：' + seriesId);
        var it = draft.items[i];
        if (it.exceptions && it.exceptions[dateISO]) {
          delete it.exceptions[dateISO];
          it.updatedAt = now();
          draft.items[i] = it;
        }
      });
      return true;
    }

    /**
     * 重复事项的范围操作（BR-10）。
     * @param {string} seriesId
     * @param {string} dateISO 分界日期（含）
     * @param {'edit'|'delete'} mode
     * @param {object} [changes] mode='edit' 时应用到新序列的字段
     * @returns {{split:boolean, seriesId:string, newSeriesId?:string}}
     */
    function splitSeriesAt(seriesId, dateISO, mode, changes) {
      if (!dt.isValidDate(dateISO)) throw StoreError('E_INVALID_DATE', '非法日期：' + dateISO);
      if (mode !== 'edit' && mode !== 'delete') throw StoreError('E_INVALID_MODE', 'mode 必须是 edit 或 delete');
      var outcome = null;

      mutate(function (draft) {
        var i = findIndexById(draft.items, seriesId);
        if (i < 0) throw StoreError('E_NOT_FOUND', '序列不存在：' + seriesId);
        var series = draft.items[i];
        if (series.kind !== 'series') throw StoreError('E_NOT_SERIES', '该事项不是重复事项：' + seriesId);

        var start = series.repeat.startDate;

        // 退化：分界日 <= 序列起始日 → 直接修改整条序列（避免产生空壳序列）
        // 注：diffDays(a, b) 返回 b - a；"分界日不晚于起始日" 即 diffDays(dateISO, start) >= 0
        if (dt.diffDays(dateISO, start) >= 0) {
          if (mode === 'delete') {
            draft.items.splice(i, 1);
            outcome = { split: false, seriesId: seriesId, deleted: true };
            return;
          }
          Object.keys(changes || {}).forEach(function (k) {
            if (k === 'id' || k === 'createdAt') return;
            series[k] = changes[k];
          });
          series.updatedAt = now();
          draft.items[i] = series;
          outcome = { split: false, seriesId: seriesId };
          return;
        }

        var prevDay = dt.addDays(dateISO, -1);

        // 例外按分界日拆开：
        //   stayInOriginal：发生日期 < 分界日（diffDays(k, dateISO) = dateISO - k > 0）→ 留在原序列
        //   moveToNew     ：发生日期 >= 分界日（<= 0）→ 随新序列迁移
        var stayInOriginal = {};
        var moveToNew = {};
        Object.keys(series.exceptions || {}).forEach(function (k) {
          if (dt.diffDays(k, dateISO) > 0) stayInOriginal[k] = series.exceptions[k];
          else moveToNew[k] = series.exceptions[k];
        });
        series.exceptions = stayInOriginal;
        series.repeat = copyRepeat(series.repeat);
        series.repeat.endDate = prevDay; // 半开区间：原序列最后一天 = dateISO - 1
        series.updatedAt = now();
        draft.items[i] = series;

        if (mode === 'delete') {
          outcome = { split: true, seriesId: seriesId, deletedTail: true };
          return;
        }

        var fresh = clone(series);
        fresh.id = idgen.itemId();
        delete fresh.exceptions;
        fresh.exceptions = moveToNew;
        fresh.repeat = copyRepeat(series.repeat);
        fresh.repeat.startDate = dateISO;
        // 新序列继承原有终点（若原终点早于分界日则不合法，此时置为 null 由校验拦截前修正）
        if (series.repeat.endDate !== undefined && series.repeat.endDate !== null) {
          fresh.repeat.endDate = null; // 拆分后新序列默认无限，避免"终点早于起点"的非法状态
        }
        Object.keys(changes || {}).forEach(function (k) {
          if (k === 'id' || k === 'createdAt' || k === 'exceptions') return;
          fresh[k] = changes[k];
        });
        fresh.createdAt = now();
        fresh.updatedAt = fresh.createdAt;
        draft.items.push(fresh);
        outcome = { split: true, seriesId: seriesId, newSeriesId: fresh.id };
      });

      return outcome;
    }

    function copyRepeat(repeat) {
      var out = {};
      Object.keys(repeat || {}).forEach(function (k) { out[k] = repeat[k]; });
      if (Array.isArray(out.weekdays)) out.weekdays = out.weekdays.slice();
      return out;
    }

    /**
     * 调整无时事项次序：与同日期相邻项交换 order。
     * @param {string} dateISO
     * @param {string} itemId
     * @param {number} delta -1 上移 / +1 下移
     */
    function moveItemOrder(dateISO, itemId, delta) {
      mutate(function (draft) {
        var group = draft.items.filter(function (it) {
          if (it.kind === 'single') return it.date === dateISO;
          return it.repeat && it.repeat.startDate === dateISO && it.time === null;
        }).filter(function (it) { return !it.time; });

        group.sort(compareUntimed);
        var idx = -1;
        for (var i = 0; i < group.length; i++) if (group[i].id === itemId) idx = i;
        if (idx < 0) throw StoreError('E_NOT_FOUND', '该日期下找不到无时事项：' + itemId);
        var target = idx + delta;
        if (target < 0 || target >= group.length) return; // 已在边界，静默无操作

        // 用显式序号重排整组，避免 order 相等时交换无效
        var ids = group.map(function (it) { return it.id; });
        var tmp = ids[idx];
        ids[idx] = ids[target];
        ids[target] = tmp;
        ids.forEach(function (id, i) {
          var j = findIndexById(draft.items, id);
          if (j >= 0) {
            draft.items[j] = Object.assign({}, draft.items[j], { order: i, updatedAt: now() });
          }
        });
      });
      return true;
    }

    /**
     * 按给定 id 顺序重排同一天的无时事项（迭代 10 条13：列表内拖动排序）。
     * 传入的 orderedIds 只需覆盖该组的一个子集；未出现的条目按原相对次序接在末尾，
     * 因此不会把「已隐藏 / 已完成」的条目意外挤到前面。
     * @param {string} dateISO
     * @param {string[]} orderedIds 期望的 id 次序（前缀）
     */
    function reorderUntimed(dateISO, orderedIds) {
      var wanted = Array.isArray(orderedIds) ? orderedIds : [];
      mutate(function (draft) {
        var group = draft.items.filter(function (it) {
          if (it.kind === 'single') return it.date === dateISO;
          return it.repeat && it.repeat.startDate === dateISO && it.time === null;
        }).filter(function (it) { return !it.time; });

        group.sort(compareUntimed);
        var rank = {};
        var next = 0;
        wanted.forEach(function (id) {
          if (typeof id === 'string' && !(id in rank)) { rank[id] = next; next += 1; }
        });
        group.forEach(function (it) { if (!(it.id in rank)) { rank[it.id] = next; next += 1; } });
        group.sort(function (a, b) { return rank[a.id] - rank[b.id]; });

        /* 与 moveItemOrder 同口径：整组压实为 0..n-1，消除历史空洞 */
        group.forEach(function (it, i) {
          var j = findIndexById(draft.items, it.id);
          if (j >= 0) {
            draft.items[j] = Object.assign({}, draft.items[j], { order: i, updatedAt: now() });
          }
        });
      });
      return true;
    }

    function compareUntimed(a, b) {
      if ((a.order || 0) !== (b.order || 0)) return (a.order || 0) - (b.order || 0);
      var ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      var tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (ta !== tb) return ta - tb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }

    /**
     * 切换完成状态（F-11）。
     * @param {string} id
     * @param {string|null} dateISO 重复实例的日期（single 事项可传 null）
     * @param {'only'|'all'} scope
     */
    function toggleDone(id, dateISO, scope) {
      scope = scope === 'all' ? 'all' : 'only';
      var result = null;
      mutate(function (draft) {
        var i = findIndexById(draft.items, id);
        if (i < 0) throw StoreError('E_NOT_FOUND', '事项不存在：' + id);
        var it = draft.items[i];
        if (it.kind === 'single' || scope === 'all') {
          it.done = !it.done;
          it.updatedAt = now();
          draft.items[i] = it;
          result = { scope: it.kind === 'single' ? 'item' : 'all', done: it.done };
          return;
        }
        if (!dt.isValidDate(dateISO)) throw StoreError('E_INVALID_DATE', '仅此次操作必须提供发生日期');
        it.exceptions = it.exceptions || {};
        var cur = it.exceptions[dateISO] || {};
        var currentDone = cur.done === undefined ? !!it.done : !!cur.done;
        var next = {};
        Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
        next.done = !currentDone;
        next.updatedAt = now();
        it.exceptions[dateISO] = next;
        it.updatedAt = now();
        draft.items[i] = it;
        result = { scope: 'only', done: next.done };
      });
      return result;
    }

    /** 某次发生的当前生效 starred（例外缺省 = 继承序列值，F-15.2） */
    function effectiveStarred(item, dateISO) {
      var ex = item.exceptions && item.exceptions[dateISO];
      if (ex && ex.starred !== undefined) return !!ex.starred;
      return !!item.starred;
    }

    /**
     * 切换「重要」标记（F-15.2 / BR-17），语义与 toggleDone 完全对齐。
     * | single                      | item.starred = !item.starred |
     * | series + scope="only"       | exceptions[date].starred = !当前生效值（保留其他例外字段） |
     * | series + scope="all" + date ≤ repeat.startDate | 整条反转 |
     * | series + scope="all" + date > repeat.startDate | 拆分（复用 splitSeriesAt），新序列取新值 |
     * @param {string} id
     * @param {string|null} dateISO 发生日期（single 可传 null）
     * @param {'only'|'all'} scope
     * @returns {{scope:string, starred:boolean, split?:boolean, seriesId?:string, newSeriesId?:string}}
     */
    function toggleStarred(id, dateISO, scope) {
      scope = scope === 'all' ? 'all' : 'only';
      var current = getItem(id);
      if (!current) throw StoreError('E_NOT_FOUND', '事项不存在：' + id);

      if (current.kind === 'single') {
        var singleResult = null;
        mutate(function (draft) {
          var i = findIndexById(draft.items, id);
          if (i < 0) throw StoreError('E_NOT_FOUND', '事项不存在：' + id);
          var it = draft.items[i];
          it.starred = !it.starred;
          it.updatedAt = now();
          draft.items[i] = it;
          singleResult = { scope: 'item', starred: it.starred, seriesId: id };
        });
        return singleResult;
      }

      if (!dt.isValidDate(dateISO)) throw StoreError('E_INVALID_DATE', '重复事项操作必须提供发生日期');

      if (scope === 'all') {
        var start = current.repeat && current.repeat.startDate;
        // 分界日不晚于序列起始日 → 退化为整条反转（不产生空壳序列）
        if (!start || dt.diffDays(dateISO, start) >= 0) {
          var allResult = null;
          mutate(function (draft) {
            var i = findIndexById(draft.items, id);
            if (i < 0) throw StoreError('E_NOT_FOUND', '事项不存在：' + id);
            var it = draft.items[i];
            it.starred = !it.starred;
            it.updatedAt = now();
            draft.items[i] = it;
            allResult = { scope: 'all', starred: it.starred, split: false, seriesId: id };
          });
          return allResult;
        }
        // 此次及以后：拆分，新序列取新值（F-15.2 / BR-10）
        var nextValue = !effectiveStarred(current, dateISO);
        var outcome = splitSeriesAt(id, dateISO, 'edit', { starred: nextValue });
        return {
          scope: 'all',
          starred: nextValue,
          split: !!outcome.split,
          seriesId: id,
          newSeriesId: outcome.newSeriesId
        };
      }

      var onlyResult = null;
      mutate(function (draft) {
        var i = findIndexById(draft.items, id);
        if (i < 0) throw StoreError('E_NOT_FOUND', '事项不存在：' + id);
        var it = draft.items[i];
        if (it.kind !== 'series') throw StoreError('E_NOT_SERIES', '该事项不是重复事项：' + id);
        it.exceptions = it.exceptions || {};
        var cur = it.exceptions[dateISO] || {};
        var next = {};
        Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
        next.starred = !effectiveStarred(it, dateISO);
        next.updatedAt = now();
        it.exceptions[dateISO] = next;
        it.updatedAt = now();
        draft.items[i] = it;
        onlyResult = { scope: 'only', starred: next.starred, seriesId: id };
      });
      return onlyResult;
    }

    /* ---------------- 紧急（迭代 4 / DM-18 / BR-37…BR-41） ---------------- */

    var URGENT_ID = schema.URGENT_CATEGORY_ID;

    /** 第一个非紧急类别（DM-3 次序）；全部为紧急时回退默认类别 */
    function firstNonUrgentCategoryId() {
      var list = orderedCategories(state.categories);
      for (var i = 0; i < list.length; i += 1) {
        if (!schema.isUrgentCategory(list[i])) return list[i].id;
      }
      return schema.DEFAULT_SETTINGS.defaultCategoryId;
    }

    /** 某次发生的当前生效类别（例外 categoryId 优先，其次序列类别） */
    function effectiveCategoryId(item, dateISO) {
      if (!item) return null;
      var ex = (dateISO && item.exceptions) ? item.exceptions[dateISO] : null;
      if (ex && ex.categoryId !== undefined) return ex.categoryId;
      return item.categoryId;
    }

    /**
     * 冻结接口：某次发生是否紧急（只读，不修改入参）。
     * @param {object} item 事项或发生（DM-4 / DM-5）
     * @param {string|null} dateISO 发生日期；single 可传 null
     */
    function effectiveUrgent(item, dateISO) {
      var date = dt.isValidDate(dateISO) ? dateISO : null;
      return effectiveCategoryId(item, date) === URGENT_ID;
    }

    /** 转入紧急（BR-38）：记录原类别；已在紧急时不覆盖 previousCategoryId（BR-39） */
    function markUrgentOn(node, previousCategoryId) {
      if (node.categoryId === URGENT_ID) return; // 幂等
      if (!schema.isPlainObject(node.meta)) node.meta = {};
      node.meta.previousCategoryId = previousCategoryId !== undefined ? previousCategoryId : node.categoryId;
      node.categoryId = URGENT_ID;
    }

    /** 类别是否仍存在（还原目标必须有效；BR-38） */
    function categoryExists(catId) {
      var list = state.categories || [];
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].id === catId) return true;
      }
      return false;
    }

    /** 还原目标：previousCategoryId（仍存在）→ 备选类别（仍存在）→ 第一个非紧急类别 */
    function restoreTarget(prev, fallback) {
      if (typeof prev === 'string' && prev && prev !== URGENT_ID && categoryExists(prev)) return prev;
      if (typeof fallback === 'string' && fallback && fallback !== URGENT_ID && categoryExists(fallback)) return fallback;
      return firstNonUrgentCategoryId();
    }

    /** 取消紧急（BR-38）：categoryId = previousCategoryId || 第一个非紧急类别，并删除该字段 */
    function unmarkUrgentOn(node, previousCategoryId) {
      var prev = node.meta && node.meta.previousCategoryId;
      node.categoryId = restoreTarget(prev, previousCategoryId);
      if (schema.isPlainObject(node.meta)) delete node.meta.previousCategoryId;
    }

    /**
     * 切换「紧急」（冻结接口，语义与 toggleStarred 逐条等价）。
     * | single                                  | item.categoryId ⟷ 紧急 |
     * | series + scope="single"/"only"          | exceptions[date] 转入/还原（继承序列类别） |
     * | series + scope="all" + date ≤ startDate | 整条转入/还原 |
     * | series + scope="all" + date >  startDate| 拆分（等价 future） |
     * | series + scope="future"                 | 此次及以后：拆分（date ≤ startDate 时退化为整条） |
     * @param {string} id
     * @param {string|null} dateISO
     * @param {'single'|'only'|'all'|'future'} scope
     * @returns {{scope:string, urgent:boolean, seriesId:string, split?:boolean, newSeriesId?:string}}
     */
    function toggleUrgent(id, dateISO, scope) {
      var mode = (scope === 'all' || scope === 'future') ? scope : 'single';
      var current = getItem(id);
      if (!current) throw StoreError('E_NOT_FOUND', '事项不存在：' + id);

      // 定日事项：直接切换 categoryId
      if (current.kind === 'single') {
        var singleResult = null;
        mutate(function (draft) {
          var i = findIndexById(draft.items, id);
          if (i < 0) throw StoreError('E_NOT_FOUND', '事项不存在：' + id);
          var it = draft.items[i];
          if (it.categoryId === URGENT_ID) unmarkUrgentOn(it, null);
          else markUrgentOn(it, it.categoryId);
          it.updatedAt = now();
          draft.items[i] = it;
          singleResult = { scope: 'single', urgent: it.categoryId === URGENT_ID, seriesId: id };
        });
        return singleResult;
      }

      if (!dt.isValidDate(dateISO)) throw StoreError('E_INVALID_DATE', '重复事项操作必须提供发生日期');
      var start = current.repeat && current.repeat.startDate;
      var atOrBeforeStart = !start || dt.diffDays(dateISO, start) >= 0;

      // scope=future（或 scope=all 且晚于起始日）：拆分；date ≤ startDate 时退化为整条
      if (mode !== 'single' && !atOrBeforeStart) {
        var fromUrgent = effectiveUrgent(current, dateISO);
        if (fromUrgent) {
          // 还原「此次及以后」：新序列回到 previousCategoryId（否则第一个非紧急类别），并删除该字段
          var prevId = restoreTarget(current.meta && current.meta.previousCategoryId, null);
          var restoredMeta = Object.assign({}, schema.isPlainObject(current.meta) ? current.meta : {});
          delete restoredMeta.previousCategoryId;
          var outcomeBack = splitSeriesAt(id, dateISO, 'edit', { categoryId: prevId, meta: restoredMeta });
          return {
            scope: mode, urgent: false, split: !!outcomeBack.split,
            seriesId: id, newSeriesId: outcomeBack.newSeriesId
          };
        }
        var newMeta = Object.assign({}, schema.isPlainObject(current.meta) ? current.meta : {}, {
          previousCategoryId: current.categoryId
        });
        var outcome = splitSeriesAt(id, dateISO, 'edit', { categoryId: URGENT_ID, meta: newMeta });
        return {
          scope: mode, urgent: true, split: !!outcome.split,
          seriesId: id, newSeriesId: outcome.newSeriesId
        };
      }

      if (mode === 'all') {
        // 整条切换（与 toggleStarred scope="all" 的边界分支一致）
        var allResult = null;
        mutate(function (draft) {
          var i = findIndexById(draft.items, id);
          if (i < 0) throw StoreError('E_NOT_FOUND', '事项不存在：' + id);
          var it = draft.items[i];
          if (it.categoryId === URGENT_ID) unmarkUrgentOn(it, null);
          else markUrgentOn(it, it.categoryId);
          it.updatedAt = now();
          draft.items[i] = it;
          allResult = { scope: 'all', urgent: it.categoryId === URGENT_ID, split: false, seriesId: id };
        });
        return allResult;
      }

      // scope=single：写例外（仅此次）
      var onlyResult = null;
      mutate(function (draft) {
        var i = findIndexById(draft.items, id);
        if (i < 0) throw StoreError('E_NOT_FOUND', '事项不存在：' + id);
        var it = draft.items[i];
        if (it.kind !== 'series') throw StoreError('E_NOT_SERIES', '该事项不是重复事项：' + id);
        it.exceptions = it.exceptions || {};
        var ex = it.exceptions[dateISO];
        var cur = schema.isPlainObject(ex) ? ex : {};
        var next = {};
        Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
        var curCat = cur.categoryId !== undefined ? cur.categoryId : it.categoryId;
        if (curCat === URGENT_ID) {
          // 例外缺省继承序列类别；序列本身若为紧急则回落到其 previousCategoryId
          var itemPrev = (it.meta && it.meta.previousCategoryId) ||
            (it.categoryId !== URGENT_ID ? it.categoryId : null);
          unmarkUrgentOn(next, itemPrev);
        } else {
          markUrgentOn(next, curCat);
        }
        next.updatedAt = now();
        it.exceptions[dateISO] = next;
        it.updatedAt = now();
        draft.items[i] = it;
        onlyResult = { scope: 'single', urgent: next.categoryId === URGENT_ID, seriesId: id };
      });
      return onlyResult;
    }

    // ---------------- 类别 ----------------

    function addCategory(input) {
      var name = (input && input.name ? String(input.name) : '').trim();
      if (!name) throw StoreError('E_INVALID_NAME', '类别名称不能为空');
      if (name.length > schema.CATEGORY_NAME_MAX) throw StoreError('E_INVALID_NAME', '类别名称不能超过 ' + schema.CATEGORY_NAME_MAX + ' 字');
      var lower = name.toLowerCase();
      var dup = state.categories.some(function (c) { return c.name.trim().toLowerCase() === lower; });
      if (dup) throw StoreError('E_DUPLICATE_NAME', '已存在同名类别：' + name);
      var color = input && schema.COLOR_RE.test(String(input.color)) ? String(input.color).toLowerCase() : '#6b7280';
      // DM-3：新类别 order = max(现有 order) + 1（列表为空则 0）
      var maxOrder = -1;
      state.categories.forEach(function (c) {
        if (typeof c.order === 'number' && isFinite(c.order)) maxOrder = Math.max(maxOrder, c.order);
      });
      var cat = {
        id: idgen.categoryId(),
        name: name,
        color: color,
        builtin: false,
        order: maxOrder + 1,
        createdAt: now()
      };
      mutate(function (draft) { draft.categories.push(cat); });
      return cat.id;
    }

    function updateCategory(id, patch) {
      mutate(function (draft) {
        var i = findIndexById(draft.categories, id);
        if (i < 0) throw StoreError('E_NOT_FOUND', '类别不存在：' + id);
        var cat = draft.categories[i];
        /* 2026-10-20（用户反馈「除了紧急类型仅可改名，其他类型均可自定义」）：
           · 紧急：**只允许改名** —— id / 颜色 / 次序 / 存在性全部固定（颜色恒 #dc2626）。
           · 非紧急（含三个内置类别）：改名、改色、排序都放开；仍**不可删除** ——
             `settings.defaultCategoryId` 与删除类别时的迁移兜底都指向内置类别，删光会没有落点
             （见 removeCategory 的 E_BUILTIN_LOCKED）。 */
        if (patch.name !== undefined) {
          var name = String(patch.name).trim();
          if (!name) throw StoreError('E_INVALID_NAME', '类别名称不能为空');
          if (name.length > schema.CATEGORY_NAME_MAX) throw StoreError('E_INVALID_NAME', '类别名称不能超过 ' + schema.CATEGORY_NAME_MAX + ' 字');
          var lower = name.toLowerCase();
          var dup = draft.categories.some(function (c) { return c.id !== id && c.name.trim().toLowerCase() === lower; });
          if (dup) throw StoreError('E_DUPLICATE_NAME', '已存在同名类别：' + name);
          cat.name = name;
        }
        if (patch.color !== undefined) {
          if (!schema.COLOR_RE.test(String(patch.color))) throw StoreError('E_INVALID_COLOR', '颜色格式非法，应为 #rrggbb');
          /* 紧急颜色是它的身份标识（红 = 急），也是「紧急列/紧急胶囊」的唯一视觉线索；
             允许改色会让「紧急」在界面里彻底认不出来，因此锁死。同色写入视为无操作。 */
          if (schema.isUrgentCategory(cat)
            && String(patch.color).toLowerCase() !== String(cat.color).toLowerCase()) {
            throw StoreError('E_BUILTIN_LOCKED', '「' + cat.name + '」只可改名，颜色固定为 ' + cat.color);
          }
          /* 统一小写落盘：颜色在数据里是字符串比较的（药丸/胶囊按色值查表），
             '#DC2626' 与 '#dc2626' 必须视为同一色。 */
          cat.color = String(patch.color).toLowerCase();
        }
        draft.categories[i] = cat;
      });
      return getCategory(id);
    }

    /** 删除自定义类别；被引用时必须提供 moveTo */
    function removeCategory(id, moveTo) {
      var cat = getCategory(id);
      if (!cat) throw StoreError('E_NOT_FOUND', '类别不存在：' + id);
      if (cat.builtin) throw StoreError('E_BUILTIN_LOCKED', '内置类别不可删除');
      var refCount = state.items.filter(function (it) { return it.categoryId === id; }).length;
      if (refCount > 0) {
        if (!moveTo) throw StoreError('E_CATEGORY_IN_USE', '该类别被 ' + refCount + ' 个事项引用，请先选择迁移目标', { refCount: refCount });
        var target = getCategory(moveTo);
        if (!target) throw StoreError('E_NOT_FOUND', '迁移目标类别不存在：' + moveTo);
        if (moveTo === id) throw StoreError('E_INVALID_TARGET', '迁移目标不能是自身');
      }
      mutate(function (draft) {
        if (refCount > 0) {
          draft.items.forEach(function (it, i) {
            if (it.categoryId === id) {
              draft.items[i] = Object.assign({}, it, { categoryId: moveTo, updatedAt: now() });
            }
          });
        }
        var i = findIndexById(draft.categories, id);
        draft.categories.splice(i, 1);
        compactStoreCategories(draft);
        if (draft.settings.defaultCategoryId === id) draft.settings.defaultCategoryId = moveTo || 'cat_short_task';
      });
      return true;
    }

    /**
     * 就地压实类别次序（迭代 4）：紧急恒首位且 order = -1，其余 order = 0..n-1。
     * 同时保证紧急在数组首位（数组顺序即渲染顺序）。
     */
    function compactStoreCategories(draft) {
      var urgent = null;
      var others = [];
      (draft.categories || []).forEach(function (c) {
        if (schema.isUrgentCategory(c)) {
          if (!urgent) urgent = c;
          return;
        }
        others.push(c);
      });
      others.forEach(function (c, k) { c.order = k; });
      if (urgent) {
        urgent.order = -1;
        urgent.builtin = true;
        urgent.special = 'urgent';
        draft.categories = [urgent].concat(others);
      } else {
        draft.categories = others;
      }
      return draft.categories;
    }

    /** 类别当前次序（DM-3：order 升序 → createdAt 升序 → id 字典序） */
    function orderedCategories(list) {
      return (list || []).slice().sort(function (a, b) {
        var oa = (typeof a.order === 'number' && isFinite(a.order)) ? a.order : 0;
        var ob = (typeof b.order === 'number' && isFinite(b.order)) ? b.order : 0;
        if (oa !== ob) return oa - ob;
        var ta = a.createdAt ? Date.parse(a.createdAt) : 0;
        var tb = b.createdAt ? Date.parse(b.createdAt) : 0;
        if (isNaN(ta)) ta = 0;
        if (isNaN(tb)) tb = 0;
        if (ta !== tb) return ta - tb;
        var ia = String(a.id || '');
        var ib = String(b.id || '');
        return ia < ib ? -1 : ia > ib ? 1 : 0;
      });
    }

    /**
     * 按给定 id 次序重排非紧急类别（2026-10-21：类别列表改为拖动排序）。
     * 与 reorderUntimed 同口径：orderedIds 可只覆盖子集，未出现的类别按原相对次序接在末尾；
     * 紧急永远固定在数组首位（即使 id 出现在参数里也不会被移动）。
     * 次序未变化时不写盘、不通知。
     * @param {string[]} orderedIds
     * @returns {boolean}
     */
    function reorderCategories(orderedIds) {
      var wanted = Array.isArray(orderedIds) ? orderedIds : [];
      var ordered = orderedCategories(state.categories);
      var urgent = null;
      var others = [];
      ordered.forEach(function (c) {
        if (schema.isUrgentCategory(c)) {
          if (!urgent) urgent = c;
          return;
        }
        others.push(c);
      });
      var rank = {};
      var next = 0;
      wanted.forEach(function (id) {
        if (typeof id === 'string' && !(id in rank)) { rank[id] = next; next += 1; }
      });
      others.forEach(function (c) { if (!(c.id in rank)) { rank[c.id] = next; next += 1; } });
      var desired = others.slice().sort(function (a, b) { return rank[a.id] - rank[b.id]; });
      var before = others.map(function (c) { return c.id; }).join('\n');
      var after = desired.map(function (c) { return c.id; }).join('\n');
      if (before === after) return true;

      mutate(function (draft) {
        var byId = {};
        orderedCategories(draft.categories).forEach(function (c) { byId[c.id] = c; });
        var list = [];
        desired.forEach(function (c) { if (byId[c.id]) list.push(byId[c.id]); });
        draft.categories = (urgent && byId[urgent.id] ? [byId[urgent.id]] : []).concat(list);
        compactStoreCategories(draft);
      });
      return true;
    }

    /**
     * 类别上移/下移（BR-19 / F-05）：与相邻项交换后压实。
     * 迭代 4（BR-37）：紧急恒首位——紧急自身不可移动，其它类别只能在「非紧急子序列」内移动，
     * 因此永远不会越过紧急。
     * i === j（已在边界）时**无操作**：不写盘、不通知。
     * @param {string} id
     * @param {number} delta -1 上移 / +1 下移
     * @returns {{moved:boolean, index:number}} index = 目标下标（无操作时为原下标，全数组口径）
     */
    function moveCategoryOrder(id, delta) {
      var d = (typeof delta === 'number' && isFinite(delta)) ? Math.round(delta) : 0;
      var ordered = orderedCategories(state.categories);
      var i = findIndexById(ordered, id);
      if (i < 0) throw StoreError('E_NOT_FOUND', '类别不存在：' + id);
      if (schema.isUrgentCategory(ordered[i])) return { moved: false, index: i }; // 恒首位，不可移动

      // 非紧急子序列内的目标下标（紧急不参与交换，保证恒首位）
      var movable = ordered.filter(function (c) { return !schema.isUrgentCategory(c); });
      var mi = findIndexById(movable, id);
      var mj = mi + d;
      if (mj < 0) mj = 0;
      if (mj > movable.length - 1) mj = movable.length - 1;
      if (mi === mj) return { moved: false, index: i };
      var targetId = movable[mj].id;
      var j = findIndexById(ordered, targetId);

      mutate(function (draft) {
        var list = orderedCategories(draft.categories);
        var byId = {};
        list.forEach(function (c) { byId[c.id] = c; });
        var ids = list.map(function (c) { return c.id; });
        var tmp = ids[i];
        ids[i] = ids[j];
        ids[j] = tmp;
        draft.categories = ids.map(function (cid) { return byId[cid]; });
        compactStoreCategories(draft);
      });
      return { moved: true, index: j };
    }

    // ---------------- 记录 ----------------

    function setNote(dateISO, text) {
      if (!dt.isValidDate(dateISO)) throw StoreError('E_INVALID_DATE', '非法日期：' + dateISO);
      var clean = text === null || text === undefined ? '' : String(text);
      mutate(function (draft) {
        if (clean.trim() === '') {
          if (draft.notes[dateISO]) delete draft.notes[dateISO];
          return;
        }
        draft.notes[dateISO] = { text: clean, updatedAt: now() };
      });
      return true;
    }

    function getNote(dateISO) {
      var n = state.notes[dateISO];
      return n ? n.text : '';
    }

    /** 该日期是否为周一（当周记录键，DM-8.1） */
    function isMonday(iso) {
      if (!dt.isValidDate(iso)) return false;
      if (typeof dt.isMonday === 'function') return !!dt.isMonday(iso);
      return dt.startOfWeek(iso) === iso;
    }

    /**
     * 写入当周记录（F-18.3 / BR-22）：键必须是该周周一；空文本删除键。
     * 与 notes 完全并列、互不覆盖。
     * @param {string} mondayISO
     * @param {string} text
     */
    function setWeekNote(mondayISO, text) {
      if (!dt.isValidDate(mondayISO)) throw StoreError('E_INVALID_DATE', '非法日期：' + mondayISO);
      if (!isMonday(mondayISO)) throw StoreError('E_NOT_MONDAY', '当周记录的键必须是周一：' + mondayISO);
      var clean = text === null || text === undefined ? '' : String(text);
      mutate(function (draft) {
        if (!schema.isPlainObject(draft.weekNotes)) draft.weekNotes = {};
        if (clean.trim() === '') {
          if (draft.weekNotes[mondayISO]) delete draft.weekNotes[mondayISO];
          return;
        }
        draft.weekNotes[mondayISO] = { text: clean, updatedAt: now() };
      });
      return true;
    }

    /** 读取当周记录（DM-8.1）；无记录返回 null */
    function getWeekNote(mondayISO) {
      if (!dt.isValidDate(mondayISO)) return null;
      var w = state.weekNotes ? state.weekNotes[mondayISO] : null;
      return w ? { text: w.text, updatedAt: w.updatedAt } : null;
    }

    // ---------------- 本月计划（2026-10-20 六轮 / F-05.2） ----------------

    /**
     * 读取某月的计划清单（按数组顺序 = 显示顺序）。
     * 与 items / notes / weekNotes 完全并列，**不会**产生任何事项，
     * 因此月计划天然「不同步到每天」。
     * @param {string} ym "YYYY-MM"
     * @returns {Array<{id:string,text:string,done:boolean,createdAt:string,updatedAt:string}>}
     */
    function getMonthPlan(ym) {
      if (!schema.isMonthKey(ym)) return [];
      var list = (state.monthPlans && state.monthPlans[ym]) || [];
      return list.map(function (e) {
        return { id: e.id, text: e.text, done: !!e.done, createdAt: e.createdAt, updatedAt: e.updatedAt };
      });
    }

    /** 追加一条月计划，返回新条目 id（空文本 / 超限抛错）。 */
    function addMonthPlanItem(ym, text) {
      if (!schema.isMonthKey(ym)) throw StoreError('E_INVALID_MONTH', '非法年月：' + ym);
      var clean = String(text === null || text === undefined ? '' : text).trim();
      if (!clean) throw StoreError('E_INVALID_TEXT', '计划内容不能为空');
      if (clean.length > schema.MONTH_PLAN_TEXT_MAX) clean = clean.slice(0, schema.MONTH_PLAN_TEXT_MAX);
      var stamp = now();
      var entry = { id: idgen.genericId('mp'), text: clean, done: false, createdAt: stamp, updatedAt: stamp };
      mutate(function (draft) {
        if (!schema.isPlainObject(draft.monthPlans)) draft.monthPlans = {};
        var list = Array.isArray(draft.monthPlans[ym]) ? draft.monthPlans[ym] : [];
        if (list.length >= schema.MONTH_PLAN_MAX) {
          throw StoreError('E_LIMIT', '单月最多 ' + schema.MONTH_PLAN_MAX + ' 条计划');
        }
        list.push(entry);
        draft.monthPlans[ym] = list;
      });
      return entry.id;
    }

    /** 修改某条月计划的文本（空文本抛错，删除请用 removeMonthPlanItem）。 */
    function updateMonthPlanItem(ym, id, text) {
      if (!schema.isMonthKey(ym)) throw StoreError('E_INVALID_MONTH', '非法年月：' + ym);
      var clean = String(text === null || text === undefined ? '' : text).trim();
      if (!clean) throw StoreError('E_INVALID_TEXT', '计划内容不能为空');
      if (clean.length > schema.MONTH_PLAN_TEXT_MAX) clean = clean.slice(0, schema.MONTH_PLAN_TEXT_MAX);
      mutate(function (draft) {
        var list = (draft.monthPlans && draft.monthPlans[ym]) || [];
        var target = null;
        for (var i = 0; i < list.length; i += 1) {
          if (list[i].id === id) { target = list[i]; break; }
        }
        if (!target) throw StoreError('E_NOT_FOUND', '计划不存在：' + id);
        target.text = clean;
        target.updatedAt = now();
      });
      return true;
    }

    /** 切换某条月计划的完成态（右键标记）；返回切换后的 done。 */
    function toggleMonthPlanItemDone(ym, id) {
      if (!schema.isMonthKey(ym)) throw StoreError('E_INVALID_MONTH', '非法年月：' + ym);
      var nextDone = false;
      mutate(function (draft) {
        var list = (draft.monthPlans && draft.monthPlans[ym]) || [];
        var target = null;
        for (var i = 0; i < list.length; i += 1) {
          if (list[i].id === id) { target = list[i]; break; }
        }
        if (!target) throw StoreError('E_NOT_FOUND', '计划不存在：' + id);
        target.done = !target.done;
        target.updatedAt = now();
        nextDone = target.done;
      });
      return nextDone;
    }

    /** 删除某条月计划；该月删空后移除键（与 notes 同口径）。 */
    function removeMonthPlanItem(ym, id) {
      if (!schema.isMonthKey(ym)) throw StoreError('E_INVALID_MONTH', '非法年月：' + ym);
      mutate(function (draft) {
        var list = (draft.monthPlans && draft.monthPlans[ym]) || [];
        var next = list.filter(function (e) { return e.id !== id; });
        if (next.length === list.length) throw StoreError('E_NOT_FOUND', '计划不存在：' + id);
        if (!next.length) delete draft.monthPlans[ym];
        else draft.monthPlans[ym] = next;
      });
      return true;
    }

    // ---------------- 设置 ----------------

    function updateSettings(patch) {
      patch = patch || {};
      // DM-10：pxPerHour 是 dayPxPerHour 的兼容字段；只给 pxPerHour 时按别名翻译
      var normalized = Object.assign({}, patch);
      if (normalized.pxPerHour !== undefined && normalized.dayPxPerHour === undefined) {
        normalized.dayPxPerHour = normalized.pxPerHour;
      }
      mutate(function (draft) {
        draft.settings = schema.mergeSettings(Object.assign({}, draft.settings, normalized));
      });
      return getState().settings;
    }

    // ---------------- 数据管理 ----------------

    function exportDocument() {
      return {
        app: schema.APP_NAME,
        schemaVersion: schema.SCHEMA_VERSION,
        exportedAt: now(),
        data: getState()
      };
    }

    function importDocument(payload, mode) {
      var backup = serialize();
      var result = schema.importInto(state, payload, mode);
      if (!result.ok) {
        return result; // 零写入
      }
      // 记录导入前快照
      try {
        storage.setItem(BACKUP_KEY, backup);
      } catch (e) { /* 快照失败不阻塞导入，但记录警告 */ }
      var sanitized = schema.sanitizeDocument(result.doc);
      state = sanitized.doc;
      commit(true);
      return { ok: true, warnings: (result.warnings || []).concat(sanitized.warnings), errors: [] };
    }

    /** 回退到上一次导入前 */
    function rollbackImport() {
      var raw = storage.getItem(BACKUP_KEY);
      if (!raw) return { ok: false, code: 'E_NO_BACKUP', errors: [{ path: '$', message: '没有可回退的导入前快照' }] };
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return { ok: false, code: 'E_PARSE', errors: [{ path: '$', message: '快照解析失败：' + e.message }] };
      }
      var s = schema.sanitizeDocument(parsed);
      state = s.doc;
      commit(true);
      return { ok: true, warnings: s.warnings, errors: [] };
    }

    /* ---------------- 数据作用域（Phase 1B 第一切片） ---------------- */

    function getScope() {
      return scope.kind === 'guest' ? K.guestScope() : K.userScope(scope.uid);
    }

    function getScopeId() {
      return K.scopeId(scope);
    }

    /** 启动解析诊断：是否发生过回落、写指针结果。 */
    function getScopeInfo() {
      return {
        scope: getScope(),
        id: K.scopeId(scope),
        repaired: !!(scopeInfo && scopeInfo.repaired),
        reason: scopeInfo ? scopeInfo.reason : 'explicit-scope',
        pointerWrite: scopeInfo ? scopeInfo.pointerWrite : null
      };
    }

    function scopeError(code, message, detail) {
      return StoreError(code, message, detail);
    }

    /**
     * 切换活动数据源（指针最后写；失败不改变内存状态与指针）。
     * 账号作用域必须已存在本地副本，且会话 uid 必须匹配——本函数绝不复制游客数据。
     *
     * @param {object|string} nextScope 作用域对象或 "guest" / "user:<uid>"
     * @param {{sessionUid?:string}} [opts]
     */
    function switchScope(nextScope, opts) {
      opts = opts || {};
      var target = normalizeScope(nextScope);
      if (K.scopeEquals(scope, target)) {
        return { ok: true, changed: false, scope: getScope(), id: K.scopeId(scope) };
      }
      if (K.isUserScope(target)) {
        var session = requireAccountSession(target.uid, opts);
        if (!session.ok) return session;
      }

      // 先把当前作用域的节流写入落盘，避免切换后丢失
      if (saveTimer) {
        var saved = saveNow();
        if (!saved.ok) {
          lastError = scopeError(saved.code || 'E_SAVE', '切换前保存失败：' + (saved.error || ''), saved);
          return { ok: false, code: lastError.code, message: lastError.message };
        }
      }

      var targetRead = scopeStorage.readScopeRecord(storage, target);
      if (!targetRead.ok) {
        lastError = scopeError(targetRead.code, targetRead.message, targetRead);
        return { ok: false, code: targetRead.code, message: targetRead.message };
      }
      if (!targetRead.exists && K.isUserScope(target)) {
        return { ok: false, code: 'E_ACCOUNT_COPY_MISSING', message: '账号本地副本不存在，不能切换（不得用游客数据代替）' };
      }

      var staged = targetRead.exists
        ? parseDocument(targetRead.raw, { backup: true })
        : { ok: true, doc: schema.createEmptyDocument(), warnings: [] };
      if (!staged.ok) {
        lastError = scopeError(staged.code || 'E_TARGET_INVALID', '目标作用域数据不可用', staged);
        return {
          ok: false, code: staged.code || 'E_TARGET_INVALID',
          message: '目标作用域数据不可用', errors: staged.errors || [], warnings: staged.warnings || []
        };
      }

      // 指针最后写；失败会自动恢复旧指针
      var pointer = scopeStorage.switchActiveScope(storage, target);
      if (!pointer.ok) {
        lastError = scopeError(pointer.code || 'E_POINTER_WRITE', '活动指针写入失败：' + (pointer.message || ''), pointer);
        return {
          ok: false, code: pointer.code || 'E_POINTER_WRITE',
          message: lastError.message, rolledBack: !!pointer.rolledBack
        };
      }

      scope = target;
      dbKey = K.dbKeyForScope(scope);
      seedKey = K.seedKeyForScope(scope);
      state = staged.doc;
      lastWarnings = (staged.warnings || []).slice();
      seeded = false;
      lastError = null;
      scopeInfo = { scope: scope, id: K.scopeId(scope), repaired: false, reason: 'switched', pointerWrite: { ok: true } };
      notify();
      return { ok: true, changed: true, scope: getScope(), id: K.scopeId(scope) };
    }

    /**
     * 账号操作的会话闸门：Store 会话与调用方提供的 uid 都是权威来源，
     * 任一与目标账号不符即拒绝；两者都没有则视为未登录。
     */
    function requireAccountSession(uid, opts) {
      var supplied = (opts && typeof opts.sessionUid === 'string') ? opts.sessionUid : null;
      if (sessionUid && supplied && sessionUid !== supplied) {
        return { ok: false, code: 'E_SCOPE_SESSION_MISMATCH', message: '调用方会话 uid 与 Store 会话不一致' };
      }
      var effectiveUid = sessionUid || supplied;
      if (!effectiveUid) {
        return { ok: false, code: 'E_SCOPE_NO_SESSION', message: '未登录时不能访问账号数据' };
      }
      if (effectiveUid !== uid) {
        return { ok: false, code: 'E_SCOPE_SESSION_MISMATCH', message: '会话 uid 与目标账号不一致' };
      }
      return { ok: true, uid: effectiveUid };
    }

    /**
     * 把候选文档持久化到指定账号副本（只写该账号键，不切换指针、不重建锚点）。
     * 这是同步层 G12 的本地落盘原语；本阶段不接任何远端。
     */
    function persistAccountCopy(uid, doc, opts) {
      opts = opts || {};
      var session = requireAccountSession(uid, opts);
      if (!session.ok) return session;
      var target = K.userScope(uid);
      var validation = schema.validateDocument(doc);
      if (!validation.ok) {
        return { ok: false, code: 'E_INVALID_DOC', message: '候选文档校验失败', errors: validation.errors };
      }
      var sanitized = schema.sanitizeDocument(doc);
      var raw = JSON.stringify(sanitized.doc);
      var before = scopeStorage.readScopeRecord(storage, target);
      var written = scopeStorage.writeScopeRecord(storage, target, raw);
      if (!written.ok) {
        var rolledBack = false;
        if (before.ok) {
          rolledBack = before.exists
            ? scopeStorage.writeScopeRecord(storage, target, before.raw).ok
            : scopeStorage.removeScopeRecord(storage, target).ok;
        }
        lastError = scopeError(written.code, '账号副本写入失败：' + (written.message || ''), written);
        return { ok: false, code: written.code, message: lastError.message, rolledBack: rolledBack };
      }
      return { ok: true, doc: sanitized.doc, warnings: sanitized.warnings, key: K.dbKeyForScope(target) };
    }

    /** 读取账号副本（只读，不改变活动作用域）。 */
    function readAccountCopy(uid, opts) {
      var session = requireAccountSession(uid, opts);
      if (!session.ok) return session;
      var target = K.userScope(uid);
      var rec = scopeStorage.readScopeRecord(storage, target);
      if (!rec.ok) return { ok: false, code: rec.code, message: rec.message };
      if (!rec.exists) return { ok: false, code: 'E_ACCOUNT_COPY_MISSING', message: '账号本地副本不存在' };
      var parsed = parseDocument(rec.raw, { backup: false });
      if (!parsed.ok) {
        return { ok: false, code: parsed.code || 'E_INVALID_DOC', message: '账号本地副本不可用', errors: parsed.errors || [] };
      }
      return { ok: true, doc: parsed.doc, warnings: parsed.warnings, key: rec.key };
    }

    function hasAccountCopy(uid) {
      return scopeStorage.hasScopeRecord(storage, K.userScope(uid));
    }

    /**
     * 清空当前活动作用域（F-12.3）。
     * - 只删除当前作用域数据键，并写当前作用域 seed 标记；
     * - 账号作用域先写合法 reset 记录；游客作用域不触碰任何账号同步记录（Q-14 / A-1）；
     * - 任一步失败都会恢复数据键与同步记录，内存文档保持不变。
     * @returns {boolean} 成功与否；失败原因见 getLastError()
     */
    function clearAll() {
      if (saveTimer) {
        var flushed = saveNow();
        if (!flushed.ok) {
          lastError = scopeError(flushed.code || 'E_SAVE', '清空前保存失败：' + (flushed.error || ''), flushed);
          return false;
        }
      }
      var result = scopeStorage.clearScope(storage, scope, { now: now() });
      if (!result.ok) {
        lastError = scopeError(result.code || 'E_CLEAR', result.message || '清空当前作用域失败', result);
        return false;
      }
      state = schema.createEmptyDocument();
      lastWarnings = [];
      seeded = false;
      lastError = null;
      commit(false);
      return true;
    }

    function getWarnings() {
      return lastWarnings.slice();
    }

    function getLastError() {
      return lastError;
    }

    function isStorageDegraded() {
      return storageDegraded || storage.degraded;
    }

    function isSeeded() {
      return seeded;
    }

    // ---------------- UI 状态（非关键，DM-11 / BR-16 / DM-16） ----------------

    var UI_VIEW_MODES = ['month', 'week', 'day'];
    var UI_EXPANDED_MAX = 200;
    var MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

    /** 归一 UI 状态：只保留合法形状，不注入缺失键（空状态必须仍是 {}） */
    function normalizeUIState(raw) {
      if (!schema.isPlainObject(raw)) return {};
      var out = {};
      Object.keys(raw).forEach(function (k) { out[k] = raw[k]; });
      if (out.viewMode !== undefined && UI_VIEW_MODES.indexOf(out.viewMode) === -1) delete out.viewMode;
      if (out.monthCenter !== undefined && !MONTH_RE.test(String(out.monthCenter))) delete out.monthCenter;
      if (out.weekStart !== undefined && !dt.isValidDate(out.weekStart)) delete out.weekStart;
      if (out.expanded !== undefined) {
        var expanded = {};
        if (schema.isPlainObject(out.expanded)) {
          Object.keys(out.expanded).forEach(function (k) {
            if (out.expanded[k] === true) expanded[k] = true;
          });
        }
        out.expanded = expanded;
      }
      if (out.expandedLRU !== undefined) {
        var lru = [];
        var seen = {};
        if (Array.isArray(out.expandedLRU)) {
          out.expandedLRU.forEach(function (k) {
            if (typeof k !== 'string' || !k || seen[k]) return;
            seen[k] = true;
            lru.push(k);
          });
        }
        while (lru.length > UI_EXPANDED_MAX) lru.shift();
        out.expandedLRU = lru;
      }
      return out;
    }

    function loadUIState() {
      try {
        var raw = storage.getItem(UI_KEY);
        if (!raw) return {};
        var parsed = JSON.parse(raw);
        return normalizeUIState(parsed);
      } catch (e) {
        return {};
      }
    }

    function saveUIState(patch) {
      var next = Object.assign(loadUIState(), normalizeUIState(patch));
      try {
        storage.setItem(UI_KEY, JSON.stringify(next));
      } catch (e) { /* 非关键状态，失败可忽略 */ }
      return next;
    }

    /** 该发生键是否处于展开态（BR-16：纯视图状态，不入库） */
    function isExpanded(key) {
      if (typeof key !== 'string' || !key) return false;
      var ui = loadUIState();
      return !!(schema.isPlainObject(ui.expanded) && ui.expanded[key] === true);
    }

    /**
     * 设置折叠状态；expanded 最多保留 200 项，expandedLRU 末位为最近使用。
     * @param {string} key 发生键（DM-5）
     * @param {boolean} on
     */
    function setExpanded(key, on) {
      if (typeof key !== 'string' || !key) return loadUIState();
      var ui = loadUIState();
      var expanded = schema.isPlainObject(ui.expanded) ? Object.assign({}, ui.expanded) : {};
      var lru = Array.isArray(ui.expandedLRU) ? ui.expandedLRU.slice() : [];
      if (on) {
        expanded[key] = true;
        lru = lru.filter(function (k) { return k !== key; });
        lru.push(key);
        while (lru.length > UI_EXPANDED_MAX) {
          var oldest = lru.shift();
          delete expanded[oldest];
        }
      } else {
        delete expanded[key];
        lru = lru.filter(function (k) { return k !== key; });
      }
      return saveUIState({ expanded: expanded, expandedLRU: lru });
    }

    return {
      // 生命周期
      load: load,
      saveNow: saveNow,
      flush: flush,
      hasPendingSave: hasPendingSave,
      subscribe: subscribe,
      getState: getState,
      reset: function () { state = schema.createEmptyDocument(); commit(true); },
      // 查询
      getItem: getItem,
      getCategory: getCategory,
      getNote: getNote,
      getWarnings: getWarnings,
      getLastError: getLastError,
      isStorageDegraded: isStorageDegraded,
      isSeeded: isSeeded,
      // 数据作用域（Phase 1B）
      getScope: getScope,
      getScopeId: getScopeId,
      getScopeInfo: getScopeInfo,
      switchScope: switchScope,
      persistAccountCopy: persistAccountCopy,
      readAccountCopy: readAccountCopy,
      hasAccountCopy: hasAccountCopy,
      // 事项
      addItem: addItem,
      updateItem: updateItem,
      removeItem: removeItem,
      addSeriesException: addSeriesException,
      removeSeriesException: removeSeriesException,
      hasNonUrgentOverride: hasNonUrgentOverride,
      splitSeriesAt: splitSeriesAt,
      moveItemOrder: moveItemOrder,
      reorderUntimed: reorderUntimed,
      toggleDone: toggleDone,
      toggleStarred: toggleStarred,
      // 紧急（迭代 4 / DM-18）
      toggleUrgent: toggleUrgent,
      effectiveUrgent: effectiveUrgent,
      // 类别
      addCategory: addCategory,
      updateCategory: updateCategory,
      removeCategory: removeCategory,
      moveCategoryOrder: moveCategoryOrder,
      reorderCategories: reorderCategories,
      // 记录
      setNote: setNote,
      setWeekNote: setWeekNote,
      getWeekNote: getWeekNote,
      // 本月计划（2026-10-20 六轮）
      getMonthPlan: getMonthPlan,
      addMonthPlanItem: addMonthPlanItem,
      updateMonthPlanItem: updateMonthPlanItem,
      toggleMonthPlanItemDone: toggleMonthPlanItemDone,
      removeMonthPlanItem: removeMonthPlanItem,
      // 设置
      updateSettings: updateSettings,
      // 数据
      exportDocument: exportDocument,
      importDocument: importDocument,
      rollbackImport: rollbackImport,
      clearAll: clearAll,
      // UI 状态
      loadUIState: loadUIState,
      saveUIState: saveUIState,
      isExpanded: isExpanded,
      setExpanded: setExpanded,
      // 常量（测试用）
      KEYS: {
        DB: DB_KEY, BACKUP: BACKUP_KEY, UI: UI_KEY, SEED: SEED_KEY,
        ACTIVE: K.KEYS.active, CORRUPT_PREFIX: CORRUPT_PREFIX
      }
    };
  }

  return {
    StoreError: StoreError,
    createStore: createStore,
    createStorage: createStorage,
    createMemoryStorage: createMemoryStorage,
    KEYS: {
      DB: DB_KEY, BACKUP: BACKUP_KEY, UI: UI_KEY, SEED: SEED_KEY,
      ACTIVE: K.KEYS.active, CORRUPT_PREFIX: CORRUPT_PREFIX
    },
    SAVE_THROTTLE_MS: SAVE_THROTTLE_MS
  };
});
