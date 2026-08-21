# E5 设计门：flexGrow / flexShrink / flexBasis

- 状态：Accepted
- 日期：2026-08-22
- 关联计划：[`pingo-ui-implementation-plan.md`](./pingo-ui-implementation-plan.md) Track B E5
- 关联设计：[`design.md`](./design.md) §12.1、[`css-events-plan.md`](./css-events-plan.md)
- 出口门禁：见本文 §9，与总计划"待执行步骤的验收标准 / E5"逐条对应

## 1. 问题

M6 CSS 子集已交付 `flexDirection` / `justifyContent` / `alignItems`，但没有主轴伸缩。
`css-events-plan.md` §188 明确写着 "grow/shrink/basis 在正确性 oracle 建立后追加"。

缺失造成两处具体阻塞：

1. **pingo-ui Input 的 `prefix`/`suffix` slot 无法实现**：slot 与输入区共处一行时，
   输入区必须吃掉剩余主轴空间。没有 `flexGrow` 只能写死像素宽度。
2. **A1 执行期实证缺陷**：`overflow` 非 `visible` 的容器内，子节点百分比宽/高解析为
   `0`。Progress 组件已用"去掉 `overflow: hidden`"规避。总计划风险表要求本设计门
   一并给出结论。

## 2. 事实取证

以下均从当前仓库代码读出，不是假设。

### 2.1 布局是单遍、显式栈、深度优先

`core/pingo-layout/src/engine.rs::compute_subtree` 用 `Vec<Frame>` 显式栈遍历，
子节点在下压时用父 `Frame.child_constraints` 约束测量，在弹出时把外框尺寸累加进
`parent.main` / `parent.cross`。父节点弹出时才知道自身 `size`，随后
`arrange_children` 第二次遍历子节点，只写 `offsets`，不改 `sizes`。

结论：主轴伸缩需要一次**真正的重新测量**（子树可能因主轴尺寸变化而改变换行、
文本高度、孙节点布局），不能在 `arrange_children` 里改写尺寸了事。

### 2.2 百分比归零的根因

`make_frame` 中：

```rust
if scene.scrollable_axis(node, true)  { child_constraints.max_width  = f32::INFINITY; }
if scene.scrollable_axis(node, false) { child_constraints.max_height = f32::INFINITY; }
```

`scrollable_axis` 对 `overflow: auto | hidden | scroll` 均返回 `true`
（`core/pingo-scene/src/scene.rs:795`）。子节点的百分比基准来自
`percentage_basis(incoming.max_*, incoming.min_*)`，而

```rust
fn percentage_basis(maximum: f32, minimum: f32) -> f32 {
    if maximum.is_finite() { maximum } else { minimum }
}
```

`INFINITY` → 落到 `minimum`（常为 `0.0`）→ 百分比解析为 0。

根因是**"测量约束"与"百分比基准"被混为同一个量**。滚动容器的测量约束必须无限
（内容要能溢出），但百分比基准应当是容器自身的 content box —— 这与 CSS 一致：
百分比针对 containing block 的 content box，不针对可滚动内容区。

### 2.3 编码链路已经通用

`packages/reconciler/src/computed-style-resource.ts::encodeValue` 对 canonical
`f32` 与 `length` 已有分支；`ComputedStyleResource::decode` 按 `StyleProperty`
元数据解码。新增两个 `f32` 属性和一个 `length` 属性**不需要改二进制布局**，
只需 schema + 生成代码 + 语法解析。

### 2.4 feature bit 目前不是真实闸门

`packages/style/src/resolver.ts:24` 与 `stylesheet.ts:59` 把
`STYLE_FEATURE_BITS` 全量 OR 写进能力快照；`computed-style-resource.ts` 把
`STYLE_ALL_FEATURE_BITS` 写进资源头；Core 只校验"不含未知位"。因此当前的
feature bit 只是"这个 Shell 说自己是哪个子集版本"，**没有任何按属性的拒绝行为**。

## 3. 决策

### D1：新增三个 longhand + 一个 Shell shorthand

| CSS 名        | JS 名        | id  | grammar               | canonical | initial | 继承 | animation | percentageReference    |
| ------------- | ------------ | --- | --------------------- | --------- | ------- | ---- | --------- | ---------------------- |
| `flex-grow`   | `flexGrow`   | 59  | `non-negative-number` | `f32`     | `0`     | 否   | `number`  | `none`                 |
| `flex-shrink` | `flexShrink` | 60  | `non-negative-number` | `f32`     | `1`     | 否   | `number`  | `none`                 |
| `flex-basis`  | `flexBasis`  | 61  | `length-auto`         | `length`  | `auto`  | 否   | `number`  | `containing-main-size` |

