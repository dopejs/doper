import { describe, expect, it, vi } from "vitest";

import { sliderDescriptor, sliderRatio } from "./slider";

type Node = { readonly props: Record<string, unknown> };

function slider(value: number, props: Partial<Parameters<typeof sliderDescriptor>[0]> = {}) {
  return sliderDescriptor({ ...props }, value, undefined, vi.fn()) as unknown as Node;
}

describe("sliderRatio", () => {
  it("maps the range onto the unit interval", () => {
    expect(sliderRatio(0, 0, 100)).toBe(0);
    expect(sliderRatio(50, 0, 100)).toBe(0.5);
    expect(sliderRatio(100, 0, 100)).toBe(1);
  });

  it("clamps a value outside the range", () => {
    expect(sliderRatio(-10, 0, 100)).toBe(0);
    expect(sliderRatio(200, 0, 100)).toBe(1);
  });

  it("returns zero for an empty or inverted range instead of dividing by zero", () => {
    expect(sliderRatio(5, 10, 10)).toBe(0);
    expect(sliderRatio(5, 10, 0)).toBe(0);
  });
});

describe("sliderDescriptor", () => {
  it("expresses the fill and thumb as percentages of the track", () => {
    // Percentages rather than pixels: the filled range follows the value
    // without the Shell needing to know how wide the track ended up.
    const [, range, thumb] = slider(25).props["children"] as Node[];
    expect(range?.props["style"]).toMatchObject({ width: "25%" });
    expect(thumb?.props["style"]).toMatchObject({ left: "25%" });
  });

  it("steps with the arrows and jumps with Home and End", () => {
    const onValueChange = vi.fn();
    const keyDown = slider(50, { onValueChange, step: 5 }).props["onKeyDown"] as (
      event: unknown,
    ) => void;
    const preventDefault = vi.fn();
    keyDown({ key: "ArrowRight", preventDefault });
    expect(onValueChange).toHaveBeenLastCalledWith(55);
    keyDown({ key: "ArrowDown", preventDefault });
    expect(onValueChange).toHaveBeenLastCalledWith(45);
    keyDown({ key: "Home", preventDefault });
    expect(onValueChange).toHaveBeenLastCalledWith(0);
    keyDown({ key: "End", preventDefault });
    expect(onValueChange).toHaveBeenLastCalledWith(100);
  });

  it("does not report a move that would leave the range", () => {
    const onValueChange = vi.fn();
    const keyDown = slider(100, { onValueChange }).props["onKeyDown"] as (event: unknown) => void;
    keyDown({ key: "ArrowRight", preventDefault: vi.fn() });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("attaches no handlers when disabled", () => {
    const disabled = slider(50, { disabled: true });
    expect(disabled.props["onKeyDown"]).toBeUndefined();
    expect(disabled.props["className"]).toContain("pui-slider--disabled");
  });

  it("reports its value to assistive technology", () => {
    const node = slider(42, { semanticLabel: "音量" });
    expect(node.props["semanticRole"]).toBe("slider");
    expect(node.props["semanticValue"]).toBe("42");
    expect(node.props["semanticLabel"]).toBe("音量");
  });
});
