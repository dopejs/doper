import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Label } from "./label";

afterEach(() => setTheme("light"));

describe("Label", () => {
  it("renders label text with skin class", () => {
    const node = Label({ children: "用户名" }) as { props: Record<string, unknown> };
    expect(node.props.className).toBe("pui-label");
    expect(node.props.value).toBe("用户名");
  });

  it("appends dark marker and user className", () => {
    setTheme("dark");
    const node = Label({ children: "x", className: "mine" }) as {
      props: Record<string, unknown>;
    };
    expect(node.props.className).toBe("pui-label pui-dark mine");
  });
});
