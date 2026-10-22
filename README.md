# DayPlan

DayPlan 是一个离线优先的个人日程应用，提供日 / 周 / 月三种视图、农历与节假日标记、重复事项和本地数据存储。

## 在线访问

https://limengpku.github.io/DayPlan/

`main` 分支根目录直接由 GitHub Pages 发布，无需构建步骤。

## 本地运行

双击 `index.html` 即可运行，无需服务器、构建或第三方运行时。

## 目录

```
index.html          网页入口
src/                业务代码（经典 script，零依赖）
styles/             样式
```

## 隐私

所有数据保存在访问者浏览器的 `localStorage`，不联网、无账号、无 telemetry。不同设备或不同访问来源的数据各自独立。

## 数据来源

节假日与农历数据已内联在 `src/data/holidays.js` 与 `src/core/lunar.js` 中；来源链接随数据一并保留。

## 许可

本仓库目前未附开源许可证（UNLICENSED）。
