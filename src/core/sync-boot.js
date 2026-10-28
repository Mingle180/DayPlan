/**
 * DayPlan · 启动分类（纯函数，无 DOM / 存储 / 网络依赖）
 *
 * 契约：docs/spec/13-sync-contract.md §1.9（真值表）、§4.4（启动恢复）、
 *       §4.7（保守恢复）、§2.1（历史标记）。
 *
 * 这一层只回答一个问题：**这次启动该走哪条路**。它不读云端、不写任何键，
 * 只看磁盘上已有的两样东西——同步记录与历史标记。
 *
 * 优先级（顺序即契约，不能按「看起来更严重」重排）：
 *   1 合法 reset            → signed-in      重开前不发请求，**绝不进 §4.7**
 *   2 有效 active           → checking       交四象限
 *   3 有效 closed           → signed-in      不自动请求
 *   4 无记录、无历史标记     → first-sync    走 §4.2，可能是 A/A′/B/C/D
 *   5 记录缺失 + 历史标记在  → recovery      曾同步过，保守恢复（§4.7）
 *   6 记录存在但不可用       → recovery      解析失败 / v≠3 / 字段组合非法 /
 *                                           hashMethod 不受支持（不要求历史标记）
 *   7 非对象（数组 / 数字）   → first-sync    按「记录已损坏、视同没有」处理（Q-30）
 *
 * 为什么 reset 排在历史标记前面：历史标记只说明「曾经同步过」，它不描述
 * 「现在还想不想同步」。用户清空本机或删掉云端之后，历史标记依然存在，
 * 若让它反客为主，用户每次重开同步都会被弹一次「记录损坏，请选保留哪边」。
 *
 * 为什么 5/6 不能降级成 first-sync：首次同步的 C 情况允许「以本机为准」覆盖
 * 云端。记录都丢了，谁也不知道上次同步到哪一步，此时唯一安全的做法是停下来。
 *
 * Q-30（2026-10-27 已裁定）：非对象记录（`[1,2]`、`42`、`"active"`）既不是
 * 「解析失败」也不是「字段组合非法」，§1.9 表里没有专门一行。裁定为**视同记录
 * 损坏、按首次同步处理**，而不是进 paused-error：
 *   坏记录里一个可用字段都没留下，任何「基于记录判断哪边更新」的方案都只能猜，
 *   而 paused-error 只给「导出 + 重新登录」，重登不重写记录，等于没有出口；
 *   本机数据与云端数据其实都还在，让用户重新走一次首次同步是唯一能同时保住两边的路。
 * 代价：两端都有内容时会落到 §4.2 的 C 情况，其「覆盖前先导出」的确认由界面把关。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(isNode ? require('./sync-record.js') : root.DayPlan.syncRecord);
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.syncBoot = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (R) {
  'use strict';

  /**
   * Q-30 裁定后，`blocked` **不再由任何输入产出**（非对象记录改判 first-sync）。
   * 但引擎 / 界面里到处都有「boot.kind 是 blocked 就停」的防御分支，保留这个
   * 枚举值可以让那些分支继续成立——将来真出现「既非有效记录也非损坏」的形态时，
   * 只需在这里加一行映射，不必再去补一遍下游。
   */
  var KINDS = {
    reset: 'reset',
    active: 'active',
    closed: 'closed',
    firstSync: 'first-sync',
    recovery: 'recovery',
    blocked: 'blocked'
  };

  /** kind → 引擎状态。集中在一处，避免每个调用方各自解释 kind。 */
  var MAP = {
    'reset': { engineState: 'signed-in', needsCheck: false },
    'active': { engineState: 'checking', needsCheck: true },
    'closed': { engineState: 'signed-in', needsCheck: false },
    'first-sync': { engineState: 'signed-in', needsCheck: false },
    'recovery': { engineState: 'checking', needsCheck: true },
    'blocked': { engineState: 'paused-error', needsCheck: false }
  };

  /** 历史标记：存在性（存储意义）与可用性（形状意义）分开报告。 */
  function inspectHistory(raw) {
    var present = raw !== undefined && raw !== null && raw !== '';
    if (!present) return { present: false, usable: false, status: 'missing' };
    var parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return { present: true, usable: false, status: 'unparseable' };
      }
    }
    var v = R.validateHistoryMarker(parsed);
    return { present: true, usable: !!v.ok, status: v.ok ? 'ok' : 'invalid' };
  }

  function out(kind, reason, detail) {
    var m = MAP[kind];
    return {
      kind: kind,
      engineState: m.engineState,
      needsCheck: m.needsCheck,
      reason: reason,
      detail: detail || {}
    };
  }

  /**
   * @param {{record:(*|undefined), history:(*|undefined)}} input
   *        `record` / `history` 是**存储里的原始值**（对象或 JSON 字符串均可）。
   * @returns {{kind:string, engineState:string, needsCheck:boolean, reason:string,
   *            detail:{recordStatus:string, historyPresent:boolean,
   *                    historyUsable:boolean, historyStatus:string, disputed:boolean}}}
   */
  function classifyBoot(input) {
    input = input || {};
    var parsed = R.parseSyncRecord(input.record);
    var hist = inspectHistory(input.history);
    var detail = {
      recordStatus: parsed.status,
      historyPresent: hist.present,
      historyUsable: hist.usable,
      historyStatus: hist.status,
      disputed: !!parsed.disputed
    };

    /* 1–3：记录本身可用时，历史标记完全不参与判定（§1.9、§2.1）。 */
    if (parsed.ok) {
      if (parsed.state === 'reset') return out(KINDS.reset, 'reset-record', detail);      // 1
      if (parsed.state === 'active') return out(KINDS.active, 'active-record', detail);   // 2
      if (parsed.state === 'closed') return out(KINDS.closed, 'closed-record', detail);   // 3
    }

    /* 4：什么都没留下 —— 真正的「从未同步」。 */
    if (parsed.status === 'missing' && !hist.present) {
      return out(KINDS.firstSync, 'no-record-no-history', detail);
    }

    /* 5：记录键不见了，但历史标记证明曾经同步过。 */
    if (parsed.status === 'missing' && hist.present) {
      return out(KINDS.recovery, 'record-missing-history-present', detail);
    }

    /* 6：记录在，但没法用。不要求历史标记存在。 */
    if (parsed.record !== null || parsed.status === 'unparseable') {
      return out(KINDS.recovery, 'record-unusable', detail);
    }

    /* 7：非对象（数组 / 数字 / 字符串）。Q-30 裁定：视同「这条记录已经没了」。
       不是「无法判定」——坏记录里没有任何字段可供判定，继续追问只会把人困住。 */
    return out(KINDS.firstSync, 'record-not-object', detail);
  }

  return {
    KINDS: KINDS,
    classifyBoot: classifyBoot
  };
});
