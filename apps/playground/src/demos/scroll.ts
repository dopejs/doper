import { createElement, type DoperNode } from "@dopejs/doper";

import type { Demo, DemoContext } from "../demo";

const ITEM_COUNT = 1_000_000;
const ROW_HEIGHT = 32;

let programmaticOffset: number | undefined;

function scene(context: DemoContext): DoperNode {
  const { width, height } = context;
  return createElement("container", {
    width,
    height,
    backgroundColor: "#ffffffff",
    children: createElement("virtualList", {
      width,
      height,
      itemCount: ITEM_COUNT,
      estimatedItemHeight: ROW_HEIGHT,
      // A ScrollTo mutation is emitted only when this prop changes, so
      // ordinary wheel/drag scrolling still stays inside Core.
      ...(programmaticOffset === undefined ? {} : { scrollY: programmaticOffset }),
      renderItem: (index: number) =>
        createElement("container", {
          width,
          height: ROW_HEIGHT,
          padding: [6, 12, 6, 12],
          backgroundColor: index % 2 === 0 ? "#ffffffff" : "#f5f7faff",
          children: createElement("text", {
            value: `#${String(index).padStart(7, "0")}    订单 ${((index * 7919) % 100000)
              .toString(36)
              .toUpperCase()}    ¥${String((index * 37) % 9999)}.00`,
            fontSize: 13,
            lineHeight: 20,
            color: "#1f2329ff",
          }),
        }),
    }),
  });
}

/** Core-owned virtual scrolling: the Shell never materializes a million rows. */
export const scrollDemo: Demo = {
  id: "scroll",
  title: "百万行原生虚拟滚动",
  description:
    "一百万行由 Core 拥有的虚拟列表。滚动稳态完全在 Core 内闭环、不回调 Shell，" +
    "Shell 只按 Core 规划的预热窗口物化可见区间。用滚轮或拖拽试试，右侧是实时帧指标。",
  render: scene,
  activate: (context) => {
    context.setMetric("列表项", ITEM_COUNT.toLocaleString());
    for (const row of [0, 500_000, 999_999]) {
      const button = document.createElement("button");
      button.textContent = `跳到第 ${row.toLocaleString()} 行`;
      button.addEventListener("click", () => {
        programmaticOffset = row * ROW_HEIGHT;
        context.root.render(scene(context));
      });
      context.controls.append(button);
    }
    return () => {
      programmaticOffset = undefined;
    };
  },
};
