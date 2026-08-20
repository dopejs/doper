---
title: 变更日志
---

# Changelog

版本口径见 `docs/release.md`：10 个包同版本原子发布，npm semver 与二进制
ABI 版本独立管理。

## Unreleased

- 启动 M6-A：新增版本化单源 style schema、生成的 TS/Rust 元数据、独立 Shell CSS
  subset resolver，以及 `createStyleSheet`、`supportsStyle`、`styleCapabilities` 等 facade API。
  M6-A 还增加了独立 candidate-list reference resolver、seeded parser/cascade 差分、
  无变化输入缓存、computed-style 变化与失效域指标；当前 capability 明确报告 resolver ready、
  engine not ready，View/Core 样式集成仍属后续 M6-B。

## 0.2.1 - 2026-08-20

- 公开幂等且可重试的 `initializeWasm`，业务可以自行编排 WASM loading；默认 Storybook
  loading 改为轻量延迟展示，Worker 初始化复用同一入口。
- 双时钟 Playground 改为进入页面即持续的百万行虚拟滚动；按钮只阻塞主线程，不再
  启动或重置滚动状态。
- 新增 Core/Worker 时钟持有的恒速程序化滚动 `setScrollVelocity`；Input Stream
  增加对应命令，ABI 版本 10 → 11。

## 0.2.0 - 2026-08-20

- 滚轮传递曲线对齐浏览器原生：离散滚轮格改为动画滚动，高精度（触控板）delta 保持即时 1:1；
  Input Stream 的 `DispatchEvent` 新增 flags 字段，ABI 版本 1 → 2。
- 官网提供简体中文、繁体中文、西班牙语、法语、德语、俄语、希伯来语、阿拉伯语、日语与韩语。

## 0.1.0

首个可发布版本。P0–M5 全部工程里程碑完成，`pnpm m5:check`（M0→M5 全链
自动门禁）全绿。

- 确定性 Rust/WASM Core + TypeScript Shell：单源 schema、版本化二进制
  Mutation/Input/DisplayList/反向流，畸形输入原子拒绝。
- 双时钟渲染：SAB → postMessage → 主线程 Canvas2D 降级链，主线程阻塞
  200ms 时 Worker 连续呈现。
- 原生虚拟滚动（百万行 P95/P99 亚微秒级重放）与文本子系统（显式字体
  shaping、glyph atlas、系统字体 fallback）。
- canvas 原生编辑：EditContext/输入代理双路径、IME composition、指针与
  键盘 caret 导航、剪贴板、undo/redo、密码遮罩、caret scroll-into-view。
- 命中测试（增量 BVH + 朴素 oracle 属性测试）与 capture/target/bubble
  三阶段事件、non-passive 区域同步 `preventDefault` 协议。
- 无障碍：语义树导出、DOM 影子树镜像、`getByRole` 语义 E2E 选择器、
  键盘聚焦转发。
- 迁移与生产化：`@dopejs/pingo-compat` 按页面灰度/回退、迁移扫描器、
  发布包与 WASM SHA-256 完整性验证、诊断与运行手册。
- WebGPU 隔离原型与 headless oracle 零失配差分（ADR-0006：
  Continue Experiment，默认关闭）。

显式延后：bidi 视觉导航、widgets placeholder、WebGPU 默认启用。
平台资格（真机性能、真实 IME、屏幕阅读器）另行跟踪，不随包版本承诺。
