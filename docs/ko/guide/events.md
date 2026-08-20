# 이벤트와 히트 테스트

## 수집과 히트 테스트의 분리

메인 스레드는 pointer/wheel/touch를 `{ passive: true }`로 구독합니다. 스크롤 관련 이벤트는
**델타와 타임스탬프를 공유 채널에 쓰기만 하고, 히트 테스트도 setState도 하지 않습니다**.

히트 테스트는 Core에서 일어납니다. 월드 AABB 기반 BVH를 Scene에 맞춰 증분 유지하고(토폴로지가
바뀌면 재구축, 기하만 바뀌면 refit), 히트 후 root→target 경로를 만들어 역방향 스트림으로 Shell에
돌려줍니다.

BVH와 단순 선형 구현의 결과가 일치한다는 것은 속성 테스트가 보장합니다. 최적화된 경로에는 항상
차분 가능한 오라클이 있습니다.

## 3단계 전파

이벤트 모델은 DOM에 맞춥니다. capture → target → bubble.

```tsx
<container onClickCapture={(event) => log("outer capture", event.eventPhase)}>
  <container
    onPointerDown={(event) => {
      event.preventDefault();
      event.stopPropagation();
    }}
  />
</container>
```

사용할 수 있는 핸들러는 `onPointerDown`, `onPointerUp`, `onPointerMove`, `onPointerCancel`,
`onClick`, `onWheel`이며 각각 `*Capture` 버전이 있습니다.

`PingoEvent`는 `target`, `currentTarget`, `eventPhase`, 캔버스 로컬 논리 좌표 `x`/`y`,
`deltaX`/`deltaY`, `buttons`, 수정자 키, `preventDefault()`, `stopPropagation()`,
`stopImmediatePropagation()`을 제공합니다.

## preventDefault의 타이밍 문제

passive 리스너는 `preventDefault()`를 호출할 수 없습니다. 이는 얼버무릴 수 있는 세부사항이 아니라
명시적으로 다뤄야 하는 정확성 문제입니다.

해법은 이렇습니다. 기본 동작을 막아야 하는 영역(예: 내부 스크롤 영역)을 **Core가 미리 계산**해
"비 passive 영역 사각형"을 메인 스레드로 동기화합니다. 메인 스레드는 그 영역에 대해서만 비 passive
리스너로 바꾸고, 영역에 히트하면 **동기적으로** `preventDefault()`를 호출합니다. 따라서 비동기
회신에 의존하는 경쟁 상태가 존재하지 않습니다.

## 히트 의미론의 경계

현재 의미론은 암묵적 동작을 피하려고 의도적으로 좁혀 두었습니다.

- **겹친 히트**에서는 "가장 나중에 그려진 것"을 target으로 삼습니다. z-order, `pointer-events`로
  히트를 끄는 것, 보이지 않는 노드 건너뛰기는 아직 제공하지 않습니다. 어느 하나를 도입하려면
  명시적인 설계 결정이 필요합니다.
- **프레임 스냅샷 히트**：같은 이벤트 배치 안의 모든 이벤트는 직전에 커밋된 프레임의 기하에 대해
  히트를 계산합니다. 배치 안의 스크롤로 기하가 바뀌어도 다음 프레임까지 히트에 영향을 주지
  않습니다. 이것이 이벤트 배치의 원자적 롤백 의미론과 결정적 재생을 보장합니다.
- 키보드 입력은 [편집 입력 프로토콜](/ko/guide/editing)을 통하며 히트 이벤트로 위장하지 않습니다.

[Playground의 이벤트 데모](/ko/playground#/events)에서 3단계 전파 로그를 실시간으로 볼 수 있습니다.