`appliesTo`：全部六种 node type（与 `width` 一致）。
`invalidation`：`["layout", "paint", "hit", "scroll"]`，`affects`：`["layout", "hit", "scroll"]`
——与 `width` / `flexDirection` 完全一致，满足总计划"invalidation 域与 flexDirection 一致"。

**不进 `stateStyleProperties`**：这三项含 `layout`，schema 校验会直接拒绝
（`generate-style.mjs` 第 206 行显式检查 layout/scroll 反馈环）。

新增 grammar `non-negative-number`（TS 类型 `number`）：接受有限非负数与其字符串
形式，canonical 为 `f32`。

**shorthand `flex`**（Shell 展开，不进 ABI）：

| 输入                                     | grow | shrink | basis  |
| ---------------------------------------- | ---- | ------ | ------ |
| `flex: none`                             | 0    | 0      | `auto` |
| `flex: auto`                             | 1    | 1      | `auto` |
| `flex: <number>`                         | n    | 1      | `0px`  |
| `flex: <number> <number>`                | a    | b      | `0px`  |
| `flex: <number> <length\|auto>`          | a    | 1      | basis  |
| `flex: <number> <number> <length\|auto>` | a    | b      | basis  |
| `flex: <length\|auto>`                   | 1    | 1      | basis  |

**与 CSS 的已知偏差**：CSS 规定 `flex: <number>` 的 basis 为 `0%`，本实现用 `0px`。
理由：`0%` 在 basis 不确定的容器中会退化为 `auto`，而 `0px` 恒定确定；两者在确定
容器中数值相同。此偏差写入 `docs/style-support.md`。

### D2：主轴伸缩用"栈驱动两遍"，不引入递归

`compute_subtree` 的显式栈是为了避免深树爆栈，不能因为 flex 改成递归。

`Frame` 增加 `flex_pass: FlexPass`（`Initial` / `Resolving`）与 `flex_targets`
（`Vec<(NodeId, f32)>`，只装**主轴尺寸确实要改**的子节点）。

弹出流程：

```
弹出 frame
  ├─ 计算 intrinsic / natural / size（不变）
  ├─ 若 flex_pass == Initial 且 resolve_flex(...) 产出非空 targets：
  │     frame.flex_pass = Resolving
  │     frame.flex_targets = targets
  │     重置 main/cross/placed/next_child，把 frame 压回栈 → 循环自然重新下降
  └─ 否则：写 sizes、arrange_children、把外框尺寸累加给父 frame（不变）
```

第二遍下降时：

- 子节点**在 `flex_targets` 中** → 正常压栈，`constraints_for_child` 把主轴收紧为
  `min == max == target_outer_main - margin`，整棵子树按新主轴尺寸重算。
- 子节点**不在 `flex_targets` 中** → **不下降**。直接读 `output.sizes[index]`
  累加进 `parent.main` / `parent.cross`，`offsets` 由随后的 `arrange_children` 重写。

这条"只重算真正变化的子树"是复杂度的关键：一个容器里 1 个 `flex:1` 子节点、
9 个固定子节点，第二遍只重算 1 棵子树，不是 10 棵。

**复杂度与可观测性**：嵌套 grow 链上第二遍会沿链传播，最坏 `O(2^d)`（d = 真正发生
伸缩的嵌套 flex 容器深度）。非伸缩容器只走一遍，代价为零。为了让这条风险可测，
`LayoutMetrics` 新增：

- `flex_resolutions: u64` —— 触发第二遍的容器数
- `flex_relayouts: u64` —— 第二遍中被重算的子树数

`m1:perf` / `m3:perf` 门禁沿用绝对帧时目标；上述计数器进入诊断输出，用于定位
"某帧 flex 重算爆炸"。

### D3：伸缩求解按 CSS §9.7 的冻结循环实现

单行（子集不含 `flex-wrap`），in-flow 子节点集合 = 非 `display:none` 子节点。

1. **hypothetical main size**：
   - `flex-basis` 确定（px，或 % 且主轴基准确定）→ base = 该值（`content-box` 时加内边距）
   - `flex-basis: auto` → 回落主轴尺寸属性（row 用 `width`，column 用 `height`）
   - 两者皆 auto → base = 第一遍测得的内容尺寸
   - base 夹进 `[min_main, max_main]`
2. `free = content_main - Σ(outer hypothetical) - Σ gap`
3. `free > 0` 用 grow 因子，`free < 0` 用 shrink 因子（按 `shrink_i × base_i` 加权），
   `free == 0` 直接结束。
4. 因子为 0 的项立即冻结；grow 时 base 已达 max 的、shrink 时 base 已达 min 的立即冻结。
5. 循环：分配 → 夹 min/max → 统计 violation 总和 → violation > 0 冻结所有下越界项、
   < 0 冻结所有上越界项、== 0 全部冻结。迭代次数 ≤ 子节点数。
