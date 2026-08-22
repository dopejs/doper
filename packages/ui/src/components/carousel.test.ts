import { describe, expect, it, vi } from "vitest";

import { carouselDescriptor, carouselStep } from "./carousel";

type Node = { readonly props: Record<string, unknown> };

describe("carouselStep", () => {
  it("clamps at both ends when not looping", () => {
    expect(carouselStep(0, -1, 3, false)).toBe(0);
    expect(carouselStep(2, 1, 3, false)).toBe(2);
  });

  it("wraps in both directions when looping", () => {
    expect(carouselStep(2, 1, 3, true)).toBe(0);
    // Modulo twice: a bare `%` yields -1 here, which would translate the track
    // one slide off-screen instead of showing the last one.
    expect(carouselStep(0, -1, 3, true)).toBe(2);
  });

  it("survives an empty carousel", () => {
    expect(carouselStep(0, 1, 0, true)).toBe(0);
    expect(carouselStep(0, 1, 0, false)).toBe(0);
  });
});

describe("carouselDescriptor", () => {
  function controls(index: number, props: Partial<Parameters<typeof carouselDescriptor>[0]> = {}) {
    const node = carouselDescriptor(
      { items: [null, null, null], ...props },
      index,
    ) as unknown as Node;
    const [, row] = node.props["children"] as Node[];
    return (row?.props["children"] as Node[]) ?? [];
  }

  it("disables the control that cannot move", () => {
    const [previous] = controls(0);
    expect(previous?.props["className"]).toContain("pui-carousel__control--disabled");
    expect(previous?.props["onTap"]).toBeUndefined();

    const [, next] = controls(2);
    expect(next?.props["className"]).toContain("pui-carousel__control--disabled");
  });

  it("keeps both controls live while looping", () => {
    const [previous, next] = controls(0, { loop: true });
    expect(previous?.props["onTap"]).toBeDefined();
    expect(next?.props["onTap"]).toBeDefined();
  });

  it("translates the track rather than repositioning it", () => {
    // The engine can only animate transform and opacity, so transform is the
    // one property that can move smoothly instead of jumping.
    const node = carouselDescriptor({ items: [null, null] }, 1) as unknown as Node;
    const viewport = (node.props["children"] as Node[])[0];
    const track = viewport?.props["children"] as Node;
    expect(track.props["style"]).toMatchObject({ transform: "translateX(-100%)" });
    expect(track.props["transition"]).toMatchObject({ property: "transform" });
  });

  it("moves with the arrow keys and claims no other key", () => {
    const onIndexChange = vi.fn();
    const node = carouselDescriptor(
      { items: [null, null, null], onIndexChange },
      1,
    ) as unknown as Node;
    const keyDown = node.props["onKeyDown"] as (event: unknown) => void;
    const preventDefault = vi.fn();
    keyDown({ key: "ArrowRight", preventDefault });
    expect(onIndexChange).toHaveBeenCalledWith(2);
    const ignored = vi.fn();
    keyDown({ key: "Enter", preventDefault: ignored });
    expect(ignored).not.toHaveBeenCalled();
  });
});
