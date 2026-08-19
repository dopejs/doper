# Pingo 品牌标识设计 · 2026-08-20

## 背景

仓库原有一套 pingo 品牌资产（开口圆环 + 墨点），2026-08-20 经评审决定**全部废弃，重新设计**。新标识需要覆盖官网、文档、favicon、app icon 等场景，名称为 **Pingo**（首字母大写），并要求图形标可脱离字标独立使用。

## 设计概念

**像素 P（Pixel P）**：粗颗粒像素网格拼出字母 P，右上角一颗旋转 18° 的像素脱离网格、悬在碗口上方——「正在被放置的像素」。

语义对应：

- 像素网格 = canvas / 栅格化的产品本质；
- 正在落位的像素 = 引擎每帧在做的事（DisplayList → 光栅化），也暗示「构建中」的工程文化；
- P = Pingo 首字母。

## 几何规范（viewBox 64×64）

- 5 列 × 5 行网格，像素块 9×9，圆角 2，步进 10（间隙 1）。
- 网格原点 (10, 11)，列 x ∈ {10,20,30,40,50}，行 y ∈ {11,21,31,41,51}。
- P 的字形：第 0 行填满列 0–3；第 1 行填列 0 与列 4；第 2 行填满列 0–3；第 3、4 行只填列 0。
- 悬浮像素：9×9，圆角 2，中心约 (55.5, 6.5)，旋转 18°。
- favicon 专用小尺寸版：像素块 10×10、步进 11、原点 (7, 9)，悬浮像素 10×10 于 (51, 2)，保证 16px 下可读。

## 色彩

| 角色 | 色值 | 用途 |
|---|---|---|
| 墨色 Ink | `#14161B` | 网格主体（浅色背景） |
| 纸色 Paper | `#F7F6F2` | 网格主体（深色背景 / 深色磁贴内） |
| 品牌蓝 Accent | `#2E5BFF` | 仅悬浮像素；官网主按钮/链接等强调色 |

规则：彩色只允许出现在悬浮像素上，其余像素永远单色。单色场景（印刷、蚀刻、`currentColor` 内联）使用 mono 版，悬浮像素与网格同色。

## 资产清单（assets/brand/）

| 文件 | 内容 |
|---|---|
| `pingo-mark.svg` | 彩色主标，透明底（墨色网格 + 蓝像素） |
| `pingo-mark-dark.svg` | 深色背景用主标（纸色网格 + 蓝像素） |
| `pingo-mark-mono.svg` | `currentColor` 单色版 |
| `pingo-icon.svg` | 深色圆角磁贴（app icon / GitHub avatar） |
| `pingo-favicon.svg` | 小尺寸优化版，内嵌 `prefers-color-scheme` 媒体查询自动反白 |

旧资产 `pingo-mascot-*.svg`、`pingo-preview.png`、`pingo-mascot-preview.png` 随本次切换删除；社交分享预览图后续按新标识重新生成。

## 使用规则

- 不改变像素块的比例、间隙、圆角；不旋转整体图形（悬浮像素自带 18°）；不加描边、阴影、渐变。
- 深色背景下必须使用 `pingo-mark-dark.svg`（或 mono 版自行着色），禁止直接反色 CSS 滤镜。
- 最小清晰尺寸：标准版 24px；16px 场景必须使用 favicon 版几何。
- 字标：Pingo（首字母大写），几何无衬线、字重 650 左右、收紧字距；图形与字标间距约为一个像素块宽度。

## 官网接入点

- `docs/public/`：放置 mark / mark-dark / favicon 三份 SVG 供站点引用。
- `docs/.vitepress/config.ts`：`themeConfig.logo` 配置 light/dark 双版本；`head` 增加 SVG favicon 链接；`theme-color` 更新为 `#2E5BFF`。
- 全部 10 个语言的 `index.md`：hero 增加 light/dark 双版本 image。
- `assets/brand/README.md`：重写为本文档的精简规范。

## 验证

- `pnpm docs:build` 通过；
- 构建产物静态伺服后浏览器目视检查：导航栏（明/暗）、hero、favicon 链接均正确。
