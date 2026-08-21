import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Badge } from "./badge";

afterEach(() => setTheme("light"));

describe("Badge", () => {
  it("composes default variant classes", () => {
    const node = Badge({ children: "Beta" }) as { props: Record<string, unknown> };
    expect(node.props.className).toBe("pui-badge pui-badge--default");
  });

  it("supports variants and dark theme", () => {
    setTheme("dark");
    const node = Badge({ children: "x", variant: "outline" }) as {
      props: Record<string, unknown>;
    };
    expect(node.props.className).toBe("pui-badge pui-badge--outline pui-dark");
  });

  it("appends user className last", () => {
    const node = Badge({ children: "x", className: "mine" }) as {
      props: Record<string, unknown>;
    };
    expect(node.props.className).toBe("pui-badge pui-badge--default mine");
  });
});
