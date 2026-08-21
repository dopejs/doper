# pingo-ui 组件库方案

> 状态：草案
> 关联文档：[`css-events-plan.md`](./css-events-plan.md)、[`scss-less-support.md`](./scss-less-support.md)、
> [`m10-capability-decisions.md`](./m10-capability-decisions.md)、[`design.md`](./design.md) §12.1、
> [`style-support.md`](./style-support.md)
> 定位：以 shadcn 式组件库（`@dopejs/pingo-ui`）为目标的产品与工程方案。
> 本文档取代 2026-08-21 前一版《pingo-ui 基础能力补齐方案》。

---

## 1. 目标与已锁定决策

目标：让用户用 pingo 完成 UI 开发时，有一套可直接依赖的、shadcn 心智的组件库：
语义化 variant/size API、token 主题、可覆盖的皮肤、引擎原生渲染。

已锁定决策（2026-08-21）：

1. **分发形式：npm 包 + 主题配置。** 不做 shadcn 式 copy-source CLI；组件以编译产物
   交付，定制走 token/variant 面。
2. **主题模型：构建期定主题，运行时只切明暗。** 品牌色由 SCSS 变量在构建期确定；
   light/dark 两套皮肤预编译，运行时通过 context 切换。
3. **弹层路径：补引擎能力，不做 HTML overlay。** Dialog/Popover/Tooltip/Select 等
   依赖 zIndex/position/keyboard 引擎能力，按 §7 的工作包立项推进。
4. **SCSS / LESS 构建期支持已落地**（`@dopejs/pingo-style-preprocess`：
   `compileScssString` / `compileLessString` / `createStyleSheetFromScss|Less` /
   `compilePingoStyleFile` codegen + `?pingo-style` Vite 插件 + source-map 诊断；
   `rgb()/rgba()/hsl()/hsla()` 已归一到 `rgba8`；浏览器 bundle 无 `sass`/`less`，
   边界检查通过）。注意：颜色关键字（`white`/`black` 等）**未支持**，preset 作者
   只能写 hex 或 `rgb()/hsl()`。

原则不变：组件库产出 pingo 原生 TSX 组件；皮肤使用 `className + PingoStyleSheet`
模型；不扩大"通用浏览器 CSS 兼容"范围。

---

## 2. 现状盘点

### 2.1 已有能力

- JSX 原语：`View`、`Text`、`Image`、`Video`、`Input`、`TextArea`。`scroll` /
  `virtualList` 是兼容入口（design.md §12.1 已收敛为 View overflow + virtual），
  **组件库新代码不基于它们**。
- 组合 widget：`Pressable`（含 `disabled`）、`Button`、`TextField`、装饰型
  `TextArea`。
- CSS 子集 1.1.0，57 个 longhand；同节点 class/compound class 选择器 +
  `:hover/:active/:focus/:focus-visible`；层叠按 sheet 注册顺序，后注册者同优先级
  覆盖先注册者。
- 无障碍：`semanticRole/semanticLabel/semanticValue` props + 语义镜像树，button 的
  Enter/Space 默认激活由 DOM 镜像处理。
- 样式作者链路：SCSS/LESS 构建期编译 → `compileStyleSheet` 校验 → 不可变
  `PingoStyleSheet`。

### 2.2 约束（驱动设计）

- 无 CSS 自定义属性 / `var()`，stylesheet 在 `createRoot` 后不可替换（reconciler
  冻结注册顺序，`PingoStyleSheet` 无 CSSOM 变更面）。
- 无后代选择器：主题不能写成 `.dark .card`，只能用同节点 compound class。
- 无 `:disabled` 伪类；交互伪类只有 hover/active/focus/focus-visible。
- Core 事件流只承载 pointer/click/wheel/focus；键盘只走编辑事务。
- 无 `position/zIndex/boxShadow`；flex 只有 direction/justify/align（grow/shrink/
  basis/wrap 按 css-events-plan 在 oracle 建立后追加）。

---

## 3. 为什么否决 floating-ui + HTML overlay

弹层曾评估过"floating-ui 定位 + HTML 覆盖层"路线，否决理由：

