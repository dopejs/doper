# E8 布局回读与碰撞感知定位实现计划

**Goal:** 按 [`docs/e8-layout-readback-design.md`](./e8-layout-readback-design.md)
交付 `useLayoutValue` 全链路：schema/ABI → Scene 观察集 → Core 几何导出 → Host 三
transport → Runtime hook → 定位策略 → 四个锚定组件接入，并保留 feature flag 回滚。

**前置：** 设计门 D1–D8 需先批准；§4 三条未决问题在 E8-1 前定稿。

---

### Task E8-1: schema 与生成代码

**Files:** `schemas/protocol.v1.json`、生成产物（`core/pingo-abi/src/generated.rs`、
`packages/host/src/generated.ts` 等）

- [ ] `abiVersion` 19 → 20；`minimumReadableAbiVersion` 不变（20 对 19 纯增量）。
- [ ] Mutation 命令 `ObserveGeometry = 96`（新分组，`nodeId + flags`）。
- [ ] `layoutGeometryBatch`：header（version/recordCount）+ 每记录 10 words
      （`nodeId`、`flags`、own rect ×4、clip rect ×4），形状对齐
      `editingGeometryBatch`。
- [ ] `limits.maxObservedGeometryNodes`（设计门 §4.2 定值）。
- [ ] `pnpm protocol:generate`；两侧常量均来自生成，不手写。

### Task E8-2: ABI 编解码

**Files:** `core/pingo-abi/src/{mutation.rs,generated.rs}`、新增
`core/pingo-abi/src/layout_geometry.rs`、`packages/host/src/main-thread.ts`

- [ ] `MutationCommand::ObserveGeometry` 编解码 + 校验（flags 保留位为零、
      nodeId 上界）。
- [ ] `parseLayoutGeometry`（TS）与对应 Rust 编码：版本不符、截断、
      recordCount 与负载不匹配、保留位非零，逐条拒绝且不部分改状态。
- [ ] golden bytes + TS↔Rust 往返 + malformed 表 + `arbitrary_bytes_never_panic`。
- [ ] 覆盖率：新解码器的拒绝分支必须被测到（`coverage:rust` 对 `pingo-abi`
      的 95% 行门槛已经会挡）。

### Task E8-3: Scene 观察集与 Core 几何导出

**Files:** `core/pingo-scene/src/scene.rs`、`core/pingo-hit/src/lib.rs`、
`core/pingo-core/src/{engine.rs,wasm.rs}`

- [ ] Scene 维护观察集（提交期），并提供 `observes_any()` 布尔——手法同
      `StyleCapabilities`（`2933441`），无观察时热路径退化为一次布尔读。
- [ ] 超过 `maxObservedGeometryNodes` 时提交整体失败，不半应用。
- [ ] hit 几何循环把**被观察节点**的 `own_aabb` 与有效裁剪框写入旁路小表；
      **不**加宽 `WorldGeometry`（设计门 D4）。
- [ ] `Engine::layout_geometry() -> Vec<u32>` + `wasm.rs` 导出。
- [ ] 单测：未观察→零记录；观察后→rect 与 `reference` 一致；节点销毁→记录消失；
      `visibility: hidden` 节点仍有几何（D6 依赖此性质，需断言而非假定）；
      滚出容器→own rect 保留、clip 退化为空。
- [ ] 性能：`pnpm m1:perf` 与 `m3:perf` 在零观察下相对基线无回归。

### Task E8-4: Host 通道与三 transport 一致性

**Files:** `packages/host/src/{main-thread.ts,worker-client.ts,worker-protocol.ts,
hosted-root.ts}`

- [ ] `onLayoutGeometry` 回调 + 每帧 `emitLayoutGeometry()`（照 `emitSemantics`）。
- [ ] Worker 协议消息 + 主线程回放路径。
- [ ] `HostedRoot` 侧维护 nodeId → 最新几何的表，并暴露给 Runtime。
- [ ] feature flag（默认关闭，设计门 D8）：关闭时不发 `ObserveGeometry`，
      不注册回调。
- [ ] 契约测试：SAB / postMessage / 主线程 Canvas2D 三条 transport 下几何帧
      内容一致、与 DisplayList 的相对顺序一致。

### Task E8-5: Runtime `useLayoutValue` 与公开面

