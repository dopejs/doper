# 텍스트와 편집

## 편집은 엔진의 기능이지 애플리케이션의 조합이 아니다

전통적인 canvas 방식의 고질적인 약점은 입력이 필요할 때 canvas 위에 HTML `input`을 덮는 것입니다.
그 결과 캐럿 어긋남, IME 후보창 위치 이탈, 스크롤 비동기, 접근성 단절 같은 문제가 줄줄이 따라옵니다.

doper는 편집을 Core의 일급 기능으로 다룹니다. 캐럿, 선택 영역, 드래그 선택, 더블클릭 단어 선택,
키보드 이동, IME 조합, 후보창 위치, 클립보드, 실행 취소/다시 실행, 읽기 전용과 비밀번호까지
모두 엔진이 구현합니다.
**애플리케이션은 어떤 HTML 입력 컨트롤도 만들지 않고, 배치하지 않으며, 동기화하지도 않습니다.**

## 위젯 사용하기

```ts
import { TextField, TextArea } from "@dopejs/doper";

TextField({
  value: order.note,
  revision: order.revision,
  semanticLabel: "주문 메모",
  inputMode: "text",
  onTransaction: (transaction) => order.apply(transaction),
});

TextArea({ value: description, revision, rows: 4 });
```

## 프리미티브 사용하기

```ts
createElement("editableText", {
  value,
  revision,
  multiline: false,
  readOnly: false,
  password: false,
  maxGraphemes: 200,
  inputMode: "email",
  onTransaction: (transaction) => apply(transaction),
  onSubmit: () => moveToNextCell(),
});
```

로컬 컨트롤러를 쓸 수도 있습니다.

```ts
import { useTextEditingController } from "@dopejs/doper";

const editor = useTextEditingController({ value: cell.value });
createElement("editableText", { controller: editor });
```

## 입력 브리지와 폴백

메인 스레드는 우선순위에 따라 운영체제의 텍스트 입력 서비스에 연결합니다.

1. **EditContext** —— canvas에 바인딩해 텍스트/선택/조합을 받고, IME에 control, selection,
   character bounds를 제공합니다.
2. **엔진이 관리하는 입력 프록시** —— EditContext를 쓸 수 없을 때 호스트는 **하나뿐인** 숨겨진
   `textarea`로 `beforeinput`, 조합, 소프트 키보드, 클립보드를 일괄 처리합니다.

두 번째는 플랫폼 폴백 구현이지 EmbedDOM 컴포넌트 모델이 아닙니다. Scene 안의 편집 노드마다
대응하는 DOM은 존재하지 않습니다. 두 경로는 같은 편집 계약 테스트를 통과합니다.

## 버전이 부여된 편집 트랜잭션

상태 소유권은 명확합니다. **Shell은 업무 데이터를, Core는 활성 편집 세션의 순간 상태를 소유합니다.**

```
입력 → Core가 base_revision 검증 → 즉시 적용하고 다시 그림 → 역방향으로 버전 붙은 EditTransaction
                                                                     ↓
                                            Shell이 확인하거나 새 revision으로 보정값을 보냄
```

오래된 트랜잭션이 더 새로운 상태를 덮어쓰는 일은 없습니다. 즉 키 입력마다 전체 TSX 빌드를
돌 필요가 없으면서도 제어된 데이터와 업무 검증은 계속 성립합니다.

```ts
onTransaction: (transaction) => {
  // transaction.baseRevision / revision / delta / selection / kind
  value = applyDelta(value, transaction);
};
```

## 텍스트 위치 모델

웹 입력 API는 UTF-16 오프셋을 쓰고, Rust 문자열은 UTF-8이며, 자소·셰이핑 클러스터·시각적
글리프의 경계는 모두 다릅니다. 엔진은 명시적인 대응 관계를 유지합니다.

```
UTF-16 offset ↔ Unicode scalar ↔ 자소 ↔ 셰이핑 클러스터 ↔ 글리프 / 줄
```

프로토콜 경계에서는 EditContext 및 InputEvent에 맞추어 UTF-16으로 통일합니다.
**삭제, 이동, 선택이 자소, 결합 시퀀스, 이모지 ZWJ, 셰이핑 클러스터를 쪼개는 일은 없습니다.**
이는 속성 테스트와 조합 픽스처 매트릭스(결합 문자, 이모지 ZWJ, RTL, CJK 다단계 후보)가 지킵니다.

## 비밀번호와 프라이버시

비밀번호 텍스트는 기록·재생, 로그, devtools 평문, 접근성 값 어디에도 들어가지 않으며 비밀번호
대상은 클립보드에도 쓰지 않습니다. Core는 마스킹된 글리프만 출력하므로 평문이 애초에 DisplayList에
들어가지 않습니다. 이는 자동 테스트로 검증되며 [공개 Playground](/ko/playground#/editing)에서 직접
DOM을 확인할 수도 있습니다.

## 알려진 경계

- **bidi 시각적 캐럿 이동**은 bidi 텍스트 기능과 함께 제공될 예정이며 현재는 명시적 보류입니다.
- 리치 텍스트 스키마, 공동 편집 충돌 해결, 수식과 Markdown 명령은 상위 레이어의 책임이지만
  동일한 편집 트랜잭션과 selection API 위에 구축할 수 있습니다.
