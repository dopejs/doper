import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Progress, type ProgressProps } from "./progress";

afterEach(() => setTheme("light"));

type Host = { type: unknown; props: Record<string, unknown> };

function render(props: ProgressProps) {
  // Components evaluate to host descriptors without a root.
  return Progress.component(props) as Host;
}

describe("Progress", () => {
  it("renders the indicator at the value percentage", () => {
    const node = render({ value: 50 });
    expect(node.props.className).toBe("pui-progress");
    const indicator = node.props.children as Host;
    expect(indicator.props.className).toBe("pui-progress__indicator");
    expect(indicator.props.style).toEqual({ width: "50%" });
  });

  it("clamps out-of-range values to 0..100", () => {
    expect((render({ value: 150 }).props.children as Host).props.style).toEqual({
      width: "100%",
    });
    expect((render({ value: -5 }).props.children as Host).props.style).toEqual({
      width: "0%",
    });
  });

  it("respects max", () => {
    expect((render({ value: 50, max: 200 }).props.children as Host).props.style).toEqual({
      width: "25%",
    });
  });

  it("guards a non-positive max against NaN width", () => {
    expect((render({ value: 0, max: 0 }).props.children as Host).props.style).toEqual({
      width: "0%",
    });
  });

  it("appends dark markers from the theme signal", () => {
    setTheme("dark");
    const node = render({ value: 50 });
    expect(node.props.className).toBe("pui-progress pui-dark");
    expect((node.props.children as Host).props.className).toBe("pui-progress__indicator pui-dark");
  });

  it("appends user className last", () => {
    expect(render({ value: 50, className: "mine" }).props.className).toBe("pui-progress mine");
  });
});
