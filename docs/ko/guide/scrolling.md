# 가상 스크롤

## 왜 엔진 안에서 하는가

DOM 기반 가상 리스트의 꼬리 지연은 스크롤 이벤트가 메인 스레드로 돌아가 setState를 일으키고
diff를 거쳐 재레이아웃하는 데서 옵니다. 메인 스레드가 바쁘면 프레임이 떨어집니다.

pingo는 윈도 계산을 Core에 둡니다. 스크롤 중에는 **Shell을 전혀 호출하지 않습니다**. Shell은
Core가 계획한 프리페치 윈도에 따라 보이는 구간만 실체화하고, 데이터가 아직 없으면 자리표시자를
그린 뒤 이후 프레임에서 보완합니다.

## 사용법

```ts
createElement("virtualList", {
  width: 480,
  height: 640,
  itemCount: 1_000_000,
  estimatedItemHeight: 32,
  renderItem: (index: number) =>
    createElement("container", {
      width: 480,
      height: 32,
      children: createElement("text", { value: `${index}번째 행` }),
    }),
});
```

`estimatedItemHeight`는 초기 추정값일 뿐입니다. 실제 높이를 측정하면 Core가 누적합 트리(Fenwick)로
앵커 위치를 보정하므로 스크롤 위치가 튀지 않습니다.

## 조정 가능한 항목

| prop                     | 역할                                            |
| ------------------------ | ----------------------------------------------- |
| `baseOverscanViewports`  | 대칭 프리페치 범위(뷰포트 배수)                 |
| `velocityHorizonSeconds` | 방향 예측에 쓰는 속도 투영 시간                 |
| `maximumAheadViewports`  | 한 방향 프리페치 상한                           |
| `scrollX` / `scrollY`    | 프로그램적 스크롤 위치(변할 때만 ScrollTo 발행) |

방향 예측은 빠른 플링에서 진행 방향을 우선 프리페치하며, 양쪽에 예산을 균등하게 낭비하지 않습니다.

## 프로그램적 스크롤

```ts
// prop 변화로 ScrollTo mutation을 한 번 발행합니다
root.render(createElement("virtualList", { scrollY: 500_000 * 32 /* ... */ }));
```

커스텀 제스처에는 root의 직접 조작 API를 사용합니다.

```ts
root.beginScroll(handle);
root.scrollBy(handle, 0, deltaY, elapsedMs);
root.endScroll(handle); // 플링 속도 추정은 Core에 맡깁니다
```

`handle`은 요소의 `ref` 콜백(`NodeHandle`)에서 얻습니다.

## 휠과 트랙패드

휠의 **이동량**은 브라우저 네이티브와 같지만 전달 곡선은 입력 소스에 따라 갈립니다. 고정밀
델타(트랙패드)는 1:1로 즉시 적용하고 관성은 OS 이벤트 스트림이 제공합니다. 이산 휠 노치는
애니메이션 목표값에 누적되어 지수적으로 감속하며 접근하고, 브라우저와 똑같이 콘텐츠 경계에
하드 클램프되어 오버스크롤이 생기지 않습니다.

## 중첩과 편집

포인터 드래그가 편집 가능한 텍스트 위에서 시작되면 텍스트 선택이 스크롤 드래그보다 우선합니다.
휠은 여전히 가장 가까운 스크롤 조상을 스크롤합니다. 이 우선순위는 히트 경로의 깊이로 결정되며
애플리케이션이 개입할 필요가 없습니다.

## 성능 기준

고정 픽스처(100만 행, 20,000 프레임)의 자동 벤치마크는 병합 게이트의 일부입니다.
현재 P95/P99는 마이크로초 미만 재생이며 30분 연속 스크롤에서도 통제 불가능한 메모리 증가가 없습니다.

실기기 P95/P99와 입력 지연은 플랫폼 자격 수집이며 엔지니어링 완료 조건이 아닙니다. 이 경계는
의도적입니다. 재현할 수 없는 기기 데이터로 개발을 막지 않기 위해서이고, 엔지니어링 수치를 기기
약속으로 위장하지 않기 위해서입니다.

[Playground의 스크롤 데모](/ko/playground#/scroll)에서 실시간 프레임 지표를 볼 수 있습니다.
