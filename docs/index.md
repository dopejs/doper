---
layout: home

hero:
  name: Pingo
  text: canvas 渲染引擎
  tagline: Rust/WASM 核心 + TypeScript 外壳 + 可插拔后端。为高性能交互、原生虚拟滚动与 canvas 内文本编辑而设计。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: Playground
      link: /playground
    - theme: alt
      text: GitHub
      link: https://github.com/dopejs/pingo

features:
  - title: 双时钟，主线程卡死也不掉帧
    details: UI 时钟与渲染时钟相互独立。滚动、动画、布局与合成在 Worker 内闭环推进；主线程被阻塞 200ms 时画面仍然连续。
  - title: 原生虚拟滚动
    details: 前缀和树、方向预测预热与占位补建都在 Core 内。百万行固定 fixture 的 20,000 帧重放 P95/P99 为亚微秒级，滚动稳态完全不回调 Shell。
  - title: canvas 原生编辑
    details: caret、选区、拖选、双击选词、IME composition、候选窗定位、剪贴板与撤销重做全部由引擎实现。业务不再为输入能力创建 HTML 控件。
  - title: 无障碍是架构的一部分
    details: Core 导出语义树，宿主镜像成 canvas 旁的 DOM 影子树。屏幕阅读器可用，E2E 能按 role/label 选中元素，而不是比对像素。
  - title: 确定性与差分测试
    details: 版本化二进制流、可注入时钟与随机源、录制回放，以及增量与全量、优化与朴素、wasm 与 native 的差分 oracle。
  - title: 自动降级，永远有退路
    details: SharedArrayBuffer → postMessage → 主线程 Canvas2D 按能力自动选择，功能等价。迁移层支持按页面灰度与一键回退。
---

## 30 秒上手

```sh
pnpm add @dopejs/doper
```

> 品牌名已切换为 Pingo。公开 npm 包将在兼容迁移完成后切换到 `@dopejs/pingo`；当前安装命令仍保持为 `@dopejs/doper`。

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/doper";

const root = await createHostedCanvasRoot(document.querySelector("canvas")!);

root.render(
  createElement("virtualList", {
    width: 480,
    height: 640,
    itemCount: 1_000_000,
    estimatedItemHeight: 32,
    renderItem: (index) => createElement("text", { value: `第 ${index} 行` }),
  }),
);
```

一百万行不会在 Shell 侧物化，滚动过程也不回调组件树——窗口计算与补建都发生在 Core 内。

## 它不做什么

Pingo 是渲染引擎，不是浏览器。**不做** SSR/HTML 首屏、通用 CSS 兼容（盒模型、层叠、选择器）、
小程序或原生适配层，也不做业务级富文本语义（协同、公式、Markdown 命令）。

引擎**确实拥有** caret、选区、IME、剪贴板、撤销重做与可编辑文本原语——这些不会被推回业务层用
DOM 控件拼凑。

## 当前状态

v0.1.0，P0–M5 全部工程里程碑完成，`pnpm m5:check` 全链自动门禁通过。

真机性能、真实输入法与屏幕阅读器矩阵属于平台资格采集，单独跟踪；
bidi 视觉导航与 WebGPU 后端默认启用是[已记录的延后项](/plan)。