1. **架构明确拒绝。** design.md 目标 6 与编辑子系统章节均要求业务不创建、不定位、
   不同步 HTML 覆盖控件；pingo 当前不存在任何 EmbedDOM 机制，选此路线等于新建一
   整套 HTML 覆盖子系统。
2. **存在不可修复的正确性断裂。** 架构不变量：滚动帧不回调 Shell，主线程 stall 时
   worker 继续滚动。HTML overlay 依赖 Shell 侧异步 layout 读定位，canvas 内容滚动
   时 overlay 无法跟随锚点，视觉上脱锚；这在 worker 模式下是结构性问题。
3. **组件库永久分裂。** HTML 在 z-order 上永远在 canvas 之上，无法与 canvas 内容
   交错；弹层内无法内嵌 canvas 组件；同一套组件库出现两种渲染、两套事件、两套
   无障碍路径。

m10 决策把 absolute positioning 判为 Defer 的原因是"没有覆盖层叠、锚点、焦点和
滚动容器的产品 fixture"。pingo-ui 的弹层组件正是该 fixture，决策表自写的进入条件
（oracle、预算、feature bit 回滚）现在可以被满足——按 §7 正式修订该决策，而非
绕过它。

---

## 4. 包结构与分发

```
@dopejs/pingo-ui（packages/ui，npm 包，纯 TS 运行时）
  ├─ styles/tokens.scss       ← 语义 token 契约（shadcn 命名）
  ├─ styles/presets/          ← 主题 preset；shadcn-default 为默认，未来自研主题同级
  ├─ styles/components/*.scss ← 组件皮肤源码，只允许引用 token，随包发布
  ├─ styles/generated/        ← 包构建期 codegen：预编译默认 light/dark 皮肤
  ├─ theme/                   ← ThemeProvider + useTheme（context）
  ├─ cva/                     ← cva-lite
  └─ components/              ← pingo 原生 TSX
```

两类用户路径：

- **零配置**：直接注册包内预编译 sheet，不接触 SCSS 工具链。
- **品牌定制**：`@use "@dopejs/pingo-ui/styles/tokens" with ($primary: ...)`，经
  style-preprocess 的 Vite 插件重新编译组件皮肤。**改品牌色 = 重新构建。**

包构建用 style-preprocess 的 codegen 模式（`compilePingoStyleFile`：SCSS → CSS
文本 → `compileStyleSheet` 校验 → 生成 TS 模块），预编译产物进入 npm 包；浏览器
bundle 不含 `sass`/`less`。

---

## 5. 主题模型

由 §2.2 约束决定：无 CSS 变量、无后代选择器、stylesheet 不可替换，因此——

- **明暗不拆 sheet。** 所有 themed 规则编译成同节点 compound class 对，例如
  `.btn-primary` / `.btn-primary--dark`，一份 sheet 同时含两套皮肤。unthemed 布局
  规则不复制。themed 规则翻倍带来的体积增量限于皮肤规则，量级小，可接受。
- **ThemeProvider 只是 context**（`"light" | "dark"`，默认 light）。组件内部
  `useTheme()` 后把 theme 作为 cva 的内部 variant 轴选 className。切换主题 = 重渲
  染换 className，引擎零改动。
- **token 全部在构建期解析**为 canonical 值（hex/rgba、px、%），不存在运行时
  token 表。

### 5.1 token 配置化（shadcn 只是默认 preset）

对齐 shadcn 默认主题不等于把 shadcn 值写死。token 层是正式配置面：

- `styles/tokens.scss` 定义**语义 token 契约**：token 名沿用 shadcn 语义
  （`primary/secondary/muted/accent/destructive/radius/spacing/typography` 等），
  默认值来自 shadcn 默认主题。
- **默认主题是一个 preset 文件**（`styles/presets/shadcn-default.scss`），未来的
  自研设计主题是另一个 preset——切换 = 换 preset 重新构建，组件代码零改动。
- **硬约束：组件皮肤（`styles/components/*.scss`）只允许引用语义 token，禁止
  出现字面色值/尺寸**。用构建期源码检查强制（components 目录下 SCSS 声明值必须
  是变量引用），防止定制点在换主题时失效。
