# @dopejs/pingo-ui

## 是什么

shadcn 心智的 pingo 原生组件库：组件 API 与皮肤语义对齐 shadcn/ui，渲染目标是
pingo canvas 引擎而不是 DOM。以 npm 包分发（`publishConfig.access: public`，发布
产物为 `dist/` + `styles/`），运行时是纯 TS——组合 `@dopejs/pingo-jsx` 原语、
`@dopejs/pingo-widgets` 的 Pressable、`@dopejs/pingo-editing` 的
TextEditingController 与 `@dopejs/pingo-runtime` 的 hooks/signal，对引擎零改动依赖。

## 快速开始

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/pingo";
import { Button, Input, createPingoUiStyleSheet } from "@dopejs/pingo-ui";

const root = await createHostedCanvasRoot(canvas, {
  styleSheets: [createPingoUiStyleSheet()],
});

root.render(createElement(Button, { children: "保存", onPress: () => save() }));
// 输入框：受控/非受控皆可，onValueChange 回报 controller 应用后的当前值
root.render(createElement(Input, { value: "", onValueChange: (v) => console.log(v) }));
```

`createPingoUiStyleSheet()` 为每个 root 创建一份独立的不可变 sheet；零配置路径
不需要接触 SCSS 工具链。

## 覆盖约定（重要）

- **用户 sheet 必须在 pingo-ui sheet 之后注册**：同优先级的规则按 source order
  覆盖，写在后面的 sheet 生效。即
  `styleSheets: [createPingoUiStyleSheet(), myOverrides]`。
- 组件的 `className` prop 追加在组件自身类名之后（如
  `pui-input pui-input--disabled mine`）。注意：覆盖生效的依据是上面的 sheet 注册
  顺序（同优先级按 source order），与类名在 className 字符串里的位置无关。

## 主题

```ts
import { setTheme, useTheme } from "@dopejs/pingo-ui";

