import { describe, expect, it, vi } from "vitest";

import { classes, createOverlayFocus, escapeHandler } from "./overlay";

function handle(focus: () => void): { focus: () => void } {
  return { focus };
}

describe("createOverlayFocus", () => {
  it("focuses the panel on mount and gives focus back on unmount", () => {
    const triggerFocus = vi.fn();
    const panelFocus = vi.fn();
    const focus = createOverlayFocus();

    focus.trigger(handle(triggerFocus) as never);
    focus.panel(handle(panelFocus) as never);
    expect(panelFocus).toHaveBeenCalledOnce();
    expect(triggerFocus).not.toHaveBeenCalled();

    // Unmounting the panel hands focus back, or the next key reaches nothing.
    focus.panel(null);
    expect(triggerFocus).toHaveBeenCalledOnce();
  });

  it("survives a panel that closes before anything registered a trigger", () => {
    const focus = createOverlayFocus();
    expect(() => focus.panel(null)).not.toThrow();
  });
});

describe("escapeHandler", () => {
  it("claims Escape and leaves every other key alone", () => {
    const close = vi.fn();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const handler = escapeHandler(close);

    handler({ key: "Escape", preventDefault, stopPropagation } as never);
    expect(close).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();

    for (const key of ["Enter", " ", "a", "ArrowDown"]) {
      handler({ key, preventDefault, stopPropagation } as never);
    }
    expect(close).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

describe("classes", () => {
  it("drops empty and undefined parts", () => {
    expect(classes("a", undefined, "", "b")).toBe("a b");
    expect(classes(undefined)).toBe("");
  });
});
