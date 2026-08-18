import { afterEach, describe, expect, it } from "vitest";

import {
  createElement,
  createHostedCanvasRoot,
  createImage,
  type FrameReport,
  type HostedCanvasRoot,
} from "./index";

const roots: HostedCanvasRoot[] = [];

afterEach(async () => {
  while (roots.length > 0) await roots.pop()?.close();
});

/**
 * A list cell in a real product is not a line of text.
 *
 * These cover the two primitives a realistic cell needs and that the engine
 * previously lacked: children flowing along a row, and a bitmap that actually
 * reaches the canvas. Both are asserted against drawn pixels rather than
 * command counts, because a scene that lays out correctly and paints nothing
 * looks identical in diagnostics.
 */
describe("rich list cells", () => {
  it("flows a row of children horizontally and draws each one", async () => {
    const { canvas, context, reports, root } = await mount();

    // Three swatches on one line: if the row flowed as a column instead, the
    // second and third would land below the first and the sampled points would
    // be the background colour.
    root.render(
      createElement("container", {
        width: 300,
        height: 60,
        backgroundColor: "#ffffffff",
        direction: "row",
        gap: 10,
        padding: [10, 10, 10, 10],
        children: [
          createElement("container", {
            key: "a",
            width: 40,
            height: 40,
            backgroundColor: "#ff0000ff",
          }),
          createElement("container", {
            key: "b",
            width: 40,
            height: 40,
            backgroundColor: "#00ff00ff",
          }),
          createElement("container", {
            key: "c",
            width: 40,
            height: 40,
            backgroundColor: "#0000ffff",
          }),
        ],
      }),
    );
    await settle(reports);

    // Padding 10, then 40-wide swatches separated by a 10 gap.
    expect(pixel(context, 30, 30)).toEqual([255, 0, 0, 255]);
    expect(pixel(context, 80, 30)).toEqual([0, 255, 0, 255]);
    expect(pixel(context, 130, 30)).toEqual([0, 0, 255, 255]);
    // Between the first and second swatch is the container's own background.
    expect(pixel(context, 55, 30)).toEqual([255, 255, 255, 255]);
    canvas.remove();
  });

  it("draws an image resource and takes its pixel size when unsized", async () => {
    const { canvas, context, reports, root } = await mount();

    // A two-by-two bitmap: distinct quadrant colours make a flipped or
    // mis-strided upload obvious rather than plausible.
    const pixels = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const source = createImage(pixels, 2, 2, { label: "swatch" });

    root.render(
      createElement("container", {
        width: 300,
        height: 100,
        backgroundColor: "#ffffffff",
        direction: "row",
        children: [
          createElement("image", { key: "scaled", source, width: 40, height: 40 }),
          createElement("image", { key: "natural", source }),
        ],
      }),
    );
    await settle(reports);

    // The scaled copy fills a 40x40 box: quadrants land at 10 and 30.
    expect(pixel(context, 10, 10)).toEqual([255, 0, 0, 255]);
    expect(pixel(context, 30, 10)).toEqual([0, 255, 0, 255]);
    expect(pixel(context, 10, 30)).toEqual([0, 0, 255, 255]);
    expect(pixel(context, 30, 30)).toEqual([255, 255, 0, 255]);
    // The unsized copy took the bitmap's own two-by-two size, so it sits in the
    // two columns immediately after the scaled one.
    expect(pixel(context, 40, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(context, 41, 1)).toEqual([255, 255, 0, 255]);
    canvas.remove();
  });

  it("refuses pixels that do not match the declared dimensions", () => {
    // The check belongs at the API boundary so the message names the caller's
    // mistake instead of surfacing as a malformed resource inside Core.
    expect(() => createImage(new Uint8Array(15), 2, 2)).toThrow(/RGBA8/u);
    expect(() => createImage(new Uint8Array(16), 0, 2)).toThrow(/positive integers/u);
  });
});

async function mount(): Promise<{
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  reports: FrameReport[];
  root: HostedCanvasRoot;
}> {
  const canvas = document.createElement("canvas");
  canvas.width = 300;
  canvas.height = 100;
  document.body.append(canvas);
  const reports: FrameReport[] = [];
  const root = await createHostedCanvasRoot(canvas, {
    onFrame: (report) => reports.push(report),
    // Read back from the same canvas the engine drew into.
    transport: { pageWorkerEnabled: false },
  });
  roots.push(root);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("canvas has no 2d context");
  return { canvas, context, reports, root };
}

async function settle(reports: readonly FrameReport[]): Promise<void> {
  const start = performance.now();
  while (reports.length === 0) {
    if (performance.now() - start > 3_000) throw new Error("no frame was reported");
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

function pixel(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
): [number, number, number, number] {
  const data = context.getImageData(x, y, 1, 1).data;
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
}
