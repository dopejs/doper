import { createElement, type DoperNode } from "@dopejs/doper";

import type { Demo, DemoContext } from "../demo";

const BOX = 120;
let animationHandle: number | undefined;

function scene(context: DemoContext, angleOffset: number): DoperNode {
  const { width, height } = context;
  const cx = width / 2;
  const cy = height / 2;
  const children: DoperNode[] = [];
  for (let index = 0; index < 3; index += 1) {
    const angle = angleOffset + (index * Math.PI * 2) / 3;
    children.push(
      createElement("container", {
        width: BOX,
        height: BOX,
        backgroundColor: ["#5aa9ffff", "#7ad3a4ff", "#ffb454ff"][index] ?? "#5aa9ffff",
        transform: [
          1,
          0,
          0,
          1,
          cx - BOX / 2 + Math.cos(angle) * 110,
          cy - BOX / 2 + Math.sin(angle) * 110,
        ],
      }),
    );
  }
  return createElement("container", {
    width,
    height,
    backgroundColor: "#ffffffff",
    children,
  });
}

/** Capability-driven transport selection and the main-thread stall drill. */
export const transportDemo: Demo = {
  id: "transport",
  title: (messages) => messages.transportTitle,
  description: (messages) => messages.transportDescription,
  render: (context) => scene(context, 0),
  activate: (context) => {
    context.setMetric(
      context.messages.crossOriginIsolated,
      String(globalThis.crossOriginIsolated ?? false),
    );
    context.setMetric(context.messages.transportMode, context.root.mode);
    context.setMetric("SAB", String(typeof SharedArrayBuffer !== "undefined"));

    let angle = 0;
    const tick = (): void => {
      angle += 0.02;
      context.root.render(scene(context, angle));
      animationHandle = requestAnimationFrame(tick);
    };
    animationHandle = requestAnimationFrame(tick);

    const stall = document.createElement("button");
    stall.textContent = context.messages.blockMainThread;
    stall.addEventListener("click", () => {
      const until = performance.now() + 200;
      while (performance.now() < until) {
        // Deliberate busy wait: in worker mode the render clock keeps running.
      }
    });
    const note = document.createElement("p");
    note.style.margin = "0";
    note.textContent =
      context.root.mode === "main-thread"
        ? context.messages.stallOnMainThread
        : context.messages.stallOnWorker;
    context.controls.append(stall, note);

    return () => {
      if (animationHandle !== undefined) cancelAnimationFrame(animationHandle);
      animationHandle = undefined;
    };
  },
};
