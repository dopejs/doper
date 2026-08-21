import { describe, expect, it } from "vitest";

import fixture from "../../../benchmarks/abi/animation-resource.v1.json";

import { encodeAnimationResource } from "./animation-resource";

describe("animation resource", () => {
  it("encodes transition and immutable keyframe tracks canonically", () => {
    const bytes = encodeAnimationResource(
      [
        { property: "opacity", durationMs: 250, delayMs: -50, easing: "ease-in-out" },
        {
          property: "transform",
          durationMs: 500,
          easing: { cubicBezier: [0.1, 0.2, 0.8, 1] },
        },
      ],
      {
        property: "opacity",
        durationMs: 1_000,
        iterations: 2.5,
        direction: "alternate",
        fill: "both",
        easing: { steps: 4, position: "start" },
        keyframes: [
          { offset: 0, value: 0 },
          { offset: 0.25, value: 1 },
          { offset: 1, value: 0.5 },
        ],
      },
    );
    expect(bytes).toBeDefined();
    if (bytes === undefined) throw new Error("animation bytes missing");
    const view = new DataView(bytes.buffer);
    expect([...bytes.slice(0, 4)]).toEqual([1, 2, 1, 0]);
    expect(view.getUint32(4, true)).toBe(bytes.byteLength);
    expect(view.getUint32(12, true)).toBe(250_000);
    expect(view.getInt32(16, true)).toBe(-50_000);
    expect(bytes[37]).toBe(5);
    expect(bytes[65]).toBe(6);
    expect(fixture).toMatchObject({ encodingVersion: 1, schemaVersion: 1 });
    expect([...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")).toBe(
      fixture.hex,
    );
  });

  it("rejects duplicate, hostile, mismatched, and unbounded declarations", () => {
    expect(() =>
      encodeAnimationResource(
        [
          { property: "opacity", durationMs: 1 },
          { property: "opacity", durationMs: 2 },
        ],
        undefined,
      ),
    ).toThrow("duplicate transition property");
    expect(() =>
      encodeAnimationResource(undefined, {
        property: "opacity",
        durationMs: 1,
        keyframes: [
          { offset: 0, value: 0 },
          { offset: 0.5, value: 1 },
        ],
      }),
    ).toThrow("zero and one endpoints");
    expect(() =>
      encodeAnimationResource(undefined, {
        property: "transform",
        durationMs: 1,
        keyframes: [
          { offset: 0, value: [1, 0, 0, 1, 0, 0] },
          { offset: 1, value: Number.NaN },
        ],
      }),
    ).toThrow("affine matrix");
    expect(() =>
      encodeAnimationResource(
        { property: "opacity", durationMs: Number.POSITIVE_INFINITY },
        undefined,
      ),
    ).toThrow("must be finite");
  });
});
