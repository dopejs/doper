# アクセシビリティとテスト容易性

## 初日からアーキテクチャに入れる

canvas の内容は本質的にスクリーンリーダーから見えません。doper はアクセシビリティをリリース後に
被せるレイヤーとして扱いません。Core がセマンティクスツリー（role / label / value / bounds /
focusable）を保持し、`@dopejs/doper-a11y` がそれを canvas の隣の絶対配置された DOM シャドウツリーへ
差分的に反映します。

シャドウ要素は視覚的には透明ですが、アクセシビリティツリーと tab 順には存在します。フォーカスすると
エンジンの編集セッションへ転送されるため、キーボード利用者は canvas 内の入力欄を実際に操作できます。

## セマンティクスを宣言する

```tsx
<container semanticRole="region" semanticLabel="決済パネル">
  <text value="決済" semanticRole="heading" semanticLabel="決済" />
  {TextField({ semanticLabel: "宛先", value, revision })}
</container>
```

`editableText` は既定で textbox のセマンティクスを持ちます。パスワード欄の値が
セマンティクスツリーに入ることは**決してありません**。

## セマンティクスで E2E を書く

セマンティクスツリーが実際の DOM に反映されるため、E2E はピクセル比較ではなくロールと名前で
要素を選択できます。

```ts
import { getByRole, queryAllByRole } from "@dopejs/doper";

const email = getByRole(document.body, "textbox", { name: "宛先" });
email.focus(); // エンジンの編集セッションへ転送されます
expect(queryAllByRole(document.body, "textbox")).toHaveLength(2);
```

ピクセルスナップショットは残しますが、描画の正しさを示す**補助的な証拠**であって唯一の
アサーションではありません。この選択により、フォントのレンダリングやアンチエイリアスが変わった
だけで UI テストが総崩れになることを防げます。

## セマンティクスツリーを観測する

```ts
const root = await createHostedCanvasRoot(canvas, {
  onSemantics: (nodes) => inspect(nodes),
  accessibility: true, // 既定で有効。false にするとシャドウツリーを無効化します
});
```

各ノードは `nodeId`、`role`、`label`、`value`、ワールド `bounds`、`focusable`、`focused`、
`password` フラグを返します。フレーム診断の `dirtySemanticsNodes` でセマンティクス無効化の頻度を
観察できます。

## プラットフォーム認定

自動化がカバーするのは、セマンティクスツリーの書き出し、シャドウツリーの対応付け、role/label
セレクタ、キーボード契約です。
**実際のスクリーンリーダー（VoiceOver、NVDA、TalkBack）の挙動マトリクスはプラットフォーム認定**
として別に追跡し、エンジニアリングの完了条件には含めません。この線引きは、検証していない
実機の結論をサポートの約束として偽らないためのものです。

[Playground のセマンティクスデモ](/ja/playground#/semantics)で現在のセマンティクスツリーを直接読めます。
