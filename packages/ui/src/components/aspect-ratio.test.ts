import { describe, expect, it, vi } from "vitest";

import { aspectRatioDescriptor, ratioHeight } from "./aspect-ratio";

type Node = { readonly props: Record<string, unknown> };

describe("ratioHeight", () => {
  it("divides the width by the ratio", () => {
    expect(ratioHeight(320, 16 / 9)).toBe(180);
    expect(ratioHeight(100, 1)).toBe(100);
  });

  it("refuses a width it has not measured yet", () => {
    expect(ratioHeight(undefined, 1)).toBeUndefined();
    expect(ratioHeight(0, 1)).toBeUndefined();
  });

  it("refuses a nonsensical ratio rather than producing a nonsensical height", () => {
    expect(ratioHeight(100, 0)).toBeUndefined();
    expect(ratioHeight(100, -1)).toBeUndefined();
    expect(ratioHeight(100, Number.NaN)).toBeUndefined();
    expect(ratioHeight(100, Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("aspectRatioDescriptor", () => {
  it("sets no height before the width is known", () => {
    // Guessing would lay the subtree out at the wrong size and then move it,
    // which is worse than one frame of zero height for a box whose whole job
    // is to reserve space correctly.
    const node = aspectRatioDescriptor({ children: null }, undefined, vi.fn()) as unknown as Node;
    expect(node.props["style"]).toBeUndefined();
  });

  it("applies the derived height once measured", () => {
    const node = aspectRatioDescriptor({ children: null }, 180, vi.fn()) as unknown as Node;
    expect(node.props["style"]).toEqual({ height: 180 });
  });
});
