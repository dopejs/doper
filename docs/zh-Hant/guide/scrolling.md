# 虛擬捲動

## 為什麼在引擎裡做

DOM 虛擬列表的長尾問題來自：捲動事件要回到主執行緒 → 觸發 setState → diff → 重排。
主執行緒一忙，幀就掉。

doper 把視窗計算放進 Core：捲動穩態**完全不呼叫 Shell**。Shell 只負責依 Core 規劃的
預熱視窗具現化可見區間；資料沒準備好時先畫佔位，後續幀補建。

## 用法

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
      children: createElement("text", { value: `第 ${index} 列` }),
    }),
});
```

`estimatedItemHeight` 只是初始估計。真實高度量測出來後，Core 透過前綴和樹（Fenwick）
校正錨點位置，捲軸不會跳動。

## 可調項

| prop                     | 作用                                    |
| ------------------------ | --------------------------------------- |
| `baseOverscanViewports`  | 對稱預熱範圍（視窗倍數）                |
| `velocityHorizonSeconds` | 速度投影時長，用於方向預測              |
| `maximumAheadViewports`  | 單方向預熱上限                          |
| `scrollX` / `scrollY`    | 程式化捲動位置（變化時才發出 ScrollTo） |

方向預測會在快速 fling 時優先預熱運動方向，而不是對稱浪費兩側預算。

## 程式化捲動

```ts
// 透過 prop 變化觸發一次 ScrollTo mutation
root.render(createElement("virtualList", { scrollY: 500_000 * 32 /* ... */ }));
```

或用 root 上的直接操縱 API（用於自訂手勢）：

```ts
root.beginScroll(handle);
root.scrollBy(handle, 0, deltaY, elapsedMs);
root.endScroll(handle); // 交給 Core 估算 fling 速度
```

`handle` 來自元素的 `ref` 回呼（`NodeHandle`）。

## 滾輪與觸控板

滾輪的**位移**與瀏覽器原生一致，但傳遞曲線依輸入來源分流：高精度差量（觸控板）即時 1:1 套用，
慣性仍由作業系統的事件流提供；離散滾輪格則累加到動畫目標並以指數緩出逼近，就像瀏覽器那樣，
且硬夾到內容邊界不產生 overscroll。

## 巢狀與編輯

指標拖曳落在可編輯文字上時，文字選取優先於捲動拖曳；滾輪仍然捲動最近的捲動祖先。
這個優先序由命中路徑深度決定，不需要業務介入。

## 效能口徑

固定 fixture（百萬列、20,000 幀）的自動 benchmark 是合併門檻的一部分。
目前 P95/P99 為次微秒級重播，30 分鐘連續捲動無不可控記憶體成長。

實機 P95/P99 與輸入延遲屬於平台資格採集，不作為工程出口條件——這條界線是刻意的，
避免用無法重現的裝置資料阻塞工程進度，也避免用工程資料冒充裝置承諾。

在 [Playground 的捲動示範](/zh-Hant/playground#/scroll)裡可以看到即時幀指標。
