import { describe, expect, it, vi } from "vitest";

import { contextMenuDescriptor, type ContextMenuOrigin } from "./context-menu";

type Node = { readonly props: Record<string, unknown> };

const items = [
  { value: "copy", label: "复制" },
  { value: "paste", label: "粘贴", disabled: true },
  { value: "delete", label: "删除" },
];

function menu(
  origin: ContextMenuOrigin | undefined,
  overrides: { readonly onSelect?: (value: string) => void; readonly active?: string } = {},
) {
  const state = {
    origin,
    active: overrides.active,
    open: vi.fn(),
    close: vi.fn(),
    setActive: vi.fn(),
  };
  const node = contextMenuDescriptor(
    {
      children: null,
      items,
      ...(overrides.onSelect === undefined ? {} : { onSelect: overrides.onSelect }),
    },
    state,
  ) as unknown as Node;
  const content = (node.props["children"] as (Node | null)[])[1];
  return { node, state, content };
}

describe("contextMenuDescriptor", () => {
  it("opens at the press position, not at the trigger's corner", () => {
    // A context menu that ignores where the pointer was is a dropdown.
    const { node, state } = menu(undefined);
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    (node.props["onContextMenu"] as (event: unknown) => void)({
      x: 42,
      y: 84,
      preventDefault,
      stopPropagation,
    });
    expect(state.open).toHaveBeenCalledWith({ x: 42, y: 84 });
    expect(preventDefault).toHaveBeenCalledOnce();
    // Stopping propagation lets a nested menu win over an outer one.
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it("renders nothing until it has been opened", () => {
    expect(menu(undefined).content).toBeNull();
    expect(menu({ x: 1, y: 2 }).content).not.toBeNull();
  });

  it("places the panel at the recorded origin", () => {
    expect(menu({ x: 12, y: 34 }).content?.props["style"]).toMatchObject({ left: 12, top: 34 });
  });

  it("gives a disabled entry no handlers and skips it when moving", () => {
    const { content, state } = menu({ x: 0, y: 0 });
    const entries = content?.props["children"] as Node[];
    expect(entries[1]?.props["onTap"]).toBeUndefined();

    const keyDown = content?.props["onKeyDown"] as (event: unknown) => void;
    keyDown({ key: "ArrowDown", preventDefault: vi.fn() });
    // From nothing active, Down lands on the first enabled entry, and paste is
    // never a destination because it was filtered out of the value list.
    expect(state.setActive).toHaveBeenCalledWith("copy");
  });

  it("closes on Escape and on choosing", () => {
    const onSelect = vi.fn();
    const { content, state } = menu({ x: 0, y: 0 }, { onSelect });
    const entries = content?.props["children"] as Node[];
    (entries[0]?.props["onTap"] as () => void)();
    expect(onSelect).toHaveBeenCalledWith("copy");
    expect(state.close).toHaveBeenCalledOnce();

    const preventDefault = vi.fn();
    (content?.props["onKeyDown"] as (event: unknown) => void)({
      key: "Escape",
      preventDefault,
      stopPropagation: vi.fn(),
    });
    expect(state.close).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("carries menu semantics", () => {
    const { content } = menu({ x: 0, y: 0 });
    expect(content?.props["semanticRole"]).toBe("menu");
    expect((content?.props["children"] as Node[])[0]?.props["semanticRole"]).toBe("menuitem");
  });
});
