# DayPlan

DayPlan 是一个离线优先的个人日程应用，提供日 / 周 / 月三种视图、农历与节假日标记、重复事项和本地数据存储。

## 在线访问

https://mingle180.github.io/DayPlan/

`main` 分支根目录直接由 GitHub Pages 发布，无需构建步骤。

## 本地运行

双击 `index.html` 即可运行，无需服务器、构建或第三方运行时。

## 目录

```
index.html          网页入口
src/                业务代码（经典 script，零依赖）
styles/             样式
assets/             字体、插画与纸纹素材
```

## 隐私

所有数据保存在访问者浏览器的 `localStorage`，不联网、无账号、无 telemetry。不同设备或不同访问来源的数据各自独立。

## 数据来源

节假日与农历数据已内联在 `src/data/holidays.js` 与 `src/core/lunar.js` 中；来源链接随数据一并保留。

## 字体与素材

- **霞鹜文楷（LXGW WenKai）** —— 正文字体，Copyright © 2021-2026 LXGW（基于 Klee One Project），SIL Open Font License 1.1。许可全文：[`assets/fonts/lxgwwenkai/OFL.txt`](assets/fonts/lxgwwenkai/OFL.txt)。页面加载的是按 `unicode-range` 切分的子集（WOFF2），属于 OFL 附加许可允许的「为网页字体分发所做的修改」，保留字体名，不作为可安装的桌面字体分发。
- **Rouge Script** —— 顶栏英文手写装饰字，Copyright © 2011 Typesenses，SIL Open Font License 1.1。许可全文：[`assets/fonts/rouge-script-OFL.txt`](assets/fonts/rouge-script-OFL.txt)。
- 插画与纸纹素材位于 `assets/illustrations/` 与 `assets/textures/`，随本仓库一并发布。

各字体的来源与文件清单见 [`assets/fonts/README.md`](assets/fonts/README.md)。

## 许可

本项目以 **GNU Affero General Public License v3.0 only**（SPDX：`AGPL-3.0-only`）授权，完整条款见 [LICENSE](LICENSE)。

Copyright (C) 2026 Mingle180。

本站由同一仓库源码直接发布；通过网络使用本项目的用户，可依 AGPL 第 13 条从本仓库获取完整对应源代码：<https://github.com/Mingle180/DayPlan>。
