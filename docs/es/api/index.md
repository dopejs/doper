# API pública

Lo que exporta `@dopejs/pingo` es el contrato público. Los paquetes internos (`@dopejs/pingo-host` y
demás) no prometen estabilidad, y el [escáner de migración](/migration) impide que una aplicación
dependa de ellos directamente.

::: tip La instantánea es el contrato
La superficie pública está congelada en `benchmarks/api/facade.v1.d.ts`. Cualquier cambio de firma
obliga a actualizar esa instantánea de forma explícita y a revisarla; `pnpm api:check` falla si hay
desviación.
:::

## Root y host

```ts
createHostedCanvasRoot(canvas, options?): Promise<HostedCanvasRoot>
createCanvasRoot(context, core, options?): DoperRoot   // ruta M1 en el hilo principal
createWasmCore(width, height, input?): Promise<CoreClient>
```

Métodos de `HostedCanvasRoot`:

| Método                                                    | Descripción                                             |
| --------------------------------------------------------- | ------------------------------------------------------- |
| `render(node)`                                            | Confirma un fotograma del árbol de componentes          |
| `close()`                                                 | Cierra el root, el Worker y el Core                     |
| `mode`                                                    | Transporte real: `sab` / `post-message` / `main-thread` |
| `beginScroll` / `scrollBy` / `endScroll` / `cancelScroll` | Manipulación directa del scroll                         |
| `focusEditable` / `blurEditable`                          | Inicia o termina la sesión de edición nativa            |
| `updateEditingGeometry`                                   | Geometría IME manual (normalmente automática)           |
| `transportMetrics()` / `inputTransportMetrics()`          | Instantánea de transporte y contrapresión               |

Opciones habituales: `onFrame`, `onHostError`, `onEditTransaction`, `onEventTransaction`,
`onSemantics`, `onNonPassiveRegions`, `transport`, `rasterCache`, `accessibility`,
`nativeTextInputMode`.

## Elementos y JSX

```ts
createElement(type, props, key?): DoperElement
Fragment
```

Elementos del host: `container`, `text`, `scroll`, `virtualList`, `editableText`.
Tipos: `CommonProps`, `ContainerProps`, `TextProps`, `ScrollProps`, `VirtualListProps`,
`EditableTextProps`, `EditableInputMode`, `Color`, `EdgeInsets`, `NodeHandle`, `Ref`,
`DoperNode`, `FunctionComponent`.

El runtime JSX se ofrece en `@dopejs/pingo/jsx-runtime` y `@dopejs/pingo/jsx-dev-runtime`.

## Reactividad y hooks

```ts
(signal, computed, effect, batch, untracked);
(useState, useSignal, useMemo, useCallback, useRef, useEffect);
```

Tipos: `Signal`, `ReadonlySignal`, `RefObject`, `Unsubscribe`.

## Edición

```ts
TextEditingController;
useTextEditingController(options);
```

Tipos: `EditTransaction`, `EditingGeometry`, `EditingSelection`, `NativeTextInputMode`.

## Widgets

```ts
TextField(props): DoperNode
TextArea(props): DoperNode
```

## Accesibilidad

```ts
SemanticTreeMirror
getByRole(root, role, { name? }): HTMLElement
queryAllByRole(root, role, { name? }): HTMLElement[]
```

Tipos: `SemanticNode`, `SemanticMirrorNode`, `SemanticTreeMirrorOptions`.

## Fuentes

```ts
createFont(options): DoperFont
loadFont(source, options?): Promise<DoperFont>
```

Compatible con TTF / OTF / TTC / WOFF / WOFF2 (el decodificador WOFF2 se carga bajo demanda).
Tipos: `DoperFontSource`, `DoperFontOptions`, `DoperFontLoadOptions`,
`DoperFontLoadError`, `DoperFontLoadErrorCode`, `Woff2Decoder`.

## Publicación y diagnóstico

```ts
ENGINE_VERSION: string
ENGINE_ABI_VERSION: number
engineIdentity(): { version, abiVersion }
verifyWasmIntegrity(bytes, manifest): Promise<void>
```

`WasmIntegrityError` se lanza cuando un WASM alojado por tu cuenta no coincide con el manifiesto de
la compilación. Véase [diagnóstico](/diagnostics).

## Frontera de migración

`@dopejs/pingo-compat` es un paquete de frontera independiente que ofrece `mountCompatPage` para el
despliegue por página y la vuelta atrás. Más detalles en la [guía de migración](/migration).
