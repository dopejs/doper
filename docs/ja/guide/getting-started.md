# はじめに

## インストール

```sh
pnpm add @dopejs/doper
```

アプリケーションが依存するのは `@dopejs/doper` ひとつだけです。`@dopejs/doper-host` や
`@dopejs/doper-jsx` などは内部実装パッケージで公開契約ではありません。
[移行スキャナ](/migration)がそれらの直接 import を拒否します。

## 最初のキャンバスをマウントする

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

`createHostedCanvasRoot` はブラウザの能力を検出し、SharedArrayBuffer、postMessage、
メインスレッド Canvas2D の中から転送経路を選びます。フォールバックのための分岐を書く必要はありません。
実際に選ばれた経路は `root.mode` が返します。

## TSX を使う

`tsconfig.json` を設定します。

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@dopejs/doper"
  }
}
```

これで次のように書けます。

```tsx
function OrderRow({ index }: { index: number }) {
  return (
    <container width={480} height={32} padding={[6, 12, 6, 12]}>
      <text value={`注文 #${index}`} fontSize={13} lineHeight={20} />
    </container>
  );
}

root.render(<OrderRow index={1} />);
```

## ホスト要素

組み込み要素は 5 つだけで、いずれも Scene ノードに直接対応します。CSS のカスケードもセレクタもありません。

| 要素           | 用途                                                          |
| -------------- | ------------------------------------------------------------- |
| `container`    | 汎用のグループ化、背景、パディング、変換                      |
| `text`         | テキストラン（シェーピング、折り返し、キャレット幾何は Core） |
| `scroll`       | Core が所有するスクロールコンテナ                             |
| `virtualList`  | Core がウィンドウを計画する仮想リスト                         |
| `editableText` | 編集可能テキストのプリミティブ                                |

`TextField` と `TextArea` は `editableText` の上に組み立てたウィジェット（枠線、エラー表示）で、
新しい入力経路を持ち込むことはありません。

## 状態と副作用

```ts
import { signal, useEffect, useSignal, useState } from "@dopejs/doper";

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return createElement("text", { value: `${count} 秒経過` });
}
```

利用できるリアクティブプリミティブは `signal`、`computed`、`effect`、`batch`、`untracked`、
フックは `useState`、`useSignal`、`useMemo`、`useCallback`、`useRef`、`useEffect` です。

::: warning 同期的なレイアウト読み取りはありません
`useLayoutEffect` のような Worker レイアウトの同期読み取りはサポートされません。レイアウトは別の
クロック上で行われます。レイアウト結果が必要なときは非同期の契約を使い、描画中に幾何を同期的に
読もうとしないでください。
:::

## 実行状況を観測する

```ts
const root = await createHostedCanvasRoot(canvas, {
  onFrame: (report) => {
    console.log(report.commands, report.displayListBytes, report.core?.sceneNodes);
  },
  onHostError: (error) => report(error),
});
```

`onFrame` はフレームごとにコマンド数、DisplayList のバイト数、Core 側のダーティ数、レイアウト作業量、
picture ハッシュを返します。性能調査の一次資料です。詳しくは[診断](/diagnostics)を参照してください。

## 次のステップ

- [アーキテクチャ概要](/ja/guide/architecture)：Shell と Core の役割分担
- [仮想スクロール](/ja/guide/scrolling)、[テキストと編集](/ja/guide/editing)
- [Playground](/ja/playground)：操作できるライブデモ
