# E3 设计门：position: absolute + inset

- 状态：Accepted
- 日期：2026-08-22
- 关联计划：[`pingo-ui-implementation-plan.md`](./pingo-ui-implementation-plan.md) Track B E3
- 前置：E2（zIndex，已完成 `62850ea`）；m10 决策表 overlay/absolute positioning 已 Adopt

## 1. 问题

A2 的八个弹层组件需要把内容放在**流之外**：Dialog 覆盖视口中央、Popover 贴着锚点、
Toast 停在角落。当前子集只有 flex 流，任何"脱离流"的效果都做不出来。

## 2. 决策

### D1：只有 `static` 与 `absolute`

新增 keyword `absolute`、`static`；`position` 属性 grammar `positioning`，
canonical keyword，initial `static`。

不做 `relative`：它的唯一作用是建立包含块并做视觉偏移，而 §D3 让**每个元素都是
自己绝对定位子节点的包含块**，`relative` 因此没有语义可加；视觉偏移已有 `transform`。
不做 `fixed`/`sticky`：两者都要求相对视口或滚动容器的独立定位通道，属于后续工作。

### D2：`top`/`right`/`bottom`/`left` + `inset` shorthand

四个 longhand，grammar `length-auto`，initial `auto`，canonical `length`。
`inset` 是 Shell shorthand，按 CSS 的 1–4 值规则展开。

百分比基准：`left`/`right` 用包含块的 inline 尺寸，`top`/`bottom` 用 block 尺寸——
即 E5 引入的 `PercentBasis`，不需要新的基准概念。

### D3：包含块是**父节点的 padding box**

CSS 的规则是"最近的 positioned 祖先"。本子集改为**父节点**，理由：

1. 布局是显式栈的单遍算法，偏移量按父节点相对存储（`output.offsets` 就是父相对）。
   相对祖先定位需要额外累计"祖先到父节点"的偏移，等于在热路径上多带一份状态。
2. 父节点的可用 content box 是**下降时就已知**的量（`Frame::percent`，E5 引入），
   而祖先的最终尺寸要等它的子节点全部弹出才知道。
3. 覆盖 A2 的实际用法：Popover 挂在锚点下，Dialog/Toast 挂在 root 下。

**代价**：`position: relative` 祖先 + 深层 `absolute` 后代的 CSS 惯用写法不成立，
绝对定位子节点必须是包含块的直接子节点。写入 `docs/style-support.md` 偏差清单，
"最近 positioned 祖先"作为后续工作。

### D4：脱离流的布局路径

绝对定位子节点：

- **不参与主轴累计**：不进 `parent.main`/`parent.cross`，不吃 gap，不计入
  `justify-content` 的子节点数。容器的自动尺寸与它无关，这与 CSS 一致。
- **不参与 flex 伸缩**：不记入 `FlexScratch::items`。
- **约束**：显式声明的 `width`/`height` **按声明使用，允许溢出包含块**——与 CSS 一致，
  包含块提供原点与百分比基准，不是上限。未声明尺寸时：对边 inset 都不是 `auto`
  则由 `content - start - end` 定出尺寸；否则以包含块 content box 为上界收缩到内容
  （本子集对 CSS shrink-to-fit 的近似，因为没有 min/max-content）。
- **偏移**：`left` 非 auto 用 `left`；否则 `right` 非 auto 用
  `content_width - right - width`；两者都 auto 时落在 content box 原点
  （CSS 的 static position 在本子集里简化为原点，写入偏差清单）。
  纵向同理。偏移都加上父节点的 padding+border 内边距。
- **`align-items` / `justify-content` 不作用于它**：CSS 对绝对定位子节点也是如此。
  reference oracle 第一版曾对它套用 `align-items: stretch`，差分测试当场抓到。

### D5：hit / clip / semantics 不需要新语义

绝对定位只改变几何，不改变拓扑：节点仍是父节点的子节点，因此

- **hit**：世界几何由 offset/size 推出，绝对定位子节点自动跟随；叠加顺序由 E2 的
  z-index 决定。
- **clip**：父节点的 `overflow` 仍然裁剪它——与 CSS 对"包含块自身裁剪"的规定一致。
- **semantics**：顺序仍是文档顺序，与 E2 的结论一致。

### D6：与滚动容器的交互

绝对定位子节点位于父节点的 content box 内，因此**参与父节点的滚动内容尺寸**：
它随内容一起滚动。这是"包含块是父节点"的直接推论，也是 CSS 对
`position: absolute` 在滚动包含块内的行为。

### D7：relayout boundary

绝对定位节点的几何依赖父节点的 content box，与百分比同源，所以沿用 E5 建立的规则：
`is_fixed_boundary` 已经排除"读取父百分比基准"的节点；`top/right/bottom/left`
加入 `PERCENTAGE_SENSITIVE_PROPERTIES`，百分比 inset 的节点不做包含边界。

## 3. 出口门禁

1. 本文档评审通过。
2. layout/hit/clip/semantics 增量↔全量 oracle 一致（reference oracle 同步实现）。
3. 帧时与节点预算不回归。
4. feature bit 关闭后拒绝新值，且 flow layout 不变。
5. 与滚动容器交互的语义测试。

## 4. 失败模式与回滚

| 失败模式                       | 表现             | 缓解                                              |
| ------------------------------ | ---------------- | ------------------------------------------------- |
| 绝对定位子节点污染容器自动尺寸 | 容器被撑大       | 不进 main/cross 累计，有单测                      |
| 两侧 inset + width 同时给出    | CSS 要求丢弃一个 | 按 CSS：`left` 优先，`right` 被忽略；写入支持表   |
| 绝对定位 + flex 伸缩互相干扰   | 尺寸抖动         | 绝对定位子节点不进 flex item 列表，有 oracle 差分 |
| 深层 absolute 找不到期望的祖先 | 位置错           | §D3 显式偏差，README 与支持表都写明               |

**回滚**：从 schema 移除五个属性与 `inset` shorthand 并重新生成。Core 取不到
`position` 即视作 `static`，全部节点回到 flow 布局；`PERCENTAGE_SENSITIVE_PROPERTIES`
里多出的四项只会让包含边界更保守，不影响正确性。
