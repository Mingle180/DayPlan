/**
 * DayPlan · 通知提醒的纯函数（D34）
 *
 * 契约：docs/spec/19-notifications.md。
 * 只做「算时间 / 物化提醒行 / 生成稳定签名」，不碰 DOM、不碰网络、不碰存储。
 *
 * 时间口径：
 *   · 文档里存的是本地墙钟（YYYY-MM-DD + HH:mm / YYYY-MM-DDTHH:mm）；
 *   · 云端 reminders.fire_at 存 UTC ISO 字符串，由本机时区换算得出；
 *   · 设备换时区后，下一次打开或保存会按新时区重算并覆盖（旧时区期间保持原值）。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(
    isNode ? require('./datetime.js') : root.DayPlan.datetime,
    isNode ? require('./recurrence.js') : root.DayPlan.recurrence,
    isNode ? require('./schema.js') : root.DayPlan.schema
  );
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.reminder = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dt, recurrence, schema) {
  'use strict';

  var HORIZON_DAYS = 60;   /* 重复事项向后物化的天数 */
  var LOOKBACK_DAYS = 7;   /* 已过去的提醒仍保留，供「设为已过点」时立即补发一次 */
  var DAY_MS = 24 * 60 * 60 * 1000;
  var MINUTE_MS = 60 * 1000;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function localDateISO(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** "YYYY-MM-DD" + "HH:mm" → 本地墙钟毫秒；非法返回 null */
  function localMs(dateISO, time) {
    if (!dt || !dt.isValidDate(dateISO) || !dt.isValidTime(time)) return null;
    var ymd = dateISO.split('-');
    var hm = time.split(':');
    var d = new Date(Number(ymd[0]), Number(ymd[1]) - 1, Number(ymd[2]),
      Number(hm[0]), Number(hm[1]), 0, 0);
    var t = d.getTime();
    return isFinite(t) ? t : null;
  }

  /** 倒计时目标 "YYYY-MM-DDTHH:mm" → 本地墙钟毫秒；非法返回 null */
  function targetMs(targetAt) {
    if (typeof targetAt !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(targetAt);
    if (!m) return null;
    return localMs(m[1] + '-' + m[2] + '-' + m[3], m[4] + ':' + m[5]);
  }

  function normalize(value) {
    return schema && typeof schema.normalizeReminder === 'function'
      ? schema.normalizeReminder(value)
      : null;
  }

  function splitOffset(minutes) {
    var n = Number(minutes);
    if (!isFinite(n) || n < 0) n = 0;
    n = Math.floor(n);
    return {
      days: Math.floor(n / 1440),
      hours: Math.floor((n % 1440) / 60),
      minutes: n % 60
    };
  }

  /**
   * 天 / 时 / 分 → 分钟。任一项非法或为负返回 null；总时长超过上限时夹到上限。
   * 空字符串按 0 处理（用户只填「天」时其余两格留空是常态）。
   */
  function combineOffset(days, hours, minutes) {
    var parts = [days, hours, minutes];
    var nums = [];
    for (var i = 0; i < parts.length; i += 1) {
      var raw = parts[i];
      if (raw === '' || raw === null || raw === undefined) { nums.push(0); continue; }
      var n = Number(raw);
      if (!isFinite(n) || n < 0 || Math.floor(n) !== n) return null;
      nums.push(n);
    }
    var total = nums[0] * 1440 + nums[1] * 60 + nums[2];
    var max = schema && typeof schema.REMINDER_OFFSET_MAX === 'number'
      ? schema.REMINDER_OFFSET_MAX : 525600;
    if (total > max) total = max;
    return total;
  }

  /** 某次发生的提醒时刻（UTC ISO） */
  function fireAtISO(dateISO, time, offsetMinutes) {
    var base = localMs(dateISO, time);
    if (base === null) return null;
    var off = Number(offsetMinutes);
    if (!isFinite(off) || off < 0) off = 0;
    return new Date(base - off * MINUTE_MS).toISOString();
  }

  /** 倒计时的提醒时刻（UTC ISO） */
  function countdownFireAtISO(targetAt, offsetMinutes) {
    var base = targetMs(targetAt);
    if (base === null) return null;
    var off = Number(offsetMinutes);
    if (!isFinite(off) || off < 0) off = 0;
    return new Date(base - off * MINUTE_MS).toISOString();
  }

  /** 物化后的本地展示文案：「11月3日 08:30」；跨年时带年份。 */
  function formatFireAt(iso, nowMs) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var d = new Date(t);
    var now = new Date(isFinite(nowMs) ? nowMs : Date.now());
    var head = (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + '年' : '')
      + (d.getMonth() + 1) + '月' + d.getDate() + '日 ';
    return head + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 「提前 1 天 2 小时」「准时」——表单里的一行说明。 */
  function offsetLabel(offsetMinutes) {
    var n = Math.floor(Number(offsetMinutes));
    if (!isFinite(n) || n <= 0) return '准时提醒';
    var s = splitOffset(n);
    var parts = [];
    if (s.days) parts.push(s.days + ' 天');
    if (s.hours) parts.push(s.hours + ' 小时');
    if (s.minutes) parts.push(s.minutes + ' 分钟');
    return '提前 ' + parts.join(' ') + ' 提醒';
  }

  function pushRow(out, seen, row) {
    var key = row.sourceKind + '|' + row.sourceId + '|' + row.occurrenceKey;
    if (seen[key]) return;
    seen[key] = true;
    out.push(row);
  }

  /**
   * 把文档里所有开启提醒的事项 / 倒计时展开成提醒行。
   *
   * @param {object} doc
   * @param {{nowMs?:number, horizonDays?:number, lookbackDays?:number}} [opts]
   * @returns {Array<{sourceKind:string, sourceId:string, occurrenceKey:string,
   *                  fireAt:string, title:string, fireAtMs:number}>}
   *
   * 规则：
   *   · 未设置时间的事项、已完成的事项 / 发生、已删除的重复发生都不产生提醒；
   *   · 重复事项按 60 天窗口展开；提前量超过窗口的多出来的天也补足；
   *   · fireAt 落在 [now - 7 天, now + 60 天] 之外的行不物化（历史行不反复制造）。
   */
  function materialize(doc, opts) {
    opts = opts || {};
    doc = doc || {};
    var nowMs = isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    var horizonDays = isFinite(opts.horizonDays) ? opts.horizonDays : HORIZON_DAYS;
    var lookbackDays = isFinite(opts.lookbackDays) ? opts.lookbackDays : LOOKBACK_DAYS;
    var horizonEnd = nowMs + horizonDays * DAY_MS;
    var windowStart = nowMs - lookbackDays * DAY_MS;
    var out = [];
    var seen = {};

    function inWindow(ms) {
      return ms !== null && isFinite(ms) && ms >= windowStart && ms <= horizonEnd;
    }

    var items = Array.isArray(doc.items) ? doc.items : [];
    items.forEach(function (it) {
      if (!it || it.done === true) return;
      var rem = normalize(it.reminder);
      if (!rem || !it.time || !it.time.start) return;
      if (it.kind === 'single') {
        var fire = localMs(it.date, it.time.start);
        if (fire === null) return;
        var fireMs = fire - rem.offsetMinutes * MINUTE_MS;
        if (!inWindow(fireMs)) return;
        pushRow(out, seen, {
          sourceKind: 'item',
          sourceId: it.id,
          occurrenceKey: '',
          fireAt: new Date(fireMs).toISOString(),
          fireAtMs: fireMs,
          title: it.title
        });
        return;
      }
      if (it.kind !== 'series' || !recurrence) return;
      var extraDays = Math.ceil(rem.offsetMinutes / 1440);
      var from = localDateISO(windowStart);
      var to = localDateISO(horizonEnd + extraDays * DAY_MS + DAY_MS);
      var expanded;
      try {
        expanded = recurrence.expandSeries(it, { from: from, to: to });
      } catch (e) {
        return;
      }
      expanded.occurrences.forEach(function (occ) {
        if (!occ || occ.done === true || !occ.time || !occ.time.start) return;
        var base = localMs(occ.date, occ.time.start);
        if (base === null) return;
        var ms = base - rem.offsetMinutes * MINUTE_MS;
        if (!inWindow(ms)) return;
        pushRow(out, seen, {
          sourceKind: 'item',
          sourceId: it.id,
          occurrenceKey: occ.date,
          fireAt: new Date(ms).toISOString(),
          fireAtMs: ms,
          title: occ.title
        });
      });
    });

    var countdowns = Array.isArray(doc.countdowns) ? doc.countdowns : [];
    countdowns.forEach(function (cd) {
      if (!cd || !cd.id) return;
      var rem = normalize(cd.reminder);
      if (!rem) return;
      var base = targetMs(cd.targetAt);
      if (base === null) return;
      var ms = base - rem.offsetMinutes * MINUTE_MS;
      if (!inWindow(ms)) return;
      pushRow(out, seen, {
        sourceKind: 'countdown',
        sourceId: cd.id,
        occurrenceKey: '',
        fireAt: new Date(ms).toISOString(),
        fireAtMs: ms,
        title: cd.title
      });
    });

    out.sort(function (a, b) { return a.fireAtMs - b.fireAtMs; });
    return out;
  }

  /** 稳定签名：只包含同步需要的字段，避免 title 之外的无端重写。 */
  function signature(rows) {
    var list = Array.isArray(rows) ? rows : [];
    return list.map(function (r) {
      return [r.sourceKind, r.sourceId, r.occurrenceKey, r.fireAt, r.title].join('\u0001');
    }).join('\u0002');
  }

  /** 下一次到期的提醒（本地兜底只用这一个 setTimeout 武装）。 */
  function nextDue(rows, nowMs) {
    var now = isFinite(nowMs) ? nowMs : Date.now();
    var list = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].fireAtMs >= now) return list[i];
    }
    return null;
  }

  return {
    HORIZON_DAYS: HORIZON_DAYS,
    LOOKBACK_DAYS: LOOKBACK_DAYS,
    localDateISO: localDateISO,
    localMs: localMs,
    targetMs: targetMs,
    normalize: normalize,
    splitOffset: splitOffset,
    combineOffset: combineOffset,
    fireAtISO: fireAtISO,
    countdownFireAtISO: countdownFireAtISO,
    formatFireAt: formatFireAt,
    offsetLabel: offsetLabel,
    materialize: materialize,
    signature: signature,
    nextDue: nextDue
  };
});
