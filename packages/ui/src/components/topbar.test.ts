import { createElement } from "@dopejs/pingo-jsx";
import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { topBarDescriptor } from "./topbar";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> & { className?: string } };
type Tree = Host & { props: { children: readonly Host[] } };

const icon = createElement("text", { value: "★" });

describe("topBarDescriptor", () => {
  it("puts the growing title column between the slots", () => {
    const node = topBarDescriptor({
      title: "仪表盘",
      leading: icon,
      actions: icon,
    }) as unknown as Tree;
    expect(node.props.semanticRole).toBe("banner");
    expect(node.props.children.map((child) => child.props.className)).toEqual([
      undefined,
      "pui-topbar__title",
      "pui-topbar__actions",
    ]);
    expect(node.props.children[1]?.props.value).toBe("仪表盘");
  });

  it("keeps the growing column even with no title, so actions still sit at the edge", () => {
    const node = topBarDescriptor({ actions: icon }) as unknown as Tree;
    expect(node.props.children).toHaveLength(2);
    // A View rather than Text: there is nothing to say, only room to take.
    expect(node.props.children[0]?.props.className).toBe("pui-topbar__title");
    expect(node.props.children[0]?.props.value).toBeUndefined();
  });

  it("omits the slots it was not given", () => {
    const node = topBarDescriptor({ title: "标题" }) as unknown as Tree;
    expect(node.props.children).toHaveLength(1);
  });

  it("themes the bar and appends the caller class last", () => {
    setTheme("dark");
    expect((topBarDescriptor({ className: "mine" }) as unknown as Host).props.className).toBe(
      "pui-topbar pui-dark mine",
    );
  });
});
