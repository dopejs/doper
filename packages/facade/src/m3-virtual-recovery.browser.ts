import { describe, expect, it } from "vitest";

import {
  createElement,
  createHostedCanvasRoot,
  type FrameReport,
  type NodeHandle,
  type VirtualListProps,
} from "./index";

/**
 * A starved viewport has to recover quickly.
 *
 * Reported from the live playground: after a fast gesture the list showed
 * placeholder skeletons for around a second. Frame counts and transport mode
 * looked healthy the whole time, so the only way to see the problem is to watch
 * how long visible items stay unmaterialized.
 */
describe("virtual list recovery after a large jump", () => {
  it("serves the viewport within a few frames of the offset settling", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    document.body.append(canvas);

    const reports: FrameReport[] = [];
    const windows: Array<{ start: number; end: number }> = [];
    const root = await createHostedCanvasRoot(canvas, {
      onFrame: (report) => reports.push(report),
      onVirtualRefills: (requests) => {
        for (const request of requests) windows.push({ start: request.start, end: request.end });
      },
      transport: { pageWorkerEnabled: false },
    });

    let handle: NodeHandle | null = null;
    const scene = (scrollY: number) => {
      const props = {
        width: 640,
        height: 480,
        itemCount: 1_000_000,
        estimatedItemHeight: 32,
        scrollY,
        ref: (value: NodeHandle | null) => {
          handle = value;
        },
        renderItem: (index: number) => createElement("text", { value: `row ${index}` }),
      } satisfies VirtualListProps;
      return createElement<typeof props>("virtualList", props);
    };

    root.render(scene(0));
    await waitFor(
      () => reports.some((report) => (report.core?.sceneNodes ?? 0) > 2),
      3_000,
      "mount",
    );
    if (handle === null) throw new Error("virtual list ref was not attached");

    // Jump far enough that nothing in the new viewport can already be
    // materialized, which is what a fast gesture produces.
    root.render(scene(400_000 * 32));

    const settledAt = await waitFor(
      () => (reports.at(-1)?.core?.visiblePlaceholders ?? 1) === 0,
      3_000,
      `viewport served (windows: ${JSON.stringify(windows.slice(-4))}, ` +
        `placeholders: ${String(reports.at(-1)?.core?.visiblePlaceholders)}, ` +
        `nodes: ${String(reports.at(-1)?.core?.sceneNodes)})`,
    );

    // One round trip is a frame or two. A second is the reported defect.
    expect(settledAt).toBeLessThan(300);
    await root.close();
    canvas.remove();
  });

  it("serves the viewport as fast after a wheel gesture as after a jump", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    document.body.append(canvas);

    const reports: FrameReport[] = [];
    // The deployed site runs the postMessage transport without cross-origin
    // isolation, which is where the stall was reported.
    const root = await createHostedCanvasRoot(canvas, {
      onFrame: (report) => reports.push(report),
      transport: { preference: "post-message" },
    });

    // Rows shaped like the playground's: materializing a window costs a
    // container plus a text node per item, not a bare string, and that cost is
    // what decides whether the Shell keeps up.
    const props = {
      width: 640,
      height: 480,
      itemCount: 1_000_000,
      estimatedItemHeight: 32,
      renderItem: (index: number) =>
        createElement("container", {
          width: 640,
          height: 32,
          padding: [6, 12, 6, 12],
          backgroundColor: index % 2 === 0 ? "#ffffffff" : "#f5f7faff",
          children: createElement("text", {
            value: `#${String(index).padStart(7, "0")}    row ${index}`,
            fontSize: 13,
            lineHeight: 20,
          }),
        }),
    } satisfies VirtualListProps;
    root.render(createElement<typeof props>("virtualList", props));
    await waitFor(
      () => reports.some((report) => (report.core?.sceneNodes ?? 0) > 2),
      3_000,
      "mount",
    );

    // Discrete notches, the shape a mouse wheel and a trackpad flick produce.
    // Core animates them, so the offset keeps moving after the last event.
    for (let index = 0; index < 40; index += 1) {
      const event = new WheelEvent("wheel", {
        deltaY: 400,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
        clientX: 320,
        clientY: 240,
      });
      Object.defineProperty(event, "wheelDeltaY", { value: -1_200 });
      canvas.dispatchEvent(event);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }

    // Time the recovery from the last wheel event. Core animates a notch over
    // 120ms, so anything beyond that plus a round trip is the viewport sitting
    // on skeletons with nothing left to wait for.
    const served = await waitFor(
      () => (reports.at(-1)?.core?.visiblePlaceholders ?? 1) === 0,
      5_000,
      `viewport served after wheel (placeholders: ${String(
        reports.at(-1)?.core?.visiblePlaceholders,
      )})`,
    );

    // The measured latency is the point of this test, so keep it in the output.
    console.log(`wheel recovery on ${root.mode}: ${served.toFixed(0)}ms`);
    expect(served).toBeLessThan(300);
    await root.close();
    canvas.remove();
  });
});

/** Resolves with the elapsed milliseconds once the predicate holds. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<number> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  return performance.now() - start;
}
