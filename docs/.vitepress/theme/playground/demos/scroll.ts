import { createElement, createImage, type DoperImage, type DoperNode } from "@dopejs/pingo";

import type { Demo, DemoContext } from "../demo";

const ITEM_COUNT = 1_000_000;
const ROW_HEIGHT = 76;
const THUMBNAIL_PIXELS = 44;

/** Rows the user has ticked; a cell is interactive, not a picture of one. */
const selected = new Set<number>();
let programmaticOffset: number | undefined;

const ACCENT = "#2f6df6ff";
const MUTED = "#8b95a5ff";
const INK = "#1f2329ff";

const STATUSES = [
  { label: "已发货", background: "#e8f3ffff", color: "#1a6fd4ff" },
  { label: "待付款", background: "#fff3e0ff", color: "#b26a00ff" },
  { label: "已完成", background: "#e9f7eeff", color: "#1e8e4aff" },
  { label: "退款中", background: "#fdecebff", color: "#c0392bff" },
] as const;

const CHANNELS = ["自营", "分销", "跨境", "预售", "团购"] as const;

/**
 * A small palette of thumbnails shared by every row.
 *
 * The resource pool interns by content, so one bitmap per palette entry reaches
 * Core no matter how many rows reference it. Generating a distinct bitmap per
 * row would instead upload `width * height * 4` bytes per visible item.
 */
const THUMBNAILS: DoperImage[] = Array.from({ length: 6 }, (_, palette) =>
  createImage(thumbnailPixels(palette), THUMBNAIL_PIXELS, THUMBNAIL_PIXELS, {
    label: "商品缩略图",
  }),
);

/** Builds a deterministic two-tone thumbnail without any asset fetch. */
function thumbnailPixels(palette: number): Uint8Array {
  const size = THUMBNAIL_PIXELS;
  const pixels = new Uint8Array(size * size * 4);
  const hue = [
    [47, 109, 246],
    [30, 142, 74],
    [178, 106, 0],
    [192, 57, 43],
    [123, 74, 226],
    [0, 150, 168],
  ][palette] ?? [47, 109, 246];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      // A diagonal split plus a corner block: enough structure that a flipped
      // or mis-strided upload is visible rather than merely plausible.
      const front = x + y > size || (x < size / 3 && y < size / 3);
      const shade = front ? 1 : 0.55;
      pixels[offset] = Math.round((hue[0] ?? 0) * shade + (front ? 0 : 90));
      pixels[offset + 1] = Math.round((hue[1] ?? 0) * shade + (front ? 0 : 90));
      pixels[offset + 2] = Math.round((hue[2] ?? 0) * shade + (front ? 0 : 90));
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

/** One chip: a filled box whose padding sizes it around its label. */
function tag(key: string, label: string, background: string, color: string): DoperNode {
  return createElement("container", {
    key,
    backgroundColor: background,
    padding: [3, 7, 3, 7],
    children: createElement("text", { value: label, fontSize: 11, lineHeight: 14, color }),
  });
}

function cell(index: number, context: DemoContext): DoperNode {
  const status = STATUSES[index % STATUSES.length] ?? STATUSES[0];
  const channel = CHANNELS[index % CHANNELS.length] ?? CHANNELS[0];
  const ticked = selected.has(index);
  const code = ((index * 7919) % 100000).toString(36).toUpperCase().padStart(4, "0");

  return createElement("container", {
    width: context.width,
    height: ROW_HEIGHT,
    backgroundColor: ticked ? "#eef4ffff" : index % 2 === 0 ? "#ffffffff" : "#fafbfcff",
    direction: "row",
    gap: 12,
    padding: [12, 16, 12, 16],
    children: [
      // There is no border prop, so the outline is an outer box showing one
      // logical pixel around an inner one. Worth noticing rather than hiding:
      // every chip and control in this cell is a filled rectangle.
      createElement("container", {
        key: "check",
        width: 18,
        height: 18,
        backgroundColor: ticked ? ACCENT : "#c4ccd8ff",
        padding: [1, 1, 1, 1],
        semanticRole: "checkbox",
        semanticValue: ticked ? "checked" : "unchecked",
        onTap: () => {
          if (ticked) selected.delete(index);
          else selected.add(index);
          context.root.render(scene(context));
          context.setMetric(context.messages.selectedRows, String(selected.size));
        },
        children: createElement("container", {
          width: 16,
          height: 16,
          backgroundColor: ticked ? ACCENT : "#ffffffff",
          padding: [0, 0, 0, 3],
          children: ticked
            ? createElement("text", {
                value: "✓",
                fontSize: 12,
                lineHeight: 15,
                color: "#ffffffff",
              })
            : undefined,
        }),
      }),
      createElement("image", {
        key: "thumb",
        source: THUMBNAILS[index % THUMBNAILS.length] ?? THUMBNAILS[0],
        width: 44,
        height: 44,
      }),
      createElement("container", {
        key: "body",
        width: 300,
        gap: 4,
        children: [
          createElement("text", {
            key: "title",
            value: `订单 ${code} · ${channel}渠道`,
            fontSize: 14,
            lineHeight: 18,
            fontWeight: 600,
            color: INK,
          }),
          createElement("text", {
            key: "sub",
            value: `#${String(index).padStart(7, "0")}  收货人 ${code.slice(0, 2)}**  2026-08-${String((index % 28) + 1).padStart(2, "0")}`,
            fontSize: 12,
            lineHeight: 16,
            color: MUTED,
          }),
          createElement("container", {
            key: "tags",
            direction: "row",
            gap: 6,
            children: [
              tag("status", status?.label ?? "", status?.background ?? "", status?.color ?? ""),
              tag("channel", channel ?? "", "#f1f3f5ff", "#5a6472ff"),
              index % 3 === 0 ? tag("vip", "VIP", "#fff0f6ff", "#c2255cff") : undefined,
            ],
          }),
        ],
      }),
      createElement("container", {
        key: "amount",
        width: 96,
        gap: 4,
        children: [
          createElement("text", {
            key: "value",
            value: `¥${String((index * 37) % 9999)}.00`,
            fontSize: 14,
            lineHeight: 18,
            fontWeight: 600,
            color: INK,
          }),
          createElement("text", {
            key: "count",
            value: `${String((index % 5) + 1)} 件`,
            fontSize: 12,
            lineHeight: 16,
            color: MUTED,
          }),
        ],
      }),
      createElement("container", {
        key: "action",
        backgroundColor: ACCENT,
        padding: [6, 12, 6, 12],
        semanticRole: "button",
        onTap: () => {
          context.setMetric(context.messages.lastAction, `${context.messages.viewOrder} ${code}`);
        },
        children: createElement("text", {
          value: context.messages.viewOrder,
          fontSize: 12,
          lineHeight: 16,
          color: "#ffffffff",
        }),
      }),
    ],
  });
}

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
      renderItem: (index: number) => cell(index, context),
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
    selected.clear();
    context.setMetric(context.messages.listItems, ITEM_COUNT.toLocaleString());
    // Every row is a checkbox, a thumbnail, two text columns, three chips and a
    // button, so the node count per row is the number this demo exists to
    // stress: a list of bare strings never exercises layout or paint.
    context.setMetric(context.messages.nodesPerRow, "~20");
    context.setMetric(context.messages.selectedRows, "0");
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
      selected.clear();
    };
  },
};
