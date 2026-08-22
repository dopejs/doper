# pingo-ui 对齐 shadcn：缺口收敛计划

> **进度（2026-08-22）：全部完成。** E9 `6fca724`；A4 `b77fba5` `df5a8db` `bb06278`
> `3eb00dd`；A5 `03f43a4`；A6 `840c42b`；A7 与 storybook / README 收尾见末次提交。
> 组件数 25 → 46，`pnpm m1:check` 等全量门禁通过。

**Goal:** 把 pingo-ui 从 25 个 shadcn 对应组件补到 46 个，并补齐一个引擎能力
（contextmenu 事件）。范围与优先级由需求方 2026-08-22 逐条裁定，见 §0。

**前置：** E8（布局回读 + 碰撞感知定位）已完成，Scroll Area 依赖它。

---

## 0. 范围裁定（需求方决定，不要擅自扩缩）

| 档             | 内容                          | 裁定                     |
| -------------- | ----------------------------- | ------------------------ |
| A 纯组合       | 13 个，原料齐全               | **必做**                 |
| B 能力已有未做 | Slider / Resizable / Carousel | **必做**                 |
| C-Table        | Table + Data Table            | **必做，且自带虚拟滚动** |
| C-Calendar     | Calendar / Date Picker        | **必做**                 |
| C-ScrollArea   | Scroll Area                   | **必做**                 |
| C-ContextMenu  | Context Menu                  | **必做，属基础能力**     |
| C-AspectRatio  | Aspect Ratio                  | 低优先级，排在最后       |
| C-Chart        | Chart                         | **暂不做**               |

Chart 需要组件层的矢量路径节点（`nodeKinds` 只有 Root/Container/Text/Image/
EditableText/Scroll/Video，`FillPath` 是 Core 内部指令），是独立工程，不混进本计划。

## 1. 两个决定形态的结论

### D1：Table 由显式 column spec 驱动，不模拟 table 布局

虚拟滚动与内容驱动列宽在原理上互斥——未渲染的行无法参与测量。因此 Table 的列宽由
一份 `columns: { key, header, width | flex, align }[]` 决定，表头与每一行共用同一份
spec；行是 `VirtualList` 的 `renderItem(index)` 产物。

这不是对"没有 table 布局"的让步：shadcn 的 Table 是纯 `<table>`，它**无法虚拟化**。
带虚拟滚动的表格在任何技术栈上都是 column-spec 驱动的。

### D2：Scroll Area 用 E8 的几何回读自绘滚动条，不新增引擎能力

引擎没有 `onScroll`，但滚动会平移内容节点，因此观察视口与内容两个节点即可导出：

- 滚动偏移 = `viewport.bounds.top - content.bounds.top`
- 内容尺寸 = `content.bounds.height`
- 拇指长度比 = `viewport.bounds.height / content.bounds.height`

**已知限制**：与 E8 的一切一样晚一帧，甩动时拇指会滞后一帧。彻底解决要 Core 渲染
滚动条，属后续工作，本计划不做。

---

## Track A4：纯组合批（13 个，无引擎依赖）

**Files:** `packages/ui/src/components/*`、`packages/ui/styles/components/*`、
`packages/ui/src/index.ts`、storybook

- [x] `AlertDialog`：Dialog 之上的确认语义（title/description/cancel/action）。
- [x] `Collapsible`：Accordion 的单项基元，供 Sidebar 分组等复用。
- [x] `Toggle` / `ToggleGroup`：Button 变体 + 受控/非受控选中态。
- [x] `Breadcrumb`：分隔符是文本字形，随图标体系一并升级。
- [x] `Pagination`：页码列表 + 上下页，键盘左右移动。
- [x] `HoverCard`：Popover + 悬停延迟开合（用指针进出事件，非 CSS hover）。
- [x] `Combobox`：Command + Popover + 受控值，复用既有筛选。
- [x] `Menubar`：横向 DropdownMenu 组，方向键跨菜单移动。
- [x] `NavigationMenu`：Menubar 的导航语义变体。
- [x] `InputOTP`：N 个单字符 Input + 焦点自动前移/回退 + 粘贴分发。
- [x] `Drawer`：Sheet 的底部/顶部方向变体。
- [x] `Form`：字段包装 + 错误位 + `aria` 关联；校验器由调用方注入，不内置。
- [x] 每个组件：descriptor 单测（结构/受控/键盘/明暗）+ skin 断言 + storybook 展区。

