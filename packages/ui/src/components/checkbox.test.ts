import { afterEach, describe, expect, it, vi } from "vitest";

import { setTheme } from "../theme";
import { Checkbox, type CheckboxProps } from "./checkbox";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };
type Tree = { props: Record<string, unknown> & { children: unknown } };

function render(props: CheckboxProps): Tree {
  return Checkbox.component(props) as unknown as Tree;
}

describe("Checkbox", () => {
  it("renders unchecked with box and no indicator", () => {
    const node = render({ checked: false });
    expect(node.props.className).toBe("pui-checkbox");
    expect(node.props.semanticRole).toBe("checkbox");
    expect(node.props.semanticValue).toBe("unchecked");
    const [box] = node.props.children as [Host];
    expect(box.props.className).toBe("pui-checkbox__box");
    expect(box.props.children ?? null).toBeNull();
  });

  it("renders the check indicator when checked", () => {
    const node = render({ checked: true });
    expect(node.props.semanticValue).toBe("checked");
    const [box] = node.props.children as [Host];
    expect(box.props.className).toBe("pui-checkbox__box pui-checkbox__box--checked");
    const indicator = box.props.children as Host;
    expect(indicator.props.className).toBe("pui-checkbox__indicator");
    expect(indicator.props.value).toBe("✓");
  });

  it("renders the optional label text", () => {
    const node = render({ checked: false, label: "接受协议" });
    const [, label] = node.props.children as [Host, Host];
    expect(label.props.className).toBe("pui-label pui-checkbox__label");
    expect(label.props.value).toBe("接受协议");
  });

  it("forwards the negated checked value on tap", () => {
    const onCheckedChange = vi.fn();
    const node = render({ checked: true, onCheckedChange });
    (node.props.onTap as () => void)();
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("omits handlers and reports disabled state when disabled", () => {
    const node = render({ checked: false, disabled: true, onCheckedChange: () => {} });
    expect(node.props.className).toBe("pui-checkbox pui-checkbox--disabled");
    expect(node.props.semanticValue).toBe("disabled");
    expect(node.props.onTap).toBeUndefined();
    expect(node.props.onPointerDown).toBeUndefined();
  });

  it("appends dark markers and keeps the user className last", () => {
    setTheme("dark");
    const node = render({ checked: true, label: "L", className: "mine" });
    expect(node.props.className).toBe("pui-checkbox pui-dark mine");
    const [box, label] = node.props.children as [Host, Host];
    expect(box.props.className).toBe("pui-checkbox__box pui-checkbox__box--checked pui-dark");
    expect((box.props.children as Host).props.className).toBe("pui-checkbox__indicator pui-dark");
    expect(label.props.className).toBe("pui-label pui-checkbox__label pui-dark");
  });
});
