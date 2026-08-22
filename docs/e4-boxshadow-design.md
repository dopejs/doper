# E4 设计门：boxShadow

- 状态：Accepted
- 日期：2026-08-22
- 关联计划：[`pingo-ui-implementation-plan.md`](./pingo-ui-implementation-plan.md) Track B E4
- 前置：WASM 工程预算余量已由 `wasm-size-attribution.md`「2026-08-22 有序容器回收」恢复到 30,363 bytes

## 1. 问题

Card、Dialog、Popover、DropdownMenu、Toast 在 shadcn 里全部靠阴影建立层次。
`packages/ui/styles/components/card.scss` 顶部就写着「boxShadow intentionally
absent until engine work package E4 lands」。没有阴影，弹层与背景之间没有任何
视觉分离，A2 的八个弹层组件即使定位正确也不可用。

## 2. 事实取证

- `DisplayCommand`（`core/pingo-abi/src/display_list.rs:61`）已有
  `FillColorRRect { rect, radii, rgba }` 与 `FillColorBorder`，都是**内联颜色**指令，
  不经资源表；阴影可以走同一条路子。
- `build_node`（`core/pingo-paint/src/engine.rs:817`）按
  `Save → Transform → Alpha → ClipRect → 背景 → 图像 → 边框 → 装饰` 顺序发指令；
  阴影必须插在**背景之前**。
- `style_border_radius`（同文件 1206 行）已经把 `border-radius` 解析成一个 f32；
  阴影复用同一个圆角，不引入第二套圆角语义。
- `stateStyleProperties`（`schemas/style.v1.json`）里 `borderRadius`、
  `backgroundColor` 已在列，且 schema 校验会拒绝含 `layout`/`scroll` 失效域的项。
- Canvas2D 的 `shadowBlur` / `shadowColor` / `shadowOffsetX/Y` 在 `fill()` 时生效，
  且**不受 `spread` 支持**——CSS 的 spread 没有 Canvas2D 对应物。

## 3. 决策

### D1：canonical `shadow-list`，新 value tag 10

新增属性：

| CSS 名       | JS 名       | id  | grammar      | canonical     | initial | 继承 | animation  | 失效域               |
| ------------ | ----------- | --- | ------------ | ------------- | ------- | ---- | ---------- | -------------------- |
| `box-shadow` | `boxShadow` | 62  | `box-shadow` | `shadow-list` | `none`  | 否   | `discrete` | `paint`, `paintSelf` |

`appliesTo`：全部六种 node type。`affects`：`["paint"]`。
**进 `stateStyleProperties`**：hover 抬升是 shadcn 的基本手法，且失效域只含 paint，
不构成 layout 反馈环（schema 校验会验证这一点）。

canonical 文本形式：`none`，或以 `, ` 连接的 `<x>px <y>px <blur>px <spread>px <rgba8>`，
每个长度都归一到 px，颜色归一到 `#rrggbbaa`。

二进制载荷（value tag `shadowList = 10`）：

```
u32 count
count × { f32 offsetX, f32 offsetY, f32 blur, f32 spread, u32 rgba }
```

即 `4 + 20n` 字节，四字节对齐。上限 **4 个阴影**：足够覆盖 shadcn 的
`shadow-sm/…/2xl`（最多两层），留一倍余量，同时给解码器一个明确的拒绝点。

### D2：只支持外阴影，`inset` 显式拒绝

Canvas2D 画内阴影需要「反向路径 + clip」构造，成本与出错面都远高于收益，
而 shadcn 预设一个内阴影都没有。Shell 解析器遇到 `inset` 产出
`invalid-value` 诊断并丢弃该声明；文档写进 `style-support.md` 偏差清单。

### D3：`spread` 在 Core 展开，不传给 Canvas2D

Canvas2D 没有 spread。Core 在发指令时把 spread 折进矩形本身：
矩形外扩 `spread`，圆角 `max(0, radius + spread)`。剩下的 offset/blur/color
才是 Canvas2D 的原生能力。这样后端保持「薄回放循环」，不必自己理解 CSS 语义。

