---
layout: home

hero:
  name: Pingo
  text: canvas 렌더링 엔진
  tagline: Rust/WASM 코어 + TypeScript 셸 + 교체 가능한 백엔드. 고성능 상호작용, 네이티브 가상 스크롤, canvas 내 텍스트 편집을 위해 설계되었습니다.
  actions:
    - theme: brand
      text: 시작하기
      link: /ko/guide/getting-started
    - theme: alt
      text: Playground
      link: /ko/playground
    - theme: alt
      text: GitHub
      link: https://github.com/dopejs/pingo

features:
  - title: 이중 클록 — 메인 스레드가 멈춰도 프레임은 유지
    details: UI 클록과 렌더링 클록이 서로 독립적입니다. 스크롤, 애니메이션, 레이아웃, 합성이 Worker 안에서 완결되므로 메인 스레드가 200ms 막혀도 화면은 끊기지 않습니다.
  - title: 네이티브 가상 스크롤
    details: 누적합 트리, 방향 예측 프리페치, 자리표시자 보완이 모두 Core 안에 있습니다. 100만 행 고정 픽스처를 20,000 프레임 재생한 P95/P99가 마이크로초 미만이며, 스크롤 중에는 Shell을 전혀 호출하지 않습니다.
  - title: canvas 네이티브 편집
    details: 캐럿, 선택 영역, 드래그 선택, 더블클릭 단어 선택, IME 조합, 후보창 위치, 클립보드, 실행 취소/다시 실행을 모두 엔진이 구현합니다. 입력을 위해 HTML 컨트롤을 만들 필요가 없습니다.
  - title: 접근성은 아키텍처의 일부
    details: Core가 시맨틱 트리를 내보내고 호스트가 canvas 옆에 DOM 섀도 트리로 반영합니다. 스크린 리더가 읽을 수 있고, E2E는 픽셀 비교 대신 role/label로 요소를 선택합니다.
  - title: 결정성과 차분 테스트
    details: 버전이 부여된 바이너리 스트림, 주입 가능한 시계와 난수원, 기록과 재생, 그리고 증분/전체·최적화/단순·wasm/native 차분 오라클.
  - title: 자동 폴백, 언제나 퇴로가 있음
    details: SharedArrayBuffer → postMessage → 메인 스레드 Canvas2D를 기능 동등하게 능력에 따라 자동 선택합니다. 마이그레이션 레이어는 페이지 단위 점진 적용과 원클릭 롤백을 지원합니다.
---

## 30초 만에 시작하기

```sh
pnpm add @dopejs/doper
```

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/doper";

const root = await createHostedCanvasRoot(document.querySelector("canvas")!);

root.render(
  createElement("virtualList", {
    width: 480,
    height: 640,
    itemCount: 1_000_000,
    estimatedItemHeight: 32,
    renderItem: (index) => createElement("text", { value: `${index}번째 행` }),
  }),
);
```

100만 행은 Shell에서 실체화되지 않고, 스크롤 중에 컴포넌트 트리를 호출하지도 않습니다.
윈도 계산과 보완은 모두 Core 안에서 일어납니다.

## 하지 않는 것

doper는 렌더링 엔진이지 브라우저가 아닙니다. SSR/HTML 최초 렌더링, 범용 CSS 호환(박스 모델,
캐스케이드, 셀렉터), 미니 프로그램이나 네이티브 어댑터 레이어, 업무 수준의 리치 텍스트
의미론(공동 편집, 수식, Markdown 명령)은 **다루지 않습니다**.

반면 캐럿, 선택 영역, IME, 클립보드, 실행 취소/다시 실행, 편집 가능한 텍스트 프리미티브는
**엔진이 소유합니다**. 이를 DOM 컨트롤 조합으로 업무 레이어에 떠넘기지 않습니다.

## 현재 상태

v0.1.0. P0–M5 엔지니어링 마일스톤을 모두 완료했고 `pnpm m5:check` 전 구간 자동 게이트를 통과했습니다.

실기기 성능, 실제 입력기, 스크린 리더 매트릭스는 플랫폼 자격 수집으로 따로 추적합니다.
bidi 시각적 캐럿 이동과 WebGPU 백엔드 기본 활성화는 [기록된 보류 항목](/plan)입니다.

::: tip 엔지니어링 문서 언어
기술 설계, 구현 계획, ADR은 현재 간체 중국어로만 제공되며 모든 언어에서 같은 문서로 연결됩니다.
:::
