import { describe, expect, it } from "vitest";

import { PingoImage, createImage } from "./image";

describe("createImage", () => {
  it("copies the pixels it was handed", () => {
    // The caller keeps its own buffer and may reuse it for the next frame, so
    // the engine's copy has to be independent of it.
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const image = createImage(pixels, 2, 1, { label: "swatch" });
    pixels.fill(0);

    expect(image).toBeInstanceOf(PingoImage);
    expect([...image.copyPixels()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(image.width).toBe(2);
    expect(image.height).toBe(1);
    expect(image.label).toBe("swatch");
    // And each read is isolated too, or two Scene resources would alias.
    const first = image.copyPixels();
    first.fill(9);
    expect([...image.copyPixels()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("accepts a buffer or a view over one", () => {
    const backing = new Uint8Array([0, 0, 1, 2, 3, 4]);
    const view = backing.subarray(2);
    expect([...createImage(view, 1, 1).copyPixels()]).toEqual([1, 2, 3, 4]);
    expect([...createImage(new Uint8Array([5, 6, 7, 8]).buffer, 1, 1).copyPixels()]).toEqual([
      5, 6, 7, 8,
    ]);
  });

  it("defaults to an empty label", () => {
    expect(createImage(new Uint8Array(4), 1, 1).label).toBe("");
  });

  it("rejects dimensions that do not describe the pixels", () => {
    // Checked here rather than at the ABI boundary so the error names the
    // caller's mistake instead of surfacing as a malformed resource in Core.
    expect(() => createImage(new Uint8Array(15), 2, 2)).toThrow(/RGBA8/u);
    expect(() => createImage(new Uint8Array(20), 2, 2)).toThrow(/RGBA8/u);
    for (const [width, height] of [
      [0, 1],
      [1, 0],
      [-1, 1],
      [1.5, 1],
      [Number.NaN, 1],
    ] as const) {
      expect(() => createImage(new Uint8Array(4), width, height)).toThrow(/positive integers/u);
    }
  });

  it("rejects a label that is not a string", () => {
    expect(() => createImage(new Uint8Array(4), 1, 1, { label: 7 as unknown as string })).toThrow(
      /label/u,
    );
  });
});
