# ADR-0006：WebGPU 后端方向的 M5 数据决策

- 状态：Accepted（决策结论：**Continue Experiment**）
- 日期：2026-08-17
- 决策者：doper maintainers
- 关联设计：`docs/design.md` §3.1、§16、§17；`docs/plan.md` M5-D

## Context

设计要求后端可插拔：同一份 DisplayList 喂 Canvas2D 与未来的 wgpu/WebGPU
后端。M5 需要用测量数据在 Adopt / Continue Experiment / Reject 之间做出
决策，且"没有对应平台资格数据时不在该平台默认开启 WebGPU"。

## Evidence

隔离原型 `probes/webgpu-backend`（独立 workspace，不进产品 WASM 与产品
门禁）以 wgpu 30 消费与 Canvas2D/headless 完全相同的 DisplayList：

- **正确性**：M1 oracle 子集（save/restore、轴对齐 affine、轴对齐 clip、
  alpha、纯色填充、编辑装饰）与 headless CPU oracle 逐像素差分，
  文档化容差为逐通道 ≤2；实测 **0 个失配像素**（128×96 全画面，含
  嵌套 transform/clip/半透明混合）。旋转变换在原型子集外并被显式拒绝。
- **性能**（本机 Apple Silicon / Metal，512×512、400 矩形、100 样本）：
  GPU 重放 P50/P95 = 0.342/0.395ms，CPU oracle P50/P95 = 2.155/2.273ms，
  约 6 倍优势。该数据只代表桌面高端 GPU。
- **自动门禁**：`node scripts/check-m5-backend-differential.mjs` 在有
  GPU 的环境跑差分 + benchmark；无 adapter 环境显式输出 SKIPPED，
  不伪装通过。

## Decision

**Continue Experiment。** 理由：

1. 正确性证据充分（同一 DisplayList、零失配），说明 DisplayList 语义
   足以支撑第二后端，架构方向成立。
2. 性能证据不完整：只有桌面 Metal 数据；设计的核心风险是"低端安卓上
   WebGPU 反而更慢"，该假设必须由真机平台资格数据检验后才能 Adopt。
3. 原型子集远小于产品 DisplayList（无文本/glyph atlas/图像/圆角），
   Adopt 前还需扩展并重新差分。

## Consequences

- WebGPU 后端保持默认关闭；任何平台的默认启用都需要该平台的资格数据。
- 原型保持隔离 workspace，不影响产品 WASM 体积与门禁时长。
- 后续里程碑扩展子集时，本 ADR 的差分与容差口径继续适用（D2 oracle）。

## Rollback

原型可整体删除（独立目录 + 独立脚本），不影响任何产品路径。
