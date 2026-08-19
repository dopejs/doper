# 공개 API

`@dopejs/pingo`의 익스포트가 공개 계약입니다. 내부 패키지(`@dopejs/pingo-host` 등)는 안정성을
약속하지 않으며, [마이그레이션 스캐너](/migration)가 애플리케이션의 직접 의존을 막습니다.

::: tip 스냅샷이 곧 계약
공개 표면은 `benchmarks/api/facade.v1.d.ts`에 고정되어 있습니다. 시그니처가 바뀌면 이 스냅샷을
명시적으로 갱신하고 리뷰를 거쳐야 하며, 어긋나면 `pnpm api:check`가 실패합니다.
:::

## 루트와 호스트

```ts
createHostedCanvasRoot(canvas, options?): Promise<HostedCanvasRoot>
createCanvasRoot(context, core, options?): DoperRoot   // 메인 스레드 M1 경로
createWasmCore(width, height, input?): Promise<CoreClient>
```

`HostedCanvasRoot` 메서드:

| 메서드                                                    | 설명                                                   |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `render(node)`                                            | 컴포넌트 트리를 한 프레임 커밋                         |
| `close()`                                                 | root, Worker, Core 종료                                |
| `mode`                                                    | 실제 전송 경로: `sab` / `post-message` / `main-thread` |
| `beginScroll` / `scrollBy` / `endScroll` / `cancelScroll` | 스크롤 직접 조작                                       |
| `focusEditable` / `blurEditable`                          | 네이티브 편집 세션 시작 및 종료                        |
| `updateEditingGeometry`                                   | IME 기하 수동 지정(보통 자동)                          |
| `transportMetrics()` / `inputTransportMetrics()`          | 전송과 배압 스냅샷                                     |

자주 쓰는 옵션: `onFrame`, `onHostError`, `onEditTransaction`, `onEventTransaction`,
`onSemantics`, `onNonPassiveRegions`, `transport`, `rasterCache`, `accessibility`,
`nativeTextInputMode`.

## 요소와 JSX

```ts
createElement(type, props, key?): DoperElement
Fragment
```

호스트 요소: `container`, `text`, `scroll`, `virtualList`, `editableText`.
타입: `CommonProps`, `ContainerProps`, `TextProps`, `ScrollProps`, `VirtualListProps`,
`EditableTextProps`, `EditableInputMode`, `Color`, `EdgeInsets`, `NodeHandle`, `Ref`,
`DoperNode`, `FunctionComponent`.

JSX 런타임은 `@dopejs/pingo/jsx-runtime`과 `@dopejs/pingo/jsx-dev-runtime`으로 제공합니다.

## 반응성과 훅

```ts
(signal, computed, effect, batch, untracked);
(useState, useSignal, useMemo, useCallback, useRef, useEffect);
```

타입: `Signal`, `ReadonlySignal`, `RefObject`, `Unsubscribe`.

## 편집

```ts
TextEditingController;
useTextEditingController(options);
```

타입: `EditTransaction`, `EditingGeometry`, `EditingSelection`, `NativeTextInputMode`.

## 위젯

```ts
TextField(props): DoperNode
TextArea(props): DoperNode
```

## 접근성

```ts
SemanticTreeMirror
getByRole(root, role, { name? }): HTMLElement
queryAllByRole(root, role, { name? }): HTMLElement[]
```

타입: `SemanticNode`, `SemanticMirrorNode`, `SemanticTreeMirrorOptions`.

## 폰트

```ts
createFont(options): DoperFont
loadFont(source, options?): Promise<DoperFont>
```

TTF / OTF / TTC / WOFF / WOFF2를 지원합니다(WOFF2 디코더는 필요할 때 동적 로드).
타입: `DoperFontSource`, `DoperFontOptions`, `DoperFontLoadOptions`,
`DoperFontLoadError`, `DoperFontLoadErrorCode`, `Woff2Decoder`.

## 릴리스와 진단

```ts
ENGINE_VERSION: string
ENGINE_ABI_VERSION: number
engineIdentity(): { version, abiVersion }
verifyWasmIntegrity(bytes, manifest): Promise<void>
```

자체 호스팅한 WASM이 빌드 manifest와 일치하지 않으면 `WasmIntegrityError`가 발생합니다.
[진단](/diagnostics)을 보십시오.

## 마이그레이션 경계

`@dopejs/pingo-compat`은 독립적인 경계 패키지로, 페이지 단위 점진 적용과 롤백을 위한
`mountCompatPage`를 제공합니다. 자세한 내용은 [마이그레이션 가이드](/migration)에 있습니다.
