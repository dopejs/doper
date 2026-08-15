import { describe, expect, it } from "vitest";

import { createElement, isDoperElement, normalizeChildren } from "./element.js";
import { Fragment } from "./types.js";

describe("JSX element protocol", () => {
  it("extracts identity without mutating or leaking key into component props", () => {
    const props = { width: 10, key: "fallback" };
    const element = createElement("container", props, "explicit");
    expect(isDoperElement(element)).toBe(true);
    expect(element.key).toBe("explicit");
    expect(element.props).toEqual({ width: 10 });
    expect(props).toEqual({ width: 10, key: "fallback" });
  });

  it("normalizes nested arrays, fragments, primitives, and placeholders", () => {
    const child = createElement("text", { value: "child" });
    const fragment = createElement(Fragment, {
      children: ["a", false, [2, null, child]],
    });
    expect(normalizeChildren([undefined, fragment, true, 3n])).toEqual(["a", "2", child, "3"]);
  });
});
