---
title: 变更日志
---

# Changelog

版本口径见 `docs/release.md`：11 个包同版本原子发布，npm semver 与二进制
ABI 版本独立管理。

## Unreleased

- 规划 M9“生产资格、增量合成与发布硬化”：以 immutable Picture/D3 oracle 解决纯滚动
  DisplayList 重建，恢复产品 Core WASM 至 384 KiB 工程余量，建立可过期的平台资格 v2、
  无外部副作用的候选发布总门禁和完整回滚演练；M9 当前尚未开始实现。
- 完成 M8：ABI 16 增加 Video/VideoFrame 资源契约，Host 提供 HTMLMediaElement 加载、
  CORS、媒体控制/事件与 main-thread/VideoFrame/ImageBitmap 降级；Worker protocol 升至 v11。
  每个视频一帧在途、丢旧保新、资源回收/后台暂停与复制/掉帧诊断均有自动门禁；新增
  `Pressable`/`Button` 和语义镜像 Enter/Space 默认动作，保留 `videoEnabled` 独立回滚。
- 完成 M7：`View.virtual` 支持 x/y 单轴与 `ViewHandle` 滚动 API；Core 新增 ABI 15
  immutable animation resource、opacity/transform transition 与 keyframes、retarget/cancel、
  连续 pause/resume、实时 reduced motion、稳定诊断和逻辑帧录制回放。三 transport 的
  Worker stall、native/WASM 字节差分、500 动画性能/内存预算与 WASM 体积门禁已自动化。
- 完成 M6：foundation facade、单源 CSS subset、typed computed style、display/overflow、
  原生事件状态/伪类、迁移诊断与独立回滚开关全部通过 `pnpm m6:check`。
- 项目许可证从下一次 npm 发布起由 MIT 切换为 Apache-2.0；v0.2.1 及以前
  的已发布版本仍保持 MIT。

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
