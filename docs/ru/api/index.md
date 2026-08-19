# Публичный API

То, что экспортирует `@dopejs/pingo`, и есть публичный контракт. Внутренние пакеты
(`@dopejs/pingo-host` и прочие) не обещают стабильности, а [сканер миграции](/migration) не даёт
приложению зависеть от них напрямую.

::: tip Снимок и есть контракт
Публичная поверхность зафиксирована в `benchmarks/api/facade.v1.d.ts`. Любое изменение сигнатуры
требует явного обновления этого снимка и ревью; при расхождении `pnpm api:check` падает.
:::

## Root и хост

```ts
createHostedCanvasRoot(canvas, options?): Promise<HostedCanvasRoot>
createCanvasRoot(context, core, options?): DoperRoot   // путь M1 в главном потоке
createWasmCore(width, height, input?): Promise<CoreClient>
```

Методы `HostedCanvasRoot`:

| Метод                                                     | Описание                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `render(node)`                                            | Коммитит один кадр дерева компонентов                         |
| `close()`                                                 | Закрывает root, Worker и ядро                                 |
| `mode`                                                    | Фактический транспорт: `sab` / `post-message` / `main-thread` |
| `beginScroll` / `scrollBy` / `endScroll` / `cancelScroll` | Прямое управление прокруткой                                  |
| `focusEditable` / `blurEditable`                          | Начинает или завершает нативную сессию редактирования         |
| `updateEditingGeometry`                                   | Ручная передача геометрии IME (обычно автоматически)          |
| `transportMetrics()` / `inputTransportMetrics()`          | Снимок транспорта и обратного давления                        |

Часто используемые опции: `onFrame`, `onHostError`, `onEditTransaction`, `onEventTransaction`,
`onSemantics`, `onNonPassiveRegions`, `transport`, `rasterCache`, `accessibility`,
`nativeTextInputMode`.

## Элементы и JSX

```ts
createElement(type, props, key?): DoperElement
Fragment
```

Элементы хоста: `container`, `text`, `scroll`, `virtualList`, `editableText`.
Типы: `CommonProps`, `ContainerProps`, `TextProps`, `ScrollProps`, `VirtualListProps`,
`EditableTextProps`, `EditableInputMode`, `Color`, `EdgeInsets`, `NodeHandle`, `Ref`,
`DoperNode`, `FunctionComponent`.

Среда выполнения JSX доступна через `@dopejs/pingo/jsx-runtime` и `@dopejs/pingo/jsx-dev-runtime`.

## Реактивность и хуки

```ts
(signal, computed, effect, batch, untracked);
(useState, useSignal, useMemo, useCallback, useRef, useEffect);
```

Типы: `Signal`, `ReadonlySignal`, `RefObject`, `Unsubscribe`.

## Редактирование

```ts
TextEditingController;
useTextEditingController(options);
```

Типы: `EditTransaction`, `EditingGeometry`, `EditingSelection`, `NativeTextInputMode`.

## Виджеты

```ts
TextField(props): DoperNode
TextArea(props): DoperNode
```

## Доступность

```ts
SemanticTreeMirror
getByRole(root, role, { name? }): HTMLElement
queryAllByRole(root, role, { name? }): HTMLElement[]
```

Типы: `SemanticNode`, `SemanticMirrorNode`, `SemanticTreeMirrorOptions`.

## Шрифты

```ts
createFont(options): DoperFont
loadFont(source, options?): Promise<DoperFont>
```

Поддерживаются TTF / OTF / TTC / WOFF / WOFF2 (декодер WOFF2 подгружается по требованию).
Типы: `DoperFontSource`, `DoperFontOptions`, `DoperFontLoadOptions`,
`DoperFontLoadError`, `DoperFontLoadErrorCode`, `Woff2Decoder`.

## Выпуск и диагностика

```ts
ENGINE_VERSION: string
ENGINE_ABI_VERSION: number
engineIdentity(): { version, abiVersion }
verifyWasmIntegrity(bytes, manifest): Promise<void>
```

`WasmIntegrityError` выбрасывается, когда самостоятельно размещённый WASM не совпадает с манифестом
сборки. См. [диагностику](/diagnostics).

## Граница миграции

`@dopejs/pingo-compat` — отдельный граничный пакет, предоставляющий `mountCompatPage` для постраничного
раскатывания и возврата. Подробности в [руководстве по миграции](/migration).
