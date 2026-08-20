# CSS 子集、原生事件与基础组件演进方案

> 状态：M6-A Shell resolver 已完成；M6-B Core 集成仍未开始
> 日期：2026-08-20
> 关联决策：[`ADR-0007`](./adr/0007-css-events-and-foundation-components.md)

## 1. 目标

pingo 的下一阶段沿两条互相依赖的主线演进：

1. 提供可逐步扩展、语义可验证的 CSS 子集，业务同时使用 `style` 与
   `className`。
2. 补齐接近 DOM/Pointer Events 的引擎原生事件；Core 持有命中、交互状态与
   默认行为，不要求业务用 `setState` 模拟 hover、active、focus 或滚动。

两条主线在伪类与动画处汇合：浏览器事件经 Input Stream 进入 Core，Core 根据已呈现
帧命中并更新 `:hover` / `:active` / `:focus` / `:focus-visible` 状态，再选择 Shell
预编译的状态样式并从当前 presentation value 启动 transition。这个闭环不得同步调用
Shell；Worker 可用时，主线程阻塞不会让已经开始的滚动或动画停下。

本方案不是通用浏览器 CSS、HTML 或 CSSOM 实现。支持范围由版本化能力矩阵定义；支持
某个属性或值时遵循对应 CSS 语义，不支持时返回结构化诊断，不能静默套用近似行为。

## 2. 公开组件模型

公开基础组件收敛为：

| 组件       | 公开职责                                               | Core 能力                                   |
| ---------- | ------------------------------------------------------ | ------------------------------------------- |
| `View`     | 盒模型、Flex、绘制、事件、overflow、滚动与可选虚拟化   | 通用 Scene box；按 computed overflow 挂滚动 |
| `Text`     | 文本内容、shaping、换行与文本样式                      | Text 子系统                                 |
| `Image`    | 图片资源、固有尺寸、`object-fit` / `object-position`   | Image resource                              |
| `Video`    | 媒体状态、视频帧合成与原生媒体事件                     | Host 媒体管线 + Core 帧资源                 |
| `Input`    | 单行编辑、selection、IME、剪贴板、受控/本地 controller | 共享 EditableText 子系统                    |
| `TextArea` | 多行编辑、内部滚动、selection、IME、剪贴板             | 共享 EditableText 子系统                    |

`Fragment` 仍是不产生 Scene 节点的描述符。`Input` 和 `TextArea` 是不同的公开语义，
但不得复制两套编辑内核。`Button`、`Pressable`、`TextField` 等属于组合型 foundation
widget，不增加 Core 节点种类。

现有 API 按兼容层迁移：

| 现有入口       | 新模型                              |
| -------------- | ----------------------------------- |
| `container`    | `View`                              |
| `scroll`       | `View` + `overflow`                 |
| `virtualList`  | `View` + `overflow` + `virtual`     |
| `text`         | `Text`                              |
| `image`        | `Image`                             |
| `editableText` | `Input` / `TextArea` 共享的内部原语 |

0.x 阶段先只增不删；旧入口由 facade/widgets 包装到新模型并保留自动契约测试。没有
迁移报告、codemod、至少一个完整弃用周期和显式 breaking release，不删除旧入口。

## 3. 滚动与虚拟化

### 3.1 overflow 建立滚动能力

`View` 根据 computed `overflow` 建立裁剪与滚动轴，不再需要独立 `ScrollView`：

```tsx
<View style={{ width: 480, height: 640, overflowY: "auto" }}>{children}</View>
```

首期语义：

- `visible`：不裁剪、不建立滚动机制。
- `clip`：裁剪且不可滚动。
- `hidden`：裁剪，可程序化滚动。
- `auto`：内容溢出时可滚动。
- `scroll`：始终建立滚动机制。
- `overflowX` / `overflowY` 覆盖 shorthand，并遵守两轴 computed-value 联动。

overflow 变化只改变同一 View 的派生滚动状态，不更换 node id、不卸载组件。滚动位置在
能力临时关闭或 `display:none` 时保留，重新启用后按新内容边界钳制。

### 3.2 虚拟化是滚动能力的数据契约

CSS 不能推导数据总数、估算尺寸或补建函数，因此虚拟化保持显式行为 prop：

```tsx
<View
  style={{ width: 800, height: 600, overflowY: "auto" }}
  virtual={{
    axis: "y",
    itemCount: orders.length,
    estimatedItemSize: 36,
    getItemKey: (index) => orders[index].id,
    renderItem: (index) => <OrderRow order={orders[index]} />,
  }}
/>
```

约束：

