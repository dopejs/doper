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
  title: (messages) => messages.scrollTitle,
  description: (messages) => messages.scrollDescription,
  render: scene,
  activate: (context) => {
    context.setMetric(context.messages.listItems, ITEM_COUNT.toLocaleString());
    for (const row of [0, 500_000, 999_999]) {
      const button = document.createElement("button");
      button.textContent = context.messages.jumpToRow(row.toLocaleString());
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
