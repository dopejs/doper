import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Input } from "./input";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };

describe("Input", () => {
  it("renders the shell with skin classes and an editable field child", () => {
    const node = Input({ semanticLabel: "邮箱" }) as Host & {
      props: { children: { props: Record<string, unknown> } };
    };
    expect(node.props.className).toBe("pui-input");
    expect(node.props.children.props.className).toBe("pui-input__field");
  });

  it("marks disabled as readOnly with the disabled class", () => {
    const node = Input({ disabled: true }) as Host & {
      props: { children: { props: Record<string, unknown> } };
    };
    expect(node.props.className).toBe("pui-input pui-input--disabled");
    expect(node.props.children.props.readOnly).toBe(true);
  });

  it("appends the dark marker and user className", () => {
    setTheme("dark");
    const node = Input({ className: "mine" }) as Host;
    expect(node.props.className).toBe("pui-input pui-dark mine");
  });

  it("forwards onValueChange through the controller transaction path", () => {
    const node = Input({ onValueChange: () => {} }) as Host & {
      props: { children: { props: Record<string, unknown> } };
    };
    expect(typeof node.props.children.props.onTransaction).toBe("function");
    expect(node.props.children.props.controller).toBeDefined();
  });
});
