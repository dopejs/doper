import { createElement } from "@dopejs/pingo-jsx";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setTheme } from "../theme";
import { listRowDescriptor } from "./list-row";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> & { className?: string } };
type Tree = Host & { props: { children: readonly Tree[] } };

const badge = createElement("text", { value: "3" });

function row(props: Parameters<typeof listRowDescriptor>[0]): Tree {
  return listRowDescriptor(props) as unknown as Tree;
}

describe("listRowDescriptor", () => {
  it("puts the growing text column between the slots", () => {
    const node = row({ title: "收件箱", leading: badge, trailing: badge });
    expect(node.props.children.map((child) => child.props.className)).toEqual([
      undefined,
      "pui-list-row__text",
      undefined,
    ]);
    // The text column is always present, so the trailing slot ends up on the
    // far edge whatever the title's length.
    expect(node.props.children[1]?.props.children).toHaveLength(1);
  });

  it("adds a description line only when given one", () => {
    expect(row({ title: "t", description: "d" }).props.children[0]?.props.children).toHaveLength(2);
    expect(row({ title: "t" }).props.children[0]?.props.children).toHaveLength(1);
  });

  it("is interactive only when it can act", () => {
    const onPress = vi.fn();
    const live = row({ title: "t", onPress });
    expect(live.props.className).toBe("pui-list-row pui-list-row--interactive");
    expect(live.props.semanticRole).toBe("button");
    (live.props.onTap as () => void)();
    expect(onPress).toHaveBeenCalledOnce();

    // No handler means no interaction, and it reads as a plain list item.
    const inert = row({ title: "t" });
    expect(inert.props.className).toBe("pui-list-row");
    expect(inert.props.semanticRole).toBe("listitem");
    expect(inert.props.onTap).toBeUndefined();
  });

  it("carries no handlers at all while disabled", () => {
    const onPress = vi.fn();
    const node = row({ title: "t", onPress, disabled: true });
    expect(node.props.className).toBe("pui-list-row pui-list-row--disabled");
    // Nothing to fire beats a handler that decides not to.
    expect(node.props.onTap).toBeUndefined();
    expect(node.props.onPointerDown).toBeUndefined();
    expect(onPress).not.toHaveBeenCalled();
  });

  it("reports selection only when the caller tracks it", () => {
    expect(row({ title: "t" }).props.semanticValue).toBeUndefined();
    const selected = row({ title: "t", selected: true });
    expect(selected.props.className).toBe("pui-list-row pui-list-row--selected");
    expect(selected.props.semanticValue).toBe("selected");
    expect(row({ title: "t", selected: false }).props.semanticValue).toBe("unselected");
  });

  it("themes the row and its description", () => {
    setTheme("dark");
    const node = row({ title: "t", description: "d" });
    expect(node.props.className).toBe("pui-list-row pui-dark");
    expect(node.props.children[0]?.props.children[1]?.props.className).toBe(
      "pui-list-row__description pui-dark",
    );
  });
});
