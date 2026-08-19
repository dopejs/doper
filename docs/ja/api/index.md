# 公開 API

`@dopejs/pingo` のエクスポートが公開契約です。内部パッケージ（`@dopejs/pingo-host` など）は
安定性を約束しません。[移行スキャナ](/migration)がアプリケーションからの直接依存を止めます。

::: tip スナップショットが契約
公開面は `benchmarks/api/facade.v1.d.ts` に固定されています。シグネチャの変更はこのスナップショットを
明示的に更新してレビューを通す必要があり、乖離すると `pnpm api:check` が失敗します。
:::

## ルートとホスト

```ts
createHostedCanvasRoot(canvas, options?): Promise<HostedCanvasRoot>
createCanvasRoot(context, core, options?): DoperRoot   // メインスレッドの M1 経路
createWasmCore(width, height, input?): Promise<CoreClient>
```

`HostedCanvasRoot` のメソッド：

| メソッド                                                  | 説明                                                   |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `render(node)`                                            | コンポーネントツリーを 1 フレーム分コミット            |
| `close()`                                                 | root、Worker、Core を終了                              |
| `mode`                                                    | 実際の転送経路：`sab` / `post-message` / `main-thread` |
| `beginScroll` / `scrollBy` / `endScroll` / `cancelScroll` | スクロールの直接操作                                   |
| `focusEditable` / `blurEditable`                          | ネイティブ編集セッションの開始と終了                   |
| `updateEditingGeometry`                                   | IME 幾何の手動指定（通常は自動）                       |
| `transportMetrics()` / `inputTransportMetrics()`          | 転送と背圧のスナップショット                           |

よく使うオプション：`onFrame`、`onHostError`、`onEditTransaction`、`onEventTransaction`、
`onSemantics`、`onNonPassiveRegions`、`transport`、`rasterCache`、`accessibility`、
`nativeTextInputMode`。

## 要素と JSX

```ts
createElement(type, props, key?): DoperElement
Fragment
```

ホスト要素：`container`、`text`、`scroll`、`virtualList`、`editableText`。
型：`CommonProps`、`ContainerProps`、`TextProps`、`ScrollProps`、`VirtualListProps`、
`EditableTextProps`、`EditableInputMode`、`Color`、`EdgeInsets`、`NodeHandle`、`Ref`、
`DoperNode`、`FunctionComponent`。

JSX ランタイムは `@dopejs/pingo/jsx-runtime` と `@dopejs/pingo/jsx-dev-runtime` で提供します。

## リアクティビティとフック

```ts
(signal, computed, effect, batch, untracked);
(useState, useSignal, useMemo, useCallback, useRef, useEffect);
```

型：`Signal`、`ReadonlySignal`、`RefObject`、`Unsubscribe`。

## 編集

```ts
TextEditingController;
useTextEditingController(options);
```

型：`EditTransaction`、`EditingGeometry`、`EditingSelection`、`NativeTextInputMode`。

## ウィジェット

```ts
TextField(props): DoperNode
TextArea(props): DoperNode
```

## アクセシビリティ

```ts
SemanticTreeMirror
getByRole(root, role, { name? }): HTMLElement
queryAllByRole(root, role, { name? }): HTMLElement[]
```

型：`SemanticNode`、`SemanticMirrorNode`、`SemanticTreeMirrorOptions`。

## フォント

```ts
createFont(options): DoperFont
loadFont(source, options?): Promise<DoperFont>
```

TTF / OTF / TTC / WOFF / WOFF2 に対応します（WOFF2 デコーダは必要時に動的読み込み）。
型：`DoperFontSource`、`DoperFontOptions`、`DoperFontLoadOptions`、
`DoperFontLoadError`、`DoperFontLoadErrorCode`、`Woff2Decoder`。

## リリースと診断

```ts
ENGINE_VERSION: string
ENGINE_ABI_VERSION: number
engineIdentity(): { version, abiVersion }
verifyWasmIntegrity(bytes, manifest): Promise<void>
```

セルフホストした WASM がビルドの manifest と一致しない場合、`WasmIntegrityError` が投げられます。
[診断](/diagnostics)を参照してください。

## 移行の境界

`@dopejs/pingo-compat` は独立した境界パッケージで、ページ単位の段階適用とロールバックのための
`mountCompatPage` を提供します。詳しくは[移行ガイド](/migration)を参照してください。
