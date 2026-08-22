import { describe, expect, it, vi } from "vitest";

import { clampSplit, resizableDescriptor } from "./resizable";

type Node = { readonly props: Record<string, unknown> };

function parts(split: number, props: Partial<Parameters<typeof resizableDescriptor>[0]> = {}) {
  const node = resizableDescriptor(
    { first: null, second: null, ...props },
    split,
    undefined,
  ) as unknown as Node;
  return node.props["children"] as Node[];
}

describe("clampSplit", () => {
  it("keeps a split inside the caller's bounds", () => {
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(0)).toBe(0.1);
    expect(clampSplit(1)).toBe(0.9);
  });

  it("rejects a nonsensical split rather than collapsing a pane", () => {
    // A negative or NaN basis reads as a layout bug far from its cause. NaN has
    // no side to clamp towards, so it takes the lower bound; an infinity clamps
    // to whichever bound it was heading for.
    expect(clampSplit(Number.NaN)).toBe(0.1);
    expect(clampSplit(Number.POSITIVE_INFINITY)).toBe(0.9);
    expect(clampSplit(Number.NEGATIVE_INFINITY)).toBe(0.1);
  });

  it("survives inverted bounds", () => {
    expect(clampSplit(0.5, 0.9, 0.1)).toBe(0.5);
  });
});

describe("resizableDescriptor", () => {
  it("sizes the first pane and lets the second take the remainder", () => {
    // Two computed percentages could disagree about the total; a flex remainder
    // cannot.
    const [first, , second] = parts(0.3);
    expect(first?.props["style"]).toMatchObject({ width: "30%" });
    expect(second?.props["style"]).toMatchObject({ flex: "1 1 0px" });
  });

  it("switches the sized axis with the direction", () => {
    const [first] = parts(0.3, { direction: "column" });
    expect(first?.props["style"]).toMatchObject({ height: "30%" });
  });

  it("moves with the arrows that match its axis", () => {
    const onSplitChange = vi.fn();
    const [, handle] = parts(0.5, { onSplitChange });
    const keyDown = handle?.props["onKeyDown"] as (event: unknown) => void;
    const preventDefault = vi.fn();
    keyDown({ key: "ArrowRight", preventDefault });
    expect(onSplitChange).toHaveBeenCalledWith(0.52);

    const ignored = vi.fn();
    keyDown({ key: "ArrowDown", preventDefault: ignored });
    expect(ignored).not.toHaveBeenCalled();
  });

  it("attaches no handlers when disabled", () => {
    const [, handle] = parts(0.5, { disabled: true });
    expect(handle?.props["onKeyDown"]).toBeUndefined();
    expect(handle?.props["className"]).toContain("pui-resizable__handle--disabled");
  });

  it("reports the split as a separator position", () => {
    const [, handle] = parts(0.42);
    expect(handle?.props["semanticRole"]).toBe("separator");
    expect(handle?.props["semanticValue"]).toBe("42");
  });
});
