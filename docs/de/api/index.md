# Öffentliche API

Was `@dopejs/doper` exportiert, ist der öffentliche Vertrag. Interne Pakete (`@dopejs/doper-host` und
weitere) sagen keine Stabilität zu, und der [Migrationsscanner](/migration) verhindert, dass eine
Anwendung direkt von ihnen abhängt.

::: tip Der Schnappschuss ist der Vertrag
Die öffentliche Oberfläche ist in `benchmarks/api/facade.v1.d.ts` festgeschrieben. Jede Signaturänderung
erfordert eine ausdrückliche Aktualisierung dieses Schnappschusses samt Review; `pnpm api:check`
schlägt bei Abweichung fehl.
:::

## Root und Host

```ts
createHostedCanvasRoot(canvas, options?): Promise<HostedCanvasRoot>
createCanvasRoot(context, core, options?): DoperRoot   // M1-Pfad im Hauptthread
createWasmCore(width, height, input?): Promise<CoreClient>
```

Methoden von `HostedCanvasRoot`:

| Methode                                                   | Beschreibung                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| `render(node)`                                            | Committet einen Frame des Komponentenbaums                      |
| `close()`                                                 | Schließt Root, Worker und Core                                  |
| `mode`                                                    | Tatsächlicher Transport: `sab` / `post-message` / `main-thread` |
| `beginScroll` / `scrollBy` / `endScroll` / `cancelScroll` | Direkte Scroll-Manipulation                                     |
| `focusEditable` / `blurEditable`                          | Startet oder beendet die native Bearbeitungssitzung             |
| `updateEditingGeometry`                                   | IME-Geometrie manuell setzen (normalerweise automatisch)        |
| `transportMetrics()` / `inputTransportMetrics()`          | Schnappschuss von Transport und Gegendruck                      |

Gängige Optionen: `onFrame`, `onHostError`, `onEditTransaction`, `onEventTransaction`,
`onSemantics`, `onNonPassiveRegions`, `transport`, `rasterCache`, `accessibility`,
`nativeTextInputMode`.

## Elemente und JSX

```ts
createElement(type, props, key?): DoperElement
Fragment
```

Host-Elemente: `container`, `text`, `scroll`, `virtualList`, `editableText`.
Typen: `CommonProps`, `ContainerProps`, `TextProps`, `ScrollProps`, `VirtualListProps`,
`EditableTextProps`, `EditableInputMode`, `Color`, `EdgeInsets`, `NodeHandle`, `Ref`,
`DoperNode`, `FunctionComponent`.

Die JSX-Runtime steht über `@dopejs/doper/jsx-runtime` und `@dopejs/doper/jsx-dev-runtime` bereit.

## Reaktivität und Hooks

```ts
(signal, computed, effect, batch, untracked);
(useState, useSignal, useMemo, useCallback, useRef, useEffect);
```

Typen: `Signal`, `ReadonlySignal`, `RefObject`, `Unsubscribe`.

## Bearbeitung

```ts
TextEditingController;
useTextEditingController(options);
```

Typen: `EditTransaction`, `EditingGeometry`, `EditingSelection`, `NativeTextInputMode`.

## Widgets

```ts
TextField(props): DoperNode
TextArea(props): DoperNode
```

## Barrierefreiheit

```ts
SemanticTreeMirror
getByRole(root, role, { name? }): HTMLElement
queryAllByRole(root, role, { name? }): HTMLElement[]
```

Typen: `SemanticNode`, `SemanticMirrorNode`, `SemanticTreeMirrorOptions`.

## Schriften

```ts
createFont(options): DoperFont
loadFont(source, options?): Promise<DoperFont>
```

Unterstützt TTF / OTF / TTC / WOFF / WOFF2 (der WOFF2-Decoder wird bei Bedarf nachgeladen).
Typen: `DoperFontSource`, `DoperFontOptions`, `DoperFontLoadOptions`,
`DoperFontLoadError`, `DoperFontLoadErrorCode`, `Woff2Decoder`.

## Veröffentlichung und Diagnose

```ts
ENGINE_VERSION: string
ENGINE_ABI_VERSION: number
engineIdentity(): { version, abiVersion }
verifyWasmIntegrity(bytes, manifest): Promise<void>
```

`WasmIntegrityError` wird geworfen, wenn ein selbst gehostetes WASM nicht zum Build-Manifest passt.
Siehe [Diagnose](/diagnostics).

## Migrationsgrenze

`@dopejs/doper-compat` ist ein eigenständiges Grenzpaket und stellt `mountCompatPage` für seitenweises
Ausrollen und Zurücknehmen bereit. Details im [Migrationsleitfaden](/migration).
