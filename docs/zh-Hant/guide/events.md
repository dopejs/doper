# 事件與命中測試

## 採集與命中分離

主執行緒用 `{ passive: true }` 監聽 pointer/wheel/touch。捲動相關事件**只把差量與時間戳
寫入共享通道，不做命中測試、不觸發 setState**。

命中測試發生在 Core：基於世界 AABB 的 BVH 隨 Scene 增量維護（拓撲變化則重建，幾何變化只 refit），
命中後建構 root→target 路徑，透過反向流回傳 Shell。

BVH 與樸素線性實作有屬性測試保證結果一致——最佳化路徑始終有可差分的 oracle。

## 三階段傳播

事件模型對齊 DOM：capture → target → bubble。

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

可用 handler：`onPointerDown`、`onPointerUp`、`onPointerMove`、`onPointerCancel`、
`onClick`、`onWheel`，每個都有對應的 `*Capture` 版本。

`DoperEvent` 提供 `target`、`currentTarget`、`eventPhase`、畫布區域邏輯座標 `x`/`y`、
`deltaX`/`deltaY`、`buttons`、修飾鍵、`preventDefault()`、`stopPropagation()`、
`stopImmediatePropagation()`。

## preventDefault 的時序問題

passive 監聽器不能呼叫 `preventDefault()`。這是必須明確處理的正確性點，而不是可以敷衍過去的細節。

解法：需要阻止預設行為的區域（例如內部可捲動區）由 **Core 預先計算**並把「非 passive 區域矩形」
同步回主執行緒；主執行緒據此對這些區域改用非 passive 監聽，並在命中區域時**同步**呼叫
`preventDefault()`。因此不存在相依非同步回傳的競態。

## 命中語意邊界

目前語意是刻意收窄的，避免隱式行為：

- **重疊命中**取「最後繪製者」為 target；暫不提供 z-order、`pointer-events` 關閉命中
  或不可見節點跳過語意。引入其中任何一項都需要明確的設計決策。
- **依幀快照命中**：同一事件批次內的所有事件針對上一次提交幀的幾何做命中。
  批次內捲動改變幾何要到下一幀才影響命中——這保證了事件批次的原子回滾語意與確定性重播。
- 鍵盤輸入走[編輯輸入協定](/zh-Hant/guide/editing)，不偽裝成命中事件。

在 [Playground 的事件示範](/zh-Hant/playground#/events)裡可以看到即時的三階段傳播記錄。
