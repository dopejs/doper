import { describe, expect, it, vi } from "vitest";

import { scrollAreaDescriptor, scrollbarThumb } from "./scroll-area";

type Node = { readonly props: Record<string, unknown> };

describe("scrollbarThumb", () => {
  it("is absent when the content fits", () => {
    // No bar rather than a full-length one: a scrollbar that cannot move is
    // just noise beside the content.
    expect(scrollbarThumb(0, 100, 0, 100)).toBeUndefined();
    expect(scrollbarThumb(0, 100, 0, 50)).toBeUndefined();
  });

  it("sizes the thumb by the visible fraction", () => {
    expect(scrollbarThumb(0, 100, 0, 400)?.length).toBe(0.25);
  });

  it("derives the offset from the two boxes, since there is no scroll position", () => {
    // Scrolling translates the content upwards, so its top moves above the
    // viewport's by exactly the scrolled distance.
    expect(scrollbarThumb(0, 100, 0, 400)?.offset).toBe(0);
    expect(scrollbarThumb(0, 100, -300, 400)?.offset).toBeCloseTo(0.75);
    expect(scrollbarThumb(0, 100, -150, 400)?.offset).toBeCloseTo(0.375);
  });

  it("clamps an over-scrolled position rather than running off the track", () => {
    expect(scrollbarThumb(0, 100, -9999, 400)?.offset).toBeCloseTo(0.75);
    expect(scrollbarThumb(0, 100, 50, 400)?.offset).toBe(0);
  });

  it("survives a zero-height viewport", () => {
    expect(scrollbarThumb(0, 0, 0, 400)).toBeUndefined();
  });
});

describe("scrollAreaDescriptor", () => {
  const refs = { viewport: vi.fn(), content: vi.fn() };

  it("draws no bar until a measurement arrives", () => {
    // The first frame has no geometry, and guessing would put the thumb in the
    // wrong place before correcting it.
    const node = scrollAreaDescriptor({ children: null }, refs, undefined) as unknown as Node;
    expect((node.props["children"] as Node[])[1]).toBeNull();
  });

  it("expresses the thumb as percentages of the track", () => {
    const node = scrollAreaDescriptor({ children: null }, refs, {
      offset: 0.25,
      length: 0.5,
    }) as unknown as Node;
    const bar = (node.props["children"] as Node[])[1];
    const thumb = bar?.props["children"] as Node;
    expect(thumb.props["style"]).toMatchObject({ height: "50%", marginTop: "25%" });
  });

  it("keeps scrolling when the bar is hidden", () => {
    // Core owns the scrolling; hiding the bar is a paint decision only.
    const node = scrollAreaDescriptor({ children: null, hideScrollbar: true }, refs, {
      offset: 0,
      length: 0.5,
    }) as unknown as Node;
    const [viewport, bar] = node.props["children"] as Node[];
    expect(bar).toBeNull();
    expect(viewport?.props["ref"]).toBe(refs.viewport);
  });
});
