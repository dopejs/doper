# 公開 API

`@dopejs/doper` 的匯出即公開契約。內部套件（`@dopejs/doper-host` 等）不承諾穩定性，
[遷移掃描器](/migration)會阻止業務直接相依它們。

::: tip 快照即契約
公開面被固化在 `benchmarks/api/facade.v1.d.ts` 中，任何簽章變化都必須明確更新該快照並經過審閱，
`pnpm api:check` 在漂移時失敗。
:::

## 根與宿主

```ts
createHostedCanvasRoot(canvas, options?): Promise<HostedCanvasRoot>
createCanvasRoot(context, core, options?): DoperRoot   // 主執行緒 M1 路徑
createWasmCore(width, height, input?): Promise<CoreClient>
```

`HostedCanvasRoot` 方法：

| 方法                                                      | 說明                                                 |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `render(node)`                                            | 提交一幀元件樹                                       |
| `close()`                                                 | 關閉 root、Worker 與 Core                            |
| `mode`                                                    | 實際傳輸路徑：`sab` / `post-message` / `main-thread` |
| `beginScroll` / `scrollBy` / `endScroll` / `cancelScroll` | 直接操縱捲動                                         |
| `focusEditable` / `blurEditable`                          | 啟用或結束原生編輯工作階段                           |
| `updateEditingGeometry`                                   | 手動提供 IME 幾何（通常自動完成）                    |
| `transportMetrics()` / `inputTransportMetrics()`          | 傳輸與背壓快照                                       |

常用選項：`onFrame`、`onHostError`、`onEditTransaction`、`onEventTransaction`、
`onSemantics`、`onNonPassiveRegions`、`transport`、`rasterCache`、`accessibility`、
`nativeTextInputMode`。

## 元素與 JSX

```ts
createElement(type, props, key?): DoperElement
Fragment
```

主機元素：`container`、`text`、`scroll`、`virtualList`、`editableText`。
型別：`CommonProps`、`ContainerProps`、`TextProps`、`ScrollProps`、`VirtualListProps`、
`EditableTextProps`、`EditableInputMode`、`Color`、`EdgeInsets`、`NodeHandle`、`Ref`、
`DoperNode`、`FunctionComponent`。

JSX 執行階段透過 `@dopejs/doper/jsx-runtime` 與 `@dopejs/doper/jsx-dev-runtime` 提供。

## 響應式與 hooks

```ts
(signal, computed, effect, batch, untracked);
(useState, useSignal, useMemo, useCallback, useRef, useEffect);
```

型別：`Signal`、`ReadonlySignal`、`RefObject`、`Unsubscribe`。

## 編輯

```ts
TextEditingController;
useTextEditingController(options);
```

型別：`EditTransaction`、`EditingGeometry`、`EditingSelection`、`NativeTextInputMode`。

## Widgets

```ts
TextField(props): DoperNode
TextArea(props): DoperNode
```

## 無障礙

```ts
SemanticTreeMirror
getByRole(root, role, { name? }): HTMLElement
queryAllByRole(root, role, { name? }): HTMLElement[]
```

型別：`SemanticNode`、`SemanticMirrorNode`、`SemanticTreeMirrorOptions`。

## 字體

```ts
createFont(options): DoperFont
loadFont(source, options?): Promise<DoperFont>
```

支援 TTF / OTF / TTC / WOFF / WOFF2（WOFF2 解碼器按需動態載入）。
型別：`DoperFontSource`、`DoperFontOptions`、`DoperFontLoadOptions`、
`DoperFontLoadError`、`DoperFontLoadErrorCode`、`Woff2Decoder`。

## 發佈與診斷

```ts
ENGINE_VERSION: string
ENGINE_ABI_VERSION: number
engineIdentity(): { version, abiVersion }
verifyWasmIntegrity(bytes, manifest): Promise<void>
```

`WasmIntegrityError` 在自架 WASM 與建置 manifest 不一致時擲出。見[診斷](/diagnostics)。

## 遷移邊界

`@dopejs/doper-compat` 是獨立的邊界套件，提供 `mountCompatPage` 做依頁面灰度與回退。
詳見[遷移指南](/migration)。
