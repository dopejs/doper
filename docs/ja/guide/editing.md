# テキストと編集

## 編集はエンジンの機能であり、アプリ側の寄せ集めではない

従来の canvas 実装によくある弱点は、入力が必要になったときに canvas の上へ HTML の `input` を
重ねることです。その結果、キャレットのずれ、IME 候補ウィンドウの位置ずれ、スクロールの非同期、
アクセシビリティの断絶といった問題が連鎖します。

doper は編集を Core の一級機能として扱います。キャレット、選択、ドラッグ選択、ダブルクリックでの
単語選択、キーボード操作、IME 変換、候補ウィンドウの位置、クリップボード、取り消し／やり直し、
読み取り専用、パスワードまで、すべてエンジンが実装します。
**アプリケーションは HTML の入力コントロールを作らず、配置せず、同期もしません。**

## ウィジェットを使う

```ts
import { TextField, TextArea } from "@dopejs/doper";

TextField({
  value: order.note,
  revision: order.revision,
  semanticLabel: "注文メモ",
  inputMode: "text",
  onTransaction: (transaction) => order.apply(transaction),
});

TextArea({ value: description, revision, rows: 4 });
```

## プリミティブを使う

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

ローカルのコントローラを使うこともできます。

```ts
import { useTextEditingController } from "@dopejs/doper";

const editor = useTextEditingController({ value: cell.value });
createElement("editableText", { controller: editor });
```

## 入力ブリッジとフォールバック

メインスレッドは優先順位に従って OS のテキスト入力サービスに接続します。

1. **EditContext** —— canvas に紐づけ、テキスト・選択・変換を受け取り、IME へ control、selection、
   character bounds を提供します。
2. **エンジン管理の入力プロキシ** —— EditContext が使えない場合、ホストは**ひとつだけ**の隠し
   `textarea` を保持し、`beforeinput`、変換、ソフトウェアキーボード、クリップボードをまとめて扱います。

2 番目はプラットフォームのフォールバック実装であり、EmbedDOM のコンポーネントモデルではありません。
Scene 内の編集ノードごとに対応する DOM は存在しません。両経路は同じ編集契約テストを通ります。

## バージョン付き編集トランザクション

状態の所有権は明確です。**Shell が業務データを、Core が編集セッションの一時状態を所有します。**

```
入力 → Core が base_revision を検証 → 即座に適用して再描画 → 逆方向にバージョン付き EditTransaction
                                                                     ↓
                                             Shell が確認、または新しい revision で訂正値を送る
```

古いトランザクションが新しい状態を上書きすることはありません。つまりキー入力ごとに TSX の
ビルドを一巡させる必要がない一方で、制御されたデータと業務バリデーションは成立し続けます。

```ts
onTransaction: (transaction) => {
  // transaction.baseRevision / revision / delta / selection / kind
  value = applyDelta(value, transaction);
};
```

## テキスト位置モデル

Web の入力 API は UTF-16 オフセット、Rust の文字列は UTF-8、そして書記素、シェーピングクラスタ、
視覚的グリフの境界はいずれも異なります。エンジンは明示的な対応関係を保持します。

```
UTF-16 offset ↔ Unicode scalar ↔ 書記素 ↔ シェーピングクラスタ ↔ グリフ / 行
```

プロトコル境界では EditContext と InputEvent に合わせて UTF-16 に統一します。
**削除・移動・選択が書記素、結合列、絵文字 ZWJ、シェーピングクラスタを分断することはありません。**
これはプロパティテストと変換フィクスチャの組み合わせ（結合文字、絵文字 ZWJ、RTL、CJK の複数
文節変換）で守られています。

## パスワードとプライバシー

パスワードのテキストは記録・再生、ログ、devtools の平文、アクセシビリティの値のいずれにも入らず、
パスワード対象はクリップボードにも書き出しません。Core はマスクされたグリフだけを出力するので、
平文がそもそも DisplayList に入りません。これは自動テストで検証されており、
[公開 Playground](/ja/playground#/editing) で DOM を自分で確認することもできます。

## 既知の境界

- **bidi の視覚的キャレット移動**は bidi テキスト機能と同時に提供予定で、現時点では明示的な先送りです。
- リッチテキストのスキーマ、共同編集の衝突解決、数式や Markdown コマンドは上位レイヤーの責務ですが、
  同じ編集トランザクションと selection API の上に構築できます。
