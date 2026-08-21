import { afterEach, describe, expect, it, vi } from "vitest";

import { setTheme } from "../theme";
import { Switch, type SwitchProps } from "./switch";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };
type Tree = Host & { props: { children: Host } };

function render(props: SwitchProps): Tree {
  return Switch.component(props) as unknown as Tree;
}

describe("Switch", () => {
  it("renders the track with skin classes, switch role, and off state", () => {
    const node = render({ checked: false });
    expect(node.props.className).toBe("pui-switch");
    expect(node.props.semanticRole).toBe("switch");
    expect(node.props.semanticValue).toBe("off");
    expect(node.props.children.props.className).toBe("pui-switch__thumb");
  });

  it("adds checked classes and reports the on state", () => {
    const node = render({ checked: true });
    expect(node.props.className).toBe("pui-switch pui-switch--checked");
    expect(node.props.semanticValue).toBe("on");
    expect(node.props.children.props.className).toBe(
      "pui-switch__thumb pui-switch__thumb--checked",
    );
  });

  it("forwards the negated checked value on tap and click", () => {
    const onCheckedChange = vi.fn();
    const node = render({ checked: false, onCheckedChange });
    (node.props.onTap as () => void)();
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    (node.props.onClick as () => void)();
    expect(onCheckedChange).toHaveBeenCalledTimes(2);
  });

  it("omits interaction handlers when disabled and reports disabled state", () => {
    const node = render({ checked: true, disabled: true, onCheckedChange: () => {} });
    expect(node.props.className).toBe("pui-switch pui-switch--checked pui-switch--disabled");
    expect(node.props.semanticValue).toBe("disabled");
    expect(node.props.onTap).toBeUndefined();
    expect(node.props.onClick).toBeUndefined();
    expect(node.props.onPointerDown).toBeUndefined();
  });

  it("appends the dark marker to track and thumb", () => {
    setTheme("dark");
    const node = render({ checked: true });
    expect(node.props.className).toBe("pui-switch pui-switch--checked pui-dark");
    expect(node.props.children.props.className).toBe(
      "pui-switch__thumb pui-switch__thumb--checked pui-dark",
    );
  });

  it("keeps the user className last", () => {
    const node = render({ checked: false, className: "mine" });
    expect(node.props.className).toBe("pui-switch mine");
  });
});
