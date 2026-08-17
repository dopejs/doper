# 架構概覽

## 兩側所有權

```
TSX / hooks          →  Mutation Stream  →   Scene / Layout / Paint
（TypeScript Shell）      二進位、批次        （Rust Core，wasm）
                                                    ↓
Canvas2D 重播器      ←   DisplayList      ←    Picture
```

**Shell 擁有元件樹，Core 擁有 Scene。兩者不共享可變物件。**
所有跨界通訊都是版本化的二進位流：小端、四位元組對齊、指令化，接收方在存取記憶體前完成
opcode、長度、對齊、ID 與算術檢查，畸形輸入被原子拒絕而不是部分套用。

這條邊界不是效能最佳化，而是正確性邊界：即使位元組通常來自本專案自己的編碼器，解碼器也按不可信
輸入對待，並有 fuzz 覆蓋。

## 雙時鐘

UI 時鐘（主執行緒）與繪製時鐘（Worker）彼此獨立：

- 主執行緒採集輸入、跑元件樹、提交 Mutation 幀。
- Worker 驅動捲動物理、動畫、版面與合成。

**捲動穩態不呼叫 Shell。** 缺失的資料用佔位符繪製，在後續幀補建。因此主執行緒被業務程式碼
阻塞 200ms 時，捲動與動畫仍然連續——這個情境有自動故障注入測試守護。

## 降級鏈

能力偵測依序選擇傳輸路徑，三檔功能等價：

1. **SharedArrayBuffer** —— 需要跨來源隔離（COOP/COEP）
2. **postMessage** —— 無 SAB 時
3. **主執行緒 Canvas2D** —— 無 Worker / OffscreenCanvas 時

```ts
const root = await createHostedCanvasRoot(canvas, {
  transport: { preference: "sab" }, // 可選偏好，不滿足時仍會降級
});
console.log(root.mode); // "sab" | "post-message" | "main-thread"
```

本站的 [Playground](/zh-Hant/playground) 就是活例子：GitHub Pages 無法下發 COOP/COEP 回應標頭，
所以線上執行在 postMessage 路徑，頁面頂部的 transport 標記會如實顯示。

## 失效模型

**prop 語意決定失效域**，呼叫方不手動標記為髒，也沒有 `forceUpdate` 逃生口。

每個屬性在單一來源 schema 中宣告它影響版面、繪製、命中還是語意。改一個 `opacity` 不會觸發重排；
改 `width` 會。髒位圖依域維護，`onFrame` 會把各域的髒節點數暴露出來。

這個選擇是「積極最窄失效 + 屬性測試兜底」：增量繪製結果必須與全量繪製逐像素一致，
差分測試會把反例收斂到最小失敗案例。

## Scene 表示

Core 內的 Scene 是 SoA（結構陣列轉為陣列結構）：

- 節點 ID 含**世代**，槽位重用不會讓過期 ID 重新生效。
- commit 後保持**拓撲有序**：父節點永遠排在子節點前。
- 結構編輯每次 commit 壓實一次，而不是每次 mutation 一次。
- 版面結果用雙緩衝 SoA 批次比較，熱路徑上沒有每節點閉包或監聽器配置。

## 後端可插拔

Core 輸出扁平的二進位 DisplayList，後端只是重播器。Canvas2D 後端是一個吝於配置的
typed-array 迴圈——**每次繪製都呼叫一次 wasm→JS 不是可接受的繪製路徑**。

同一份 DisplayList 也餵給隔離的 wgpu 原型，兩者輸出做像素差分。
是否採用 WebGPU 是資料決策，見 [ADR-0006](/adr/0006-webgpu-backend-decision)。

## 確定性

時間、亂數源與輸入流都可注入或可重播，Core 輸出不相依執行緒排程順序。
`DOPR` 封存依原序錄製 Mutation 與 Input 流，可脫離瀏覽器在 headless 環境確定性重播——
線上問題因此能在本機重現，敏感編輯流顯式跳過錄製。

## 深入

完整的演算法、資料結構與驗收口徑見[技術設計文件](/design)。
