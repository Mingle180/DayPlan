/**
 * DayPlan · 演示数据（F-12 / DM-14）
 *
 * 首次运行（主键不存在且未标记已清空）时注入一次，包含用户提出的两个重复场景：
 *   1) 2026–2100 每年农历八月初六
 *   2) 2026-09-01 起至 2027-02-01（不含）每周一 08:00–10:00
 * 固定 id 便于测试断言与幂等清理。
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports;
  var api = factory(isNode ? require('./datetime.js') : root.DayPlan.datetime);
  if (isNode) {
    module.exports = api;
  } else {
    root.DayPlan = root.DayPlan || {};
    root.DayPlan.seed = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (dt) {
  'use strict';

  var IDS = {
    focus: 'itm_demo_focus',
    errand: 'itm_demo_errand',
    lunar: 'itm_demo_lunar',
    weekly: 'itm_demo_weekly'
  };

  /**
   * 生成演示文档。
   * @param {string} [todayISO] 注入时的"当天"，缺省取本地今天
   */
  function createDemoDocument(todayISO) {
    var today = todayISO && dt.isValidDate(todayISO) ? todayISO : dt.todayISO();
    var now = new Date().toISOString();

    return {
      /* D8（2026-10-26）：v4 必备顶层字段。seed 不依赖 schema.js（避免多一条 UMD 依赖链），
         因此这里写字面量；`seed` 用例里有一条「演示文档版本 === SCHEMA_VERSION」的守护断言，
         两边漂移会立刻判红。D9（2026-10-27）随 SCHEMA_VERSION 升到 5。 */
      schemaVersion: 5,
      app: 'DayPlan',
      meta: { createdAt: now, updatedAt: now, app: 'DayPlan' },
      categories: [
        // 迭代 4（DM-18.1）：紧急内置特殊类别，恒首位（order = -1）
        { id: 'urgent', name: '紧急', color: '#dc2626', builtin: true, special: 'urgent', order: -1, createdAt: now },
        { id: 'cat_long_term', name: '长期目标', color: '#7c3aed', builtin: true, order: 0 },
        { id: 'cat_short_task', name: '短期任务', color: '#2563eb', builtin: true, order: 1 },
        { id: 'cat_temp_event', name: '临时活动', color: '#ea580c', builtin: true, order: 2 }
      ],
      items: [
        {
          id: IDS.focus,
          kind: 'single',
          title: '示例：专注工作块',
          categoryId: 'cat_short_task',
          date: today,
          time: { start: '09:00', end: '10:30' },
          note: '这是一条带时段的事项，显示在时间轴上方。点击它可以看到详情或修改。',
          done: false,
          starred: false,
          order: 0,
          createdAt: now,
          updatedAt: now
        },
        {
          id: IDS.errand,
          kind: 'single',
          title: '示例：买咖啡豆',
          categoryId: 'cat_temp_event',
          date: today,
          time: null,
          note: '这是一条未设时段的事项，显示在时间轴下方，可直接拖动调整次序。',
          done: false,
          starred: false,
          order: 1,
          createdAt: now,
          updatedAt: now
        },
        {
          id: IDS.lunar,
          kind: 'series',
          title: '示例：每年八月初六纪念日',
          categoryId: 'cat_long_term',
          time: null,
          note: '农历重复：2026–2100 年每年农历八月初六。2026 年为公历 2026-09-16。',
          done: false,
          starred: false,
          order: 2,
          repeat: {
            type: 'lunarYearly',
            startDate: '2026-01-01',
            endDate: '2101-01-01',
            lunarMonth: 8,
            lunarDay: 6,
            leap: false
          },
          exceptions: {},
          createdAt: now,
          updatedAt: now
        },
        {
          id: IDS.weekly,
          kind: 'series',
          title: '示例：周一晨间学习',
          categoryId: 'cat_short_task',
          time: { start: '08:00', end: '10:00' },
          note: '公历有限区间重复：2026 年 9 月至 2027 年 1 月，每周一 08:00–10:00。',
          done: false,
          starred: false,
          order: 3,
          repeat: {
            type: 'weekly',
            startDate: '2026-09-01',
            endDate: '2027-02-01',
            interval: 1,
            weekdays: [1]
          },
          exceptions: {},
          createdAt: now,
          updatedAt: now
        }
      ],
      notes: (function () {
        var n = {};
        n[today] = {
          text: '这是示例记录，可直接改成你的心得。切换日期后内容会各自保留。',
          updatedAt: now
        };
        return n;
      })(),
      weekNotes: {},
      /* D8：v4 必备顶层字段。演示数据不预置倒计时（不替用户决定"什么算截止"），
         但字段必须存在——否则演示文档是"形状不合规的 v4"。 */
      countdowns: [],
      /* D9（2026-10-27）：v5 必备顶层字段。演示文档不预置完成台条目，字段必须存在。 */
      finishDock: [],
      settings: {
        // DM-10：演示数据显式保留迭代 2 的 60px/h 观感（避免 SM-07 的 540px 断言漂移）
        dayPxPerHour: 60,
        pxPerHour: 60,
        weekPxPerHour: 56,
        idleCompressHeight: 26,
        idleCompressEnabled: true,
        timelineStartHour: 0,
        timelineEndHour: 24,
        showLunarInCalendar: true,
        showNoteMarker: true,
        showHolidayMarker: true,
        maxLanes: 3,
        defaultCategoryId: 'cat_short_task',
        weekStartsOn: 1
      }
    };
  }

  /* ---------------- 原封演示内容判定（D9.2，2026-10-27） ----------------
   * 用途：同步四象限 C（两边都有内容）里的一种特例——新设备首次启动注入的就是
   * 这份演示数据，云端才是账号真数据。此时弹「两边都有内容」是在拿演示数据
   * 冒充用户数据吓人；判定为「原封演示」时界面可以放心地自动以云端为准。
   *
   * 判据刻意**结构化**而不是哈希比对：演示文档带首次启动的时刻戳，每次注入
   * 都不同，哈希法需要对齐基准反而脆。全部满足才算：
   *   ① 事项 id 全部 ∈ 演示固定 id（用户造不出这些 id；空数组也算过——等于用户清空了）
   *   ② 类别 id 全部 ∈ 演示四个内置（用户删过某个内置也仍算，删除不构成要保留的数据）
   *   ③ 日记录只含演示原文（改过一个字就不算）
   *   ④ weekNotes / monthPlans / countdowns / finishDock 全空
   * settings 不参与（不同步，演示档只是观感参数）。 */

  var DEMO_NOTE_TEXT = '这是示例记录，可直接改成你的心得。切换日期后内容会各自保留。';
  var DEMO_ITEM_IDS = [IDS.focus, IDS.errand, IDS.lunar, IDS.weekly];
  var DEMO_CATEGORY_IDS = ['urgent', 'cat_long_term', 'cat_short_task', 'cat_temp_event'];

  function idIn(id, list) {
    return typeof id === 'string' && list.indexOf(id) !== -1;
  }

  function isEmptyish(v) {
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') {
      for (var k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k)) return false;
      }
      return true;
    }
    return false;
  }

  function isPristineDemoDoc(doc) {
    if (!doc || typeof doc !== 'object') return false;

    var items = Array.isArray(doc.items) ? doc.items : [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !idIn(it.id, DEMO_ITEM_IDS)) return false;
    }

    var cats = Array.isArray(doc.categories) ? doc.categories : [];
    for (var j = 0; j < cats.length; j++) {
      var c = cats[j];
      if (!c || !idIn(c.id, DEMO_CATEGORY_IDS)) return false;
    }

    var notes = doc.notes;
    if (notes !== undefined && notes !== null) {
      if (typeof notes !== 'object' || Array.isArray(notes)) return false;
      for (var key in notes) {
        if (!Object.prototype.hasOwnProperty.call(notes, key)) continue;
        var n = notes[key];
        if (!n || typeof n.text !== 'string' || n.text !== DEMO_NOTE_TEXT) return false;
      }
    }

    return isEmptyish(doc.weekNotes)
      && isEmptyish(doc.monthPlans)
      && isEmptyish(doc.countdowns)
      && isEmptyish(doc.finishDock);
  }

  return {
    IDS: IDS,
    createDemoDocument: createDemoDocument,
    isPristineDemoDoc: isPristineDemoDoc
  };
});
