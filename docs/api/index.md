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
| `focusEditable` / `blurEditable`                          | 激活或结束原生编辑会话                               |
| `updateEditingGeometry`                                   | 手动提供 IME 几何（通常自动完成）                    |
| `transportMetrics()` / `inputTransportMetrics()`          | 传输与背压快照                                       |

常用选项：`onFrame`、`onHostError`、`onEditTransaction`、`onEventTransaction`、
`onSemantics`、`onNonPassiveRegions`、`transport`、`rasterCache`、`accessibility`、
`nativeTextInputMode`。

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
和共享的 `editableText` 原语。`View.virtual` 提供 M6 纵向兼容窗口；x/y 轴泛化属于 M7。
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

## 响应式与 hooks

```ts
(signal, computed, effect, batch, untracked);
(useState, useSignal, useMemo, useCallback, useRef, useEffect);
```

类型：`Signal`、`ReadonlySignal`、`RefObject`、`Unsubscribe`。

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
```

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
