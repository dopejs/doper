# doper 错误诊断与事故上报

> 状态：M5-B 初版。面向线上事故排查与灰度看板接入。

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
| ABI 解码      | `invalid doper ABI stream: …`（畸形/截断/版本不符输入被原子拒绝）                    | 采集字节长度与首 16 字节 magic；核对 `abiVersion` 与资源完整性 |
| Core 派生失败 | Core poison：实例关闭，后续调用返回 `Poisoned`                                       | Host 自动用完整快照重建；连续 poison 走 compat 自动回退        |
| Host 传输     | `onHostError` 回调（transport 背压、Worker 崩溃、恢复失败）                          | Worker 路径自动降级/重建；记录 `transportMetrics()` 快照       |
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
- `transportMetrics()` / `inputTransportMetrics()`：传输模式与背压。
- `onSemantics` / `dirtySemanticsNodes`：语义树状态。
- `DOPR` 录制：Mutation/Input 原序录制，可脱离浏览器确定性回放
  （敏感编辑流显式跳过，密码永不入档）。
