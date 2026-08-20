---
title: 변경 내역
---

# Changelog

버전 정책은 `docs/release.md`를 보십시오. 11개 패키지를 같은 버전으로 원자적으로 배포하며,
npm semver와 바이너리 ABI 버전은 독립적으로 관리합니다.

## Unreleased

- 다음 npm 버전부터 프로젝트 라이선스를 MIT에서 Apache-2.0으로 변경합니다.
  이미 배포된 v0.2.1 이하 버전은 계속 MIT 라이선스를 적용합니다.
- 휠 전달 곡선을 브라우저 네이티브에 맞췄습니다. 이산 휠 노치는 애니메이션으로 스크롤하고,
  고정밀(트랙패드) 델타는 1:1로 즉시 적용합니다. Input Stream의 `DispatchEvent`에 flags 필드를
  추가했고 ABI 버전은 1 → 2가 되었습니다.
- 공식 사이트가 간체 중국어, 번체 중국어, 스페인어, 프랑스어, 독일어, 러시아어, 히브리어,
  아랍어, 일본어, 한국어를 지원합니다.

## 0.1.0

첫 배포 가능한 릴리스입니다. P0–M5 엔지니어링 마일스톤을 모두 완료했고 `pnpm m5:check`
(M0→M5 전 구간 자동 게이트)가 모두 통과했습니다.

- 결정적인 Rust/WASM Core + TypeScript Shell: 단일 스키마, 버전이 부여된 바이너리
  Mutation/Input/DisplayList/역방향 스트림, 잘못된 입력의 원자적 거부.
- 이중 클록 렌더링: SAB → postMessage → 메인 스레드 Canvas2D 폴백 체인. 메인 스레드가 200ms
  막혀도 Worker가 계속 표시합니다.
- 네이티브 가상 스크롤(100만 행 P95/P99 마이크로초 미만 재생)과 텍스트 서브시스템(명시적 폰트
  셰이핑, 글리프 아틀라스, 시스템 폰트 폴백).
- canvas 네이티브 편집: EditContext/입력 프록시 이중 경로, IME 조합, 포인터와 키보드 캐럿 이동,
  클립보드, undo/redo, 비밀번호 마스킹, 캐럿 scroll-into-view.
- 히트 테스트(증분 BVH + 단순 오라클 속성 테스트)와 capture/target/bubble 3단계 이벤트,
  비 passive 영역 동기 `preventDefault` 프로토콜.
- 접근성: 시맨틱 트리 내보내기, DOM 섀도 트리 반영, `getByRole` 시맨틱 E2E 셀렉터,
  키보드 포커스 전달.
- 마이그레이션과 production화: `@dopejs/pingo-compat`의 페이지 단위 점진 적용/롤백,
  마이그레이션 스캐너, 릴리스 패키지와 WASM SHA-256 무결성 검증, 진단과 운영 매뉴얼.
- 격리된 WebGPU 프로토타입과 헤드리스 오라클의 불일치 없는 차분(ADR-0006:
  Continue Experiment, 기본 비활성).

명시적 보류: bidi 시각적 캐럿 이동, 위젯 placeholder, WebGPU 기본 활성화.
플랫폼 자격(실기기 성능, 실제 IME, 스크린 리더)은 별도로 추적하며 패키지 버전으로 약속하지 않습니다.
