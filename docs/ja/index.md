---
layout: home

hero:
  name: Pingo
  text: canvas レンダリングエンジン
  tagline: Rust/WASM コア + TypeScript シェル + 差し替え可能なバックエンド。高性能なインタラクション、ネイティブな仮想スクロール、canvas 内テキスト編集のために設計。
  image:
    light: /pingo-mark.svg
    dark: /pingo-mark-dark.svg
    alt: Pingo
  actions:
    - theme: brand
      text: はじめに
      link: /ja/guide/getting-started
    - theme: alt
      text: Playground
      link: /ja/playground
    - theme: alt
      text: GitHub
      link: https://github.com/dopejs/pingo

features:
  - title: デュアルクロック — メインスレッドが固まってもフレームは落ちない
    details: UI クロックとレンダリングクロックは独立しています。スクロール、アニメーション、レイアウト、合成は Worker 内で完結し、メインスレッドが 200ms ブロックされても表示は途切れません。
  - title: ネイティブな仮想スクロール
    details: 累積和ツリー、方向予測によるプリフェッチ、プレースホルダー補完はすべて Core 内にあります。100 万行の固定フィクスチャを 20,000 フレーム再生した P95/P99 はサブマイクロ秒で、スクロール中は Shell を一切呼び出しません。
  - title: canvas ネイティブな編集
    details: キャレット、選択、ドラッグ選択、ダブルクリックでの単語選択、IME 変換、候補ウィンドウの位置、クリップボード、取り消し／やり直しをすべてエンジンが実装します。入力のために HTML コントロールを作る必要はありません。
  - title: アクセシビリティはアーキテクチャの一部
    details: Core がセマンティクスツリーを書き出し、ホストが canvas の隣に DOM のシャドウツリーとして反映します。スクリーンリーダーで読め、E2E はピクセル比較ではなく role/label で要素を選択できます。
  - title: 決定性と差分テスト
    details: バージョン管理されたバイナリストリーム、注入可能な時計と乱数源、記録と再生、そして差分／全体、最適化／素朴、wasm／native の差分オラクル。
  - title: 自動フォールバックで必ず退路がある
    details: SharedArrayBuffer → postMessage → メインスレッド Canvas2D を機能等価のまま能力に応じて自動選択。移行レイヤーはページ単位の段階適用とワンクリックのロールバックに対応します。
---

## 30 秒で始める

```sh
pnpm add @dopejs/pingo
```

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/pingo";

const root = await createHostedCanvasRoot(document.querySelector("canvas")!);

root.render(
  createElement("virtualList", {
    width: 480,
    height: 640,
    itemCount: 1_000_000,
    estimatedItemHeight: 32,
    renderItem: (index) => createElement("text", { value: `${index} 行目` }),
  }),
);
```

100 万行が Shell 側で実体化されることはなく、スクロール中にコンポーネントツリーが呼ばれることもありません。ウィンドウ計算も補完も Core 内で完結します。

## やらないこと

pingo はレンダリングエンジンであり、ブラウザではありません。SSR/HTML の初期表示、汎用的な CSS 互換
（ボックスモデル、カスケード、セレクタ）、ミニプログラムやネイティブのアダプタ層、業務レベルのリッチ
テキスト意味論（共同編集、数式、Markdown コマンド）は**対象外**です。

一方でキャレット、選択、IME、クリップボード、取り消し／やり直し、編集可能テキストのプリミティブは
**エンジンが所有します**。これらを DOM コントロールの寄せ集めとして業務側へ押し戻すことはありません。

## 現在の状態

v0.1.0。P0–M5 のエンジニアリングマイルストーンをすべて完了し、`pnpm m5:check` の全自動ゲートが通過しています。

実機性能、実際の IME、スクリーンリーダーのマトリクスはプラットフォーム認定として別途追跡します。
bidi の視覚的キャレット移動と WebGPU バックエンドの既定有効化は[記録済みの先送り項目](/plan)です。

::: tip エンジニアリング文書の言語
技術設計、実装計画、ADR は現在のところ簡体字中国語のみで、すべての言語から同じ文書にリンクしています。
:::
