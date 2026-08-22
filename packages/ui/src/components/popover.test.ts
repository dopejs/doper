import { afterEach, describe, expect, it, vi } from "vitest";

import { createOverlayFocus } from "../overlay";
import { setTheme } from "../theme";
import {
  anchorContentDescriptor,
  anchorTriggerDescriptor,
  tooltipDescriptor,
  type AnchorContextValue,
} from "./popover";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> & { className?: string } };

function context(open: boolean, setOpen = vi.fn()): AnchorContextValue {
  return { open, setOpen, focus: createOverlayFocus() };
}

describe("anchored overlay placement", () => {
  const measured = {
    anchorRef: vi.fn(),
    panelRef: vi.fn(),
    style: { left: 12, top: -40, maxHeight: 160, visibility: "visible" as const },
  };

  it("carries no style at all when nothing measured it", () => {
    // The rollback path: with readback off the tree must be what it was before
    // E8, not the same tree carrying neutral values.
    const host = anchorContentDescriptor({ children: "x" }, context(true)) as unknown as Host;
    expect("style" in host.props).toBe(false);
  });

  it("applies the measured placement and still hands the panel to focus", () => {
    const focus = createOverlayFocus();
    const host = anchorContentDescriptor(
      { children: "x" },
      {
        open: true,
        setOpen: vi.fn(),
        focus,
        placement: measured,
      },
    ) as unknown as Host;
    expect(host.props["style"]).toEqual(measured.style);

    // One ref, two consumers: without the fan-out the panel would have to
    // choose between being focusable and being placed.
    const handle = { nodeId: 5, focus: vi.fn() };
    (host.props["ref"] as (value: unknown) => void)(handle);
    expect(measured.panelRef).toHaveBeenCalledWith(handle);
    expect(handle.focus).toHaveBeenCalledOnce();
  });

  it("hides a tooltip whose anchor scrolled away rather than stranding it", () => {
    const hidden = {
      anchorRef: vi.fn(),
      panelRef: vi.fn(),
      style: { left: 0, top: 0, maxHeight: 0, visibility: "hidden" as const },
    };
    const host = tooltipDescriptor(
      { content: "hi", children: "x" },
      true,
      vi.fn(),
      hidden,
    ) as unknown as { props: { children: unknown[] } };
    const panel = host.props.children[1] as Host;
    expect(panel.props["style"]).toEqual(hidden.style);
  });
});

describe("anchored overlays", () => {
  it("renders no content while closed", () => {
    expect(anchorContentDescriptor({ children: "x" }, context(false))).toBeNull();
    expect(anchorContentDescriptor({ children: "x" }, undefined)).toBeNull();
  });

  it("positions the content against the anchor rather than the viewport", () => {
    const node = anchorContentDescriptor({ children: "x" }, context(true)) as unknown as Host;
    // The class carries position:absolute with top:100%; being a child of the
    // anchor is what keeps it pinned while the page scrolls, with no
    // per-frame repositioning.
    expect(node.props.className).toBe("pui-anchor__content");
  });

  it("toggles from the trigger and reports expansion", () => {
    const setOpen = vi.fn();
    const closed = anchorTriggerDescriptor(
      { children: "open" },
      context(false, setOpen),
    ) as unknown as Host;
    expect(closed.props.semanticValue).toBe("collapsed");
    (closed.props.onTap as () => void)();
    expect(setOpen).toHaveBeenLastCalledWith(true);

    const opened = anchorTriggerDescriptor(
      { children: "open" },
      context(true, setOpen),
    ) as unknown as Host;
    expect(opened.props.semanticValue).toBe("expanded");
    (opened.props.onTap as () => void)();
    expect(setOpen).toHaveBeenLastCalledWith(false);
  });

  it("closes the content on Escape and marks it dark", () => {
    const setOpen = vi.fn();
    const node = anchorContentDescriptor(
      { children: "x" },
      context(true, setOpen),
    ) as unknown as Host;
    (
      node.props.onKeyDown as (event: {
        key: string;
        preventDefault: () => void;
        stopPropagation: () => void;
      }) => void
    )({ key: "Escape", preventDefault: () => {}, stopPropagation: () => {} });
    expect(setOpen).toHaveBeenLastCalledWith(false);

    setTheme("dark");
    expect(
      (anchorContentDescriptor({ children: "x" }, context(true)) as unknown as Host).props
        .className,
    ).toBe("pui-anchor__content pui-dark");
  });
});

describe("tooltipDescriptor", () => {
  it("shows its content only while pointed at", () => {
    const setVisible = vi.fn();
    const hidden = tooltipDescriptor(
      { content: "帮助", children: "?" },
      false,
      setVisible,
    ) as unknown as { props: { children: readonly (Host | null)[] } };
    expect(hidden.props.children[1]).toBeNull();

    ((hidden as unknown as Host).props.onPointerEnter as () => void)();
    expect(setVisible).toHaveBeenLastCalledWith(true);
    ((hidden as unknown as Host).props.onPointerLeave as () => void)();
    expect(setVisible).toHaveBeenLastCalledWith(false);

    const shown = tooltipDescriptor(
      { content: "帮助", children: "?" },
      true,
      setVisible,
    ) as unknown as { props: { children: readonly Host[] } };
    expect(shown.props.children[1]?.props.className).toBe(
      "pui-anchor__content pui-tooltip__content",
    );
    expect(shown.props.children[1]?.props.semanticRole).toBe("tooltip");
  });
});
