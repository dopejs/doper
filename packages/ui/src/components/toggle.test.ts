import { describe, expect, it, vi } from "vitest";

import {
  toggleDescriptor,
  toggleGroupItemDescriptor,
  type ToggleGroupContextValue,
} from "./toggle";

type Node = { readonly props: Record<string, unknown> };

function node(value: unknown): Node {
  return value as Node;
}

describe("toggleDescriptor", () => {
  it("reports its state and flips it on press", () => {
    const onPressedChange = vi.fn();
    const off = node(toggleDescriptor({ children: "B", onPressedChange }, false));
    expect(off.props["semanticValue"]).toBe("off");
    expect(off.props["className"]).not.toContain("pui-toggle--on");
    (off.props["onTap"] as () => void)();
    expect(onPressedChange).toHaveBeenCalledWith(true);

    const on = node(toggleDescriptor({ children: "B", onPressedChange }, true));
    expect(on.props["semanticValue"]).toBe("on");
    (on.props["onTap"] as () => void)();
    expect(onPressedChange).toHaveBeenLastCalledWith(false);
  });

  it("responds to Enter and Space but claims nothing else", () => {
    const onPressedChange = vi.fn();
    const keyDown = node(toggleDescriptor({ children: "B", onPressedChange }, false)).props[
      "onKeyDown"
    ] as (event: unknown) => void;
    for (const key of ["Enter", " "]) {
      const preventDefault = vi.fn();
      keyDown({ key, preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    const ignored = vi.fn();
    keyDown({ key: "a", preventDefault: ignored });
    expect(ignored).not.toHaveBeenCalled();
    expect(onPressedChange).toHaveBeenCalledTimes(2);
  });

  it("attaches no handlers when disabled", () => {
    const disabled = node(toggleDescriptor({ children: "B", disabled: true }, false));
    for (const handler of ["onTap", "onClick", "onKeyDown", "onPointerDown"]) {
      expect(disabled.props[handler]).toBeUndefined();
    }
  });
});

describe("toggleGroupItemDescriptor", () => {
  function context(value: readonly string[], onToggle = vi.fn()): ToggleGroupContextValue {
    return { value, onToggle, registerItem: vi.fn(), focusItem: vi.fn() };
  }

  it("derives its pressed state from the group's value", () => {
    expect(
      node(toggleGroupItemDescriptor({ value: "a", children: "A" }, context(["a"]))).props[
        "semanticValue"
      ],
    ).toBe("on");
    expect(
      node(toggleGroupItemDescriptor({ value: "a", children: "A" }, context(["b"]))).props[
        "semanticValue"
      ],
    ).toBe("off");
  });

  it("asks the group to toggle rather than deciding for itself", () => {
    // The item cannot know whether the group is single or multiple, so it
    // reports the press and lets the group apply its own rule.
    const onToggle = vi.fn();
    const item = node(
      toggleGroupItemDescriptor({ value: "a", children: "A" }, context([], onToggle)),
    );
    (item.props["onTap"] as () => void)();
    expect(onToggle).toHaveBeenCalledWith("a");
  });

  it("renders standalone when no group is above it", () => {
    expect(
      node(toggleGroupItemDescriptor({ value: "a", children: "A" }, undefined)).props[
        "semanticValue"
      ],
    ).toBe("off");
  });
});
