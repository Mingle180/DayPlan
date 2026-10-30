/**
 * DayPlan · 显示层配色（纸感墨色）
 *
 * 类别颜色统一由下面这 20 条色板决定，每条是 background / accent / text 三件套。
 * 类别数据里存的是 accent 色值（#rrggbb）；渲染时用 categoryTone(color) 取三件套，
 * 缺省 / 非法色值一律回落鼠尾草绿。
 *
 * 旧数据的类别色是 19 个高饱和 HEX（#dc2626 等）：categoryTone 按色相把它们
 * 就近归到某一条色板（存储值不动），界面里不会再出现荧光红 / 亮蓝。
 * 四个内置类别（紧急 / 长期目标 / 短期任务 / 临时活动）有固定归属，
 * 分别显示成干燥玫瑰 / 雾霾蓝 / 鼠尾草绿 / 陶土橘。
 * 中性色（灰 / 黑）按明度落到灰粉棕 / 咖啡奶棕 / 羊皮纸米。
 *
 * 组件只许引用这里的结果，不许再写死 HEX。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  function parseHex(hex) {
    if (typeof hex !== 'string' || hex.length !== 7 || hex.charAt(0) !== '#') return null;
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return null;
    return [r, g, b];
  }

  function rgbToHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  /**
   * 类别色板（20 色）：accent 是类别的身份色，background / text 供事项块与胶囊使用。
   * 色板顺序即设置页色块顺序（由绿到紫到粉到橘到中性）。
   */
  var EVENT_PALETTE = [
    { id: 'sage', name: '鼠尾草绿', background: '#E5EBDD', accent: '#819477', text: '#394A36' },
    { id: 'mint', name: '薄荷灰绿', background: '#E2EDE6', accent: '#7FAE98', text: '#365448' },
    { id: 'olive', name: '橄榄绿', background: '#E9EBD9', accent: '#929B65', text: '#4C5135' },
    { id: 'forest', name: '森林苔绿', background: '#E1E8DC', accent: '#718568', text: '#344532' },
    { id: 'mist-teal', name: '灰蓝绿', background: '#DFEAE9', accent: '#7C9F9D', text: '#365653' },
    { id: 'haze-blue', name: '雾霾蓝', background: '#E2EAF0', accent: '#819EB4', text: '#3E566B' },
    { id: 'denim', name: '牛仔蓝', background: '#E1E8EF', accent: '#7695B5', text: '#374F68' },
    { id: 'slate-violet', name: '灰紫蓝', background: '#E8E6EF', accent: '#958BAF', text: '#514763' },
    { id: 'lavender', name: '薰衣草紫', background: '#EEE7F0', accent: '#AD91B5', text: '#604B66' },
    { id: 'mauve-pink', name: '藕粉紫', background: '#F0E5EB', accent: '#BD91A8', text: '#65495A' },
    { id: 'dusty-rose', name: '干燥玫瑰', background: '#F1E2DF', accent: '#C58E86', text: '#68433D' },
    { id: 'bean-pink', name: '豆沙粉', background: '#F0E4E0', accent: '#C58D82', text: '#684840' },
    { id: 'terracotta', name: '陶土橘', background: '#F4E5D9', accent: '#D18B65', text: '#75482F' },
    { id: 'almond', name: '杏仁橘', background: '#F4E9D8', accent: '#D5A36C', text: '#73502D' },
    { id: 'honey', name: '蜂蜜黄', background: '#F3EBD5', accent: '#C5A35E', text: '#69542D' },
    { id: 'cream-yellow', name: '奶油黄', background: '#F5EEDB', accent: '#D0B779', text: '#6D5B34' },
    { id: 'caramel', name: '焦糖棕', background: '#EEE4D7', accent: '#B38A62', text: '#61452E' },
    { id: 'mocha', name: '咖啡奶棕', background: '#EDE5DC', accent: '#A88B73', text: '#594536' },
    { id: 'taupe', name: '灰粉棕', background: '#EBE5E1', accent: '#B09A8C', text: '#5C4A40' },
    { id: 'parchment', name: '羊皮纸米', background: '#F1EBDD', accent: '#B9A88A', text: '#5E5140' }
  ];
  var EVENT_DEFAULT_ID = 'sage';

  var SAGE = EVENT_PALETTE[0];
  var ACCENT_INDEX = {};
  var TONE_BY_ID = {};
  var ACCENT_HSL = [];
  EVENT_PALETTE.forEach(function (entry) {
    ACCENT_INDEX[entry.accent.toLowerCase()] = entry;
    TONE_BY_ID[entry.id] = entry;
    ACCENT_HSL.push({ entry: entry, hsl: rgbToHsl(parseHex(entry.accent)) });
  });

  /* 中性旧色（灰 / 黑）不按色相找：它们没有可靠的色相，落到这三条里明度最近的一条 */
  var NEUTRAL_IDS = { taupe: true, mocha: true, parchment: true };

  /* 四个内置类别的旧色值：语义上就是「红 / 蓝 / 绿 / 橘」，不交给色相就近去猜
     （#dc2626 色相为 0°，就近会被算成陶土橘）。存储值不动，只决定显示成哪一条。 */
  var LEGACY_TONE = {
    '#dc2626': 'dusty-rose',  /* 紧急 */
    '#7c3aed': 'haze-blue',   /* 长期目标 */
    '#2563eb': 'sage',        /* 短期任务 */
    '#ea580c': 'terracotta'   /* 临时活动 */
  };

  /**
   * 类别色值 -> 色板条目（background / accent / text）。
   * ① 正好是某条 accent：直接命中（含旧内置色的固定归属）；
   * ② 其它旧高饱和色：按色相就近；③ 非法 / 缺省：鼠尾草绿。
   * @param {string} hex
   * @returns {{id:string,name:string,background:string,accent:string,text:string}}
   */
  function categoryTone(hex) {
    var key = String(hex === null || hex === undefined ? '' : hex).toLowerCase();
    if (ACCENT_INDEX[key]) return ACCENT_INDEX[key];
    var forced = LEGACY_TONE[key];
    if (forced && TONE_BY_ID[forced]) return TONE_BY_ID[forced];
    var rgb = parseHex(key);
    if (!rgb) return SAGE;
    var hsl = rgbToHsl(rgb);
    var neutral = hsl[1] < 0.12 || hsl[2] < 0.28;
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < ACCENT_HSL.length; i += 1) {
      var entry = ACCENT_HSL[i].entry;
      if (neutral && !NEUTRAL_IDS[entry.id]) continue;
      var eh = ACCENT_HSL[i].hsl;
      var d;
      if (neutral) {
        d = Math.pow(hsl[2] - eh[2], 2);
      } else {
        var dh = Math.abs(hsl[0] - eh[0]);
        if (dh > 0.5) dh = 1 - dh;
        d = Math.pow(dh * 2, 2)
          + Math.pow((hsl[1] - eh[1]) * 0.4, 2)
          + Math.pow((hsl[2] - eh[2]) * 0.2, 2);
      }
      if (d < bestD) { bestD = d; best = entry; }
    }
    return best || SAGE;
  }

  root.DayPlan.palette = {
    EVENT_PALETTE: EVENT_PALETTE,
    EVENT_DEFAULT_ID: EVENT_DEFAULT_ID,
    categoryTone: categoryTone
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
