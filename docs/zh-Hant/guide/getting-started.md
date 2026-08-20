# 快速開始

## 安裝

```sh
pnpm add @dopejs/pingo
```

業務只相依 `@dopejs/pingo` 這一個套件。`@dopejs/pingo-host`、`@dopejs/pingo-jsx` 等是內部實作套件，
不屬於公開契約——[遷移掃描器](/migration)會拒絕直接 import 它們。

## 掛載第一個畫布

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/pingo";

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
      value: "Hello pingo",
      fontSize: 24,
      lineHeight: 32,
      color: "#1f2329ff",
    }),
  }),
);
```

`createHostedCanvasRoot` 會自動偵測瀏覽器能力，在 SharedArrayBuffer、postMessage 與主執行緒
Canvas2D 之間選擇傳輸路徑，你不需要為降級寫分支。`root.mode` 回傳實際選中的路徑。

## 使用 TSX

設定 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@dopejs/pingo"
  }
}
```

之後就能這樣寫：

```tsx
function OrderRow({ index }: { index: number }) {
  return (
    <container width={480} height={32} padding={[6, 12, 6, 12]}>
      <text value={`訂單 #${index}`} fontSize={13} lineHeight={20} />
    </container>
  );
}

root.render(<OrderRow index={1} />);
```

## 主機元素

引擎只有五個內建元素，它們直接對應 Scene 節點，不存在 CSS 層疊或選擇器：

| 元素           | 用途                                           |
| -------------- | ---------------------------------------------- |
| `container`    | 通用分組、背景、內距、變換                     |
| `text`         | 文字執行（shaping、換行、caret 幾何來自 Core） |
| `scroll`       | Core 擁有的可捲動容器                          |
| `virtualList`  | Core 規劃視窗的虛擬列表                        |
| `editableText` | 可編輯文字原語                                 |

`TextField` 與 `TextArea` 是在 `editableText` 之上組合出的 widget（邊框、錯誤狀態），
它們不引入新的輸入路徑。

## 狀態與副作用

```ts
import { signal, useEffect, useSignal, useState } from "@dopejs/pingo";

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return createElement("text", { value: `已過 ${count} 秒` });
}
```

可用的響應式原語：`signal`、`computed`、`effect`、`batch`、`untracked`，
以及 hooks `useState`、`useSignal`、`useMemo`、`useCallback`、`useRef`、`useEffect`。

::: warning 沒有同步版面讀取
`useLayoutEffect` 式的同步 Worker 版面讀取不被支援——版面發生在另一個時鐘上。
需要版面結果時使用非同步契約，不要試圖在繪製中同步讀取幾何。
:::

## 觀測執行狀況

```ts
const root = await createHostedCanvasRoot(canvas, {
  onFrame: (report) => {
    console.log(report.commands, report.displayListBytes, report.core?.sceneNodes);
  },
  onHostError: (error) => report(error),
});
```

`onFrame` 每幀給出指令數、DisplayList 位元組數以及 Core 側的髒區計數、版面工作量與 picture hash，
是效能排查的第一手資料。更多見[診斷](/diagnostics)。

## 下一步

- [架構概覽](/zh-Hant/guide/architecture)：Shell 與 Core 如何分工
- [虛擬捲動](/zh-Hant/guide/scrolling)、[文字與編輯](/zh-Hant/guide/editing)
- [Playground](/zh-Hant/playground)：可互動的即時示範
