# イベントとヒットテスト

## 収集とヒットテストの分離

メインスレッドは pointer/wheel/touch を `{ passive: true }` で購読します。スクロール関連の
イベントは**デルタとタイムスタンプを共有チャネルへ書くだけで、ヒットテストも setState も行いません**。

ヒットテストは Core で行います。ワールド AABB に基づく BVH を Scene に合わせて差分更新し
（トポロジ変化なら再構築、幾何変化なら refit のみ）、ヒット後に root→target のパスを構築して
逆方向ストリームで Shell に返します。

BVH と素朴な線形実装の結果が一致することはプロパティテストで保証されています。最適化された
経路には常に差分できるオラクルがあります。

## 3 フェーズの伝播

イベントモデルは DOM に揃えています。capture → target → bubble。

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

利用できるハンドラは `onPointerDown`、`onPointerUp`、`onPointerMove`、`onPointerCancel`、
`onClick`、`onWheel` で、それぞれに `*Capture` 版があります。

`PingoEvent` は `target`、`currentTarget`、`eventPhase`、キャンバスローカルの論理座標 `x`/`y`、
`deltaX`/`deltaY`、`buttons`、修飾キー、`preventDefault()`、`stopPropagation()`、
`stopImmediatePropagation()` を提供します。

## preventDefault のタイミング問題

passive なリスナーは `preventDefault()` を呼べません。これはごまかせる細部ではなく、明示的に
扱うべき正しさの論点です。

解決策はこうです。既定動作を止める必要のある領域（たとえば内側のスクロール領域）を **Core が
あらかじめ計算**し、「非 passive 領域の矩形」をメインスレッドへ同期します。メインスレッドは
その領域だけ非 passive なリスナーに切り替え、領域にヒットしたときに**同期的に**
`preventDefault()` を呼びます。したがって非同期の返信に依存する競合は存在しません。

## ヒット意味論の境界

現在の意味論は暗黙の挙動を避けるために意図的に狭めてあります。

- **重なったヒット**では「最後に描かれたもの」を target とします。z-order、`pointer-events` による
  ヒット無効化、不可視ノードのスキップは現時点では提供しません。いずれを導入するにも明示的な
  設計判断が必要です。
- **フレームスナップショットによるヒット**：同一イベントバッチ内のすべてのイベントは、直前に
  コミットされたフレームの幾何に対してヒットを取ります。バッチ内のスクロールによる幾何変化は
  次フレームまでヒットに影響しません。これによりイベントバッチのアトミックなロールバック意味論と
  決定的な再生が保証されます。
- キーボード入力は[編集入力プロトコル](/ja/guide/editing)を通り、ヒットイベントに偽装しません。

[Playground のイベントデモ](/ja/playground#/events)で 3 フェーズ伝播のログをリアルタイムに確認できます。