setTheme("dark"); // 所有订阅组件自动重渲染
useTheme(); // 在组件 render 内读取并订阅
```

主题是一个模块级 signal；组件 render 中 `useTheme()` 由 reconciler 的 observer
tracking 自动订阅，`setTheme` 触发全部订阅组件重渲染。深色通过 compound class
机制实现：dark 主题下组件挂 `pui-dark` 标记类，皮肤里的 `.pui-x.pui-dark`
复合规则命中（如 `.pui-card.pui-dark`）。

**品牌定制**是构建期行为：新建 preset 文件用
`@use "@dopejs/pingo-ui/styles/tokens" with ($primary: ...)` 覆盖 token，经
`@dopejs/pingo-style-preprocess` 的 Vite 插件重新编译组件皮肤——改品牌色 = 重新
构建，运行时不可换。

token 契约（名称、类型、适用组件）随包版本化：**新增 token 走 minor，改名/删除
走 breaking**。token 值的颜色只能写 hex 或 `rgb()`/`rgba()`/`hsl()`/`hsla()`——
颜色关键字（如 `red`）不受支持，会被编译拒绝。

## 组件使用约束

- 所有组件都是 `memo` 包装对象，props 浅比较命中才跳过重渲染——命中要求调用方
  传稳定的 handler 引用，inline 的 `onValueChange={() => ...}` 每次渲染都是新
  引用，memo 失效（与 React.memo 同语义）。
- **有 hooks 的组件必须经 `createElement(Component, props)` / JSX 使用，直接
  函数调用没有组件作用域会抛错**：Input、TextArea、RadioGroup、Tabs、
  Accordion，以及 TabsTrigger、TabsContent、RadioGroupItem、AccordionItem；
  第二批的 Dialog、Sheet、Popover、Tooltip、DropdownMenu、Select、Command 及其
  Trigger/Content/Item 同理；第三批的 Sidebar、SidebarItem 同理
  （TopBar、StatCard、ListRow、SidebarSection 只读主题，可直接
  `Component.component(props)` 调用）。
  纯展示组件的底层函数可用 `Component.component(props)` 调用（测试场景），但
  统一走 createElement 最安全。

## 组件清单

29 个组件。第一批 17 个：

| 组件         | 导出                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| Button       | `Button`                                                                     |
| IconButton   | `IconButton`                                                                 |
| Badge        | `Badge`                                                                      |
| Card 族      | `Card` `CardHeader` `CardTitle` `CardDescription` `CardContent` `CardFooter` |
| Input        | `Input`                                                                      |
| TextArea     | `TextArea`                                                                   |
| Label        | `Label`                                                                      |
| Divider      | `Divider`                                                                    |
| Skeleton     | `Skeleton`                                                                   |
| Alert        | `Alert`                                                                      |
| Avatar       | `Avatar`                                                                     |
| Progress     | `Progress`                                                                   |
| Switch       | `Switch`                                                                     |
| Checkbox     | `Checkbox`                                                                   |
| RadioGroup   | `RadioGroup` `RadioGroupItem`                                                |
| Tabs 族      | `Tabs` `TabsList` `TabsTrigger` `TabsContent`                                |
| Accordion 族 | `Accordion` `AccordionItem`                                                  |

第二批弹层 8 个：

| 组件            | 导出                                                                          |
| --------------- | ----------------------------------------------------------------------------- |
| Dialog 族       | `Dialog` `DialogHeader` `DialogTitle` `DialogDescription` `DialogFooter`      |
| Sheet           | `Sheet`（`side: "left" \| "right"`）                                          |
| Popover 族      | `Popover` `PopoverTrigger` `PopoverContent`                                   |
| Tooltip         | `Tooltip`（指针进入显示）                                                     |
| DropdownMenu 族 | `DropdownMenu` `DropdownMenuTrigger` `DropdownMenuContent` `DropdownMenuItem` |
| Select 族       | `Select` `SelectTrigger` `SelectContent` `SelectItem`                         |
| Command         | `Command`                                                                     |
| Toast           | `Toast` `ToastViewport`                                                       |

第三批产品分子 4 个（shadcn superset，由前两批组合而成）：

| 组件       | 导出                                     |
| ---------- | ---------------------------------------- |
| TopBar     | `TopBar`                                 |
| Sidebar 族 | `Sidebar` `SidebarSection` `SidebarItem` |
| StatCard   | `StatCard`                               |
| ListRow    | `ListRow`                                |

产品分子是 `flexGrow` 的第一批真实用法：TopBar 的标题列、StatCard 的数值、
ListRow 的文本列都是伸缩件，尾部 slot 因此落在边缘，不需要任何测量。

第四批 shadcn 对齐 21 个（计划见 `docs/pingo-ui-shadcn-parity-plan.md`）：

| 组件        | 导出                                     | 备注                             |
| ----------- | ---------------------------------------- | -------------------------------- |
| AlertDialog | `AlertDialog`                            | 两个按钮均在 Tab 循环内          |
| Collapsible | `Collapsible`                            | Accordion 的单项基元             |
| Drawer      | `Drawer`                                 | Sheet 的上下方向变体             |
| Toggle 族   | `Toggle` `ToggleGroup` `ToggleGroupItem` | 单选/多选规则在组上              |
| Breadcrumb  | `Breadcrumb`                             | 末项是当前页，不是链接           |
| Pagination  | `Pagination` `paginationRange`           | 省略规则是纯函数                 |
| HoverCard   | `HoverCard`                              | 指针进出 + 延迟，非 CSS hover    |
| Combobox    | `Combobox`                               | Command + 触发器值绑定           |
| Menubar 族  | `Menubar` `MenubarMenu` `NavigationMenu` | 一个共享的展开位                 |
| InputOTP    | `InputOTP` `applyOtpEdit`                | 定长补空格，第 i 格恒等 value[i] |
| Form        | `Form` `FormField`                       | 不含校验，规则由调用方持有       |
| Slider      | `Slider` `sliderRatio`                   | 指针捕获 + 方向键                |
| Resizable   | `Resizable` `clampSplit`                 | 第二栏取 flex 余量               |
| Carousel    | `Carousel` `carouselStep`                | transform 过渡                   |
| Table       | `Table` `columnStyle` `alignClass`       | **自带虚拟滚动**                 |
| DataTable   | `DataTable` `nextSort`                   | 上报排序，不重排数据             |
| Calendar    | `Calendar` `monthGrid` `daysInMonth`     | 日期是分量，不是 `Date`          |
| DatePicker  | `DatePicker` `formatDate`                | Calendar + Popover               |
| ScrollArea  | `ScrollArea` `scrollbarThumb`            | 自绘滚动条，**晚一帧**           |
| ContextMenu | `ContextMenu`                            | 需 E9 的 contextmenu 事件        |
| AspectRatio | `AspectRatio` `ratioHeight`              | 测量宽度反推高度，**晚一帧**     |

拖拽基元 `createDrag` / `useDrag` / `positionToValue` 也一并导出，Slider、
Resizable 共用它；指针捕获在按下时取得、结束时释放，否则指针一离开节点拖拽就断。

**Table 为什么没有 table 布局**：虚拟滚动与内容驱动列宽在原理上互斥——没渲染过的
行无法参与测量。列宽由显式的 `columns` spec 决定，表头与每一行共用同一份。shadcn
的 Table 是纯 `<table>`，它**无法虚拟化**；这不是退让，是虚拟化表格唯一的形态。

**弹层的两条硬约束**（都源自引擎语义，见 `docs/style-support.md`）：

1. **视口型必须挂在靠近根的容器下**：Dialog / Sheet / ToastViewport 用
   `position: absolute` 铺满**自己的父节点**，因为本引擎的包含块是父节点而不是
   最近的 positioned 祖先。挂在一个小容器里，它就只覆盖那个小容器。
2. **锚定型自动跟随，不需要重新定位**：Popover / Tooltip / DropdownMenu / Select
   把浮层放在 trigger 的同一个 `.pui-anchor` 包装里，几何由 Core 从父节点推出，
   滚动时天然跟随；没有 JS 的每帧重定位，也没有自动翻转（`placement` 需要
   "布局后回读"，与异步 `useLayoutValue` 契约冲突）。

另有 `cva`（class-variance 工具）、`setTheme` / `getTheme` / `useTheme`、
`createPingoUiStyleSheet` / `pingoUiCssText` 从包根导出。

## 已知缺口

- Input / TextArea 无 placeholder（superset API，待引擎工作包落地后补）。
  `prefix` / `suffix` slot 已随 E5（flexGrow/flexShrink/flexBasis）落地：
  field 用 `flex: 1 1 0px` 吃掉装饰件剩下的行宽。TextArea 仍无 slot。
- 无 focus ring：pingo 没有 `:focus-within`，且边框挂在 shell 上（待选择器能力落地）。
  `boxShadow` 本身已随 E4 可用（Card 已用 `$shadow-sm`），只支持外阴影、每节点最多
  4 层，`inset` 会被拒绝；完整偏差见 `docs/style-support.md`。焦点本身是可见的（Core 有 focus/focus-visible 状态），
  缺的只是描边样式。
- 键盘导航（E1 已落地）：Tabs 用 Left/Right/Home/End，RadioGroup 用四向方向键，
  Accordion 用 Up/Down 移动焦点、Enter/Space 展开，DropdownMenu / Select /
  Command / Sidebar 用 Up/Down（Sidebar 另有 Home/End），所有弹层用 Escape 关闭。键事件只送达**当前焦点
  节点**，因此组件必须先被点击或程序聚焦；引擎不内建 Tab 顺序。
- **弹层的 Tab 遍历需要显式登记**：Core 没有 tab order（`docs/e1-keyboard-events-design.md`
  §D4），因此 Tab 本身不会移动焦点，焦点也不会从弹层"漏"出去——真正缺的不是陷阱，
  而是键盘用户根本进不到面板内的控件。Dialog / Sheet / Popover 现在通过
  `useFocusableRef(order)` 提供这条通路：面板内的控件按 `order` 登记，Tab /
  Shift+Tab 在登记项之间循环，Escape 仍然关闭；没有登记任何控件时 Tab 不被吞掉。
  `order` 由调用方给出而非自动发现——面板内容是任意子树，Shell 无法判断哪些是
  可达控件、以什么顺序可达。
- **`ScrollArea` 与 `AspectRatio` 晚一帧**：两者都靠 E8 的布局回读，而测量在它描述
  的那一帧之后才到。ScrollArea 表现为甩动时拇指滞后一帧，AspectRatio 表现为首帧没有
  高度（宁可无高度也不猜，猜错要先按错的尺寸布局再挪）。彻底解法分别是 Core 渲染
  滚动条、把 `aspect-ratio` 纳入 CSS 子集，均记在
  `docs/pingo-ui-shadcn-parity-plan.md`。
- **`Table` 的列宽必须显式给出**：见上文，虚拟滚动与内容驱动列宽互斥。
- **`DataTable` 只上报排序**：重排要把全部行都渲染出来，正是虚拟化要避免的事。
- **触屏长按不会合成 contextmenu**：`ContextMenu` 目前只响应真实的 contextmenu
  事件，长按手势需要单独的手势设计（E9 明确不做）。
- **弹层的碰撞感知定位**：`flip` / `shift` / `size` / `hide` 随 E8 实现
  （`packages/ui/src/positioning.ts`），无需配置。定位**晚一帧**——测量本身要等一帧
  布局结果，所以弹层的首帧用皮肤给的静态方向，位置正确但尚未翻转/收缩。边界取
  "引擎上报的有效裁剪框 ∩ 视口"，因此可滚动容器内的弹层受容器约束而不是受画布约束。
  设计见 `docs/e8-layout-readback-design.md`。
- Skeleton 无 pulse 动画（Core 动画只覆盖 opacity/transform，CSS keyframes 不在
  子集内）。
- Switch thumb 无滑动过渡（同上，thumb 直接跳变）。
- Checkbox 的 `✓` 与 Accordion 的 `▾` 是文本字形，显示效果依赖字体覆盖，图标
  资产就绪前是占位实现。
- 引擎行为（已修复，E5）：`overflow` 非 visible 的容器内子元素百分比尺寸曾解析为
  零；百分比现在按容器自身 content box 解析。Progress 的规避（track 不开
  overflow）保留，因为 indicator 宽度本就由 0–100% clamp 保证不溢出。
- 引擎行为（仍存在）：主轴不确定时百分比解析为 `0` 而不是 CSS 的 `auto`；
  flex item 没有 CSS 的 automatic minimum size，可被压缩到 0（等价于浏览器里
  到处写 `min-w-0`）；`position: absolute` 的包含块是**父节点**而不是最近的
  positioned 祖先，因此绝对定位元素必须是它所对齐的盒子的直接子节点，
  也没有 `position: relative`。完整偏差清单见 `docs/style-support.md`。