`blur` 到 `shadowBlur` 的换算：CSS 的模糊半径是标准差的两倍，Canvas2D 的
`shadowBlur` 也是两倍标准差，因此**一比一映射**，不做缩放。

### D4：新 DisplayList 指令 `FillColorShadow` = 42

```
FillColorShadow:
  f32 x, y, w, h            // 已折入 spread 的阴影矩形
  f32 radii[4]              // 已折入 spread 的圆角
  f32 offsetX, offsetY, blur
  u32 rgba
```

内联颜色，不进资源表——与 `FillColorRRect` 一致，避免为每个阴影建资源。

一个节点的多层阴影按**声明顺序倒序**发出（CSS 规定先声明的画在上层），
每层一条指令。

### D5：回放实现

```
ctx.save();
ctx.shadowColor = rgba;
ctx.shadowBlur = blur;
ctx.shadowOffsetX = offsetX;
ctx.shadowOffsetY = offsetY;
// 阴影只应画在盒子外：填充色用完全不透明的任意色，随后 restore。
roundRectPath(ctx, x, y, w, h, radii);
ctx.fill();
ctx.restore();
```

**已知偏差**：Canvas2D 会连同填充本身一起绘制。CSS 的外阴影不会画在 border box
底下，但那块区域随后就被背景/边框覆盖；只有当节点**背景透明**时才看得出差异
（CSS 下能看到阴影穿过盒子中心）。写进 `style-support.md`。

### D6：失效与缓存

`box-shadow` 的失效域是 `paint | paintSelf`。`paintSelf` 意味着只重建该节点
自己的 Picture，不动子树——hover 抬升因此只重绘一个盒子。这与
`backgroundColor` 的处理完全一致，不需要新的缓存规则。

## 4. 出口门禁

1. 本文档评审通过。
2. 增量↔全量像素差分一致，含 hover 阴影切换路径。
3. picture cache 失效正确性：阴影变化只失效 `paintSelf`。
4. rgba8 半透明阴影渲染正确（shadcn token 对齐）。
5. ABI golden bytes + TS/Rust 往返 + malformed/fuzz；公开面门禁按通用条款。
6. WASM 工程预算不被突破。

## 5. 备选方案

| 方案                       | 未采用原因                                                     |
| -------------------------- | -------------------------------------------------------------- |
| 阴影走 Paint 资源表        | 每个阴影一个资源 id 与一次注册往返，收益为零                   |
| 把 spread 传给后端         | Canvas2D 无对应能力，后端要自己算 CSS 语义，违反「薄回放循环」 |
| 支持 inset                 | 反向路径 + clip 的复杂度换 shadcn 用不到的能力                 |
| 用离屏 canvas 做真高斯模糊 | 每帧一次离屏合成，代价远超原生 `shadowBlur`                    |
| 阴影数量不设上限           | 解码器没有拒绝点，等于把内存放大交给输入                       |

## 6. 失败模式与回滚

| 失败模式                 | 表现           | 缓解                                               |
| ------------------------ | -------------- | -------------------------------------------------- |
| 阴影穿过透明盒子         | 与 CSS 不一致  | §D5 已知偏差，写入支持表                           |
| 阴影数量爆炸             | 每帧指令数上升 | 每节点 ≤4，超出解码即拒绝                          |
| hover 阴影导致全子树重绘 | 帧时尖峰       | 失效域只含 `paintSelf`，有缓存失效测试             |
| 后端不支持 `roundRect`   | 阴影缺失       | 复用 `FillColorRRect` 已有的圆角路径构造，能力一致 |

**回滚**：从 schema 移除 `box-shadow` 并重新生成，Shell 视其为未知属性；
Core 取不到值即不发阴影指令；`FillColorShadow` 指令保留但不再被发出，
可在后续 ABI 变更中移除。