6. `Σgrow < 1` 时只分配 `Σgrow` 比例的剩余空间（与浏览器一致）。

**与 CSS 的已知偏差（重要）**：CSS 的 flex item 有 "automatic minimum size"
（`min-width: auto` 解析为 min-content）。本子集 `min-width` / `min-height` 的
initial 是 `0px`（见 schema），没有 `auto` 值，也没有 min-content 测量。因此
**本实现的 flex item 可以被压缩到 0**，等价于浏览器里到处写 `min-w-0`。
这是显式取舍：避免引入 min-content 内在尺寸子系统。写入 `docs/style-support.md`。

**执行期新增决策 1：可滚动主轴不做 shrink。** `overflow` 非 visible 的轴上，
`child_constraints` 已被显式放宽到无限——这是"内容溢出即滚动区"的语义。若在同
一根轴上再执行 shrink，会把滚动容器存在的理由（可滚动的溢出内容）直接压没。
因此 `resolve_flex` 在 `free < 0 && scrollable_axis(container, main)` 时返回空。
grow 不受影响（视口比内容长时仍然拉伸）。写入 `docs/style-support.md`。

**执行期新增决策 2：缺失的 flex 因子按"不可伸缩"处理。** Shell 的
`resolveStyle` 对每个适用属性都会写出解析值（含 initial），所以任何被 Shell 样式
化的节点一定携带显式的 `flexShrink`（至少是 initial `1`）。反过来，**完全没有
computed style 资源的节点走的是 legacy direct-prop 路径**（滚动/虚拟列表子系统与
Core 测试用的 `Prop::Width` 等），从未选择加入 CSS 盒模型。因此 Core 取不到值时
默认 `grow = 0`、`shrink = 0`，而不是 CSS 的 `shrink = 1`。这条区分让 CSS 语义对
CSS 节点完全成立，同时保证既有 direct-prop 场景（如横向滚动的 cell 行）零回归。

### D4：修正百分比基准（分离"测量约束"与"百分比基准"）

`Frame` 增加 `percent_width` / `percent_height`，取值为**滚动轴覆盖之前**的
`child_constraints.max_*`。新增 `PercentBasis { width, height }` 随
`constraints_for_child` 一起下传给子 `make_frame`，子节点用它替代
`percentage_basis(incoming.max_*, incoming.min_*)` 里的 `max_*`。

`constraints_for_child` 对 basis 做与 constraints 相同的 margin 扣减，因此在
**非滚动轴上逐字节等价于今天的行为**；只有滚动轴上从 `INFINITY`（→0）变成容器
content box。这是一处缺陷修复，不是语义扩张。

**明确不修的相邻问题**：`flex-direction: column` 且父高度不确定时，百分比高度仍
解析为 `0`。CSS 规定此时行为等同 `auto`。本次不动，因为改它会波及全部现有
column 布局；作为已知缺口写入 `docs/style-support.md`。

### D5：feature bit 变成真实闸门

- schema `features` 增加 `{ "name": "flex-sizing", "bit": 1 }`，三个新属性
  `feature: "flex-sizing"`；`cssSubsetVersion` 升到 `1.2.0`。
- **Shell**：`computed-style-resource.ts` 的资源头 `featureBits` 从"全量 OR"改为
  "本资源实际用到的属性的 feature 位 OR"。能力快照（`resolver.ts` /
  `stylesheet.ts`）仍报告全量支持，两者语义不同：能力 = 我支持什么，资源头 = 我用了什么。
- **Core**：`ComputedStyleResource::decode` 增加逐条校验——
  `property.feature_bits() & header_feature_bits != property.feature_bits()` 即拒绝
  （`AbiError::InvalidValue`），事务性拒绝，不产生部分状态。

由此得到精确的降级行为：不认识 `flex-sizing` 的 Core 只拒绝**真正用到 flex 属性**
的资源，其余资源照常解码。回滚 = 从 schema 移除三条属性并重新生成，旧 Core 立即
恢复全量兼容。

兼容影响：资源头字节从"恒为 `STYLE_ALL_FEATURE_BITS`"变为"按内容"。所有现有
Rust 侧测试夹具写的是全量位，是所用位的超集，仍然通过。`abiVersion` 不变——
计算样式资源的二进制布局没变，变的是 header 值域的收窄与一条新校验。

## 4. Reference oracle

总计划要求"reference oracle 建立且先于语法开放"。

新增 `core/pingo-layout/src/reference.rs`，导出
`reference_layout(scene, root, constraints, measurer) -> ReferenceLayout`：

- **递归**实现（对照组的遍历策略与被测实现不同）
- 不含增量、不含 relayout boundary、不含双缓冲、不含 SoA——每个节点返回
  `(Size, Vec<(NodeId, Point, Size)>)`
