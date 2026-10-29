/**
 * DayPlan · 本机「上次保存到云端」标记（纯函数，无 DOM / 存储 / 网络依赖）
 *
 * 存在 `dayplan.cloud.v1.<uid>`，只描述**这台设备自己**看到的云端版本：
 *   { revision, savedAt, device, hash, declinedRevision }
 *
 * 判定的唯一问题是：本机内容相对上次成功保存/载入的那份有没有改动。
 *   · clean   —— 内容一致，可以静默用云端覆盖本机
 *   · pending —— 有未上传改动，打开时问一次（或用户点保存）
 *   · unknown —— 没有标记（首次登录本设备 / 存储被清），按 pending 对待
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.cloudRecord = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var KIND = { CLEAN: 'clean', PENDING: 'pending', UNKNOWN: 'unknown' };

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function numOrNull(v) {
    return typeof v === 'number' && isFinite(v) ? Math.floor(v) : null;
  }

  function strOrNull(v) {
    return typeof v === 'string' && v !== '' ? v : null;
  }

  /** 读回标记：坏形状一律当没有（返回 null），让调用方按 unknown 处理。 */
  function parseRecord(raw) {
    var value = raw;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (e) { return null; }
    }
    if (!isPlainObject(value)) return null;
    if (typeof value.hash !== 'string' || value.hash === '') return null;
    return {
      revision: numOrNull(value.revision),
      savedAt: strOrNull(value.savedAt),
      device: strOrNull(value.device),
      hash: value.hash,
      declinedRevision: numOrNull(value.declinedRevision)
    };
  }

  /** 写入前收口：只保留约定字段，未知字段不落盘。 */
  function serializeRecord(record) {
    if (!isPlainObject(record) || typeof record.hash !== 'string' || record.hash === '') return null;
    var out = {
      revision: numOrNull(record.revision),
      savedAt: strOrNull(record.savedAt),
      device: strOrNull(record.device),
      hash: record.hash
    };
    var declined = numOrNull(record.declinedRevision);
    if (declined !== null) out.declinedRevision = declined;
    return out;
  }

  /**
   * @param {object|null} record parseRecord 的结果
   * @param {string} localHash 本机当前内容的指纹
   * @returns {'clean'|'pending'|'unknown'}
   */
  function classify(record, localHash) {
    if (!record || typeof record.hash !== 'string' || !record.hash) return KIND.UNKNOWN;
    if (typeof localHash !== 'string' || !localHash) return KIND.UNKNOWN;
    return record.hash === localHash ? KIND.CLEAN : KIND.PENDING;
  }

  /** 用户选择了「保留本机」：同一云端版本不再重复询问。 */
  function isDeclined(record, revision) {
    return !!record && typeof revision === 'number' && record.declinedRevision === revision;
  }  function withDeclined(record, revision) {
    if (!record) return null;
    var next = serializeRecord(record);
    if (!next || typeof revision !== 'number') return next;
    next.declinedRevision = revision;
    return next;
  }

  /** 把 ISO 字符串换成毫秒；空 / 坏值返回 null（不猜）。 */
  function timeOf(iso) {
    if (typeof iso !== 'string' || !iso) return null;
    var t = Date.parse(iso);
    return isNaN(t) ? null : t;
  }

  /**
   * 本机这份和云端那份，谁的最后编辑时间更晚。
   *   'local'   —— 本机不比云端旧：本机改动发生在云端保存之后，不该问「载入云端」
   *   'cloud'   —— 云端确实更新：打开时才需要问一句
   *   'unknown' —— 任一侧没有可用的时间戳（老数据 / 时钟异常）→ 交给调用方按原逻辑处理
   *
   * 云端时间取 `schedule_data.updatedAt`（拍下这份内容那台设备的编辑时刻），
   * 取不到才退回行的写入时间 `updated_at` —— 后者是服务器落库时刻，只作兜底。
   */
  function newerSide(localDoc, row) {
    var localAt = timeOf(localDoc && localDoc.meta && localDoc.meta.updatedAt);
    var data = row && row.schedule_data;
    var cloudAt = timeOf(data && data.updatedAt);
    if (cloudAt === null) cloudAt = timeOf(row && row.updated_at);
    if (localAt === null || cloudAt === null) return 'unknown';
    return localAt >= cloudAt ? 'local' : 'cloud';
  }

  /** 从 UA 取一个短标签给版本列表用；不追求精确，只求两端能区分。 */
  function deviceLabel(ua) {
    var s = String(ua || '');
    var platform = /Windows NT/i.test(s) ? 'Windows'
      : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
        : /Android/i.test(s) ? 'Android'
          : /Mac OS X|Macintosh/i.test(s) ? 'macOS'
            : /Linux/i.test(s) ? 'Linux'
              : '';
    var browser = /Edg\//i.test(s) ? 'Edge'
      : /Firefox\//i.test(s) ? 'Firefox'
        : /Chrome\//i.test(s) ? 'Chrome'
          : /Safari\//i.test(s) ? 'Safari'
            : '';
    var label = [browser, platform].filter(function (x) { return !!x; }).join(' · ');
    return label || '未知设备';
  }

  return {
    KIND: KIND,
    parseRecord: parseRecord,
    serializeRecord: serializeRecord,
    classify: classify,
    isDeclined: isDeclined,
    withDeclined: withDeclined,
    newerSide: newerSide,
    deviceLabel: deviceLabel
  };
});
