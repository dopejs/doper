---
layout: home

hero:
  name: doper
  text: canvas 繪製引擎
  tagline: Rust/WASM 核心 + TypeScript 外殼 + 可插拔後端。為高效能互動、原生虛擬捲動與 canvas 內文字編輯而設計。
  actions:
    - theme: brand
      text: 快速開始
      link: /zh-Hant/guide/getting-started
    - theme: alt
      text: Playground
      link: /zh-Hant/playground
    - theme: alt
      text: GitHub
      link: https://github.com/dopejs/doper

features:
  - title: 雙時鐘，主執行緒卡死也不掉幀
    details: UI 時鐘與繪製時鐘彼此獨立。捲動、動畫、版面與合成在 Worker 內閉環推進；主執行緒被阻塞 200ms 時畫面仍然連續。
  - title: 原生虛擬捲動
    details: 前綴和樹、方向預測預熱與佔位補建都在 Core 內。百萬列固定 fixture 的 20,000 幀重播 P95/P99 為次微秒級，捲動穩態完全不回呼 Shell。
  - title: canvas 原生編輯
    details: caret、選取範圍、拖選、雙擊選詞、IME composition、候選視窗定位、剪貼簿與復原重做全部由引擎實作。業務不再為輸入能力建立 HTML 控制項。
  - title: 無障礙是架構的一部分
    details: Core 匯出語意樹，宿主鏡像成 canvas 旁的 DOM 影子樹。螢幕閱讀器可用，E2E 能依 role/label 選取元素，而不是比對像素。
  - title: 確定性與差分測試
    details: 版本化二進位流、可注入時鐘與亂數源、錄製重播，以及增量與全量、最佳化與樸素、wasm 與 native 的差分 oracle。
  - title: 自動降級，永遠有退路
    details: SharedArrayBuffer → postMessage → 主執行緒 Canvas2D 依能力自動選擇，功能等價。遷移層支援依頁面灰度與一鍵回退。
---

## 30 秒上手

```sh
pnpm add @dopejs/doper
```

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/doper";

const root = await createHostedCanvasRoot(document.querySelector("canvas")!);

root.render(
  createElement("virtualList", {
    width: 480,
    height: 640,
    itemCount: 1_000_000,
    estimatedItemHeight: 32,
    renderItem: (index) => createElement("text", { value: `第 ${index} 列` }),
  }),
);
```

一百萬列不會在 Shell 側具現化，捲動過程也不回呼元件樹——視窗計算與補建都發生在 Core 內。

## 它不做什麼

doper 是繪製引擎，不是瀏覽器。**不做** SSR/HTML 首屏、通用 CSS 相容（盒模型、層疊、選擇器）、
小程式或原生轉接層，也不做業務級富文字語意（協作、公式、Markdown 指令）。

引擎**確實擁有** caret、選取範圍、IME、剪貼簿、復原重做與可編輯文字原語——這些不會被推回業務層用
DOM 控制項拼湊。

## 目前狀態

v0.1.0，P0–M5 全部工程里程碑完成，`pnpm m5:check` 全鏈自動門檻通過。

實機效能、真實輸入法與螢幕閱讀器矩陣屬於平台資格採集，單獨追蹤；
bidi 視覺導覽與 WebGPU 後端預設啟用是[已記錄的延後項](/plan)。

::: tip 工程文件語言
技術設計、實施計畫與 ADR 目前僅提供簡體中文版本，各語言站台皆連結至同一份文件。
:::
