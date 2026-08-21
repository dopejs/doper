# ADR-0008：增量 immutable Picture 资源与事务时序

- 状态：Accepted
- 日期：2026-08-21
- 决策者：pingo maintainers
- 关联设计：`docs/design.md` §5 L4、§6、§7；`docs/m9-production-plan.md` M9-A/B

## Context

`DrawPicture` 已存在于 DisplayList 和 Canvas2D backend，但 M8 的 Core 仍在每次 paint 时把
完整子树内联展开。滚动、transform 或 opacity 只改变组合位置时，这会重复编码、传输和解码
未变化的 draw commands。优化同时引入资源时序风险：引用早于定义、释放早于最后一次回放、
Worker 重启后的残留引用、ID 复用导致陈旧命中，以及 Host 安装部分资源后失败。

Scene 必须继续作为 hit、semantics、editing geometry、media 生命周期和 durable application
state 的唯一派生源；Picture 只缓存绘制指令，不能成为第二份可变场景。

## Decision

1. ABI v17 新增独立 `DOPP` Picture resource stream。每批只包含 `DefinePicture` 和
   `ReleasePicture`，保持小端、四字节对齐、自描述长度和统一 16-byte envelope。
2. Picture ID 是 Core session 内单调递增、非零且永不复用的 generation token。达到 `u32`
   上限时停止生成并重启 Core；不能回绕或复用旧 ID。
3. 每个非隐藏 Scene 子树对应一个 immutable Picture。节点自身 layout offset 不写进资源；
   父 Picture 通过 `DrawPicture(id, offset)` 组合子 Picture。paint/结构变化只重建节点及祖先链，
   layout-only offset 变化只改变父引用。
4. 一个 committed frame 先发布所有新定义（子级在父级之前），再发布旧 generation 的释放，
   最后回放引用它们的根 DisplayList。Host 在候选 registry 中解码并验证整批资源图、缺失引用、
   环和深度/字节预算，全部成功后才原子替换 live registry。
5. Core 保留未确认的 `DOPP` bytes 和精确 `frame_seq`。Host 只有在 registry commit 成功后才
   acknowledgement；未确认时 Core 拒绝产生下一帧，错误序号不能清除 pending transaction。
6. backend 常驻 Picture payload 硬预算为 16 MiB。若一次正确帧会越过预算，Core 放弃尚未发布
   的新定义，同帧生成独立 inline DisplayList、释放所有已发布 Picture，并保持在 inline 路径，
   直到 Host 显式重新启用或 Core 重启。该回退计入 `pictureBudgetFallbacks`。
7. main-thread、postMessage 和 SAB 传输使用同一套 `DOPP` bytes 与 acknowledgement 语义。
   Worker/transport 重启创建新 Core session，因此首帧自然发布完整资源快照；旧 registry 随旧
   frame sink 销毁，不能跨 session 继承。
8. `incrementalPicturesEnabled` 默认开启，是优化级 kill switch。关闭时清空增量 cache、在下一
   个成功帧释放 live generation，并回到永久保留的 inline reference builder；不改变 Scene、
   Mutation Stream、公开组件语义或编辑 revision。

## Alternatives

- **按内容 hash 直接作为 ID**：相同 hash 不是生命周期 generation，碰撞或释放/重定义会让
  陈旧引用重新有效；hash 仅适合作诊断和内容比较。
- **Host 在回放时按需请求缺失 Picture**：会产生空白/旧帧并使滚动路径调用 Shell，破坏
  committed-frame 原子性。
- **固定槽位复用而不带 generation**：释放后的旧 DisplayList 可错误命中新内容，不接受。
- **预算超限直接 poison Core**：资源压力不是 Scene 正确性失败；inline reference 能在同帧
  保持正确输出，poison 会把可恢复压力升级为页面故障。
- **Picture 承载 hit/semantics/edit/media state**：会冻结动态交互状态并形成第二份可变 Scene。

## Evidence

- ABI golden 与 TS↔Rust roundtrip：`benchmarks/abi/picture-resources.v1.json`、
  `pnpm protocol:check`。
- Rust lifecycle/backpressure/budget fallback：`pnpm rust:test` 中 `pingo-abi`、`pingo-paint`、
  `pingo-core` 测试。
- Backend 原子安装、缺失引用、环和 release 失败不部分提交：
  `packages/backend-canvas2d/src/picture-resources.test.ts` 与
  `packages/host/src/main-thread.test.ts`。
- 产品体积和 section attribution：`pnpm core:wasm:repro` 生成的
  `packages/host/wasm/manifest.json`（构建产物，不提交）。

## Consequences

- ABI 升到 17，frame diagnostics 升到 9，Worker protocol 升到 12；旧 Worker 握手失败后走
  已有 fallback，不尝试解释新资源时序。
- 资源更新需要一次 Host→Core acknowledgement，但只发生在有定义/释放的帧；clean idle 帧
  不产生资源消息。
- 单调 ID 会在极端长 session 消耗 namespace；安全行为是受控重启而不是复用。
- 当前压力策略是全局切回 inline，而不是局部 LRU。它牺牲优化收益但保持像素和交互正确性，
  且原因可诊断。只有证明局部驱逐不产生引用竞态后才可另立 ADR 改变。

## Rollback

页面或全局把 `incrementalPicturesEnabled` 设为 `false`。触发信号包括未知 Picture ID、资源
ack backlog、optimized/reference 像素差异、常驻预算异常或 `pictureBudgetFallbacks` 增长。
回退帧释放 live Picture，后续只回放 inline DisplayList。若 registry 已拒绝事务，Host 不发送
ack 并销毁/重启该 Core session；不得跳过失败批次继续引用旧 registry。
