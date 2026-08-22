# E8 布局回读与碰撞感知定位实现计划

**Goal:** 按 [`docs/e8-layout-readback-design.md`](./e8-layout-readback-design.md)
交付 `useLayoutValue` 全链路：schema/ABI → Scene 观察集 → Core 几何导出 → Host 三
transport → Runtime hook → 定位策略 → 四个锚定组件接入，并保留 feature flag 回滚。

**前置：** 设计门 [`e8-layout-readback-design.md`](./e8-layout-readback-design.md)
D1–D9 已 Accepted，无未决项。

**进度：** E8-1 `7d49cdf`；E8-2 `7d49cdf`；E8-3 `22bb799` + 观察态基准。
本文件的复选框**随执行实时维护**，与已完成的其他子计划不同（那些是事后回填的）。

---

### Task E8-1: schema 与生成代码

**Files:** `schemas/protocol.v1.json`、生成产物（`core/pingo-abi/src/generated.rs`、
`packages/host/src/generated.ts` 等）

- [x] `abiVersion` 19 → 20；`minimumReadableAbiVersion` 不变（20 对 19 纯增量）。
- [x] Mutation 命令 `ObserveGeometry = 96`（新分组，`nodeId + flags`）。
- [x] `layoutGeometryBatch`：header（version/**frameSeq**/recordCount）+ 每记录 10 words
      （`nodeId`、`flags`、own rect ×4、clip rect ×4），形状对齐
      `editingGeometryBatch`。
- [x] `limits.maxObservedGeometryNodes`（设计门 §4.2 定值）。
- [x] `pnpm protocol:generate`；两侧常量均来自生成，不手写。

### Task E8-2: ABI 编解码

**Files:** `core/pingo-abi/src/{mutation.rs,generated.rs}`、新增
`core/pingo-abi/src/layout_geometry.rs`、`packages/host/src/main-thread.ts`

- [x] `MutationCommand::ObserveGeometry` 编解码 + 校验（flags 保留位为零、
      nodeId 上界）。
- [x] `parseLayoutGeometry`（TS）与对应 Rust 编码：版本不符、截断、
      recordCount 与负载不匹配、保留位非零，逐条拒绝且不部分改状态。
- [x] golden bytes + TS↔Rust 往返 + malformed 表 + `arbitrary_bytes_never_panic`。
- [x] 覆盖率：新解码器的拒绝分支必须被测到（`coverage:rust` 对 `pingo-abi`
      的 95% 行门槛已经会挡）。

### Task E8-3: Scene 观察集与 Core 几何导出

**Files:** `core/pingo-scene/src/scene.rs`、`core/pingo-hit/src/lib.rs`、
`core/pingo-core/src/{engine.rs,wasm.rs}`

- [x] Scene 维护观察集（提交期），并提供 `observes_any()` 布尔——手法同
      `StyleCapabilities`（`2933441`），无观察时导出路径整体不执行。
- [x] 超过 `maxObservedGeometryNodes`（64）时**只拒该条 `ObserveGeometry`**，
      同帧其余 mutation 照常提交。整帧失败是错的：畸形字节与资源策略性质不同
      （设计门 D2）。计数目前是 `observe_geometry_rejections()` 访问器；接入
      `frameDiagnostics` 需要跨语言的 schema 版本变更，随 E8-4 一起落以保持原子。
- [x] **几何循环一行不改**：`own_aabb` 与有效裁剪框在循环外，由已存的
      `transform`/`width`/`height` 与祖先链重算（设计门 D4 方案 3）。
      断言重算结果与循环内的 `inherited_clip` 逐位一致，否则两条路径会悄悄分叉。
- [x] `Engine::layout_geometry() -> Vec<u32>` + `wasm.rs` 导出。
- [x] 单测：未观察→零记录；观察后→rect 与 `reference` 一致；节点销毁→记录消失；
      `visibility: hidden` 节点仍有几何（D6 依赖此性质，需断言而非假定）；
      滚出容器→own rect 保留、clip 退化为空。
- [x] 性能：`pnpm m1:perf` 与 `m3:perf` 在零观察下相对基线无回归。
- [x] **新增观察态基准** `pnpm e8:perf`：两种场景宽度（1k / 8k，同深度）× 观察数
      0/16/64。断言 ①导出记录数等于观察数（否则"什么都没测"会看起来像完美扩展）、
      ②零观察 p95 < 5µs、③上界 64 时 p95 < 200µs、④场景放大 8 倍时导出成本增长
      < 3 倍。实测：零观察 0.04–0.17µs，上界 64 时 1k 场景 7.4µs / 8k 场景 9.0µs，
      增长 **1.25 倍**。残余依赖来自 `positions` 的 O(log n) 查找，是对数项不是
      线性项——线性会直接顶穿 ④。

