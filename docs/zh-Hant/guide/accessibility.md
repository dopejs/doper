# 無障礙與可測試性

## 從第一天進架構

canvas 內容天生對螢幕閱讀器不可見。doper 不把無障礙當作發佈後再補的覆蓋層：
Core 維護語意樹（role / label / value / bounds / focusable），
`@dopejs/pingo-a11y` 把它增量映射為 canvas 旁的絕對定位 DOM 影子樹。

影子元素視覺透明但存在於無障礙樹與 tab 順序中；聚焦它會轉送到引擎的編輯工作階段，
所以鍵盤使用者能真正操作 canvas 內的輸入框。

## 宣告語意

```tsx
<container semanticRole="region" semanticLabel="結帳面板">
  <text value="結帳" semanticRole="heading" semanticLabel="結帳" />
  {TextField({ semanticLabel: "收件人", value, revision })}
</container>
```

`editableText` 預設具備 textbox 語意。密碼欄位的值**永遠不進入**語意樹。

## 用語意做 E2E

因為語意樹被鏡像成真實 DOM，E2E 可以依角色與名稱選取元素，而不是比對像素：

```ts
import { getByRole, queryAllByRole } from "@dopejs/pingo";

const email = getByRole(document.body, "textbox", { name: "收件人" });
email.focus(); // 轉送到引擎編輯工作階段
expect(queryAllByRole(document.body, "textbox")).toHaveLength(2);
```

像素快照仍然保留，但作為繪製正確性的**補充證據**，不是唯一斷言。
這個選擇讓 UI 測試在字體繪製或反鋸齒變化時不會成片失敗。

## 觀測語意樹

```ts
const root = await createHostedCanvasRoot(canvas, {
  onSemantics: (nodes) => inspect(nodes),
  accessibility: true, // 預設開啟；設為 false 可關閉影子樹
});
```

每個節點給出 `nodeId`、`role`、`label`、`value`、世界 `bounds`、`focusable`、`focused`、
`password` 旗標。幀診斷裡的 `dirtySemanticsNodes` 可以觀察語意失效頻率。

## 平台資格

自動化覆蓋的是語意樹匯出、影子樹映射、role/label 選擇器與鍵盤契約。
**真實螢幕閱讀器（VoiceOver、NVDA、TalkBack）的行為矩陣屬於平台資格採集**，
單獨追蹤，不計入工程出口——這條界線避免用未驗證的裝置結論冒充支援承諾。

在 [Playground 的語意示範](/zh-Hant/playground#/semantics)裡可以直接讀取目前的語意樹。
