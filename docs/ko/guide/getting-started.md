# 시작하기

## 설치

```sh
pnpm add @dopejs/doper
```

애플리케이션은 `@dopejs/doper` 하나만 의존합니다. `@dopejs/doper-host`, `@dopejs/doper-jsx` 같은
패키지는 내부 구현이며 공개 계약이 아닙니다. [마이그레이션 스캐너](/migration)가 이들을 직접
import 하는 것을 거부합니다.

## 첫 캔버스 마운트하기

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/doper";

const canvas = document.querySelector<HTMLCanvasElement>("#app")!;
canvas.width = 800;
canvas.height = 600;

const root = await createHostedCanvasRoot(canvas);

root.render(
  createElement("container", {
    width: 800,
    height: 600,
    backgroundColor: "#ffffffff",
    padding: 24,
    children: createElement("text", {
      value: "Hello doper",
      fontSize: 24,
      lineHeight: 32,
      color: "#1f2329ff",
    }),
  }),
);
```

`createHostedCanvasRoot`는 브라우저 능력을 탐지해 SharedArrayBuffer, postMessage, 메인 스레드
Canvas2D 중에서 전송 경로를 고릅니다. 폴백을 위한 분기를 직접 작성할 필요가 없습니다.
실제 선택된 경로는 `root.mode`가 돌려줍니다.

## TSX 사용하기

`tsconfig.json`을 설정합니다.

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@dopejs/doper"
  }
}
```

그러면 다음처럼 작성할 수 있습니다.

```tsx
function OrderRow({ index }: { index: number }) {
  return (
    <container width={480} height={32} padding={[6, 12, 6, 12]}>
      <text value={`주문 #${index}`} fontSize={13} lineHeight={20} />
    </container>
  );
}

root.render(<OrderRow index={1} />);
```

## 호스트 요소

내장 요소는 다섯 개뿐이며 모두 Scene 노드에 직접 대응합니다. CSS 캐스케이드도 셀렉터도 없습니다.

| 요소           | 용도                                               |
| -------------- | -------------------------------------------------- |
| `container`    | 범용 그룹, 배경, 패딩, 변환                        |
| `text`         | 텍스트 런(셰이핑, 줄바꿈, 캐럿 기하는 Core가 담당) |
| `scroll`       | Core가 소유하는 스크롤 컨테이너                    |
| `virtualList`  | Core가 윈도를 계획하는 가상 리스트                 |
| `editableText` | 편집 가능한 텍스트 프리미티브                      |

`TextField`와 `TextArea`는 `editableText` 위에 조합한 위젯(테두리, 오류 상태)이며 새로운 입력
경로를 도입하지 않습니다.

## 상태와 부수 효과

```ts
import { signal, useEffect, useSignal, useState } from "@dopejs/doper";

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return createElement("text", { value: `${count}초 경과` });
}
```

사용할 수 있는 반응형 프리미티브는 `signal`, `computed`, `effect`, `batch`, `untracked`이고,
훅은 `useState`, `useSignal`, `useMemo`, `useCallback`, `useRef`, `useEffect`입니다.

::: warning 동기 레이아웃 읽기는 없습니다
`useLayoutEffect` 식의 동기적인 Worker 레이아웃 읽기는 지원하지 않습니다. 레이아웃은 다른 클록에서
일어납니다. 레이아웃 결과가 필요하면 비동기 계약을 사용하고, 렌더링 중에 기하를 동기적으로 읽으려
하지 마십시오.
:::

## 실행 상태 관측하기

```ts
const root = await createHostedCanvasRoot(canvas, {
  onFrame: (report) => {
    console.log(report.commands, report.displayListBytes, report.core?.sceneNodes);
  },
  onHostError: (error) => report(error),
});
```

`onFrame`은 프레임마다 명령 수, DisplayList 바이트 수, Core 쪽 더티 개수, 레이아웃 작업량,
picture 해시를 제공합니다. 성능 조사의 1차 자료입니다. 자세한 내용은 [진단](/diagnostics)을 보십시오.

## 다음 단계

- [아키텍처 개요](/ko/guide/architecture)：Shell과 Core의 역할 분담
- [가상 스크롤](/ko/guide/scrolling), [텍스트와 편집](/ko/guide/editing)
- [Playground](/ko/playground)：직접 조작할 수 있는 라이브 데모
