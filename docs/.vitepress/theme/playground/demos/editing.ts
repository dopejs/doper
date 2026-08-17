import { createElement, TextArea, TextField, type EditTransaction } from "@dopejs/doper";

import type { Demo, DemoContext } from "../demo";

let singleLine = "订单备注";
let singleRevision = 1n;
let multiLine = "canvas 原生编辑：\ncaret、选区、IME、剪贴板、撤销重做\n全部由引擎自己实现。";
let multiRevision = 1n;
let transactions = 0;

function applyDelta(value: string, transaction: EditTransaction): string {
  const delta = transaction.delta;
  return delta === undefined
    ? value
    : value.slice(0, delta.range.start) + delta.text + value.slice(delta.range.end);
}

function scene(context: DemoContext) {
  const { width } = context;
  const fieldWidth = Math.min(420, width - 48);
  return createElement("container", {
    width,
    height: context.height,
    backgroundColor: "#ffffffff",
    padding: 24,
    children: [
      createElement("text", {
        value: "点击输入框内任意位置置 caret，拖动选择，双击选词，方向键导航。",
        fontSize: 13,
        lineHeight: 26,
        color: "#5b6472ff",
      }),
      TextField({
        semanticLabel: "订单备注",
        value: singleLine,
        revision: singleRevision,
        width: fieldWidth,
        inputMode: "text",
        onTransaction: (transaction: EditTransaction) => {
          singleLine = applyDelta(singleLine, transaction);
          singleRevision = transaction.revision;
          transactions += 1;
          context.setMetric(context.messages.editTransactions, String(transactions));
          context.setMetric(context.messages.shellValue, singleLine.slice(0, 24));
        },
      }),
      createElement("container", { width: fieldWidth, height: 12 }),
      TextArea({
        semanticLabel: "多行说明",
        value: multiLine,
        revision: multiRevision,
        rows: 4,
        width: fieldWidth,
        onTransaction: (transaction: EditTransaction) => {
          multiLine = applyDelta(multiLine, transaction);
          multiRevision = transaction.revision;
          transactions += 1;
          context.setMetric(context.messages.editTransactions, String(transactions));
        },
      }),
      createElement("container", { width: fieldWidth, height: 12 }),
      TextField({
        semanticLabel: "密码",
        password: true,
        value: "hunter2",
        revision: 1n,
        width: fieldWidth,
      }),
      createElement("text", {
        value: "↑ 密码框：Core 只输出遮罩字形，明文不进入 DisplayList、录制回放或无障碍树。",
        fontSize: 12,
        lineHeight: 24,
        color: "#8a94a3ff",
      }),
    ],
  });
}

/** Canvas-native editing: EditContext or the centralized textarea proxy. */
export const editingDemo: Demo = {
  id: "editing",
  title: (messages) => messages.editingTitle,
  description: (messages) => messages.editingDescription,
  render: scene,
  activate: (context) => {
    transactions = 0;
    context.setMetric(context.messages.editTransactions, "0");
    const mode = "editContext" in context.canvas ? "EditContext" : "textarea proxy";
    context.setMetric(context.messages.inputBridge, mode);
    const note = document.createElement("p");
    note.style.margin = "0";
    note.textContent = context.messages.editingHint;
    context.controls.append(note);
  },
};
