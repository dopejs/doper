import { createElement, type DoperEvent, type DoperNode } from "@dopejs/doper";

import type { Demo, DemoContext } from "../demo";

const log: string[] = [];
let output: HTMLElement | undefined;

function record(entry: string): void {
  log.unshift(entry);
  log.length = Math.min(log.length, 8);
  if (output !== undefined) output.textContent = log.join("\n");
}

function phaseName(phase: 1 | 2 | 3): string {
  return phase === 1 ? "capture" : phase === 2 ? "target" : "bubble";
}

function scene(context: DemoContext): DoperNode {
  const { width, height } = context;
  const handlers = (name: string) => ({
    onPointerDownCapture: (event: DoperEvent) =>
      record(`${name}  ${phaseName(event.eventPhase)}  #${String(event.eventId)}`),
    onPointerDown: (event: DoperEvent) =>
      record(`${name}  ${phaseName(event.eventPhase)}  #${String(event.eventId)}`),
  });
  return createElement("container", {
    width,
    height,
    backgroundColor: "#ffffffff",
    padding: 24,
    ...handlers("outer"),
    children: createElement("container", {
      width: width - 48,
      height: height - 48,
      backgroundColor: "#eef3faff",
      padding: 24,
      ...handlers("middle"),
      children: createElement("container", {
        width: 220,
        height: 120,
        backgroundColor: "#5aa9ffff",
        ...handlers("target"),
        children: createElement("text", {
          value: "点我看三阶段传播",
          fontSize: 14,
          lineHeight: 120,
          color: "#ffffffff",
        }),
      }),
    }),
  });
}

/** Core BVH hit testing feeding DOM-aligned three-phase dispatch. */
export const eventsDemo: Demo = {
  id: "events",
  title: "命中测试与三阶段事件",
  description:
    "指针坐标进入 Core，由增量 BVH 做世界空间命中并构建 root→target 路径，" +
    "再由 Shell 按 capture / target / bubble 三阶段派发。点击蓝色方块观察顺序。",
  render: scene,
  activate: (context) => {
    log.length = 0;
    const title = document.createElement("p");
    title.style.margin = "0";
    title.textContent = "传播日志（新→旧）";
    output = document.createElement("pre");
    output.style.cssText =
      "margin:0;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;line-height:1.6;color:#e6ebf2";
    context.controls.append(title, output);
    return () => {
      output = undefined;
    };
  },
};