### Task E8-4: Host 通道与三 transport 一致性

**Files:** `packages/host/src/{main-thread.ts,worker-client.ts,worker-protocol.ts,
hosted-root.ts}`

- [ ] `onLayoutGeometry` 回调 + 每帧 `emitLayoutGeometry()`（照 `emitSemantics`）。
- [ ] Worker 协议消息 + 主线程回放路径。
- [ ] `HostedRoot` 侧维护 nodeId → 最新几何的表，并暴露给 Runtime。
- [ ] feature flag（默认关闭，设计门 D8）：关闭时不发 `ObserveGeometry`，
      不注册回调。
- [ ] **只采用 `frameSeq` 与已应用 DisplayList 匹配的几何帧**，不匹配即丢弃
      （设计门 D9）。不依赖发送顺序。
- [ ] 契约测试：SAB / postMessage / 主线程 Canvas2D 三条 transport 下几何帧内容一致；
      故意乱序投递时几何被丢弃而非错帧应用；断言 `frameSeq` 一致性——单靠"顺序对"
      测不出来，多数帧布局相同，用错帧看不出差别。

### Task E8-5: Runtime `useLayoutValue` 与公开面

**Files:** `packages/runtime/src/hooks.ts`、`packages/reconciler`、
`packages/facade`、api 快照

- [ ] `useLayoutValue(ref, selector)`：挂载时发 `ObserveGeometry`，卸载时撤销；
      selector 结果 `Object.is` 不变则不触发重渲染。
- [ ] 首帧返回 `undefined`；flag 关闭或 `enabled: false` 时恒为 `undefined`，
      且**不发 `ObserveGeometry`、不占额度**（设计门 D1/D2）。
- [ ] 同一节点被多处订阅只观察一次（引用计数）。
- [ ] **Shell 侧执行上界**：本地持有计数，越界订阅入 FIFO 队列，名额释放时自动补发。
      只靠 Core 拒绝会让被拒订阅永久停在 `undefined`——命令已发出，不会重试。
- [ ] 单测：第 65 个订阅进队列且不发命令；前面某个卸载后队首自动补发并拿到几何；
      dev 模式下越界有带组件上下文的告警。
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
- [ ] **锚点观察以 `enabled: open` 绑定打开状态**，不绑定 trigger 挂载。
      回归断言：渲染 100 行、每行一个未打开的 Popover，观察数为 0。
- [ ] 首帧 `visibility: hidden`，测得几何后显形（设计门 D6）；
      per-component 可选退回"先猜后校正"。
- [ ] flag 关闭时四个组件行为与今天逐字节一致（回归断言）。
- [ ] storybook 增"贴边 / 可滚动容器内 / 长列表"三个展区，明暗都覆盖。

### Task E8-8: 门禁与文档回写

- [ ] `pnpm m1:check`（含覆盖率门槛）、`m2:check`、`m3:*`、`m5:backend:diff`、
      `release:check`、`migration:check`、`storybook:build` 全绿。
- [ ] WASM 体积：新增通路的 gzip 增量记入 `docs/wasm-size-attribution.md`。
      体积主要是加载期成本，可由预加载与流式编译摊薄，因此**允许侵占工程预算
      （393,216）到产品预算（409,600）之间那 16,384 的既有余量**——那段本就是
      为此预留的。**不上调产品预算**：它是 `docs/design.md` 的产品要求，且低端机
      冷启动的编译时间随模块大小走，预加载藏不住。要守的是记录纪律，不是数字：
      每次增量都要有归因，不允许"体积不重要"退化成"不再测量"。
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

| 风险                     | 缓解                                                                    |
| ------------------------ | ----------------------------------------------------------------------- |
| 几何导出拖累帧时         | 观察集有界；两个矩形在几何循环外重算，零观察时该路径不执行（D4 方案 3） |
| 慢一帧导致打开卡顿观感   | D6 首帧隐藏；必要时 per-component 退回"先猜后校正"                      |
| 观察泄漏（订阅未撤销）   | 引用计数 + 卸载断言 + `maxObservedGeometryNodes` 硬上界兜底             |
| 策略在滚动容器内算错边界 | 边界取 Core 裁剪框 ∩ 视口，storybook 专设可滚动容器展区                 |
| 整条通路不达预期         | feature flag 默认关闭，关掉即回到今天的静态方向；ABI 纯增量无需回退     |
