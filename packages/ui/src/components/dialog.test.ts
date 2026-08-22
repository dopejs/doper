import { afterEach, describe, expect, it, vi } from "vitest";

import { createOverlayFocus } from "../overlay";
import { setTheme } from "../theme";
import { dialogDescriptor } from "./dialog";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> & { className?: string } };
type Tree = Host & { props: { children: readonly Host[] } };

function dialog(open: boolean, onOpenChange = vi.fn()): Tree | null {
  return dialogDescriptor(
    { open, onOpenChange, children: "body" },
    createOverlayFocus(),
  ) as unknown as Tree | null;
}

describe("dialogDescriptor", () => {
  it("renders nothing at all while closed", () => {
    expect(dialog(false)).toBeNull();
  });

  it("draws the panel over the backdrop", () => {
    const node = dialog(true);
    expect(node?.props.className).toBe("pui-overlay");
    // Order is the stacking: the backdrop is emitted first so the panel is
    // painted over it.
    expect(node?.props.children.map((child) => child.props.className)).toEqual([
      "pui-overlay__backdrop",
      "pui-overlay__panel",
    ]);
    expect(node?.props.semanticRole).toBe("dialog");
  });

  it("closes on the backdrop and on Escape, and ignores other keys", () => {
    const onOpenChange = vi.fn();
    const node = dialog(true, onOpenChange);
    const [backdrop, panel] = node?.props.children ?? [];

    (backdrop?.props.onTap as () => void)();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    const keyDown = panel?.props.onKeyDown as (event: {
      key: string;
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => void;
    keyDown({ key: "Enter", preventDefault: () => {}, stopPropagation: () => {} });
    expect(onOpenChange).toHaveBeenCalledOnce();
    keyDown({ key: "Escape", preventDefault: () => {}, stopPropagation: () => {} });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("takes focus as the panel mounts so Escape can reach it", () => {
    const focus = vi.fn();
    const node = dialog(true);
    (node?.props.children[1]?.props.ref as (handle: unknown) => void)({ focus });
    expect(focus).toHaveBeenCalledOnce();
  });

  it("marks the panel dark and pins a sheet to its side", () => {
    setTheme("dark");
    expect(dialog(true)?.props.children[1]?.props.className).toBe("pui-overlay__panel pui-dark");
    setTheme("light");

    const sheet = dialogDescriptor(
      { open: true, children: "body" },
      createOverlayFocus(),
      "sheet",
      "right",
    ) as unknown as Tree;
    expect(sheet.props.className).toBe("pui-overlay pui-overlay--sheet");
    expect(sheet.props.children[1]?.props.className).toBe(
      "pui-overlay__panel pui-sheet__panel pui-sheet__panel--right",
    );
  });
});

describe("sheet sides", () => {
  it("gives every side its own modifier, because they differ in axis", () => {
    // A bottom drawer is full width and fixed height; a right sheet is the
    // transpose. Only marking the non-default side would leave the two
    // horizontal edges sharing the vertical geometry.
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const node = dialogDescriptor(
        { open: true, children: null },
        createOverlayFocus(),
        "sheet",
        side,
      );
      const panel = (node as { props: { children: unknown[] } }).props.children[1] as {
        props: { className: string };
      };
      expect(panel.props.className).toContain(`pui-sheet__panel--${side}`);
    }
  });
});
