# pingo 灰度与事故运行手册

> 状态：M5-C 初版。面向线上灰度操作与事故处置。

## 1. 灰度模型

- 粒度：页面（`pageId`），由业务灰度系统决定 `mountCompatPage` 的
  `enabled`。
- 建议放量序列：内部页面 → 1% → 10% → 50% → 100%；每档观测一个完整
  高峰期后再进阶。
- 每档观测指标（`onFrame` / `transportMetrics()` / `onFallback` 上报）：
  - 帧时间 P95/P99 与掉帧率（对照 design.md 绝对指标）。
  - `onFallback` 触发率按原因分桶（`initialization-failed` /
    `runtime-error`）。
  - transport 模式分布（sab / post-message / main-thread）——降级占比
    异常升高说明部署环境（COOP/COEP）退化。
  - `WasmIntegrityError` 出现即停止放量并核查发布产物。

## 2. 回退操作（按影响面从小到大）

1. **单页面手动回退**：`page.fallback("原因")`；存量渲染器立即接管，
   无需刷新。
2. **单页面灰度关断**：灰度系统置 `enabled=false`；下次加载不再初始化
   pingo。
3. **能力级降级**：设置 `transport: { preference: "main-thread" }` 强制
   主线程 Canvas2D（绕开 Worker/SAB 疑难）。
4. **全量关断**：灰度系统全局置 false。存量路径始终可挂载，pingo 卸载
   不留状态。

自动回退已内建：初始化失败即回退；连续 host 错误（默认 3 次，可配
`maxRuntimeErrors`）自动回退并上报 `runtime-error`。

## 3. 事故处置清单

1. 采集 `engineIdentity()`、`pageId`、`root.mode`、`transportMetrics()`
   快照与 `onFallback` 原因（见 `docs/diagnostics.md`）。
2. 判断影响面：单页面 → 手动回退；多页面同错误 → 灰度关断该批页面。
3. 若怀疑资源问题：核对 CDN 上的 WASM 与 `manifest.json` digest。
4. 可复现问题：用 `DOPR` 录制回放在 headless 环境确定性复现
   （`pnpm ime:replay` 处理编辑录制）。
5. 事后：把复现输入沉淀为 fixture 进回归门禁，再恢复放量。

## 4. 演练

自动演练在 CI 持续运行（真实 Chromium）：

- `packages/compat/src/rollout.browser.ts`：灰度关断、双向切换、
  初始化故障自动回退。
- `packages/facade/src/m5-shadow.browser.ts`：迁移 fixture 在 shadow
  （主线程参考）与主路径（SAB Worker）上像素一致。
- 既有故障注入：主线程阻塞 200ms Worker 连续呈现（M2）、Worker 崩溃
  恢复与传输背压回退（host 测试）。
