# API ציבורי

מה ש-`@dopejs/doper` מייצא הוא החוזה הציבורי. חבילות פנימיות (`@dopejs/doper-host` ואחרות) אינן מבטיחות
יציבות, ו[סורק ההגירה](/migration) מונע מיישום להיות תלוי בהן ישירות.

::: tip התצלום הוא החוזה
המשטח הציבורי מקובע ב-`benchmarks/api/facade.v1.d.ts`. כל שינוי חתימה מחייב עדכון מפורש של אותו תצלום
ובדיקה שלו, ו-`pnpm api:check` נכשל בכל סטייה.
:::

## Root ומארח

```ts
createHostedCanvasRoot(canvas, options?): Promise<HostedCanvasRoot>
createCanvasRoot(context, core, options?): DoperRoot   // נתיב M1 בתהליכון הראשי
createWasmCore(width, height, input?): Promise<CoreClient>
```

המתודות של `HostedCanvasRoot`:

| מתודה                                                     | תיאור                                                     |
| --------------------------------------------------------- | --------------------------------------------------------- |
| `render(node)`                                            | מבצע commit לפריים אחד של עץ הרכיבים                      |
| `close()`                                                 | סוגר את ה-root, את ה-Worker ואת הליבה                     |
| `mode`                                                    | נתיב ההעברה בפועל: `sab` / `post-message` / `main-thread` |
| `beginScroll` / `scrollBy` / `endScroll` / `cancelScroll` | מניפולציה ישירה של הגלילה                                 |
| `focusEditable` / `blurEditable`                          | פתיחה או סיום של הפעלת עריכה נייטיב                       |
| `updateEditingGeometry`                                   | אספקת גיאומטריית IME ידנית (בדרך כלל אוטומטית)            |
| `transportMetrics()` / `inputTransportMetrics()`          | תצלום של ההעברה ושל לחץ החוזר                             |

אפשרויות נפוצות: `onFrame`, `onHostError`, `onEditTransaction`, `onEventTransaction`,
`onSemantics`, `onNonPassiveRegions`, `transport`, `rasterCache`, `accessibility`,
`nativeTextInputMode`.

## רכיבים ו-JSX

```ts
createElement(type, props, key?): DoperElement
Fragment
```

רכיבי מארח: `container`, `text`, `scroll`, `virtualList`, `editableText`.
טיפוסים: `CommonProps`, `ContainerProps`, `TextProps`, `ScrollProps`, `VirtualListProps`,
`EditableTextProps`, `EditableInputMode`, `Color`, `EdgeInsets`, `NodeHandle`, `Ref`,
`DoperNode`, `FunctionComponent`.

סביבת הריצה של JSX זמינה דרך `@dopejs/doper/jsx-runtime` ו-`@dopejs/doper/jsx-dev-runtime`.

## ריאקטיביות והוקים

```ts
(signal, computed, effect, batch, untracked);
(useState, useSignal, useMemo, useCallback, useRef, useEffect);
```

טיפוסים: `Signal`, `ReadonlySignal`, `RefObject`, `Unsubscribe`.

## עריכה

```ts
TextEditingController;
useTextEditingController(options);
```

טיפוסים: `EditTransaction`, `EditingGeometry`, `EditingSelection`, `NativeTextInputMode`.

## רכיבים מוכנים

```ts
TextField(props): DoperNode
TextArea(props): DoperNode
```

## נגישות

```ts
SemanticTreeMirror
getByRole(root, role, { name? }): HTMLElement
queryAllByRole(root, role, { name? }): HTMLElement[]
```

טיפוסים: `SemanticNode`, `SemanticMirrorNode`, `SemanticTreeMirrorOptions`.

## גופנים

```ts
createFont(options): DoperFont
loadFont(source, options?): Promise<DoperFont>
```

נתמכים TTF / OTF / TTC / WOFF / WOFF2 (מפענח ה-WOFF2 נטען לפי הצורך).
טיפוסים: `DoperFontSource`, `DoperFontOptions`, `DoperFontLoadOptions`,
`DoperFontLoadError`, `DoperFontLoadErrorCode`, `Woff2Decoder`.

## שחרור גרסה ואבחון

```ts
ENGINE_VERSION: string
ENGINE_ABI_VERSION: number
engineIdentity(): { version, abiVersion }
verifyWasmIntegrity(bytes, manifest): Promise<void>
```

‏`WasmIntegrityError` נזרק כאשר קובץ WASM שאתה מארח בעצמך אינו תואם למניפסט הבנייה. ראה
[אבחון](/diagnostics).

## גבול ההגירה

‏`@dopejs/doper-compat` היא חבילת גבול עצמאית המספקת את `mountCompatPage` להשקה לפי עמוד ולחזרה. פרטים
ב[מדריך ההגירה](/migration).