- 首期 `axis` 为 `"x" | "y"`，窗口规划、测量、预热和占位都使用该主轴。
- `virtual` 与普通 `children` 首期互斥；header/footer/sticky 使用显式 slot 后续增加。
- 对应轴必须计算为 `auto`、`scroll` 或 `hidden`；`visible` / `clip` 组合 fail fast。
- `display:none` 时停止规划与 refill，但保留 durable 配置、滚动位置和组件状态。
- Shell 只物化 Core 请求的完整预热窗；滚动帧仍不得调用 Shell。
- 二维数据以后扩展为独立的 rows/columns window contract，不把表格语义写进 Core。

`ViewHandle` 最终承载 `scrollTo`、`scrollBy`、`setScrollVelocity` 与 pointer capture；现有
root 方法在迁移期继续工作。

## 4. CSS 分层与扩展性

### 4.1 固定边界

```text
CSS text / createStyleSheet / className / inline style
                         │
                         ▼
Shell: tokenize → parse → selector/cascade → computed style
                         │ canonical property ids + typed values
                         ▼
Mutation Stream / immutable style resources
                         │
                         ▼
Core: layout → paint → hit → scroll → animation
```

Core 不接收 CSS 文本、className、选择器或自定义属性 token。Shell 不执行最终布局、命中、
滚动物理或 presentation animation。

### 4.2 单一 style schema

新增 `schemas/style.v1.json` 作为支持矩阵与生成源。每个 longhand 至少声明：

- 稳定 property id 与 CSS/JS 名称；
- 初始值、是否继承、适用节点类型；
- value grammar 与 canonical computed-value layout；
- invalidation domain；
- animation type（不可动画、离散、数值、颜色、transform 等）；
- percentage/reference box、单位与边界；
- 是否影响 hit、semantics、scroll 或非 passive region；
- fallback/feature flag 和文档状态。

生成器产出 TypeScript `PingoStyle` 类型与解析元数据、Rust property/value 枚举、ABI
编码器/解码器、失效元数据、文档支持表和属性测试生成器。任何一侧手写重复 property id
或失效表都应让检查失败。

### 4.3 四种扩展不混为一谈

| 扩展类型                        | 例子                              | 所需变化                                    |
| ------------------------------- | --------------------------------- | ------------------------------------------- |
| 新语法归一到已有 computed value | `padding` shorthand、更多颜色写法 | Shell/parser 与测试；不改 ABI/Core          |
| 已有属性增加 value grammar      | `%`、`calc()`、`var()`            | Shell；若 canonical value 不变则不改 ABI    |
| 新属性语义                      | `position`、`filter`              | style schema、ABI、Core、差分和性能门禁     |
| 新 selector/pseudo state        | `:disabled`、后代选择器           | selector compiler；需要动态依赖时扩状态协议 |

这个分层保证未来支持更多 CSS 属性和语法时，大多数 parser/cascade 扩展不会推动 ABI 版本。
只有 Core 必须理解的新 computed 语义才占用协议和 WASM 体积。

公开提供独立于 engine/ABI 的 `CSS_SUBSET_VERSION`、`supportsStyle(property, value)` 和
`styleCapabilities()`。stylesheet 编译结果携带 schema version、feature bits 与内容
hash；Worker activate 时验证能力，不兼容时在应用任何 style 前失败关闭。

### 4.4 层叠与诊断

首期优先级：

```text
initial/inherited < stylesheet source order + specificity < inline style < legacy direct prop
```

legacy direct prop 是迁移层，不属于 CSS；新代码不应同时为同一属性写 direct prop 与 style。
首期不支持 `!important`，遇到时产出稳定错误码与源码位置。未知属性、已知属性的未知值、
不支持的 selector 和互相冲突的 virtual/overflow 配置均不得静默忽略。

生产构建可把诊断降为一次性上报，但不能更改 computed result。开发模式保留 stylesheet、
rule、property 与节点来源映射，供 devtools 解释最终值和失效原因。

## 5. 第一批 CSS 子集

M6 只提交能通过完整语义与差分测试的 longhand；shorthand 在 Shell 展开，不进入 Core。

| 域          | 首期属性                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| display     | `display: flex                                                                                                   | none` |
| size        | `width/height/minWidth/minHeight/maxWidth/maxHeight`、`boxSizing`                                                |
| spacing     | margin/padding 四边 longhand，`gap/rowGap/columnGap`                                                             |
| flex        | `flexDirection`、`justifyContent`、`alignItems`；grow/shrink/basis 在正确性 oracle 建立后追加                    |
| overflow    | `overflow/overflowX/overflowY`、首期 `overscrollBehavior`                                                        |
| paint       | `backgroundColor`、`color`、`opacity`、solid border、`borderRadius`、`visibility`                                |
| text        | `fontFamily/fontSize/fontWeight/fontStyle/lineHeight`、`textAlign`、`whiteSpace`、`overflowWrap`、`textOverflow` |
| transform   | `transform`、`transformOrigin`                                                                                   |
| interaction | `pointerEvents`、`cursor`、`touchAction`                                                                         |
| image/video | `objectFit`、`objectPosition`                                                                                    |