- token 契约（名称、类型、适用组件）随包版本化；新增 token 走 minor，改名/删除
  走 breaking。preset 作者只面对这份契约，不需要读组件实现。

### cva-lite

class-variance-authority 的轻量实现，纯 TS：

- 支持 `base` / `variants` / `sizes` / `compoundVariants` / `defaultVariants`；
- 输出 className 字符串；theme 由组件内部注入，不暴露为业务 prop；
- 组件只依赖 cva 生成的 className，不手写色值。

---

## 6. 组件 API 契约

### 6.1 shadcn API 对齐策略

视觉基准：直接对齐 shadcn 默认主题（new-york 风格的尺寸/圆角/色板），token 名
沿用 shadcn 语义（`primary/secondary/muted/accent/destructive` 等）。对齐通过
preset 实现，不是硬编码——token 配置面见 §5.1，未来换自研主题只换 preset。

API 对齐分三类：

| 类别     | 内容                                                                                                                         | 处理                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 完全对齐 | 组合式组件树（`Card`/`CardHeader`/`CardTitle`…）、variant/size、className 覆盖、children 组合、受控 value、disabled          | TSX 组合照搬；pingo function component + hooks 与 React 同构                          |
| 改名适配 | `onChange(e)` 等 DOM 事件签名；pingo 编辑是 `value + revision` 或 `controller` 受控模型，回调为 `onTransaction` / `onSubmit` | 对外暴露 `onValueChange(value: string)` 薄封装，心智最接近 shadcn；DOM 事件对象不存在 |
| 不能对齐 | `asChild`/Radix Slot、HTML 属性透传（`type/autoComplete/name/form`）、DOM ref、react-hook-form 集成、`Portal`                | 无 DOM 无从对齐；Portal 由 Overlay 基元内部消化；表单生态后续做 pingo 自己的受控方案  |

### 6.2 props 中的 JSX（slot 契约）

pingo 的 JSX 产物是不可变 `PingoNode` 描述对象，作为 prop 传递与 children 同机制，
无需 portal 或特殊处理：

1. 具名 slot props 声明为 `PingoNode`：`prefix` / `suffix` / `icon` / `leading` /
   `trailing`，组件内部当 children 渲染。
2. 类型系统天然拦截 DOM JSX：`PingoNode` 与 React 元素类型不兼容，传错即编译
   错误。
3. 列表类 slot 需要 `key`（同 React 语义）。
4. 动态内容用 render prop（先例：`VirtualListProps.renderItem`）；`PingoNode`
   不可变，同一引用重复渲染是安全的。

### 6.2.1 slot 与闭包的性能契约（已按 reconciler 实现验证）

已验证的引擎事实：

- reconciler 有 descriptor identity bailout：同一元素引用则整个子树跳过
  （`reconcileChildren`）。
- 所有事件 handler（含 `onTap`）都在 Shell 侧注册表，闭包身份变化**不产生**
  Mutation Stream 流量；Core 标脏（失效域）不受 slot 影响。
- 但组件实例在 props 变化时**无条件重渲染**（无组件级 memo），父渲染会级联
  全部后代组件；slot 捕获父作用域闭包后 identity 必变，bailout 不命中。

因此组件库必须遵守：

1. **slot descriptor 原样透传**：不 clone、不包裹新元素；包装必然击穿 identity
   bailout。
2. **用户 handler 原样透传**：不在 render 中包 per-render wrapper；内部确需包装
   时用 `useCallback` 稳定身份，且依赖数组必须覆盖捕获值，禁止用 memo 捕获过期
   状态。
3. 重组件的使用方建议用 `useMemo` 稳定 slot 元素（工具已存在于 runtime）。

Input 的 `prefix`/`suffix` 属于 shadcn 之外的 superset（AntD 式 API），**已确认
纳入**（2026-08-21：以 E6 与 §6.2.1 契约落地为前提，slot 形式不设限制）；流体
宽度布局依赖 E5。

### 6.3 通用约定

每个组件：

