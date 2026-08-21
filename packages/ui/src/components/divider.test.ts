import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Divider, type DividerProps } from "./divider";

afterEach(() => setTheme("light"));

function render(props: DividerProps) {
  return Divider.component(props) as { type: unknown; props: Record<string, unknown> };
}

describe("Divider", () => {
  it("composes horizontal default classes", () => {
    expect(render({}).props.className).toBe("pui-divider");
  });

  it("applies the vertical modifier", () => {
    expect(render({ orientation: "vertical" }).props.className).toBe(
      "pui-divider pui-divider--vertical",
    );
  });

  it("appends the dark marker from the theme signal", () => {
    setTheme("dark");
    expect(render({}).props.className).toBe("pui-divider pui-dark");
  });

  it("appends user className last", () => {
    setTheme("dark");
    expect(render({ orientation: "vertical", className: "mine" }).props.className).toBe(
      "pui-divider pui-divider--vertical pui-dark mine",
    );
  });
});
