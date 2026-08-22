import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { statCardDescriptor } from "./statcard";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> & { className?: string } };
type Tree = Host & { props: { children: readonly Tree[] } };

function card(props: Parameters<typeof statCardDescriptor>[0]): Tree {
  return statCardDescriptor(props) as unknown as Tree;
}

describe("statCardDescriptor", () => {
  it("renders a label, a value, and nothing else by default", () => {
    const node = card({ label: "营收", value: "¥1,240" });
    expect(node.props.semanticLabel).toBe("营收");
    expect(node.props.children).toHaveLength(2);
    expect(node.props.children[1]?.props.children).toHaveLength(1);
  });

  it("colours the delta by trend and leaves flat muted", () => {
    expect(
      card({ label: "l", value: "v", delta: "+12%", trend: "up" }).props.children[1]?.props
        .children[1]?.props.className,
    ).toBe("pui-statcard__delta pui-statcard__delta--up");
    expect(
      card({ label: "l", value: "v", delta: "-3%", trend: "down" }).props.children[1]?.props
        .children[1]?.props.className,
    ).toBe("pui-statcard__delta pui-statcard__delta--down");
    // A flat metric is neither good nor bad, so it picks no direction.
    expect(
      card({ label: "l", value: "v", delta: "0%", trend: "flat" }).props.children[1]?.props
        .children[1]?.props.className,
    ).toBe("pui-statcard__delta");
    expect(
      card({ label: "l", value: "v", delta: "0%" }).props.children[1]?.props.children[1]?.props
        .className,
    ).toBe("pui-statcard__delta");
  });

  it("adds a description row only when given one", () => {
    expect(card({ label: "l", value: "v" }).props.children).toHaveLength(2);
    const described = card({ label: "l", value: "v", description: "同比" });
    expect(described.props.children).toHaveLength(3);
    expect(described.props.children[2]?.props.className).toBe("pui-statcard__description");
  });

  it("themes every muted surface", () => {
    setTheme("dark");
    const node = card({ label: "l", value: "v", delta: "+1%", trend: "up", description: "d" });
    expect(node.props.className).toBe("pui-statcard pui-dark");
    expect(node.props.children[0]?.props.className).toBe("pui-statcard__label pui-dark");
    expect(node.props.children[1]?.props.children[1]?.props.className).toBe(
      "pui-statcard__delta pui-statcard__delta--up pui-dark",
    );
  });
});
