import { createElement, createHostedCanvasRoot, type FrameReport } from "@dopejs/doper";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A cache may not change what is drawn.
 *
 * A raster tile is an ad-hoc `OffscreenCanvas`, and the browser does not
 * rasterize text on one the way it does on the canvas it composites, so a frame
 * that went through tiles did not match the frame before it. This asserts the
 * decision rather than the pixels: a headless build rasterizes both sides in
 * software and would agree even when a real display does not.
 */
describe("raster tile cache parity", () => {
  const roots: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await root.close();
    document.body.replaceChildren();
  });

  const mount = async (rasterCache: boolean | undefined): Promise<FrameReport[]> => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 120;
    document.body.append(canvas);
    const frames: FrameReport[] = [];
    const root = await createHostedCanvasRoot(canvas, {
      onFrame: (report) => frames.push(report),
      transport: { preference: "main-thread" },
      ...(rasterCache === undefined ? {} : { rasterCache }),
    });
    roots.push(root);
    for (const value of ["one", "two", "two"]) {
      root.render(
        createElement("container", {
          width: 300,
          height: 120,
          backgroundColor: "#ffffffff",
          children: [createElement("text", { value, fontSize: 13, lineHeight: 24 })],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return frames;
  };

  it("never routes a default-configured frame through tiles", async () => {
    const frames = await mount(undefined);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.map((frame) => frame.rasterFrame)).toEqual(frames.map(() => undefined));
  });

  it("still routes frames through the cache when explicitly opted in", async () => {
    // The subsystem stays reachable, so the opt-in has to keep working; without
    // this the default above could be satisfied by deleting the feature.
    const frames = await mount(true);
    expect(frames.some((frame) => frame.rasterFrame !== undefined)).toBe(true);
    // Every one of them bypasses. Rendering the same tree twice produces no
    // second frame at all, so a picture never repeats at the replayer and the
    // cache has nothing left to hit -- which is why it is now opt-in.
    expect(frames.filter((frame) => frame.rasterFrame?.bypassed === false)).toEqual([]);
  });
});
