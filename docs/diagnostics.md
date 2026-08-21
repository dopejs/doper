# pingo 错误诊断与事故上报

> 状态：M9。面向线上事故排查与灰度看板接入。

## 1. 身份信息

每条上报应附带 `engineIdentity()`（来自 `@dopejs/pingo`）：

```ts
import { engineIdentity } from "@dopejs/pingo";
report({ ...engineIdentity(), pageId, mode: root.mode });
```

- `version`：引擎发布版本（`ENGINE_VERSION`）。
- `abiVersion`：Shell/Core 二进制协议版本（`ENGINE_ABI_VERSION`）。
  版本不匹配的 Mutation/Input/DisplayList 流会在解码边界被拒绝，
  不会部分应用。

## 2. 错误分类

| 来源          | 形态                                                                                 | 处置                                                           |
| ------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| ABI 解码      | `invalid pingo ABI stream: …`（畸形/截断/版本不符输入被原子拒绝）                    | 采集字节长度与首 16 字节 magic；核对 `abiVersion` 与资源完整性 |
| Core 派生失败 | Core poison：实例关闭，后续调用返回 `Poisoned`                                       | Host 自动用完整快照重建；连续 poison 走 compat 自动回退        |
| Host 传输     | `onHostError` 回调（transport 背压、Worker 崩溃、恢复失败）                          | Worker 路径自动降级/重建；记录 `transportMetrics()` 快照       |
| 媒体管线      | `onError` 的稳定媒体错误码与 `onMediaMetrics` 计数                                   | 核对 CORS/codec；记录能力、路径、掉帧、复制和回收计数          |
| 迁移边界      | `onFallback` 原因：`disabled` / `initialization-failed` / `runtime-error` / `manual` | 见 `docs/runbook.md` 回退步骤                                  |
| WASM 完整性   | `WasmIntegrityError`（自托管资源与构建 manifest 不符）                               | 阻断初始化并上报 digest；核对 CDN 缓存与发布产物               |

## 3. 资源完整性

构建产物 `packages/host/wasm/manifest.json` 记录 `sha256`/`rawBytes`/
`gzipBytes` 与体积预算；发布门禁 `node scripts/check-release-package.mjs`
校验 manifest 与字节一致。自托管部署在实例化前调用：

```ts
import { verifyWasmIntegrity } from "@dopejs/pingo";
await verifyWasmIntegrity(await response.arrayBuffer(), manifest);
```

## 4. 可观测面

- `onFrame`：帧阶段耗时、脏域计数、cache 命中率、picture hash。
- `onFrame.core.pictureDefines/pictureReleases`、`pictureResidentCount/Bytes`、
  `pictureResourceBytes` 与 `pictureBudgetFallbacks`：immutable Picture 发布、确认、常驻预算与
  inline 自动回退。持续 resident 增长或 fallback 增长按 Picture 事故处理。
- `onFrame.style` / `root.styleMetrics()`：Shell style resolution、无变化 cache hit、diagnostic
  与预编译 interaction variant 累计数。
- `onFrame.core.interactionStateChanges`：Core hover/active/focus/focus-visible 状态变化累计数。
- `onFrame.core.animation*`：active 与 before/active/after phase、start/retarget/cancel、
  sampled frame、presentation change、layout node 与 retained-byte 预算。M7 的
  `animationLayoutNodes` 必须为 0。
- `transportMetrics()` / `inputTransportMetrics()`：传输模式与背压。
- `root.mediaMetrics()` / `onMediaMetrics`：当前绑定数、提交/丢弃/copy/释放/错误帧数、
  当前和历史最大在途数。单个 Video 的传输硬上限为 1，总绑定硬上限为 256；持续增长或
  卸载后不归零是资源所有权事故。
- `onFrame.cause === "media"` 时的 `mediaPath`：`html-media` 为主线程零 copy 路径，
  `video-frame` 为 Worker transferable 路径，`image-bitmap` 为 copy fallback。
- `detectMediaCapabilities()`：分别报告 HTMLVideoElement、VideoFrame 与 ImageBitmap 能力；
  不从 Worker/OffscreenCanvas 的存在推断媒体能力。
- `onSemantics` / `dirtySemanticsNodes`：语义树状态。
- `DOPR` 录制：Mutation/Input/system-font metric/逻辑帧微秒增量按原序录制，可脱离浏览器
  确定性回放 animation 与 scroll
  （敏感编辑流显式跳过，密码永不入档）。

样式事故可分别关闭 `styleResolverEnabled`、`foundationComponentsEnabled` 或
`interactionStylesEnabled`；动画可关闭 `coreAnimationEnabled`，媒体可关闭
`videoEnabled`。这些开关不删除旧 intrinsic/direct prop 路径，动画关闭后 durable 最终值
仍会提交。媒体关闭会在创建 Video 时立即拒绝，不会留下 HTMLMediaElement 或传输帧。
