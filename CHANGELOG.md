# Changelog

版本口径见 `docs/release.md`：10 个包同版本原子发布，npm semver 与二进制
ABI 版本独立管理。

## Unreleased

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
- 迁移与生产化：`@dopejs/doper-compat` 按页面灰度/回退、迁移扫描器、
  发布包与 WASM SHA-256 完整性验证、诊断与运行手册。
- WebGPU 隔离原型与 headless oracle 零失配差分（ADR-0006：
  Continue Experiment，默认关闭）。

显式延后：bidi 视觉导航、widgets placeholder、WebGPU 默认启用。
平台资格（真机性能、真实 IME、屏幕阅读器）另行跟踪，不随包版本承诺。