首期长度接受有限 grammar：有限数值（JS number 视为逻辑 px）、`px`、已实现 reference box 的
`%` 与属性明确允许的 `auto`。`em/rem/vw/vh/calc()/var()` 由 parser AST 预留但在实现前返回
unsupported-value 诊断。

`display:none` 保留节点/ref/组件状态，但整棵子树不参与 layout、paint、hit、semantics 和
scroll extent。恢复显示后重新派生布局。它首期不可 transition；CSS discrete transition、
`transition-behavior: allow-discrete` 与 `@starting-style` 后续单独设计。

## 6. className、选择器与伪类

Shell 提供不可变 `PingoStyleSheet`：CSS 文本和类型安全对象写法都编译到同一中间表示，
root 显式注册 stylesheet；`className` 使用空白分隔的 class token。inline `style` 不承载
伪类规则。

首期 selector：

- `.button`、`.button.primary`；
- `:hover`、`.button:hover`、`.button.primary:hover`；
- 同节点 `:active`、`:focus`、`:focus-visible` 组合。

首期不支持 combinator、`:has()`、结构伪类和伪元素。CSS `:hover` 对命中节点及其祖先
成立，但 `.parent:hover .child` 属于后代 selector，仍在后续范围。

Shell 对每个节点预计算基础 declarations 和有条件 declarations；Core 只检查状态位，不做
selector matching。状态变化只标脏受影响节点。首期伪类 declaration 限于 paint、颜色、
opacity、transform、border、cursor、visibility 和 pointer-events；布局/overflow/display
进入伪类前必须有命中反馈环稳定性设计和门禁。

## 7. 原生事件模型

### 7.1 事件族

M6 在现有 pointer/click/wheel 基础上增加：

- pointer over/out、enter/leave、got/lost pointer capture；
- `pointerType`、isPrimary、pressure、tilt、尺寸与可靠时间戳；
- 非编辑 keyboard、focus/blur、focusin/focusout；
- canvas leave、window blur、visibility change 与 transport recovery 清理；
- DOM 风格 capture → target → bubble、stop propagation 与 default action。

文本意图、composition、selection 与 clipboard 继续走 editing transaction，不退化成 key
事件拼装。Host 集中监听真实 DOM；Core 以已呈现帧的 hit snapshot 路由事件并持有
hover/active/focus/capture 状态。业务回调仍异步回 Shell，视觉伪类与默认滚动不等待回调。

### 7.2 状态位

协议使用可扩展 interaction-state bitset，首期启用 Hover、Active、Focus、FocusVisible；
Disabled、Checked 等在对应控件状态契约落地后启用。不能把协议固化成单个 hover boolean。

状态清理必须覆盖节点删除、generation 变化、`display:none`、`pointer-events:none`、pointer
cancel/leave、页面失焦与 Worker 恢复。多指针状态按 pointer id 保存；hover 只由具备 hover
语义的输入源建立，touch 不得留下粘滞状态。

## 8. Transition、Animation 与 Keyframes

Core 使用现有可注入渲染时钟建立通用 animation timeline。持久 computed style 与当前帧
presentation style 分离：Shell 提交最终目标，Core 每帧只派生 presentation value，不把
插值结果写回 durable Scene。中途换目标时从当前 presentation value 重定向。

M7 第一批支持：

- transition property/duration/delay/timing-function；
- linear、CSS 预设 easing、cubic-bezier、steps；
- opacity 与 transform transition；
- keyframes 的 duration/delay/easing/iteration/direction/fill/play-state；
- opacity 与 transform keyframe track；
- prefers-reduced-motion 能力输入和可测试 override。

颜色、border radius 等 paint-only 属性在插值空间确定后增加。width/height/margin/padding/
gap/flex 等 layout animation 必须单独证明每帧 layout、虚拟测量、滚动锚定和 hit rebuild 的
绝对门禁，不能与 compositor-friendly 属性一起默认开放。

## 9. Video 边界

`Video` 的公开 API 可在 M6 冻结，实际媒体管线在 M8 交付。Host 负责加载、CORS、解码、
audio 与 HTMLMediaElement/WebCodecs fallback；Core 只消费有界、可回收的视频帧资源并按
媒体时钟合成。不得把 HTMLVideoElement 或浏览器对象放进 Scene，也不得无界排队 VideoFrame。