**Files:** `packages/runtime/src/hooks.ts`、`packages/reconciler`、
`packages/facade`、api 快照

- [ ] `useLayoutValue(ref, selector)`：挂载时发 `ObserveGeometry`，卸载时撤销；
      selector 结果 `Object.is` 不变则不触发重渲染。
- [ ] 首帧返回 `undefined`；flag 关闭时恒为 `undefined`。
- [ ] 同一节点被多处订阅只观察一次（引用计数）。
- [ ] 单测：订阅/退订对称、快速开关不泄漏观察、selector 稳定性。
- [ ] `pnpm api:check` 快照按 `docs/api/index.md` 程序更新。

### Task E8-6: 定位策略纯函数

**Files:** `packages/ui/src/positioning.ts`（新增）+ 测试

- [ ] `size`：约束 `maxHeight`/`maxWidth`，内容内部滚动。
- [ ] `shift`：沿轴滑动保持在边界内，不改变边。
- [ ] `flip`：空间不足翻到对侧；两侧都不足时保留原边（不做无限翻转）。
- [ ] `hide`：锚点完全脱离有效边界时隐藏浮层。
- [ ] 边界 = 通道裁剪框 ∩ 视口，在此求交（设计门 D5）。
- [ ] 纯函数，输入 `(anchor, panel, bounds, side)`，无 DOM/Core 依赖；
      property test：结果永远不超出 bounds，或明确报告"放不下"。

### Task E8-7: 组件接入与首帧策略

**Files:** `packages/ui/src/components/{popover,menu}.ts`、皮肤、storybook

- [ ] `Popover` / `DropdownMenu` / `Select` / `Tooltip` 接入策略。
- [ ] 首帧 `visibility: hidden`，测得几何后显形（设计门 D6）；
      per-component 可选退回"先猜后校正"。
- [ ] flag 关闭时四个组件行为与今天逐字节一致（回归断言）。
- [ ] storybook 增"贴边 / 可滚动容器内 / 长列表"三个展区，明暗都覆盖。

### Task E8-8: 门禁与文档回写

- [ ] `pnpm m1:check`（含覆盖率门槛）、`m2:check`、`m3:*`、`m5:backend:diff`、
      `release:check`、`migration:check`、`storybook:build` 全绿。
- [ ] WASM 体积：新增通路的 gzip 增量记入 `docs/wasm-size-attribution.md`；
      超出工程预算则先归因回收，不上调预算。
- [ ] `docs/design.md` 记录 `useLayoutValue` 由承诺转为已实现，含兼容性与回滚。
- [ ] `overlay-auto-flip-design.md` 状态从 Blocked 改为 Superseded；
      `packages/ui/README.md` 的"没有碰撞感知定位"条目改写。
- [ ] 回写 `pingo-ui-implementation-plan.md` 进度表与验收记录。

---

## 验收标准

| 层         | 要求                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| ABI        | golden bytes、TS↔Rust 往返、malformed 表、fuzz；`pingo-abi` 行覆盖 ≥95% |
| Scene/Core | 观察集提交语义单测；几何与 hit 一致；零观察零开销（基准佐证）           |
| Transport  | 三条 transport 内容与顺序一致                                           |
| Runtime    | 订阅/退订对称、无泄漏、selector 稳定性                                  |
| 策略       | 四条策略单测 + property test（结果不越界）                              |
| 组件       | flag 关闭时行为逐字节不变；storybook 三展区明暗                         |
| 性能       | 零观察下 m1/m3 无回归；有观察时开销与观察数成正比而非场景规模           |

## 风险与回滚

| 风险                     | 缓解                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| 几何导出拖累帧时         | 观察集有界 + Scene 提交期位图；零观察退化为一次布尔读               |
| 慢一帧导致打开卡顿观感   | D6 首帧隐藏；必要时 per-component 退回"先猜后校正"                  |
| 观察泄漏（订阅未撤销）   | 引用计数 + 卸载断言 + `maxObservedGeometryNodes` 硬上界兜底         |
| 策略在滚动容器内算错边界 | 边界取 Core 裁剪框 ∩ 视口，storybook 专设可滚动容器展区             |
| 整条通路不达预期         | feature flag 默认关闭，关掉即回到今天的静态方向；ABI 纯增量无需回退 |
