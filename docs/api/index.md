# 公开 API

`@dopejs/pingo` 的导出即公开契约。内部包（`@dopejs/pingo-host` 等）不承诺稳定性，
[迁移扫描器](/migration)会阻止业务直接依赖它们。

::: tip 快照即契约
公开面被固化在 `benchmarks/api/facade.v1.d.ts` 中，任何签名变化都必须显式更新该快照并经过审阅，
`pnpm api:check` 在漂移时失败。
:::

## 根与宿主

```ts
createHostedCanvasRoot(canvas, options?): Promise<HostedCanvasRoot>
createCanvasRoot(context, core, options?): PingoRoot   // 主线程 M1 路径
initializeWasm(input?): Promise<void>
createWasmCore(width, height, input?): Promise<CoreClient>
```

`initializeWasm` 让业务把 WASM 初始化纳入自己的启动或路由 loading。它在当前
JavaScript realm 内是幂等的：并发与后续调用共享第一次成功的初始化，失败不会被缓存，
可以重试；第一次调用决定自托管 input。Worker 是独立 realm，默认仍由 Host 在 Worker
中完成初始化。`createWasmCore` 会复用同一 realm 中已经完成或正在进行的初始化。

`HostedCanvasRoot` 方法：

| 方法                                                      | 说明                                                 |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `render(node)`                                            | 提交一帧组件树                                       |
| `close()`                                                 | 关闭 root、Worker 与 Core                            |
| `mode`                                                    | 实际传输路径：`sab` / `post-message` / `main-thread` |
| `beginScroll` / `scrollBy` / `endScroll` / `cancelScroll` | 直接操纵滚动                                         |
| `setScrollVelocity(target, x, y)`                         | 由 Core 渲染时钟持续按逻辑像素/秒滚动；`0, 0` 停止   |
| `setReducedMotion(value)`                                 | 实时覆盖 Core animation 的 reduced-motion 策略       |
| `focusEditable` / `blurEditable`                          | 激活或结束原生编辑会话                               |
| `updateEditingGeometry`                                   | 手动提供 IME 几何（通常自动完成）                    |
| `transportMetrics()` / `inputTransportMetrics()`          | mutation/input 传输与背压快照                        |
| `mediaMetrics()`                                          | 媒体绑定、copy、掉帧、释放与在途帧快照               |

常用选项：`onFrame`、`onHostError`、`onMediaMetrics`、`onEditTransaction`、
`onEventTransaction`、`onSemantics`、`onNonPassiveRegions`、`transport`、`rasterCache`、
`accessibility`、`nativeTextInputMode`。

## 元素与 JSX

```ts
createElement(type, props, key?): PingoElement
Fragment
```

主机元素：`container`、`text`、`scroll`、`virtualList`、`editableText`。
类型：`CommonProps`、`ContainerProps`、`TextProps`、`ScrollProps`、`VirtualListProps`、
`EditableTextProps`、`EditableInputMode`、`Color`、`EdgeInsets`、`NodeHandle`、`Ref`、
`PingoNode`、`FunctionComponent`。

M6 新增保持旧 intrinsic 兼容的基础组件：

```ts
View(props: ViewProps)
Text(props: TextProps)
Image(props: ImageProps)
Input(props: InputProps)
UnstyledTextArea(props: UnstyledTextAreaProps)
```

它们接受既有 direct props 与 `style`/`className`，分别映射到 `container`、`text`、`image`
和共享的 `editableText` 原语。`View.virtual.axis` 显式选择 `"x" | "y"` 主轴；ref 使用
`ViewHandle`，可调用 `scrollTo`、`scrollBy`、`setScrollVelocity` 与 `capture`，旧 root 滚动
方法继续兼容。
已发布的 `TextArea` 仍是带边框、padding
与 rows 布局的 widget，为避免 0.x 静默破坏暂不改名；无装饰基础组件因此使用
`UnstyledTextArea` 兼容别名。

JSX 运行时通过 `@dopejs/pingo/jsx-runtime` 与 `@dopejs/pingo/jsx-dev-runtime` 提供。

## 样式能力（M6）

```ts
createStyleSheet(cssOrObject, options?): PingoStyleSheet
compileStyleSheet(cssOrObject, options?): StyleSheetCompilation
supportsStyle(property, value): boolean
styleCapabilities(): StyleCapabilities
CSS_SUBSET_VERSION: string
```

`createStyleSheet` 编译同节点 class/compound-class selector、shorthand、cascade 与
computed-value 元数据；失败时抛出带结构化 diagnostics 的 `StyleSheetCompileError`。
`compileStyleSheet` 是不抛异常的对应入口。完整支持矩阵见[生成的 CSS subset 表](/style-support)。
`styleCapabilities().engineReady` 为 `true`，每个属性的 `engineSupport` 为 `m6-core`。
`root.styleMetrics()` 暴露累计 resolution/cache hit/diagnostic/interaction variant 计数；
滚动热路径不进入 Shell resolver。输入变化时仍使用完整 resolver 保证结果可差分验证。

三个独立回滚选项为 `styleResolverEnabled`、`foundationComponentsEnabled` 与
`interactionStylesEnabled`；关闭后旧 direct props、intrinsic、事件与 virtualList 仍可工作。

### SCSS / Less 构建期预处理

SCSS/Less 不进入 facade 或浏览器运行时。需要生成 pingo stylesheet 的 Vite 应用安装
`@dopejs/pingo-style-preprocess`，并启用独立的 Node-only 插件：

