import { Text } from "@dopejs/pingo-jsx";
import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { IconButton, type IconButtonProps } from "./icon-button";

afterEach(() => setTheme("light"));

function render(props: IconButtonProps) {
  // Components evaluate to host descriptors without a root.
  return IconButton.component(props) as { type: unknown; props: Record<string, unknown> };
}

const icon = () => Text({ value: "+" });

describe("IconButton", () => {
  it("composes default classes and button semantics", () => {
    const node = render({ icon: icon(), semanticLabel: "Add" });
    expect(node.props.className).toBe("pui-button pui-button--icon pui-button--default");
    expect(node.props.semanticRole).toBe("button");
    expect(node.props.semanticLabel).toBe("Add");
  });

  it("applies variant and size", () => {
    const node = render({
      icon: icon(),
      semanticLabel: "x",
      variant: "ghost",
      size: "lg",
    });
    expect(node.props.className).toBe(
      "pui-button pui-button--icon pui-button--ghost pui-button--lg",
    );
  });

  it("appends the dark marker from the theme signal", () => {
    setTheme("dark");
    const node = render({ icon: icon(), semanticLabel: "x" });
    expect(node.props.className).toBe("pui-button pui-button--icon pui-button--default pui-dark");
  });

  it("disables press handling and marks semanticValue", () => {
    const node = render({ icon: icon(), semanticLabel: "x", disabled: true, className: "mine" });
    expect(node.props.className).toBe(
      "pui-button pui-button--icon pui-button--default pui-button--disabled mine",
    );
    expect(node.props.semanticValue).toBe("disabled");
    expect(node.props.onTap).toBeUndefined();
    expect(node.props.onClick).toBeUndefined();
  });

  it("wires press handlers when enabled", () => {
    const onPress = (): void => {};
    const node = render({ icon: icon(), semanticLabel: "x", onPress });
    expect(node.props.onTap).toBe(onPress);
    expect(typeof node.props.onPointerDown).toBe("function");
  });

  it("passes the icon slot through untouched (slot identity contract)", () => {
    const child = icon();
    const node = render({ icon: child, semanticLabel: "x" });
    expect(node.props.children).toBe(child);
  });
});
