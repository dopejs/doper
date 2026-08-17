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
