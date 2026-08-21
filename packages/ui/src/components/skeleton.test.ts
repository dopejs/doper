import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Skeleton, type SkeletonProps } from "./skeleton";

afterEach(() => setTheme("light"));

function render(props: SkeletonProps) {
  return Skeleton.component(props) as { type: unknown; props: Record<string, unknown> };
}

describe("Skeleton", () => {
  it("composes default classes", () => {
    const node = render({});
    expect(node.props.className).toBe("pui-skeleton");
    expect(node.props.width).toBeUndefined();
    expect(node.props.height).toBeUndefined();
  });

  it("passes width and height through as direct props", () => {
    const node = render({ width: 120, height: 16 });
    expect(node.props.width).toBe(120);
    expect(node.props.height).toBe(16);
  });

  it("appends the dark marker from the theme signal", () => {
    setTheme("dark");
    expect(render({}).props.className).toBe("pui-skeleton pui-dark");
  });

  it("appends user className last", () => {
    setTheme("dark");
    expect(render({ className: "mine" }).props.className).toBe("pui-skeleton pui-dark mine");
  });
});
