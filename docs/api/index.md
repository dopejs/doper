# 公开 API

`@dopejs/doper` 的导出即公开契约。内部包（`@dopejs/doper-host` 等）不承诺稳定性，
[迁移扫描器](/migration)会阻止业务直接依赖它们。

::: tip 快照即契约
公开面被固化在 `benchmarks/api/facade.v1.d.ts` 中，任何签名变化都必须显式更新该快照并经过审阅，
`pnpm api:check` 在漂移时失败。
:::

## 根与宿主

```ts
createHostedCanvasRoot(canvas, options?): Promise<HostedCanvasRoot>
createCanvasRoot(context, core, options?): DoperRoot   // 主线程 M1 路径
createWasmCore(width, height, input?): Promise<CoreClient>
```

`HostedCanvasRoot` 方法：

| 方法                                                      | 说明                                                 |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `render(node)`                                            | 提交一帧组件树                                       |
| `close()`                                                 | 关闭 root、Worker 与 Core                            |
| `mode`                                                    | 实际传输路径：`sab` / `post-message` / `main-thread` |
| `beginScroll` / `scrollBy` / `endScroll` / `cancelScroll` | 直接操纵滚动                                         |
| `focusEditable` / `blurEditable`                          | 激活或结束原生编辑会话                               |
| `updateEditingGeometry`                                   | 手动提供 IME 几何（通常自动完成）                    |
| `transportMetrics()` / `inputTransportMetrics()`          | 传输与背压快照                                       |

常用选项：`onFrame`、`onHostError`、`onEditTransaction`、`onEventTransaction`、
`onSemantics`、`onNonPassiveRegions`、`transport`、`rasterCache`、`accessibility`、
`nativeTextInputMode`。

## 元素与 JSX

```ts
createElement(type, props, key?): DoperElement
Fragment
```

主机元素：`container`、`text`、`scroll`、`virtualList`、`editableText`。
类型：`CommonProps`、`ContainerProps`、`TextProps`、`ScrollProps`、`VirtualListProps`、
`EditableTextProps`、`EditableInputMode`、`Color`、`EdgeInsets`、`NodeHandle`、`Ref`、
`DoperNode`、`FunctionComponent`。

JSX 运行时通过 `@dopejs/doper/jsx-runtime` 与 `@dopejs/doper/jsx-dev-runtime` 提供。

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
TextField(props): DoperNode
TextArea(props): DoperNode
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
createFont(options): DoperFont
loadFont(source, options?): Promise<DoperFont>
```

支持 TTF / OTF / TTC / WOFF / WOFF2（WOFF2 解码器按需动态加载）。
类型：`DoperFontSource`、`DoperFontOptions`、`DoperFontLoadOptions`、
`DoperFontLoadError`、`DoperFontLoadErrorCode`、`Woff2Decoder`。

## 发布与诊断

```ts
ENGINE_VERSION: string
ENGINE_ABI_VERSION: number
engineIdentity(): { version, abiVersion }
verifyWasmIntegrity(bytes, manifest): Promise<void>
```

`WasmIntegrityError` 在自托管 WASM 与构建 manifest 不一致时抛出。见[诊断](/diagnostics)。

## 迁移边界

`@dopejs/doper-compat` 是独立的边界包，提供 `mountCompatPage` 做按页面灰度与回退。
详见[迁移指南](/migration)。
