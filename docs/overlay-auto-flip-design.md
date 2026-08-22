# 设计门：锚定弹层的碰撞感知定位

- 状态：**Blocked / 待决策**（未实现，不要按已实现对待）
- 日期：2026-08-22
- 关联计划：[`pingo-ui-implementation-plan.md`](./pingo-ui-implementation-plan.md) 残余风险
- 前置：E3（`position: absolute` + inset，已完成）

## 1. 问题

`Popover` / `DropdownMenu` / `Select` / `Tooltip` 现在只有**静态方向**：内容始终
按皮肤给定的一侧（默认锚点下方）展开。锚点靠近容器下沿时，内容会溢出到可视区
之外——在 `overflow: hidden` 的容器里直接被裁掉，在可滚动容器里变成额外滚动区。

**"自动翻转"是这个缺口的窄化说法。** 浮层定位实际需要一族策略，翻转只是其中一条：

| 策略    | 作用                          | 在本组件集里的触发场景         |
| ------- | ----------------------------- | ------------------------------ |
| `flip`  | 空间不足时翻到对侧            | Tooltip / Popover 贴近容器边缘 |
| `shift` | 沿轴滑动以保持可见            | 锚点靠近角落，比 flip 更常触发 |
| `size`  | 约束 max-height，内容内部滚动 | 长列表 Select / DropdownMenu   |
| `hide`  | 锚点滚出裁剪框时隐藏浮层      | 可滚动列表里的 Popover         |

四者吃同一个输入：**锚点绝对 rect + 裁剪边界 + 浮层自身尺寸**。因此要立的项是
"碰撞感知定位"，`flip` 是建在它之上的一条策略。按本组件集的实际触发频率，
`size` 的价值不低于 `flip`——长列表 Select 溢出比 Tooltip 撞边常见。

CSS/浏览器生态用 `position-try` 或 Floating UI 这类"测量后重放"来解决。它们都
依赖一个共同前提：**能读到布局结果**。pingo 没有面向组件的这条通路，所以这不是
组件层能补的缺口。

## 2. 为什么现在做不了

- `NodeHandle` 只有 focus / 指针捕获 / 滚动，没有任何几何读取。
- 设计文档承诺的 `useLayoutValue(nodeRef, selector)`（`docs/design.md` §1940）
  **尚未实现**，仓库里没有任何实现或调用点。
- `scene-snapshot.ts` 是 Mutation 镜像，用于恢复，不是布局几何。

已有两条 Core→Shell 几何通道，但都不是通用查询：

- **编辑几何**（`parseEditingGeometry`）：单主体、跟随焦点，只服务 IME 与光标。
- **语义快照**（`pingo-core/src/engine.rs` 的 `Engine::semantics`）：对每个节点发
  `hit.geometry(node).aabb`，是**根坐标绝对 rect**。`anchorTriggerDescriptor` 本来
  就带 `semanticRole: "button"`，所以 Popover trigger 的绝对位置今天就在送往 Shell。

语义快照看似能直接拿来用，但四点都不成立，它是**可行性先例而不是捷径**：

1. 只有带 `semanticRole` / `semanticLabel` / `semanticValue` 或可编辑的节点入表。
   浮层内容 `.pui-anchor__content` 没有 role，不在其中——而 flip 恰恰要知道浮层
   自身多大。为拿定位数据给它加 role，是用污染无障碍树换几何。
2. 它是带字符串负载的**全量快照**，按无障碍节奏发送，不是查询通道。拿它定位会
   把定位耦合到 a11y 的发送时机与成本。
3. 仍然慢一帧：浮层要先被布局出来才量得到。
4. 裁剪边界"相对谁"没有答案——根？最近的可滚动祖先？Core 知道，Shell 不知道。

因此绕不过去：任何组件层实现都只能猜测尺寸，猜错的代价是弹层位置抖动，比不定位
更糟。语义通道的价值在于它证明这条管线的形状与成本是已知的：版本化 Uint32Array
帧、跨 Worker 传递、已有 malformed 拒绝路径，`useLayoutValue` 可以照搬。

## 3. 候选方案

### A：实现 `useLayoutValue`，定位策略留在 Shell

按设计文档补齐通用布局回读：Core 每帧发一个版本化的几何帧，Shell 侧按订阅分发，
组件测得溢出后改 class 重排。四条策略都在 Shell 用普通算术实现。

- 优点：兑现已承诺的公开 API，收益不止弹层（尺寸自适应、虚拟化辅助、测量类组件）；
  管线形状照搬语义快照，风险已知。
- 代价：新增公开 API + 新 ABI 通道 + 订阅生命周期；重排天然**慢一帧**，首帧会
  出现在错误一侧。需要 `docs/design.md` 更新。

### B：定位策略下沉到 Core，作为定位属性

仿 `position-try`：给绝对定位子节点一组候选边，Core 在 arrange 时按可用空间选边。

- 优点：零延迟，首帧就正确；不新增公开 API；不需要回读通道。
- 代价：**扩展 CSS 子集**（新属性 + 新关键字 + `cssSubsetVersion`），要同步
  reference oracle、hit、paint 与 golden；语义边界（相对谁测可用空间——父节点
  padding box？最近可滚动祖先？视口？）需要先定死，而当前包含块规则是"父节点"，
  与直觉上的"视口"不一致，容易做出一个看着对、换个容器就错的特性。

### C：不做，保持静态方向

把"锚点必须留出足够空间"作为使用约束写进文档（现状）。

- 优点：零成本、零风险。
- 代价：业务侧要自己保证布局，靠近边缘的场景需要手动指定方向。

## 4. 建议

**先 A，再考虑 B。** A 是已承诺的能力，收益面远大于弹层一个用例；B 在 A 之后仍
可作为"首帧正确"的优化叠加。在 A 落地前维持 C，并保证文档明说没有翻转——已写入
`packages/ui/README.md`。

A 落地后的策略顺序建议 `size` → `shift` → `flip` → `hide`，按本组件集的实际触发
频率排，不按 Floating UI 的知名度排。

不建议在没有 A 的情况下直接做 B：B 要先回答"相对谁"的语义问题，而这个问题和
§3 里"包含块是父节点"的既知偏差纠缠在一起，应当一起决策而不是分两次。

## 5. 未决问题

1. `useLayoutValue` 的 selector 粒度：整块 rect，还是按字段订阅以减少无效唤醒？
2. 几何帧是每帧全量还是只发变化节点？后者需要节点级脏标记。
3. 翻转慢一帧的首帧策略：先隐藏（`visibility: hidden`）再显示，还是接受一帧跳变？
