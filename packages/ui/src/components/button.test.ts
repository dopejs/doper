import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Button, type ButtonProps } from "./button";

afterEach(() => setTheme("light"));

function render(props: ButtonProps) {
  // Components evaluate to host descriptors without a root.
  return Button.component(props) as { type: unknown; props: Record<string, unknown> };
}

describe("Button", () => {
  it("composes default classes and button semantics", () => {
    const node = render({ children: "保存", onPress: () => {} });
    expect(node.props.className).toBe("pui-button pui-button--default");
    expect(node.props.semanticRole).toBe("button");
    expect(node.props.semanticLabel).toBe("保存");
  });

  it("applies variant and size", () => {
    const node = render({ children: "x", variant: "secondary", size: "sm" });
    expect(node.props.className).toBe("pui-button pui-button--secondary pui-button--sm");
  });

  it("appends the dark marker from the theme signal", () => {
    setTheme("dark");
    const node = render({ children: "x" });
    expect(node.props.className).toBe("pui-button pui-button--default pui-dark");
  });

  it("appends user className last and marks disabled", () => {
    const node = render({ children: "x", disabled: true, className: "mine" });
    expect(node.props.className).toBe(
      "pui-button pui-button--default pui-button--disabled mine",
    );
    expect(node.props.semanticValue).toBe("disabled");
    expect(node.props.onTap).toBeUndefined();
    expect(node.props.onClick).toBeUndefined();
  });

  it("wires press handlers when enabled", () => {
    const onPress = (): void => {};
    const node = render({ children: "x", onPress });
    expect(node.props.onTap).toBe(onPress);
    expect(typeof node.props.onPointerDown).toBe("function");
  });
});
