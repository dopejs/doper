# pingo 灰度与事故运行手册

> 状态：M9。面向线上灰度操作与事故处置。

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

能力级回退按最小影响面执行：

- Picture 未知 ID、ack backlog、预算回退增长或像素差异：设置
  `incrementalPicturesEnabled=false`，确认下一帧 `pictureResidentCount/Bytes` 归零；若事务已被
  backend 拒绝，销毁该 Core/Worker session，用 Shell durable snapshot 重建，不能跳过失败批次。
- Video copy/在途/释放计数持续增长：设置 `videoEnabled=false`，停止新绑定并关闭现有媒体资源。
- SAB 背压或隔离配置回归：按 `sab → post-message → main-thread` 降级；每次切换创建新 session，
  从完整 Scene/Picture 快照恢复，不继承旧 registry。
- 资格证据过期、digest 不符或平台回归：将对应 role 标为 `expired`/`unqualified`，停止该平台
  支持声明并选择已验证的 transport/input/media 路径；历史原始证据保持只读。

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

立即停止放量的条件：WASM/CDN digest 不一致、Picture optimized/reference 任一像素差异、
backend 资源事务部分提交、编辑 revision 回退、媒体释放数落后且不收敛，或回滚演练无法恢复
durable application state。不得通过放宽容差、清空历史或手工改资格汇总继续发布。

## 4. 演练

自动演练在 CI 持续运行（真实 Chromium）：

- `packages/compat/src/rollout.browser.ts`：灰度关断、双向切换、
  初始化故障自动回退。
- `packages/facade/src/m5-shadow.browser.ts`：迁移 fixture 在 shadow
  （主线程参考）与主路径（SAB Worker）上像素一致。
- 既有故障注入：主线程阻塞 200ms Worker 连续呈现（M2）、Worker 崩溃
  恢复与传输背压回退（host 测试）。
- `packages/facade/src/m9-picture.browser.ts`：Picture optimized/inline 像素差分和三 transport
  生命周期一致性。
- `pnpm m9:picture:wasm-native`：publish/scroll/release 在 native/wasm32 字节一致。
- `pnpm m9:soak`：108,000 次滚动输入、108,000 个动画帧、180 次编辑操作和 Video
  资源共同运行的加速 30 分钟逻辑 soak；常驻 Picture 数量固定，峰值和结束态均受预算约束。
- `pnpm platform:qualify:v2`：资格 digest、复算、环境漂移和过期策略；无真机证据保持
  `unqualified`。
