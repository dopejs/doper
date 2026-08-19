# 文字與編輯

## 編輯是引擎能力，不是業務拼裝

傳統 canvas 方案的通病是：需要輸入時，在 canvas 上蓋一個 HTML `input`。
這會帶來游標錯位、IME 候選視窗跑偏、捲動不同步、無障礙斷裂等一連串問題。

doper 把編輯作為 Core 的一等能力：caret、選取範圍、拖選、雙擊選詞、鍵盤導覽、
IME composition、候選視窗定位、剪貼簿、復原重做、唯讀與密碼，全部由引擎實作。
**業務不建立、不定位、不同步任何 HTML 輸入控制項。**

## 使用 widget

```ts
import { TextField, TextArea } from "@dopejs/pingo";

TextField({
  value: order.note,
  revision: order.revision,
  semanticLabel: "訂單備註",
  inputMode: "text",
  onTransaction: (transaction) => order.apply(transaction),
});

TextArea({ value: description, revision, rows: 4 });
```

## 使用原語

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

或使用本地 controller：

```ts
import { useTextEditingController } from "@dopejs/pingo";

const editor = useTextEditingController({ value: cell.value });
createElement("editableText", { controller: editor });
```

## 輸入橋與降級

主執行緒依優先序連接作業系統文字輸入服務：

1. **EditContext** —— 綁定 canvas，接收文字/選取範圍/composition，向輸入法提供
   control、selection 與 character bounds。
2. **引擎託管的輸入代理** —— EditContext 不可用時，宿主維護**一個**全域隱藏
   `textarea` 統一處理 `beforeinput`、composition、軟鍵盤與剪貼簿。

第二條是平台降級實作，不是 EmbedDOM 元件模型：Scene 裡不存在與每個編輯節點一一對應的 DOM。
兩條路徑通過同一套編輯行為契約測試。

## 版本化編輯交易

狀態所有權是明確的：**Shell 擁有業務資料，Core 擁有活動編輯工作階段的瞬時狀態。**

```
輸入 → Core 檢查 base_revision → 立即套用並重繪 → 反向發出版本化 EditTransaction
                                                            ↓
                                              Shell 確認，或發帶新 revision 的校正值
```

過期交易永遠不會覆蓋更新的狀態。這表示每次按鍵不需要走一遍完整的 TSX build，
同時受控資料與業務驗證仍然成立。

```ts
onTransaction: (transaction) => {
  // transaction.baseRevision / revision / delta / selection / kind
  value = applyDelta(value, transaction);
};
```

## 文字位置模型

Web 輸入 API 用 UTF-16 位移，Rust 字串是 UTF-8，而 grapheme、shaping cluster 與
視覺 glyph 的邊界又各不相同。引擎維護明確映射：

```
UTF-16 offset ↔ Unicode scalar ↔ grapheme ↔ shaping cluster ↔ glyph / line
```

協定邊界統一使用 UTF-16 以對齊 EditContext 與 InputEvent。
**刪除、移動與選取不會拆開 grapheme、組合序列、emoji ZWJ 或 shaping cluster**——
這有屬性測試與 composition fixture 矩陣（組合字元、emoji ZWJ、RTL、CJK 多段候選）守護。

## 密碼與隱私

密碼文字不進入錄製重播、記錄檔、devtools 明文或無障礙值；密碼目標也不寫剪貼簿。
Core 側只輸出遮罩字形，明文根本不進入 DisplayList。這條有自動測試斷言，
[線上 Playground](/zh-Hant/playground#/editing) 裡也可以自行檢查 DOM。

## 已知邊界

- **bidi 視覺導覽**隨 bidi 文字能力一併交付，目前是明確延後項。
- 富文字 schema、協作衝突解決、公式與 Markdown 指令屬於上層，
  但它們能建立在同一套編輯交易與 selection API 之上。
