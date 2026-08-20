# واجهة البرمجة العامة

ما تُصدّره `@dopejs/pingo` هو العقد العلني. أمّا الحزم الداخلية (`@dopejs/pingo-host` وغيرها) فلا تَعِد
بالاستقرار، و[ماسح الترحيل](/migration) يمنع التطبيقات من الاعتماد عليها مباشرة.

::: tip اللقطة هي العقد
السطح العلني مثبَّت في `benchmarks/api/facade.v1.d.ts`. وأيّ تغيير في التوقيع يستوجب تحديث تلك اللقطة
صراحةً ومراجعتها، ويفشل `pnpm api:check` عند أيّ انحراف.
:::

## الجذر والمضيف

```ts
createHostedCanvasRoot(canvas, options?): Promise<HostedCanvasRoot>
createCanvasRoot(context, core, options?): PingoRoot   // مسار M1 على الخيط الرئيسي
createWasmCore(width, height, input?): Promise<CoreClient>
```

توابع `HostedCanvasRoot`:

| التابع                                                    | الوصف                                                     |
| --------------------------------------------------------- | --------------------------------------------------------- |
| `render(node)`                                            | يُودِع إطارًا من شجرة المكوّنات                           |
| `close()`                                                 | يغلق الجذر والـ Worker والنواة                            |
| `mode`                                                    | مسار النقل الفعلي: `sab` / `post-message` / `main-thread` |
| `beginScroll` / `scrollBy` / `endScroll` / `cancelScroll` | التحكّم المباشر بالتمرير                                  |
| `focusEditable` / `blurEditable`                          | بدء جلسة التحرير الأصلية أو إنهاؤها                       |
| `updateEditingGeometry`                                   | تزويد هندسة IME يدويًا (تلقائي عادةً)                     |
| `transportMetrics()` / `inputTransportMetrics()`          | لقطة عن النقل والضغط العكسي                               |

الخيارات الشائعة: `onFrame` و`onHostError` و`onEditTransaction` و`onEventTransaction`
و`onSemantics` و`onNonPassiveRegions` و`transport` و`rasterCache` و`accessibility`
و`nativeTextInputMode`.

## العناصر وJSX

```ts
createElement(type, props, key?): PingoElement
Fragment
```

عناصر المضيف: `container` و`text` و`scroll` و`virtualList` و`editableText`.
الأنواع: `CommonProps` و`ContainerProps` و`TextProps` و`ScrollProps` و`VirtualListProps`
و`EditableTextProps` و`EditableInputMode` و`Color` و`EdgeInsets` و`NodeHandle` و`Ref`
و`PingoNode` و`FunctionComponent`.

وتُتاح بيئة تشغيل JSX عبر `@dopejs/pingo/jsx-runtime` و`@dopejs/pingo/jsx-dev-runtime`.

## التفاعلية والخطّافات

```ts
(signal, computed, effect, batch, untracked);
(useState, useSignal, useMemo, useCallback, useRef, useEffect);
```

الأنواع: `Signal` و`ReadonlySignal` و`RefObject` و`Unsubscribe`.

## التحرير

```ts
TextEditingController;
useTextEditingController(options);
```

الأنواع: `EditTransaction` و`EditingGeometry` و`EditingSelection` و`NativeTextInputMode`.

## العناصر الجاهزة

```ts
TextField(props): PingoNode
TextArea(props): PingoNode
```

## إمكانية الوصول

```ts
SemanticTreeMirror
getByRole(root, role, { name? }): HTMLElement
queryAllByRole(root, role, { name? }): HTMLElement[]
```

الأنواع: `SemanticNode` و`SemanticMirrorNode` و`SemanticTreeMirrorOptions`.

## الخطوط

```ts
createFont(options): PingoFont
loadFont(source, options?): Promise<PingoFont>
```

مدعومة الصيغ TTF / OTF / TTC / WOFF / WOFF2 (يُحمَّل مفكِّك WOFF2 عند الحاجة).
الأنواع: `PingoFontSource` و`PingoFontOptions` و`PingoFontLoadOptions`
و`PingoFontLoadError` و`PingoFontLoadErrorCode` و`Woff2Decoder`.

## الإصدار والتشخيص

```ts
ENGINE_VERSION: string
ENGINE_ABI_VERSION: number
engineIdentity(): { version, abiVersion }
verifyWasmIntegrity(bytes, manifest): Promise<void>
```

يُرمى `WasmIntegrityError` حين لا يطابق ملفّ WASM المستضاف ذاتيًا بيان البناء. انظر
[التشخيص](/diagnostics).

## حدّ الترحيل

‏`@dopejs/pingo-compat` حزمة حدّية مستقلّة توفّر `mountCompatPage` للإطلاق صفحةً صفحة وللعودة. التفاصيل
في [دليل الترحيل](/migration).
