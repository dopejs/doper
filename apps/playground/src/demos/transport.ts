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
  title: "双时钟与降级链",
  description:
    "引擎按能力自动选择 SharedArrayBuffer → postMessage → 主线程 Canvas2D。" +
    "GitHub Pages 无法下发 COOP/COEP 响应头，所以线上通常落在 postMessage 或主线程路径——" +
    "这正是降级链的真实演示。点击按钮人为阻塞主线程 200ms，观察 Worker 模式下动画是否继续。",
  render: (context) => scene(context, 0),
  activate: (context) => {
    context.setMetric("跨源隔离", String(globalThis.crossOriginIsolated ?? false));
    context.setMetric("传输模式", context.root.mode);
    context.setMetric("SAB", String(typeof SharedArrayBuffer !== "undefined"));

    let angle = 0;
    const tick = (): void => {
      angle += 0.02;
      context.root.render(scene(context, angle));
      animationHandle = requestAnimationFrame(tick);
    };
    animationHandle = requestAnimationFrame(tick);

    const stall = document.createElement("button");
    stall.textContent = "阻塞主线程 200ms";
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
        ? "当前是主线程路径，阻塞期间动画会停顿——这就是需要 Worker 的原因。"
        : "当前是 Worker 路径，阻塞期间渲染时钟仍在 Worker 内推进。";
    context.controls.append(stall, note);

    return () => {
      if (animationHandle !== undefined) cancelAnimationFrame(animationHandle);
      animationHandle = undefined;
    };
  },
};
