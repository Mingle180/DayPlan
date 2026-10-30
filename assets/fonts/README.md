# 字体

站内只用到两套字体，均为 SIL Open Font License 1.1 授权，许可证全文随文件一并分发。

| 文件 | 字体 | 版权 | 许可证 |
| --- | --- | --- | --- |
| `lxgwwenkai/lxgwwenkai-regular.css` + `lxgwwenkai/files/*.woff2` | 霞鹜文楷 LXGW WenKai（Regular 400） | Copyright 2021-2026 LXGW | [lxgwwenkai/OFL.txt](lxgwwenkai/OFL.txt) |
| `rouge-script-latin-400.woff2` | Rouge Script（Regular 400，拉丁子集） | Copyright (c) 2011 Typesenses | [rouge-script-OFL.txt](rouge-script-OFL.txt) |

霞鹜文楷的 woff2 是**为网页分发做的 unicode-range 子集**（97 个分片，按码位自动加载）。上游 OFL 的附加许可允许这种「仅为网页字体分发而子集化/转换格式」的修改版继续沿用保留字体名；这些文件只作为网页字体随站点加载，不作为可安装的桌面字体分发。若要把整字库安装到系统，请从上游项目下载原始字体并按 OFL 处理。

Rouge Script 只内嵌了拉丁子集，用于顶栏横幅的手写英文；中文回落到霞鹜文楷。
