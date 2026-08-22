import { describe, expect, it, vi } from "vitest";

import { menubarMenuDescriptor, type MenubarContextValue } from "./menubar";

type Node = { readonly props: Record<string, unknown> };

function context(open: string | undefined, overrides: Partial<MenubarContextValue> = {}) {
  return {
    open,
    setOpen: vi.fn(),
    registerMenu: vi.fn(),
    focusMenu: vi.fn(),
    ...overrides,
  } satisfies MenubarContextValue;
}

function parts(open: string | undefined, value = "file"): { trigger: Node; content: Node | null } {
  const node = menubarMenuDescriptor(
    { value, label: "文件", children: null },
    context(open),
  ) as unknown as Node;
  const [trigger, content] = node.props["children"] as [Node, Node | null];
  return { trigger, content };
}

describe("menubarMenuDescriptor", () => {
  it("renders its list only while it holds the bar's open slot", () => {
    expect(parts(undefined).content).toBeNull();
    expect(parts("file").content).not.toBeNull();
    // Another menu holding the slot closes this one: the bar has one at a time.
    expect(parts("edit").content).toBeNull();
  });

  it("reports expansion to assistive technology", () => {
    expect(parts("file").trigger.props["semanticValue"]).toBe("expanded");
    expect(parts(undefined).trigger.props["semanticValue"]).toBe("collapsed");
  });

  it("opens on Enter, Space and ArrowDown but claims nothing else", () => {
    const setOpen = vi.fn();
    const node = menubarMenuDescriptor(
      { value: "file", label: "文件", children: null },
      context(undefined, { setOpen }),
    ) as unknown as Node;
    const trigger = (node.props["children"] as Node[])[0];
    const keyDown = trigger?.props["onKeyDown"] as (event: unknown) => void;

    for (const key of ["Enter", " ", "ArrowDown"]) {
      const preventDefault = vi.fn();
      keyDown({ key, preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    expect(setOpen).toHaveBeenCalledTimes(3);

    const ignored = vi.fn();
    keyDown({ key: "ArrowLeft", preventDefault: ignored });
    // Left and Right belong to the bar, which handles them as the event
    // bubbles; claiming them here would stop the bar from ever seeing them.
    expect(ignored).not.toHaveBeenCalled();
    expect(setOpen).toHaveBeenCalledTimes(3);
  });

  it("toggles closed when its own trigger is pressed again", () => {
    const setOpen = vi.fn();
    const node = menubarMenuDescriptor(
      { value: "file", label: "文件", children: null },
      context("file", { setOpen }),
    ) as unknown as Node;
    const trigger = (node.props["children"] as Node[])[0];
    (trigger?.props["onTap"] as () => void)();
    expect(setOpen).toHaveBeenCalledWith(undefined);
  });

  it("registers its trigger so the bar can move focus to it", () => {
    const registerMenu = vi.fn();
    const node = menubarMenuDescriptor(
      { value: "file", label: "文件", children: null },
      context(undefined, { registerMenu }),
    ) as unknown as Node;
    const trigger = (node.props["children"] as Node[])[0];
    (trigger?.props["ref"] as (handle: unknown) => void)({ focus: vi.fn() });
    expect(registerMenu).toHaveBeenCalledWith("file", expect.anything());
  });

  it("renders standalone when no bar is above it", () => {
    const node = menubarMenuDescriptor(
      { value: "file", label: "文件", children: null },
      undefined,
    ) as unknown as Node;
    expect((node.props["children"] as Node[])[1]).toBeNull();
  });
});
