# E8 设计门：布局回读（`useLayoutValue`）与碰撞感知定位

- 状态：Proposed（待批准）
- 日期：2026-08-22
- 关联计划：[`pingo-ui-e8-implementation-plan.md`](./pingo-ui-e8-implementation-plan.md)
- 前置：E3（`position: absolute` + inset，已完成 `6c72939`）
- 背景与方案取舍：[`overlay-auto-flip-design.md`](./overlay-auto-flip-design.md)

## 1. 问题

`docs/design.md` §1940 承诺了 `useLayoutValue(nodeRef, selector)`——异步一帧返回的
布局回读，用来替代 `useLayoutEffect` 的同步语义。它至今**没有实现**，仓库里没有
任何实现或调用点。

缺它的直接后果是浮层只有静态方向：`Popover` / `DropdownMenu` / `Select` /
`Tooltip` 无法知道自己会不会溢出，因而没有 `flip` / `shift` / `size` / `hide`。
四条策略吃同一个输入——锚点绝对 rect、有效裁剪框、浮层自身尺寸——所以要立的项
是**碰撞感知定位**，而它的前置是布局回读。

收益不止浮层：尺寸自适应、虚拟化辅助、测量类组件都要这条通路。

## 2. 决策

### D1：公开 API 是 `useLayoutValue(ref, selector)`，异步一帧

```ts
function useLayoutValue<T>(
  ref: RefObject<NodeHandle | null>,
  selector: (geometry: LayoutGeometry) => T,
): T | undefined;
```

`LayoutGeometry` 是闭集记录（见 D3），`selector` 是在 **Shell 侧**运行的纯投影，
只用于变化比较：投影结果不变则不触发重渲染。首帧返回 `undefined`——节点还没被
布局过，没有可返回的真值，返回 `0` 会让调用方把"未知"当成"零"。

不提供同步读取。同步读会跨越双时钟边界，是 `docs/design.md` 明确排除的语义。

**Tradeoff**：调用方必须处理 `undefined` 与"慢一帧"。代价换的是不破坏双时钟，
以及不把用户代码搬进 Worker 热路径。

### D2：观察是显式的，通过 Mutation `ObserveGeometry`

新增 Mutation 命令 `ObserveGeometry`（opcode `96`，新分组）：`(nodeId, flags)`。
`flags == 0` 表示取消观察；节点销毁时观察自动失效（generation 已经保证陈旧 ID
不会复活）。

**为什么不让 Core 每帧发全场景几何**：那是 O(节点数) 的每帧分配，直接违反
"避免每帧对象分配"与"显式有界数据契约"。观察集的大小由 Shell 的实际订阅数决定，
浮层场景是个位数。

`limits.maxObservedGeometryNodes` 给观察集一个硬上界，超出即拒绝提交——否则
Shell 可以通过大量观察把 Core 拖成全场景导出。

**Tradeoff**：多一条 Shell→Core 状态；换来的是几何导出成本与场景规模解耦。

### D3：新通道 `layoutGeometryBatch`，形状照搬编辑几何

版本化 `Uint32Array` 帧，`abiVersion` 19 → 20。每条记录 10 words：

| 字段                        | 说明                                |
| --------------------------- | ----------------------------------- |
| `nodeId`                    | 带 generation                       |
| `flags`                     | 保留位必须为零                      |
| `ownLeft/Top/Width/Height`  | **未裁剪**的根坐标 rect（f32 bits） |
| `clipLeft/Top/Width/Height` | 有效裁剪框（f32 bits）              |

**为什么两个矩形**：只发交集不够。锚点被完全滚出容器时交集退化为空，位置信息随之
丢失，而那正是要判定 `hide` 的时刻。只发未裁剪 rect 也不够——那就丢了 `flip` 要的
边界。

头部、截断/版本/保留位校验、malformed 拒绝全部照 `editingGeometryBatch` 的既有形状，
不发明新约定。

### D4：不加宽 `WorldGeometry`，用旁路小表

