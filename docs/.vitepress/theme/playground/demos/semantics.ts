import { createElement, getByRole, queryAllByRole, TextField } from "@dopejs/doper";

import type { Demo, DemoContext } from "../demo";

function scene(context: DemoContext) {
  const width = context.width;
  return createElement("container", {
    width,
    height: context.height,
    backgroundColor: "#ffffffff",
    padding: 24,
    semanticRole: "region",
    semanticLabel: "结算面板",
    children: [
      createElement("text", {
        value: "结算",
        fontSize: 20,
        lineHeight: 34,
        color: "#1f2329ff",
        semanticRole: "heading",
        semanticLabel: "结算",
      }),
      createElement("text", {
        value: "canvas 上的内容同样进入无障碍树：语义快照被镜像成 canvas 旁的绝对定位 DOM 影子树。",
        fontSize: 13,
        lineHeight: 24,
        color: "#5b6472ff",
      }),
      createElement("container", { width: 100, height: 8 }),
      TextField({ semanticLabel: "收件人", value: "张三", revision: 1n, width: 320 }),
      createElement("container", { width: 100, height: 10 }),
      TextField({ semanticLabel: "电话", value: "13800000000", revision: 1n, width: 320 }),
    ],
  });
}

/** Semantic tree export mirrored into a DOM shadow tree for AT and E2E. */
export const semanticsDemo: Demo = {
  id: "semantics",
  title: (messages) => messages.semanticsTitle,
  description: (messages) => messages.semanticsDescription,
  render: scene,
  activate: (context) => {
    const list = document.createElement("pre");
    list.style.cssText =
      "margin:0;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;line-height:1.6";
    const button = document.createElement("button");
    button.textContent = context.messages.readSemantics;
    button.addEventListener("click", () => {
      const nodes = queryAllByRole(document.body, "textbox").map(
        (element) =>
          `${element.getAttribute("role") ?? "?"}  "${element.getAttribute("aria-label") ?? ""}"  ${element.textContent ?? ""}`,
      );
      const heading = queryAllByRole(document.body, "heading").length;
      list.textContent = [`heading × ${String(heading)}`, ...nodes].join("\n");
      try {
        getByRole(document.body, "textbox", { name: "收件人" }).focus();
      } catch (error) {
        list.textContent += `\n${String(error)}`;
      }
    });
    context.controls.append(button, list);
  },
};
