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
      schemaVersion: 3,
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

  return {
    IDS: IDS,
    createDemoDocument: createDemoDocument
  };
});