- flex 伸缩直接按 §D3 的规格顺序写，不做"只重算变化子树"的优化：**所有**子节点在
  第二遍都重新递归布局
- 虚拟列表不在 oracle 范围（`virtual_list` 节点直接返回错误，property test 不生成）

它是**差分预言机**，按 AGENTS.md"Performance work must preserve the unoptimized /
reference path"永久保留，不得为了让测试通过而向被测实现靠拢。

property test（proptest，带 shrinking）：随机生成 flex 树（方向、gap、justify、
align、grow/shrink/basis、min/max、固定尺寸），断言
`engine.snapshot()` 与 `reference_layout` 的每节点 offset/size 在 `1e-3` 内一致。

## 5. 受影响文件

```
schemas/style.v1.json                                +3 属性 +1 shorthand +1 grammar +1 feature
scripts/generate-style.mjs                           grammarTypes 增加 non-negative-number
packages/style/src/generated.ts                      生成
core/pingo-abi/src/style_generated.rs                生成
docs/style-support.md                                生成（含 §D1/§D3/§D4 偏差说明）
packages/style/src/values.ts                         non-negative-number 解析 + flex shorthand 展开
packages/reconciler/src/computed-style-resource.ts   featureBits 按实际用量
core/pingo-abi/src/computed_style.rs                 逐条 feature gate
core/pingo-layout/src/engine.rs                      PercentBasis、flex 两遍、metrics
core/pingo-layout/src/reference.rs                   新增 oracle
core/pingo-layout/src/lib.rs                         导出
packages/ui/src/input.tsx / input.scss                prefix/suffix slot（出口后）
```

## 6. 备选方案

| 方案                                      | 未采用原因                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| 递归重排（Taffy 式）                      | 破坏显式栈的抗爆栈保证；深树是本引擎的核心场景                                      |
| 在 `arrange_children` 里直接改尺寸        | 子树不重新测量，文本换行/孙节点几何全错；是伪实现                                   |
| 用 `f32` 存 basis 的三态（auto/px/%）     | canonical `length` 已有 `auto` 单位，重复造轮子                                     |
| 百分比问题留给 E3                         | 已有产品级规避在生产代码里（Progress），欠债在涨；且 flex-basis 的 % 依赖同一条基准 |
| 不加 feature gate，只加属性               | 降级行为不可测；违反 Track B 统一约束                                               |
| 引入 min-content 以支持 `min-width: auto` | 需要完整内在尺寸子系统，远超 E5 范围；显式记为偏差                                  |

## 7. 失败模式

| 失败模式                   | 表现         | 检测                                                        |
| -------------------------- | ------------ | ----------------------------------------------------------- |
| 冻结循环不收敛             | 布局 hang    | 迭代上限 = 子节点数，超出返回 `LayoutError::SceneInvariant` |
| 第二遍与第一遍尺寸振荡     | 帧间抖动     | 第二遍不再触发第三遍（`flex_pass` 单向），结果确定          |
| 嵌套 grow 链重算爆炸       | 帧时尖峰     | `flex_relayouts` 计数器 + `m1:perf` 绝对门禁                |
| 百分比基准修复改变现有布局 | 既有页面回归 | 非滚动轴逐字节等价（§D4）+ 全仓回归                         |
| feature gate 误拒          | 样式整体失效 | 逐条 gate 单测 + 往返测试                                   |

## 8. 回滚

1. **属性级**：schema 删除三条属性 + `flex` shorthand，`pnpm style:generate`。
   Shell 解析器把 `flexGrow` 等视为未知属性并产出 `unknown-property` 诊断；
   Core 的 `resolve_flex` 因取不到属性恒返回空 targets，退化为今天的单遍布局。
2. **feature gate 级**：schema 移除 `flex-sizing` feature，资源头回落到只声明
   `m6-foundation`；旧 Core 全量兼容。
3. **百分比修复级**：`percent_width/height` 改回直接取 `child_constraints.max_*`
   即可复原旧行为（一处赋值）。

三级互相独立，可单独回滚。

## 9. 出口门禁（与总计划逐条对应）

1. 本文档评审通过（含 oracle 选型与 overflow 百分比语义结论）—— §4、§D4。
2. reference oracle 先于语法开放：`reference.rs` 与其 property test 与 schema
   变更在同一提交序列中，且 oracle 提交在语法开放提交之前。
3. 增量↔全量 layout 差分通过，失败可 shrinking 到最小：proptest。
4. schema / 生成代码 / `style-support.md` 原子同步；invalidation 域与
   `flexDirection` 一致：`pnpm contracts:check`。
5. `pnpm rust:test` 绿；`m1:perf` / `m3:perf` 不劣化。
6. 出口后补齐 Input `prefix` / `suffix` slot：descriptor 测试 + storybook 展区。
