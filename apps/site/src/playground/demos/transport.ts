import {
  createElement,
  type NodeHandle,
  type PingoNode,
  type RenderClockMetrics,
} from "@dopejs/pingo";

import type { Demo, DemoContext } from "../demo";

const STALL_MS = 1_000;
const CORE_ITEMS = 1_000_000;
const CORE_ROW_HEIGHT = 72;
// Keep the explanatory motion readable: this is a timing demo, not a stress test.
const CORE_SCROLL_VELOCITY_PX_PER_SECOND = 216;
const UI_PHASE_MS = 500;
let scrollHandle: NodeHandle | null = null;
let uiAnimationHandle: number | undefined;
let uiPhase = 0;
let coreScrollStarted = false;
let virtualRowWidth = 0;
let virtualRowLabel = "Core / Worker";

function scene(context: DemoContext, phase: number): PingoNode {
  const { width, height, messages } = context;
  const gap = 12;
  const leftWidth = Math.floor((width - gap) * 0.42);
  const rightWidth = width - gap - leftWidth;
  const panelPadding = 20;
  const trackWidth = leftWidth - panelPadding * 2;
  const markerWidth = 42;
  const markerX = ((Math.sin(phase) + 1) / 2) * Math.max(0, trackWidth - markerWidth);
  const scrollWidth = rightWidth - panelPadding * 2;
  const scrollHeight = Math.max(160, height - 104);
  virtualRowWidth = scrollWidth;
  virtualRowLabel = messages.coreClockLabel;

  const uiLane = createElement("container", {
    key: "ui-clock",
    width: leftWidth,
    height,
    padding: [20, panelPadding, 20, panelPadding],
    gap: 8,
    backgroundColor: "#fff4f1ff",
    children: [
      createElement("text", {
        key: "title",
        value: messages.uiClockLabel,
        fontSize: 18,
        lineHeight: 24,
        fontWeight: 700,
        color: "#9f2d20ff",
      }),
      createElement("text", {
        key: "hint",
        value: messages.uiClockHint,
        fontSize: 13,
        lineHeight: 18,
        color: "#7a4a43ff",
      }),
      createElement("container", {
        key: "track",
        width: trackWidth,
        height: Math.max(120, height - 126),
        backgroundColor: "#f5d4ceff",
        children: createElement("container", {
          width: markerWidth,
          height: Math.max(120, height - 126),
          backgroundColor: "#e5484dff",
          transform: [1, 0, 0, 1, markerX, 0],
        }),
      }),
    ],
  });

  const coreLane = createElement("container", {
    key: "core-clock",
    width: rightWidth,
    height,
    padding: [20, panelPadding, 20, panelPadding],
    gap: 8,
    backgroundColor: "#f0f7ffff",
    children: [
      createElement("text", {
        key: "title",
        value: messages.coreClockLabel,
        fontSize: 18,
        lineHeight: 24,
        fontWeight: 700,
        color: "#165d9cff",
      }),
      createElement("text", {
        key: "hint",
        value: messages.coreClockHint,
        fontSize: 13,
        lineHeight: 18,
        color: "#3f6485ff",
      }),
      createElement("virtualList", {
        key: "scroll",
        ref: captureScrollHandle,
        width: scrollWidth,
        height: scrollHeight,
        backgroundColor: "#ffffffff",
        itemCount: CORE_ITEMS,
        estimatedItemHeight: CORE_ROW_HEIGHT,
        baseOverscanViewports: 4,
        velocityHorizonSeconds: 2,
        maximumAheadViewports: 16,
        renderItem: renderCoreRow,
      }),
    ],
  });

  return createElement("container", {
    width,
    height,
    direction: "row",
    gap,
    backgroundColor: "#ffffffff",
    children: [uiLane, coreLane],
  });
}

function captureScrollHandle(handle: NodeHandle | null): void {
  scrollHandle = handle;
}

function renderCoreRow(index: number): PingoNode {
  return createElement("container", {
    width: virtualRowWidth,
    height: CORE_ROW_HEIGHT,
    padding: [18, 20, 18, 20],
    backgroundColor: index % 2 === 0 ? "#dceaffff" : "#dff5e8ff",
    children: createElement("text", {
      value: `${virtualRowLabel} · ${String(index + 1).padStart(7, "0")}`,
      fontSize: 16,
      lineHeight: 24,
      fontWeight: 650,
      color: "#17426fff",
    }),
  });
}

function latestClockMetrics(): RenderClockMetrics | undefined {
  return (globalThis as { __pingoClock?: RenderClockMetrics }).__pingoClock;
}

/** Capability-driven transport selection and the main-thread stall drill. */
export const transportDemo: Demo = {
  id: "transport",
  title: (messages) => messages.transportTitle,
  description: (messages) => messages.transportDescription,
  render: (context) => scene(context, uiPhase),
  activate: (context) => {
    context.setMetric(
      context.messages.crossOriginIsolated,
      String(globalThis.crossOriginIsolated ?? false),
    );
    context.setMetric(context.messages.transportMode, context.root.mode);
    context.setMetric("SAB", String(typeof SharedArrayBuffer !== "undefined"));

    const tick = (timestamp: number): void => {
      if (!coreScrollStarted && scrollHandle !== null) {
        context.root.setScrollVelocity(scrollHandle, 0, CORE_SCROLL_VELOCITY_PX_PER_SECOND);
        coreScrollStarted = true;
      }
      uiPhase = timestamp / UI_PHASE_MS;
      context.root.render(scene(context, uiPhase));
      uiAnimationHandle = requestAnimationFrame(tick);
    };
    uiAnimationHandle = requestAnimationFrame(tick);

    const stall = document.createElement("button");
    stall.textContent = context.messages.blockMainThread;
    stall.addEventListener("click", () => {
      // This handler deliberately does not start or alter the animation. The
      // million-row Core list is already moving; the button only removes the
      // main thread from the system for one measured interval.
      const before = latestClockMetrics();
      const started = performance.now();
      const until = started + STALL_MS;
      while (performance.now() < until) {
        // Deliberate busy wait: in worker mode Core-owned motion keeps drawing.
      }
      const actual = performance.now() - started;
      context.setMetric(context.messages.actualStall, `${actual.toFixed(1)} ms`);

      // Worker reports cumulative clock metrics every 60 frames. Let the
      // queued report reach the main thread before comparing the snapshots.
      window.setTimeout(() => {
        const after = latestClockMetrics();
        if (before === undefined || after === undefined) return;
        context.setMetric(
          context.messages.workerFramesDuringStall,
          String(Math.max(0, after.frames - before.frames)),
        );
        context.setMetric(
          context.messages.selfDrivenFramesDuringStall,
          String(Math.max(0, after.selfDrivenFrames - before.selfDrivenFrames)),
        );
        context.setMetric(
          context.messages.maximumWorkerFrameGap,
          `${after.maximumFrameGapMs.toFixed(1)} ms`,
        );
      }, 250);
    });
    const note = document.createElement("p");
    note.style.margin = "0";
    note.textContent =
      context.root.mode === "main-thread"
        ? context.messages.stallOnMainThread
        : context.messages.stallOnWorker;
    context.controls.append(stall, note);

    return () => {
      if (uiAnimationHandle !== undefined) cancelAnimationFrame(uiAnimationHandle);
      uiAnimationHandle = undefined;
      uiPhase = 0;
      if (coreScrollStarted && scrollHandle !== null) {
        context.root.setScrollVelocity(scrollHandle, 0, 0);
      }
      coreScrollStarted = false;
      scrollHandle = null;
    };
  },
};