- props：`variant` / `size` / `disabled` / `className`（追加在组件 className 之后）
  - 组件专有 props；透传 `semanticRole` / `semanticLabel` / `semanticValue`。
- **覆盖约定**：用户 sheet 必须在 pingo-ui sheet 之后注册；同优先级按 source order
  覆盖。写入包文档。
- **禁用态不需要 `:disabled` 伪类**：视觉走 cva 的 disabled variant class，行为用
  `Pressable` 已有的 `disabled` prop（同时禁止 handler、焦点和镜像默认动作）。
  `:disabled` 伪类降为可选后续项，不阻塞组件库。
- 交互态样式（hover/active/focus-visible）用已有伪类预编译，由 Core 状态位驱动。

---

## 7. 引擎工作包（独立于组件库立项）

启动条件：以 pingo-ui 弹层与键盘导航需求作为产品 fixture，**先修订
`m10-capability-decisions.md` 的 absolute positioning Defer 决策**，按该决策表
自写的进入条件执行，并同步更新 `design.md` §12.1 的支持表。每项能力带独立
feature bit，关闭后拒绝新值、现有路径不变。

- **E1 keyboard 事件**。Core 输入流补非编辑 key record → 协议 Input 指令与编码 →
  `PingoEvent` 增加 `keydown/keyup`（含 `key/code/repeat`）→ `CommonProps` 增加
  `onKeyDown/onKeyUp`，路由与 pointer 事件同路径。编辑态输入仍走 editing
  transaction，不退化为 key 拼装。弹层的 Esc/方向键导航、第一批组件的键盘升级都
  依赖它。
- **E2 zIndex**。只动 Core 的 paint/hit/semantics 顺序，不动 layout。要求：稳定
  排序结果缓存，禁止每帧排序；重叠命中语义从"拓扑序最后绘制者"更新为"paint 序
  最后绘制者"；通过 m10 决策要求的无障碍顺序资格。
- **E3 position:absolute + inset**。`position` 首期只支持 `static/absolute`；
  `inset` 展开为 top/right/bottom/left；相对最近 positioned 祖先定位；脱离 flex
  流；hit/clip/semantics 同步。进入条件按 m10 决策表：layout/hit/clip/semantics
  增量↔全量 oracle、帧时与节点预算、feature bit 回滚。
- **E4 boxShadow**（弹层与 Card 视觉层级的前置）。新增 longhand + canonical
  value tag（shadow 列表），颜色走带 alpha 的 `rgba8`（shadcn 阴影为半透明黑，
  **不支持不透明简化的余地**）；Core paint 生成 shadow 指令，Canvas2D 映射
  `shadow*`；加入 `stateStyleProperties`（仅 paint 失效），注意 picture cache 的
  paintSelf 失效。首期可不含 inset/多层之外的特性。

- **E5 flexGrow / flexShrink / flexBasis**（已确认为必须能力：Input prefix/suffix、
  表单行、工具栏、ListRow 等大量组件的流体布局都依赖它）。新增三个 longhand，
  canonical 复用现有 `number` / `length`，invalidation 域与 `flexDirection` 一致
  （`layout/paint/hit/scroll`）。按 css-events-plan 的既定节奏：**先建立 flex 布局
  reference oracle（增量↔全量差分），通过后开放语法**。`flexWrap`/`alignSelf`
  不在本期，后续单独评估。
- **E6 组件级 `memo`**（纯 Shell runtime，不改 ABI、不动 Core）。当前组件实例在
  props 变化时无条件重渲染，父渲染级联全部后代组件；slot/闭包场景下 descriptor
  identity bailout 无法命中。新增 `memo(Component, arePropsEqual?)` 浅比较
  bailout，挡住"父渲染但 props 未变"的级联；函数 prop 按引用比较（inline
  handler 使 memo 不命中，与 React 语义一致）。signal 命中的 dirty marking 与
  memo 正交，不受影响。这是 §6.2.1 契约真正生效的引擎支撑。

---

## 8. 组件分批

### 第一批（零引擎依赖，17 个）

