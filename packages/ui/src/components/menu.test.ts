import { createElement } from "@dopejs/pingo-jsx";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOverlayFocus } from "../overlay";
import { setTheme } from "../theme";
import {
  DropdownMenuItem,
  menuContentDescriptor,
  menuItemDescriptor,
  menuTriggerDescriptor,
  type MenuContextValue,
} from "./menu";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> & { className?: string } };
type KeyEvent = { key: string; preventDefault: () => void; stopPropagation: () => void };

function context(overrides: Partial<MenuContextValue> = {}): MenuContextValue {
  return {
    open: true,
    setOpen: () => {},
    value: undefined,
    onSelect: () => {},
    active: undefined,
    setActive: () => {},
    focus: createOverlayFocus(),
    registerItem: () => {},
    focusItem: () => {},
    ...overrides,
  };
}

const items = [
  createElement(DropdownMenuItem, { value: "a", children: "甲" }),
  createElement(DropdownMenuItem, { value: "b", children: "乙" }),
  createElement(DropdownMenuItem, { value: "c", children: "丙" }),
];

function press(key: string, ctx: MenuContextValue): void {
  const node = menuContentDescriptor({ children: items }, ctx) as unknown as Host;
  (node.props.onKeyDown as (event: KeyEvent) => void)({
    key,
    preventDefault: () => {},
    stopPropagation: () => {},
  });
}

describe("menuContentDescriptor", () => {
  it("renders nothing while closed", () => {
    expect(menuContentDescriptor({ children: items }, context({ open: false }))).toBeNull();
  });

  it("moves the cursor and focus with the vertical arrows", () => {
    const setActive = vi.fn();
    const focusItem = vi.fn();
    press("ArrowDown", context({ setActive, focusItem }));
    expect(setActive).toHaveBeenLastCalledWith("a");
    // Moving the cursor without moving focus would send the next key to the
    // panel instead of the item.
    expect(focusItem).toHaveBeenLastCalledWith("a");

    press("ArrowDown", context({ active: "a", setActive, focusItem }));
    expect(setActive).toHaveBeenLastCalledWith("b");
    press("ArrowUp", context({ active: "a", setActive, focusItem }));
    expect(setActive).toHaveBeenLastCalledWith("c");
  });

  it("commits the cursor on Enter and Space, and only when there is one", () => {
    const onSelect = vi.fn();
    press("Enter", context({ active: "b", onSelect }));
    expect(onSelect).toHaveBeenLastCalledWith("b");
    press(" ", context({ active: "b", onSelect }));
    expect(onSelect).toHaveBeenCalledTimes(2);

    onSelect.mockClear();
    press("Enter", context({ onSelect }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes on Escape and leaves unrelated keys alone", () => {
    const setOpen = vi.fn();
    press("Escape", context({ setOpen }));
    expect(setOpen).toHaveBeenLastCalledWith(false);

    setOpen.mockClear();
    press("x", context({ setOpen }));
    expect(setOpen).not.toHaveBeenCalled();
  });
});

describe("menu trigger and items", () => {
  it("shows the selected value or a placeholder", () => {
    const empty = menuTriggerDescriptor(
      { placeholder: "选择…" },
      context({ open: false }),
      true,
    ) as unknown as { props: { children: Host } };
    expect(empty.props.children.props.value).toBe("选择…");
    expect(empty.props.children.props.className).toBe("pui-select__placeholder");

    const chosen = menuTriggerDescriptor(
      { placeholder: "选择…" },
      context({ open: false, value: "乙" }),
      true,
    ) as unknown as { props: { children: Host } };
    expect(chosen.props.children.props.value).toBe("乙");
  });

  it("marks the selected item and reports it to the root", () => {
    const onSelect = vi.fn();
    const node = menuItemDescriptor(
      { value: "b", children: "乙" },
      context({ value: "b", onSelect }),
    ) as unknown as Host;
    expect(node.props.className).toBe("pui-menu__item pui-menu__item--active");
    expect(node.props.semanticValue).toBe("selected");
    (node.props.onTap as () => void)();
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("themes the surface and the items", () => {
    setTheme("dark");
    expect(
      (menuContentDescriptor({ children: items }, context()) as unknown as Host).props.className,
    ).toBe("pui-anchor__content pui-menu__content pui-dark");
    expect(
      (menuItemDescriptor({ value: "a", children: "甲" }, context()) as unknown as Host).props
        .className,
    ).toBe("pui-menu__item pui-dark");
  });
});
