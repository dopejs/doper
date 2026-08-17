import {
  createElement,
  createHostedCanvasRoot,
  TextField,
  type DoperNode,
  type FrameReport,
} from "@dopejs/doper";
import { afterEach, describe, expect, it } from "vitest";

/** Representative migration page: heading, editable search, virtual list. */
function renderMigrationFixture(): DoperNode {
  return createElement("container", {
    width: 320,
    children: [
      createElement("text", {
        value: "Orders",
        fontSize: 20,
        lineHeight: 26,
        semanticRole: "heading",
      }),
      TextField({ semanticLabel: "Search orders", value: "abc", revision: 1n, width: 300 }),
      createElement("virtualList", {
        itemCount: 1_000,
        estimatedItemHeight: 24,
        height: 240,
        width: 300,
        renderItem: (index: number) =>
          createElement("text", {
            value: `Order #${String(index)}`,
            fontSize: 13,
            lineHeight: 24,
          }),
      }),
    ],
  });
}

describe("M5 shadow comparison", () => {
  const roots: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await root.close();
    document.body.replaceChildren();
  });

  it("renders the migration fixture identically on the shadow and primary paths", async () => {
    expect(crossOriginIsolated).toBe(true);
    const pixels: ImageData[] = [];
    for (const preference of ["main-thread", "sab"] as const) {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 360;
      document.body.append(canvas);
      const frames: FrameReport[] = [];
      const errors: Error[] = [];
      const root = await createHostedCanvasRoot(canvas, {
        accessibility: false,
        onFrame: (report) => frames.push(report),
        onHostError: (error) => errors.push(error),
        rasterCache: false,
        transport: { preference, strict: true },
      });
      roots.push(root);
      root.render(renderMigrationFixture());
      await withTimeout(
        waitUntil(() => frames.length > 0),
        5_000,
        `${preference} first frame`,
      );
      // Let refill/geometry follow-up frames settle deterministically.
      await settle(() => frames.length);
      pixels.push(sample(canvas));
      expect(errors).toEqual([]);
      await root.close();
      roots.pop();
    }
    const [shadow, primary] = pixels;
    if (shadow === undefined || primary === undefined) throw new Error("missing samples");
    // Both paths must have painted real content.
    expect(shadow.data.some((byte) => byte !== 0)).toBe(true);
    // Documented shadow tolerance: worker OffscreenCanvas text anti-aliasing
    // may differ from the main thread at glyph edges. Per-channel delta ≤ 8
    // counts as matching; at most 2% of pixels may exceed it.
    let mismatched = 0;
    for (let pixel = 0; pixel < shadow.data.length; pixel += 4) {
      let delta = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        delta = Math.max(
          delta,
          Math.abs((shadow.data[pixel + channel] ?? 0) - (primary.data[pixel + channel] ?? 0)),
        );
      }
      if (delta > 8) mismatched += 1;
    }
    const total = shadow.data.length / 4;
    expect(mismatched / total).toBeLessThanOrEqual(0.02);
  });

  function sample(canvas: HTMLCanvasElement): ImageData {
    const sampler = document.createElement("canvas");
    sampler.width = canvas.width;
    sampler.height = canvas.height;
    const context = sampler.getContext("2d");
    if (context === null) throw new Error("sampler context unavailable");
    context.drawImage(canvas, 0, 0);
    return context.getImageData(0, 0, sampler.width, sampler.height);
  }

  async function settle(observe: () => number): Promise<void> {
    let previous = -1;
    let stable = 0;
    while (stable < 5) {
      const current = observe();
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  async function waitUntil(predicate: () => boolean): Promise<void> {
    while (!predicate()) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          handle = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        }),
      ]);
    } finally {
      if (handle !== undefined) clearTimeout(handle);
    }
  }
});
