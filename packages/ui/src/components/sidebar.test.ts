import { createElement } from "@dopejs/pingo-jsx";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setTheme } from "../theme";
import {
  SidebarItem,
  sidebarDescriptor,
  sidebarItemDescriptor,
  sidebarSectionDescriptor,
  type SidebarContextValue,
} from "./sidebar";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> & { className?: string } };
type Tree = Host & { props: { children: readonly Host[] } };

function context(overrides: Partial<SidebarContextValue> = {}): SidebarContextValue {
  return {
    value: undefined,
    onSelect: () => {},
    registerItem: () => {},
    focusItem: () => {},
    ...overrides,
  };
}

const items = [
  createElement(SidebarItem, { value: "home", label: "首页" }),
  createElement(SidebarItem, { value: "stats", label: "统计" }),
  createElement(SidebarItem, { value: "settings", label: "设置" }),
];

function press(key: string, ctx: SidebarContextValue): void {
  const node = sidebarDescriptor({ children: items }, ctx, "pui-sidebar") as unknown as Host;
  (node.props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
    key,
    preventDefault: () => {},
  });
}

describe("sidebarDescriptor", () => {
  it("moves selection and focus together with the vertical arrows", () => {
    const onSelect = vi.fn();
    const focusItem = vi.fn();

    press("ArrowDown", context({ onSelect, focusItem }));
    expect(onSelect).toHaveBeenLastCalledWith("home");
    // Leaving focus behind would send the next arrow to the old item.
    expect(focusItem).toHaveBeenLastCalledWith("home");

    press("ArrowDown", context({ value: "home", onSelect, focusItem }));
    expect(onSelect).toHaveBeenLastCalledWith("stats");
    press("ArrowUp", context({ value: "home", onSelect, focusItem }));
    expect(onSelect).toHaveBeenLastCalledWith("settings");
    press("Home", context({ value: "stats", onSelect, focusItem }));
    expect(onSelect).toHaveBeenLastCalledWith("home");
    press("End", context({ value: "home", onSelect, focusItem }));
    expect(onSelect).toHaveBeenLastCalledWith("settings");
  });

  it("leaves keys it does not navigate with alone", () => {
    const onSelect = vi.fn();
    for (const key of ["ArrowLeft", "ArrowRight", "Enter", "a"]) {
      press(key, context({ onSelect }));
    }
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("reads as navigation", () => {
    const node = sidebarDescriptor(
      { children: items },
      context(),
      "pui-sidebar",
    ) as unknown as Host;
    expect(node.props.semanticRole).toBe("navigation");
  });
});

describe("sidebar items and sections", () => {
  it("marks the selected entry and reports it to the column", () => {
    const onSelect = vi.fn();
    const node = sidebarItemDescriptor(
      { value: "stats", label: "统计" },
      context({ value: "stats", onSelect }),
    ) as unknown as Host;
    expect(node.props.className).toBe("pui-sidebar__item pui-sidebar__item--active");
    expect(node.props.semanticValue).toBe("selected");
    (node.props.onTap as () => void)();
    expect(onSelect).toHaveBeenCalledWith("stats");
  });

  it("renders an icon slot ahead of the label when given one", () => {
    const withIcon = sidebarItemDescriptor(
      { value: "a", label: "首页", icon: createElement("text", { value: "★" }) },
      context(),
    ) as unknown as Tree;
    expect(withIcon.props.children).toHaveLength(2);
    const bare = sidebarItemDescriptor({ value: "a", label: "首页" }, context()) as unknown as Tree;
    expect(bare.props.children).toHaveLength(1);
  });

  it("gives a section a title only when asked", () => {
    expect(
      (sidebarSectionDescriptor({ children: items }) as unknown as Tree).props.children,
    ).toHaveLength(1);
    const titled = sidebarSectionDescriptor({
      title: "工作区",
      children: items,
    }) as unknown as Tree;
    expect(titled.props.children).toHaveLength(2);
    expect(titled.props.children[0]?.props.className).toBe("pui-sidebar__section-title");
  });

  it("themes the item and the section title", () => {
    setTheme("dark");
    expect(
      (sidebarItemDescriptor({ value: "a", label: "l" }, context()) as unknown as Host).props
        .className,
    ).toBe("pui-sidebar__item pui-dark");
    expect(
      (sidebarSectionDescriptor({ title: "t", children: items }) as unknown as Tree).props
        .children[0]?.props.className,
    ).toBe("pui-sidebar__section-title pui-dark");
  });
});
