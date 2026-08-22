# E8 设计门：布局回读（`useLayoutValue`）与碰撞感知定位

- 状态：**Accepted**（2026-08-22 逐条讨论通过，无未决项）
- 批准范围：D2 / D3 / D4 / D9 与体积口径逐条讨论确认；D5 由需求方直接拍板（裁剪边界
  取视口）；D1 / D6 / D7 / D8 随本文一并接受，未逐条辩论
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
  options?: { readonly enabled?: boolean }, // 默认 true
): T | undefined;
```

`enabled: false` 时不发 `ObserveGeometry`，也不占额度，返回 `undefined`。这不是便利
开关，是额度正确性的前提——见 D2 的"观察绑定 open 状态"。

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

**观察的生命周期绑定 open 状态，不绑定 trigger 挂载。** 面板那半边天然安全——面板只
在打开时才挂载。锚点这半边不是：`Popover` 根与 trigger 是常驻的，若在 trigger 挂载时
就观察，一个 100 行、每行一个 Popover 的表格在一个都没打开时就占满 100 个额度。因此
锚点观察必须以 `enabled: props.open` 表达（D1 的 `options.enabled` 正是为此存在）。

**内容复杂度不消耗额度。** 定位策略只需要锚点 rect、面板 rect 与边界，面板里是三个
按钮还是两百条命令项都一样，所以一个打开的弹层恒为 2 个观察。增长的是同时打开的浮层
数量：四级级联子菜单全开是 8，再叠一个 Dialog 内的 Popover 与 Tooltip 约 12–16，
对 64 仍有四倍以上余量。

**为什么不让 Core 每帧发全场景几何**：那是 O(节点数) 的每帧分配，直接违反
"避免每帧对象分配"与"显式有界数据契约"。观察集的大小由 Shell 的实际订阅数决定，
浮层场景是个位数。

`limits.maxObservedGeometryNodes = 64` 给观察集上界，否则 Shell 可以通过大量观察把
Core 拖成全场景导出。

取 64 的依据：一个打开的弹层是"锚点 + 面板"两个观察，同时开两个已属罕见，即 ~4；
64 留出 16 倍余量覆盖尺寸自适应与测量类组件，同时比场景规模低两个数量级
（m1 基准 5000 节点），"防止退化成全场景导出"的目的成立。成本上限是每帧 64 条
× 10 words ≈ 2.5 KB，加祖先链重算约 64 × 树深 ≈ 2000 步。

**上界分两层执行。**

- **Shell 是策略层。** 观察全部由 Shell 创建，因此它知道当前计数，在本地就拦住越界
  订阅并排入 FIFO 队列，名额释放时自动补发。
- **Core 是防御性兜底。** 解码器是信任边界，即使字节由本项目产生（AGENTS.md），
  所以硬上界必须在 Core 一侧独立成立：超限时**只拒该条 `ObserveGeometry`**，
  同帧其余 mutation 照常提交，绝不无界分配。

**为什么不是整帧拒绝**：畸形字节是协议被破坏，超限是资源策略，两者性质不同。让一个
正当但订阅偏多的应用整帧提交失败，是把"测量太多"升级成"应用不可用"。

**超限后的可见表现**：该节点不出现在几何帧 → `useLayoutValue` 恒返回 `undefined`
→ 组件走静态方向，与 D8 的 flag 关闭路径完全相同。弹层照常打开、位置正确，只是
不翻转/不收缩/不隐藏；不会白屏、错位或抖动。

**为什么策略层必须在 Shell**：若上界只由 Core 执行，被拒的订阅不会自动重试——命令已
发出，名额释放后它仍是 `undefined`，直到组件重新挂载。这是难以自查的行为。Shell 侧
持有计数与队列才能消除它。

**必须吵**：`frameDiagnostics` 增 `observeGeometryRejected` 计数；dev 模式下 Host
输出带节点与组件上下文的告警。允许安全降级，不允许安静地降级。

**Tradeoff**：多一条 Shell→Core 状态；换来的是几何导出成本与场景规模解耦。

### D3：新通道 `layoutGeometryBatch`，形状照搬编辑几何

版本化 `Uint32Array` 帧，`abiVersion` 19 → 20。头部为 `version` / `frameSeq` /
`recordCount`（`frameSeq` 的用途见 D9），每条记录 10 words：

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

**每帧发全部被观察节点，不做增量。** 增量要求 Core 保存上一帧 rect 并逐条比较——两者
都是 O(观察数)，和直接发出去同一量级，省下的只有线上字节，而本通道搭已有帧泵顺风车
（`packages/host/src/main-thread.ts` 的 `emitEditingGeometry` / `emitSemantics` 同一处），
不产生额外唤醒。另外两点：全量帧自足，golden 直接比字节，而增量帧的含义依赖上一帧
状态，replay 必须先重建它；更要紧的是增量让"缺席"产生歧义——某 nodeId 未出现在本帧
批次，是"没变"还是"不再被观察／节点已销毁"？两者要用不同方式响应，消歧就得再加显式
移除信号。第一个踩中它的正是 `hide`：锚点滚出容器时必须能区分"clip 退化为空"与"这帧
没提它"。

**Tradeoff**：观察集上界若将来大幅提高，全量的每帧线上成本才会变得可见，届时应拿实测
重新评估增量；在当前上界下预先做增量属于以协议复杂度换取不存在的收益。

### D4：几何循环一行不改，两个矩形在循环外按需重算

`core/pingo-hit/src/lib.rs` 的几何循环里同时持有 `own_aabb` 与 `inherited_clip`，
但 `WorldGeometry` 只保留两者的交集。有三种取法，选第三种：

1. 把 `own_aabb` 加进 `WorldGeometry`——每节点 +16 字节常驻，落在 hit 热路径的 SoA
   上，为个位数的观察节点让整场景付费。**否决。**
2. 循环里把被观察节点写进旁路小表——隐含每节点一次"是否被观察"判断；即使用
   `observes_any()` 门控，只要存在一个观察者，全场景就要付这个判断。**否决。**
3. **循环外重算。** `WorldGeometry` 已经存了 `transform` / `width` / `height`，而
   `own_aabb` 就是 `transform.rect_aabb(width, height)`；裁剪框是 `axis_clip` 对祖先
   链的纯折叠，每个祖先的 `own_aabb` 同样可重算。因此只需在循环结束后，对被观察
   节点各走一遍祖先链。**采纳。**

|        | 每节点常驻内存 | 每帧成本             | 零观察时        |
| ------ | -------------- | -------------------- | --------------- |
| 方案 1 | +16 字节       | 0                    | 0（但内存已付） |
| 方案 2 | 0              | O(场景) 判断         | 一次布尔读      |
| 方案 3 | **0**          | **O(观察数 × 树深)** | **不执行**      |

**前提**：观察不会逼出本不发生的计算——`paint_frame` 每帧无条件调 `hit.update`
（`core/pingo-core/src/engine.rs`），`build_world_geometry` 本就对全场景算过这两个量。
重算是拿已知输入再算一遍，不是新增一趟遍历。

**Tradeoff**：同一份数据算两次（一次在循环里用于交集，一次在循环外用于导出）。用
`O(观察数 × 树深)` 的重复计算，换零常驻内存与零观察时的零成本；观察集有界，树深是
数十量级，这个交换在浮层场景下明显划算。若将来观察数上界大幅提高，应重新评估方案 1。

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

首帧隐藏还顺带解开一处循环：`size` 要知道面板的**自然尺寸**才能决定是否约束，而
约束之后量到的已不是自然尺寸。首帧不施加约束、量到自然尺寸，第二帧再约束，循环消失，
且仍然只需 2 个观察。

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

### D9：几何帧用 `frameSeq` 与 DisplayList 对齐，不靠发送顺序

Worker 模式下 DisplayList 与几何帧都经 `postMessage` 到主线程，先后不定。若 Shell 拿
一帧的几何去校正另一帧的画面，弹层会在显形瞬间按错误位置定位一次、下一帧才修正——
一次可见跳动，恰是 D6 要消除的东西。

几何帧头部携带 `frameSeq`（与 `frameDiagnostics` 同源）。

**修订（实现期，2026-08-22）：判据是"不回退"，不是"与已应用的 DisplayList 匹配"。**
原文的匹配规则在 worker 模式下无法成立——那里由 worker 渲染到 OffscreenCanvas，主线程
**根本不应用 DisplayList**，没有可匹配的对象；而且几何帧若总是早于帧报告到达，"不匹配
即丢弃"会让该节点永远停在陈旧值。

实际规则：Shell 只接受 `frameSeq` **不小于**已持有几何的帧，更旧的直接丢弃并计数。
这样 Shell 始终持有最新一次测量，而这正是定位策略想要的——校正本来就要晚一帧生效，
用最新测量严格优于用"与当前画面同帧"的旧测量。要防的危害只有一个：把浮层挪回它先前
的位置，而单调接受恰好排除它。

**为什么不是"规定几何在 DisplayList 之后发"**：那依赖发送侧的代码顺序，任何人重排两
行就悄悄破坏，而且测不出来——多数帧的布局相同，用错帧的几何看不出差别。带标记之后，
契约测试可以直接断言 `frameSeq` 一致性。

**为什么不把几何塞进 DisplayList 帧当一个 section**：那让纯渲染通道背上非渲染数据，
并破坏"Canvas2D replay 是一个薄的、分配敏感的 typed-array 循环"这条不变量。

**Tradeoff**：每帧多 4 字节（头部，非每记录）与 Shell 侧一次比较；顺序错乱时最坏是慢
一帧显形，而不是定位错误。丢弃的帧计入 `staleLayoutGeometryFrames()`，所以乱序不是
静默发生的。

## 3. 不做

- 同步布局读取（`useLayoutEffect` 语义）——`docs/design.md` 明确排除。
- 任意计算下沉到 Core 的 selector——会把用户代码搬进 Worker 热路径。
- 把策略下沉到 Core 做成定位属性——见
  [`overlay-auto-flip-design.md`](./overlay-auto-flip-design.md) §3 B 方案。它能做到
  首帧正确，但要扩 CSS 子集并同步 oracle/hit/paint/golden；在 D1–D7 落地后可作为
  叠加优化重新评估，不在本设计门内。
- `autoPlacement`（自动挑最佳边）——`flip` 的超集，等前四条有真实使用反馈再说。

## 4. 未决问题

无。立项时的三条均已定稿：

| 问题                      | 结论                                          | 落点 |
| ------------------------- | --------------------------------------------- | ---- |
| 几何帧全量还是增量        | 全量                                          | D3   |
| 观察上界取值与超限行为    | 64；单条拒绝 + 降级，Shell 策略层 / Core 兜底 | D2   |
| 与 DisplayList 的同帧顺序 | 不约定顺序，用 `frameSeq` 对齐                | D9   |

讨论中另外修正了三处：D4 由"循环内旁路表"改为"循环外重算"（我的错，非取舍）；
D1 增加 `enabled` 并把观察绑定到 open 状态（否则 100 行未打开的 Popover 会占满额度）；
E8-8 的体积口径改为允许侵占工程→产品之间的既有余量，但不上调产品预算。