## Track A5：交互批（3 个，能力已有）

- [x] `Slider`：指针按下即 `setPointerCapture`，拖拽映射到值域；键盘方向键步进。
- [x] `Resizable`：同一套拖拽基元，改为改变兄弟节点的 flex 基准。
- [x] `Carousel`：transform 位移 + `TransitionSpec`（引擎只支持 opacity/transform，
      正好够用）。
- [x] 抽出共用的 `useDrag(handle, onDelta)` 基元，三者复用，单测覆盖捕获与释放。

## Track A6：数据与表面批（5 个）

- [x] `Table`：按 D1 的 column spec；表头非虚拟，表体 `VirtualList`。
- [x] `DataTable`：Table 之上的排序/筛选/选择，状态由调用方持有。
- [x] `Calendar`：7 列固定宽度网格，月份翻页，键盘方向键移动日期。
- [x] `DatePicker`：Popover + Calendar + Input 显示值。
- [x] `ScrollArea`：按 D2 自绘滚动条；限制写进 README。
- [x] `ContextMenu`：依赖 E9；在 E9 之前不启动。
- [x] Table 单测须覆盖：列宽 spec 生效、虚拟窗口只渲染可见行、表头与行列对齐。

## Track E9：contextmenu 事件（引擎）

**Files:** `schemas/protocol.v1.json`、`core/pingo-abi`、`core/pingo-core`、
`packages/jsx`、`packages/reconciler`、`packages/host`

按 E1 的既有形状做，不发明新机制：

- [x] `abiVersion` +1；`InputOpcode::DispatchContextMenu`；`InputEventKind::ContextMenu`。
- [x] ABI 编解码 + golden + TS↔Rust 往返 + malformed/fuzz。
- [x] Core：按命中测试路由（与 pointerdown 同路径），不改交互状态。
- [x] Shell：`PingoEvent` 增 `"contextmenu"`，`CommonProps` 增 `onContextMenu`。
- [x] Host：canvas `contextmenu` 监听并 `preventDefault`，三 transport 顺序一致。
- [x] 触屏长按是否合成 contextmenu：**本计划不做**，需要单独的手势设计。

## Track A7：收尾（低优先级）

- [x] `AspectRatio`：`aspect-ratio` 不在 CSS 子集，先用"宽度已知则按比例算高度"的
      组件级实现；是否进子集另行决策。

---

## 横向差距（价值高于任何单个组件）

本计划**不含**下列四项，但它们对观感的影响大于补齐 20 个组件，应尽快单独立项：

1. **图标体系**：Checkbox 的 `✓`、Accordion 的 `▾` 是文本字形，依赖字体覆盖。
   shadcn 的视觉一致性有一半来自 lucide。
2. **过渡动画**：`AnimatedProperty` 只有 `opacity` / `transform`，无 CSS
   `transition`/`animation`。accordion 展开、skeleton 脉冲、switch 滑动目前全是跳变。
3. **焦点环**：没有 `outline-*`，也没有 `:focus-within`。
4. **`flex-wrap` / `text-decoration` / `letter-spacing`** 不在子集。

## 验收标准

| 层       | 要求                                                             |
| -------- | ---------------------------------------------------------------- |
| 组件单元 | 每组件 descriptor 测试：结构、受控/非受控、键盘、禁用、明暗      |
| 皮肤     | `styles.test.ts` 断言新增 token 与层级                           |
| 虚拟化   | Table 断言可见窗口外的行未被渲染                                 |
| ABI      | E9：golden bytes、往返、malformed、fuzz；`pingo-abi` 行覆盖 ≥95% |
| 全仓     | `pnpm m1:check`、`storybook:build`、`api:check` 全绿             |

## 风险

| 风险                                | 缓解                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| Table 的 column spec API 一次定不准 | 先落 Table，DataTable 在其上叠加；spec 只增字段不改语义 |
| ScrollArea 拇指滞后被当成 bug       | README 明写晚一帧的成因与彻底解法                       |
| A4 十三个组件稀释注意力，质量滑坡   | 每个组件独立提交，出口门禁不因批量而放宽                |
| E9 拖住 ContextMenu                 | A6 其余四个不依赖 E9，可并行                            |
