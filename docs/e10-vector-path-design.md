# E10 设计门：矢量路径（SVG 基础能力）

- 状态：Accepted
- 日期：2026-08-22
- 关联计划：[`pingo-ui-shadcn-parity-plan.md`](./pingo-ui-shadcn-parity-plan.md) 中被移出范围的 Chart
- 定位：**SVG 是基础能力，Chart 是业务**。先做前者，否则会得到一套只服务图表的路径系统。

## 1. 现状：骨架已预留，从未实现

三处已经存在，且都是空的：

| 位置                           | 状态                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `ResourceKind::Path = 3`       | 已占号；Scene 显式忽略（`ResourceKind::Path \| GlyphSpan => {}`）  |
| `DisplayOpcode::FillPath = 18` | ABI 编解码齐全；**Core 从不产出**                                  |
| Canvas2D 后端                  | `FillPath` 重放完整，`definePath(id, Path2D)` 已就位；**无人调用** |

所以 ABI 不需要重新编号。缺的是资源布局、Core 侧产出、Headless 光栅化，以及 Shell
侧的 `d` 语法解析。

## 2. 决策

### D1：路径是不可变资源，不是节点属性

几何是可共享的批量数据——一个图标用 50 次应当只有一份。资源号 3 已预留。

### D2：布局为 verb 数组 + point 数组

头部：`version`、`fillRule`、`verbCount`、`pointCount`、`viewBox`（四个 f32）。
verb 为 u8（`Move=0` `Line=1` `Quad=2` `Cubic=3` `Close=4`），补齐到四字节对齐；
point 为 f32 对。

这是 Skia 与 `Path2D` 的共同形状，与 Canvas2D 调用一一对应，后端不需要中间表示。

### D3：不新增 node kind，用 Container 上的 `Path` ref 属性

新增一个 node kind 要在 layout、hit、semantics、虚拟化各处复制 Container 的全部
表面，只为多一次绘制调用。改为：任何容器节点带 `Prop::Path`（ref，id 37）时，
paint 用路径填充/描边替代圆角矩形背景。

**代价**：一个节点只能画一条路径。多路径图形用多个兄弟节点表达，这也正是 SVG 的
`<g>` 结构。

### D4：viewBox 在资源里，缩放到节点内容盒

路径自带 viewBox，paint 据此把它缩放进节点的内容盒。这样一个图标资源在 16px 和
48px 的节点里都直接可用，不需要调用方换算。

### D5：描边是独立指令，不是 Paint 的字段

新增 `StrokePath { path_id, paint_id, width, cap, join, miter }`（opcode 19）。
lucide 这类图标库是**以描边为主**的，只做填充等于做不了图标。

不做虚线（`dash`）：它需要沿路径的弧长参数化，是独立工程。

**修订（实现期，2026-08-23）：headless oracle 支持描边。** 交付时曾以"合规的
stroker 是独立工程，近似的会让 oracle 撒谎"为由拒绝描边。该理由只对了一半，而且对
错的那一半是更常用的那个：

- headless 有两种用途。**m5 后端差分**（GPU vs oracle）确实需要与另一渲染器一致，
  而描边的 join 几何与曲线扁平化容差是实现定义的，浏览器之间都不一致；
- 但更常用的是**增量重绘 vs 全量重绘**的自比较（`pingo-core` 的多条测试），那里要的
  只是**确定性**，与 Canvas2D 是否一致无关。原判断把前者的标准套到了整个 renderer。

而且 Core 目前只发 **round cap + round join**，在既有的采样架构下，圆头圆角描边的
覆盖区域**恰好等于**"到折线距离 ≤ 宽度/2"——这是精确解，不是近似，不需要构造偏移轮廓、
不需要解自交、没有 join 几何可以做错。非圆的 cap/join 仍然按 `UnsupportedCommand`
拒绝，因为对它们采样就不再精确了，而 Core 也还不产生它们。

**仍然成立的边界**：这个 oracle 不试图逐像素匹配 Canvas2D，也做不到——曲线扁平化容差
是实现定义的。它给的是确定性参考。

### D6：Shell 解析 `d` 语法，Core 只吃二进制

`M m L l H h V v C c S s Q q T t A a Z z` 全支持。圆弧 `A` 转成三次贝塞尔——不转的话
大量真实图标直接坏掉，而 Core 不应该为了一种曲线类型增加一个 verb。

不做 SVG **文档**解析（`<svg>` `<g>` `<circle>`…）：形状元素都能等价成路径，文档层
属于 Shell 的适配器，不属于引擎。

### D7：命中测试用节点盒，不是路径轮廓

精确轮廓命中需要扫描线，而图标的可点区域本来就该是它的盒子。Container 的既有行为
即是所求，无需改动。

## 3. 不做

- 渐变与图案填充（需要新的 Paint 资源种类）
- 虚线描边（需要弧长参数化）
- SVG 文档 / `<use>` / `<defs>` / 滤镜 / 蒙版
- 精确路径命中
- 非圆 cap/join 的 headless 光栅化（采样对它们不再精确；Core 也不产生它们）