Button、IconButton、Badge、Card、Divider、Label、Skeleton、Alert、Avatar、
Progress、Switch、Checkbox、RadioGroup、Input 装饰版、TextArea 装饰版、
Tabs、Accordion。

Tabs、Accordion 首期只有 pointer 交互，方向键导航在 E1 落地后升级。Input 装饰版
首发不含 slot，`prefix`/`suffix` 在 E5（流体宽度）与 E6（闭包级联抑制）落地后
补齐。

### 第二批（依赖 E1+E2+E3，弹层）

Dialog、Sheet、Popover、Tooltip、DropdownMenu、Select、Command、Toast。

弹层组件在 pingo-ui 中统一封装 `Overlay` 基元：zIndex 控制层叠、position/inset
定位、E1 提供 Esc 关闭与焦点导航。焦点陷阱（focus trap/restore）在第二批设计时
基于已有 focus 事件面评估，不提前承诺 API。

### 第三批（产品分子，shadcn superset，按需）

TopBar、Sidebar、StatCard、ListRow 等。

---

## 9. 落地顺序

```
阶段 0  packages/ui 骨架 + cva-lite + ThemeProvider
        + Button/Badge/Card/Input/Label 五个样板组件
        走通 storybook + SCSS 皮肤 + 明暗切换全链路
阶段 1  第一批剩余组件；暗色皮肤全覆盖；覆盖约定文档化
        + E6 组件级 memo（纯 Shell，不依赖 m10 修订，可最早启动）
阶段 2  引擎工作包：修订 m10 决策 → E1 → E2 → E3（E4/E5 可并行，E5 oracle 先行）
        与阶段 0/1 并行启动，不阻塞静态组件交付
阶段 3  第二批弹层组件 → 第三批按需
```

---

## 10. 测试与门禁

- 组件：语义树 E2E + 像素快照（像素为辅助断言）；每个组件覆盖 light/dark 双皮肤。
- cva-lite / ThemeProvider：单元测试，含 compoundVariants 优先级与 theme 切换后
  className 确定性。
- 皮肤：包构建时全部 SCSS 产物过 `compileStyleSheet`；facade 与浏览器 bundle 不含
  `sass`/`less`（依赖边界检查）。
- 引擎工作包：按 design.md §15 与 m10 决策表——schema metadata、parser fixture、
  computed-value test、invalidation oracle；ABI 变更需 golden bytes、TS/Rust 往返、
  malformed-input 与 fuzz；Core layout/paint/hit 变更需增量↔全量差分 oracle 与帧时
  预算。
- 弹层组件额外覆盖：层叠顺序、锚点定位、Esc/焦点导航、滚动中锚点跟随。

---

## 11. 非目标

- 不做 shadcn 式 copy-source CLI（npm 包分发已锁定）。
- 不做 React / DOM 组件输出；不做 HTML overlay 弹层。
- 不做运行时主题编辑（品牌色构建期确定；运行时只切明暗）。
- 不实现 `calc()` / `var()` / `em/rem/vw/vh`、后代选择器、`@media`、`@keyframes`、
  `:disabled`（后续按独立扩展节奏评估）。
- 不实现 CSS 渐变；需要渐变时组件层预生成图片资源。
- 不在 Core 或 Shell 运行时内置 SCSS / LESS 编译器。

---

## 12. 风险与回滚

| 风险                                   | 缓解                                                                |
| -------------------------------------- | ------------------------------------------------------------------- |
| 引擎工作包周期长于预期，第二批组件延期 | 第一批 17 个组件独立可用；弹层不阻塞发布                            |
| m10 决策修订后 oracle 不达标           | 决策表自带回滚边界：feature bit 关闭拒绝新值，现有 flow layout 不变 |
| 暗色皮肤体积超预期                     | themed 规则仅皮肤属性；按组件分包 sheet 作为后续优化                |
| 用户 sheet 注册顺序错误导致覆盖失效    | 包文档明示约定；`compileStyleSheet` 诊断与 storybook 示例兜底       |
| 焦点陷阱语义不足                       | 第二批设计时基于 E1 与已有 focus 面重新评估，不提前锁 API           |
