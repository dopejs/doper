import { afterEach, describe, expect, it, vi } from "vitest";

import { setTheme } from "../theme";
import { commandDescriptor, filterCommandItems } from "./command";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> & { className?: string } };
type Tree = Host & { props: { children: readonly Host[] } };

const items = [
  { value: "open", label: "Open file" },
  { value: "save", label: "Save file" },
  { value: "quit", label: "Quit" },
];

function actions() {
  return {
    setQuery: vi.fn(),
    setActive: vi.fn(),
    focusItem: vi.fn(),
    registerItem: vi.fn(),
  };
}

function tree(query: string, active: string | undefined, handlers = actions()) {
  return {
    node: commandDescriptor(
      { items, onSelect: handlers.setQuery },
      query,
      active,
      handlers,
    ) as unknown as Tree,
    handlers,
  };
}

describe("filterCommandItems", () => {
  it("matches case-insensitively on the label and keeps order", () => {
    expect(filterCommandItems(items, "file").map((item) => item.value)).toEqual(["open", "save"]);
    expect(filterCommandItems(items, "  QUIT ").map((item) => item.value)).toEqual(["quit"]);
    expect(filterCommandItems(items, "")).toHaveLength(3);
    expect(filterCommandItems(items, "zzz")).toHaveLength(0);
  });
});

describe("commandDescriptor", () => {
  it("lists an input and one row per surviving item", () => {
    const { node } = tree("file", undefined);
    // First child is the input; the rest are rows.
    expect(node.props.children).toHaveLength(3);
    expect(node.props.children.slice(1).map((child) => child.props.className)).toEqual([
      "pui-menu__item",
      "pui-menu__item",
    ]);
  });

  it("shows the empty label when nothing matches", () => {
    const { node } = tree("zzz", undefined);
    expect(node.props.children).toHaveLength(2);
    expect(node.props.children[1]?.props.value).toBe("无结果");
  });

  it("moves the cursor with the arrows over the filtered list only", () => {
    const { node, handlers } = tree("file", undefined);
    const keyDown = node.props.onKeyDown as (event: {
      key: string;
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => void;

    keyDown({ key: "ArrowDown", preventDefault: () => {}, stopPropagation: () => {} });
    expect(handlers.setActive).toHaveBeenLastCalledWith("open");
    expect(handlers.focusItem).toHaveBeenLastCalledWith("open");

    // "quit" was filtered out, so wrapping cannot reach it.
    const second = tree("file", "save");
    (
      second.node.props.onKeyDown as (event: {
        key: string;
        preventDefault: () => void;
        stopPropagation: () => void;
      }) => void
    )({ key: "ArrowDown", preventDefault: () => {}, stopPropagation: () => {} });
    expect(second.handlers.setActive).toHaveBeenLastCalledWith("open");
  });

  it("commits the cursor on Enter and only when there is one", () => {
    const onSelect = vi.fn();
    const handlers = actions();
    const node = commandDescriptor({ items, onSelect }, "", "save", handlers) as unknown as Tree;
    (
      node.props.onKeyDown as (event: {
        key: string;
        preventDefault: () => void;
        stopPropagation: () => void;
      }) => void
    )({ key: "Enter", preventDefault: () => {}, stopPropagation: () => {} });
    expect(onSelect).toHaveBeenCalledWith("save");

    onSelect.mockClear();
    const empty = commandDescriptor(
      { items, onSelect },
      "",
      undefined,
      handlers,
    ) as unknown as Tree;
    (
      empty.props.onKeyDown as (event: {
        key: string;
        preventDefault: () => void;
        stopPropagation: () => void;
      }) => void
    )({ key: "Enter", preventDefault: () => {}, stopPropagation: () => {} });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clears the cursor when the query changes, so Enter cannot fire a filtered row", () => {
    const { node, handlers } = tree("", "quit");
    const input = node.props.children[0] as unknown as {
      props: { onValueChange: (value: string) => void };
    };
    input.props.onValueChange("file");
    expect(handlers.setActive).toHaveBeenLastCalledWith(undefined);
  });

  it("themes the palette", () => {
    setTheme("dark");
    expect(tree("", undefined).node.props.className).toBe("pui-command pui-dark");
  });
});
