# 文本与编辑

## 编辑是引擎能力，不是业务拼装

传统 canvas 方案的通病是：需要输入时，在 canvas 上盖一个 HTML `input`。
这会带来光标错位、IME 候选窗跑偏、滚动不同步、无障碍断裂等一连串问题。

doper 把编辑作为 Core 的一等能力：caret、选区、拖选、双击选词、键盘导航、
IME composition、候选窗定位、剪贴板、撤销重做、只读与密码，全部由引擎实现。
**业务不创建、不定位、不同步任何 HTML 输入控件。**

## 使用 widget

```ts
import { TextField, TextArea } from "@dopejs/doper";

TextField({
  value: order.note,
  revision: order.revision,
  semanticLabel: "订单备注",
  inputMode: "text",
  onTransaction: (transaction) => order.apply(transaction),
});

TextArea({ value: description, revision, rows: 4 });
```

## 使用原语

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
import { useTextEditingController } from "@dopejs/doper";

const editor = useTextEditingController({ value: cell.value });
createElement("editableText", { controller: editor });
```

## 输入桥与降级

主线程按优先级连接操作系统文本输入服务：

1. **EditContext** —— 绑定 canvas，接收文本/选区/composition，向输入法提供
   control、selection 与 character bounds。
2. **引擎托管的输入代理** —— EditContext 不可用时，宿主维护**一个**全局隐藏
   `textarea` 统一处理 `beforeinput`、composition、软键盘与剪贴板。

第二条是平台降级实现，不是 EmbedDOM 组件模型：Scene 里不存在与每个编辑节点一一对应的 DOM。
两条路径通过同一套编辑行为契约测试。

## 版本化编辑事务

状态所有权是明确的：**Shell 拥有业务数据，Core 拥有活动编辑会话的瞬时状态。**

```
输入 → Core 校验 base_revision → 立即应用并重绘 → 反向发出版本化 EditTransaction
                                                            ↓
                                              Shell 确认，或发带新 revision 的校正值
```

过期事务永远不会覆盖更新的状态。这意味着每次按键不需要走一遍完整的 TSX build，
同时受控数据与业务校验仍然成立。

```ts
onTransaction: (transaction) => {
  // transaction.baseRevision / revision / delta / selection / kind
  value = applyDelta(value, transaction);
};
```

## 文本位置模型

Web 输入 API 用 UTF-16 偏移，Rust 字符串是 UTF-8，而 grapheme、shaping cluster 与
视觉 glyph 的边界又各不相同。引擎维护显式映射：

```
UTF-16 offset ↔ Unicode scalar ↔ grapheme ↔ shaping cluster ↔ glyph / line
```

协议边界统一使用 UTF-16 以对齐 EditContext 与 InputEvent。
**删除、移动与选择不会拆开 grapheme、组合序列、emoji ZWJ 或 shaping cluster**——
这有属性测试与 composition fixture 矩阵（组合字符、emoji ZWJ、RTL、CJK 多段候选）守护。

## 密码与隐私

密码文本不进入录制回放、日志、devtools 明文或无障碍值；密码目标也不写剪贴板。
Core 侧只输出遮罩字形，明文根本不进入 DisplayList。这条有自动测试断言，
[线上 Playground](/playground#/editing) 里也可以自行检查 DOM。

## 已知边界

- **bidi 视觉导航**随 bidi 文本能力一并交付，当前是显式延后项。
- 富文本 schema、协同冲突解决、公式与 Markdown 命令属于上层，
  但它们能建立在同一套编辑事务与 selection API 之上。