首期媒体事件对齐 play/pause/ended/error/loadedmetadata/timeupdate 的可观察语义；autoplay、
muted、loop、poster、object-fit 明确能力检测。没有 Worker/WebCodecs 时功能降级必须可用，
但不同路径的复制成本与帧率单独观测。

## 10. 交付顺序

### M6：样式、组件与交互状态基础

M6-A 已于 2026-08-20 完成 resolver-only 工程门禁：schema/生成物、结构化诊断、
独立 reference resolver、随机 parser/cascade 差分和无变化输入缓存均已落地。它不表示
Core 已消费 computed style；以下第 2–7 项仍待后续子里程碑交付。

1. style schema、生成器、diagnostics、capabilities 与 reference resolver。
2. 新组件 facade 与旧 intrinsic 兼容包装；不改变现有行为。
3. `style` / `className` / stylesheet 的解析、层叠、继承和 direct-prop adapter。
4. `display:none`、第一批 box/flex/paint/text 属性。
5. overflow 统一 View 滚动；现有 virtualList 迁到 `View.virtual` 的纵向等价路径。
6. pointer lifecycle、pointerType、capture、focus 与 interaction-state bitset。
7. 同节点 hover/active/focus/focus-visible selector 与状态样式。

### M7：轴泛化与 Core 动画

1. x/y 单轴 virtualizer、`estimatedItemSize` 与 ViewHandle 滚动 API。
2. transition timeline、opacity/transform 插值与 retarget/cancel。
3. immutable keyframe resources 与 animation lifecycle。
4. reduced motion、动画诊断、录制回放和性能门禁。
5. 在 oracle 和指标允许后逐项扩大 CSS value grammar 与属性集。

### M8：媒体与后续 CSS/事件扩展

1. Video Host/Core 资源管线、媒体事件和降级。
2. 非编辑 keyboard/default actions 与 foundation controls 完整契约。
3. 基于真实需求增加 selector、伪类、custom properties/calc 或二维虚拟窗口。
4. 每个扩展按 §4.3 分类，避免无关 ABI 变化。

## 11. 测试与出口门禁

- parser：WPT/规范 fixture 的已支持子集、错误位置、shorthand/longhand 等价和 fuzz。
- cascade：specificity/source order/inheritance/inline/direct adapter 的表驱动与属性测试。
- computed style：增量解析/层叠与从头计算完全一致。
- Core style：增量失效与全量 layout/paint/hit/semantics oracle 一致。
- display/overflow：layout、clip、hit、semantics、scroll extent 与恢复状态 E2E。
- events：跨三 transport 的事件顺序、enter/leave、capture、cancel、focus 与状态清理。
- pseudo/animation：相同录制输入和逻辑时间得到逐字节/逐像素一致输出；主线程 stall 时
  Worker animation 连续；retarget、cancel、display none 和 reduced motion 有确定性测试。
- virtual：旧 virtualList 与新 View.virtual 在相同输入下窗口、占位、像素和诊断一致；x/y
  使用同一 reference oracle。
- Video：资源生命周期、CORS/error、帧回收、seek/loop 和 fallback 契约；内存有硬预算。
- 性能：style recompute 不进入无变化滚动帧；pseudo 更新与 animation frame 分相计时；新增
  WASM/JS 体积分别设预算，不得挤破现有 400KB gzip 门禁。

每个 CSS property 必须同时有 schema metadata、parser fixture、computed-value test、
invalidation oracle 和文档支持项；缺任一项生成/CI 失败。

## 12. 兼容、灰度与回滚

实现保留四个彼此独立的内部 rollout 开关：CSS resolver、新组件 facade、interaction
styles、Core animation；Video 再有独立 capability flag。任一能力关闭时，旧 direct props、
旧 intrinsic、现有事件与现有 virtualList 路径继续工作。

回滚不得把新 CSS 值错误解释成旧 prop。能力协商失败应在 commit 前拒绝该 stylesheet 或
页面切片，并通过 compat 边界回到旧渲染路径。Worker/SAB/postMessage/main-thread 三档仍共享
行为契约；关闭 Worker 只影响主线程阻塞时的连续性，不改变 computed style 和事件顺序。

上线观测至少包含 stylesheet 编译失败、unsupported 诊断、style recompute 节点数、各失效域
节点数、hover/focus 状态变化、animation active/retarget/cancel 数、overflow 模式分布、virtual
refill/placeholders、视频帧队列与丢帧。
