# API publique

Ce qu'exporte `@dopejs/pingo` constitue le contrat public. Les paquets internes (`@dopejs/pingo-host`
et consorts) ne promettent aucune stabilité, et le [scanner de migration](/migration) empêche une
application d'en dépendre directement.

::: tip L'instantané est le contrat
La surface publique est figée dans `benchmarks/api/facade.v1.d.ts`. Toute modification de signature
impose de mettre à jour explicitement cet instantané et de le faire relire ; `pnpm api:check` échoue en
cas de dérive.
:::

## Root et hôte

```ts
createHostedCanvasRoot(canvas, options?): Promise<HostedCanvasRoot>
createCanvasRoot(context, core, options?): DoperRoot   // chemin M1 sur le thread principal
createWasmCore(width, height, input?): Promise<CoreClient>
```

Méthodes de `HostedCanvasRoot` :

| Méthode                                                   | Description                                              |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `render(node)`                                            | Valide une image de l'arbre de composants                |
| `close()`                                                 | Ferme le root, le Worker et le Core                      |
| `mode`                                                    | Transport réel : `sab` / `post-message` / `main-thread`  |
| `beginScroll` / `scrollBy` / `endScroll` / `cancelScroll` | Manipulation directe du défilement                       |
| `focusEditable` / `blurEditable`                          | Ouvre ou termine la session d'édition native             |
| `updateEditingGeometry`                                   | Géométrie IME fournie à la main (automatique en général) |
| `transportMetrics()` / `inputTransportMetrics()`          | Instantané du transport et de la contre-pression         |

Options courantes : `onFrame`, `onHostError`, `onEditTransaction`, `onEventTransaction`,
`onSemantics`, `onNonPassiveRegions`, `transport`, `rasterCache`, `accessibility`,
`nativeTextInputMode`.

## Éléments et JSX

```ts
createElement(type, props, key?): DoperElement
Fragment
```

Éléments hôtes : `container`, `text`, `scroll`, `virtualList`, `editableText`.
Types : `CommonProps`, `ContainerProps`, `TextProps`, `ScrollProps`, `VirtualListProps`,
`EditableTextProps`, `EditableInputMode`, `Color`, `EdgeInsets`, `NodeHandle`, `Ref`,
`DoperNode`, `FunctionComponent`.

Le runtime JSX est fourni via `@dopejs/pingo/jsx-runtime` et `@dopejs/pingo/jsx-dev-runtime`.

## Réactivité et hooks

```ts
(signal, computed, effect, batch, untracked);
(useState, useSignal, useMemo, useCallback, useRef, useEffect);
```

Types : `Signal`, `ReadonlySignal`, `RefObject`, `Unsubscribe`.

## Édition

```ts
TextEditingController;
useTextEditingController(options);
```

Types : `EditTransaction`, `EditingGeometry`, `EditingSelection`, `NativeTextInputMode`.

## Widgets

```ts
TextField(props): DoperNode
TextArea(props): DoperNode
```

## Accessibilité

```ts
SemanticTreeMirror
getByRole(root, role, { name? }): HTMLElement
queryAllByRole(root, role, { name? }): HTMLElement[]
```

Types : `SemanticNode`, `SemanticMirrorNode`, `SemanticTreeMirrorOptions`.

## Polices

```ts
createFont(options): DoperFont
loadFont(source, options?): Promise<DoperFont>
```

Prise en charge de TTF / OTF / TTC / WOFF / WOFF2 (le décodeur WOFF2 est chargé à la demande).
Types : `DoperFontSource`, `DoperFontOptions`, `DoperFontLoadOptions`,
`DoperFontLoadError`, `DoperFontLoadErrorCode`, `Woff2Decoder`.

## Publication et diagnostic

```ts
ENGINE_VERSION: string
ENGINE_ABI_VERSION: number
engineIdentity(): { version, abiVersion }
verifyWasmIntegrity(bytes, manifest): Promise<void>
```

`WasmIntegrityError` est levée lorsqu'un WASM que vous hébergez vous-même ne correspond pas au
manifeste de la compilation. Voir le [diagnostic](/diagnostics).

## Frontière de migration

`@dopejs/pingo-compat` est un paquet frontière indépendant qui fournit `mountCompatPage` pour le
déploiement page par page et le retour arrière. Détails dans le [guide de migration](/migration).