`core/pingo-hit/src/lib.rs` 的几何循环里已经同时持有 `own_aabb` 与 `inherited_clip`，
但 `WorldGeometry` 只保留两者的交集。

**不**把 `own_aabb` 加进 `WorldGeometry`：那是每节点 +16 字节常驻，落在 hit 热路径的
SoA 上，为了个位数的观察节点让整场景付费。改为在同一循环里把**被观察节点**的
`own_aabb` 与裁剪框写进一张容量等于观察集的旁路表。

**Tradeoff**：几何循环里多一次"是否被观察"的判断。用 Scene 提交期维护的位图回答
（与 `StyleCapabilities` 同一手法，见 `2933441`），未观察任何节点时该判断退化为一次
布尔读。

### D5：裁剪边界是视口 ∩ 有效裁剪框，视口由 Shell 提供

外边界是视口——在 pingo 中即 canvas 根节点的盒子，Shell 本来就拥有它
（`HostedRoot.resize` 由 Shell 驱动）。

但视口只是外边界：锚点位于可滚动 / `overflow: hidden` 的 View 内部时，滚动容器先裁。
Core 已经在算这个交集（D4 引用的 `inherited_clip`，且 `axis_clip` 按轴累积，
`overflow-x: hidden` 不会误裁 y），所以 Shell 不需要走祖先链。最终边界 =
通道返回的裁剪框 ∩ Shell 自己的视口，在 Shell 求交。

**与"包含块是父节点"偏差无关**：定位基准（`left`/`top` 从哪个盒子算）与裁剪边界
（浮层必须待在谁里面）是两个独立问题。策略产出的是位移量；无 `transform` 时父空间
位移等于世界空间位移，有 `transform` 时用 `WorldGeometry.transform` 求逆精确换算。

### D6：首帧以 `visibility: hidden` 挂载

浮层打开的第一帧没有测量结果，必须二选一：接受一帧跳变，或先隐藏。选后者——弹层
的一帧跳变非常显眼，而 `visibility: hidden` 在子集内、占布局空间、不影响几何计算
（`visible` 只门控可命中性，不门控几何循环）。

**Tradeoff**：打开慢一帧。可通过"静态方向先猜、测得后校正"降级为跳变，作为
per-component 选项，不作默认。

### D7：定位策略是纯函数，上线顺序 `size` → `shift` → `flip` → `hide`

每条策略是 `(anchor, panel, bounds, side) => 位移/尺寸约束` 的纯函数，与通道解耦，
可单独单测。顺序按本组件集的实际触发频率排，不按生态知名度排：长列表 Select 撑破
容器比 Tooltip 贴边常见得多。

### D8：feature flag 与回滚

整条通路挂在一个 Host 选项后（默认关闭），关闭时 `useLayoutValue` 始终返回
`undefined`，组件退回 D7 之前的静态方向。回滚路径是关 flag，不需要回退 ABI——
`abiVersion` 20 对 19 是纯增量，旧 Shell 不发 `ObserveGeometry` 即得到旧行为。

## 3. 不做

- 同步布局读取（`useLayoutEffect` 语义）——`docs/design.md` 明确排除。
- 任意计算下沉到 Core 的 selector——会把用户代码搬进 Worker 热路径。
- 把策略下沉到 Core 做成定位属性——见
  [`overlay-auto-flip-design.md`](./overlay-auto-flip-design.md) §3 B 方案。它能做到
  首帧正确，但要扩 CSS 子集并同步 oracle/hit/paint/golden；在 D1–D7 落地后可作为
  叠加优化重新评估，不在本设计门内。
- `autoPlacement`（自动挑最佳边）——`flip` 的超集，等前四条有真实使用反馈再说。

## 4. 未决问题

1. 几何帧是每帧发全部被观察节点，还是只发变化的？后者需要按节点比较上一帧的 rect。
   建议先做全量（观察集本就有界），有实测再优化。
2. `maxObservedGeometryNodes` 取值。建议 64 起，需要用 Storybook 的真实弹层数量校准。
3. Worker 模式下几何帧与 DisplayList 的顺序保证：同帧内先后是否需要固定。
