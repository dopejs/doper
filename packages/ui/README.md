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
  Accordion，以及 TabsTrigger、TabsContent、RadioGroupItem、AccordionItem。
  纯展示组件的底层函数可用 `Component.component(props)` 调用（测试场景），但
  统一走 createElement 最安全。

## 组件清单

17 个组件（27 个导出值）：

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
  Accordion 用 Up/Down 移动焦点、Enter/Space 展开。键事件只送达**当前焦点节点**，
  因此组件必须先被点击或程序聚焦；引擎不内建 Tab 顺序，跨组件的 Tab 循环由业务
  用 `ref` + `handle.focus()` 实现。
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
  到处写 `min-w-0`）。完整偏差清单见 `docs/style-support.md`。