```ts
// vite.config.ts
import { pingoStylePreprocess } from "@dopejs/pingo-style-preprocess/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [pingoStylePreprocess()] });
```

然后用显式 query 区分 pingo stylesheet 与普通 DOM CSS：

```ts
/// <reference types="@dopejs/pingo-style-preprocess/client" />

import buttonSheet from "./button.scss?pingo-style"; // PingoStyleSheet，不注入 DOM
import "./site.less"; // 普通 Vite DOM CSS
```

`?pingo-style` 在构建期完成 Sass/Less 编译、依赖边界检查、source-map 诊断和 pingo CSS
subset 校验；partial/import 会加入 Vite watch graph。Node API 还提供
`compileScssString`、`compileLessString` 与 `compilePingoStyleFile`。完整约束和回滚方式见
[SCSS / Less 支持设计](/scss-less-support)。

## Core 动画（M7）

`CommonProps.transition` 接受单条或每属性一条 `TransitionSpec`；`animation` 接受
`KeyframeAnimationSpec`，首期属性严格限于 `opacity` 与六元素 affine `transform`。支持
delay、duration、CSS easing/cubic-bezier/steps、iteration、direction、fill 与 playState；
暂停/恢复保持逻辑进度，retarget 从当前 presentation value 继续。Host 默认跟随
`prefers-reduced-motion` 的实时变化，也可用 `reducedMotion` 初值和
`root.setReducedMotion()` 覆盖。

`coreAnimationEnabled: false` 是独立回滚开关：Shell 仍提交 durable 最终值，但不定义
animation resource。它不回退 ABI；旧 Core 必须通过正常 ABI 协商拒绝 ABI 15。

CSS 文本中的 `transition-*` / `animation-*` longhand 尚未加入 subset；M7 公开的是结构化、
类型安全的组件属性，Core 始终不解析 CSS。

## Video（M8）

```ts
Video(props: VideoProps): PingoElement
detectMediaCapabilities(): MediaCapabilities
```

`VideoProps` 提供 `src`、`poster`、`autoPlay`、`loop`、`muted`、`crossOrigin`、`preload`，
以及 `onPlay`、`onPause`、`onEnded`、`onLoadedMetadata`、`onTimeUpdate`、`onError`。
`ref` 的 `VideoHandle` 提供 `play()`、`pause()` 与 `seek(seconds)`。尺寸与
`style.objectFit`/`objectPosition` 由 Core 计算，HTMLVideoElement、解码与 audio 始终留在 Host。

主线程使用 `html-media` 零 copy 路径；Worker 优先使用 transferable `VideoFrame`，不可用时
使用 `ImageBitmap` copy。路径通过媒体帧的 `FrameReport.mediaPath` 观测，资源与背压通过
`root.mediaMetrics()` / `onMediaMetrics` 观测。每个 Video 最多一帧传输在途，突发帧丢旧保新；
解绑、替换和关闭 root 会清理浏览器资源。`videoEnabled: false` 是独立回滚开关。

## 响应式与 hooks

```ts
(signal, computed, effect, batch, untracked);
(useState, useSignal, useMemo, useCallback, useRef, useEffect);
(createContext, useContext); // Provider 作为元素类型：<ctx.Provider value={...}>
```

类型：`Signal`、`ReadonlySignal`、`RefObject`、`Unsubscribe`、`PingoContext`、`ContextProvider`。

`useContext` 沿组件 owner 链读最近 Provider；Provider value 变化只重渲染订阅的消费者，
并穿透 `memo`（signal 失效路径）。用 hooks 的组件必须经 `createElement`/JSX 使用，
直接函数调用没有组件作用域。

## 编辑

```ts
TextEditingController;
useTextEditingController(options);
```

类型：`EditTransaction`、`EditingGeometry`、`EditingSelection`、`NativeTextInputMode`。

## Widgets

```ts
TextField(props): PingoNode
TextArea(props): PingoNode
Pressable(props): PingoNode
Button(props): PingoNode
```

`Pressable` 与 `Button` 只组合 View/Text 和既有事件/语义，不引入 Core control kind。
语义镜像为 button 提供 Enter keydown 与 Space keyup 默认激活；`disabled` 同时移除事件、
焦点顺序和原生语义激活。

## 无障碍

```ts
SemanticTreeMirror
getByRole(root, role, { name? }): HTMLElement
queryAllByRole(root, role, { name? }): HTMLElement[]
```

类型：`SemanticNode`、`SemanticMirrorNode`、`SemanticTreeMirrorOptions`。

## 字体

```ts
createFont(options): PingoFont
loadFont(source, options?): Promise<PingoFont>
```

支持 TTF / OTF / TTC / WOFF / WOFF2（WOFF2 解码器按需动态加载）。
类型：`PingoFontSource`、`PingoFontOptions`、`PingoFontLoadOptions`、
`PingoFontLoadError`、`PingoFontLoadErrorCode`、`Woff2Decoder`。

## 发布与诊断

```ts
ENGINE_VERSION: string
ENGINE_ABI_VERSION: number
engineIdentity(): { version, abiVersion }
verifyWasmIntegrity(bytes, manifest): Promise<void>
```

`WasmIntegrityError` 在自托管 WASM 与构建 manifest 不一致时抛出。见[诊断](/diagnostics)。

## 迁移边界

`@dopejs/pingo-compat` 是独立的边界包，提供 `mountCompatPage` 做按页面灰度与回退。
详见[迁移指南](/migration)。
