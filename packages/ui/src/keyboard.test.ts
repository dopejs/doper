import { createElement } from "@dopejs/pingo-jsx";
import { describe, expect, it } from "vitest";

import { orderedValues, step } from "./keyboard";

const Item = (props: { readonly value: string }): string => props.value;

describe("orderedValues", () => {
  it("reads declared values from children in document order", () => {
    expect(
      orderedValues([
        createElement(Item, { value: "a" }),
        createElement(Item, { value: "b" }),
        createElement(Item, { value: "c" }),
      ]),
    ).toEqual(["a", "b", "c"]);
  });

  it("flattens nested arrays and skips anything without a string value", () => {
    expect(
      orderedValues([
        "text",
        null,
        [createElement(Item, { value: "a" }), createElement(Item, { value: "b" })],
        createElement(Item, { value: 7 as unknown as string }),
      ]),
    ).toEqual(["a", "b"]);
  });
});

describe("step", () => {
  const values = ["a", "b", "c"];

  it("wraps in both directions", () => {
    expect(step(values, "c", "ArrowRight", "horizontal")).toBe("a");
    expect(step(values, "a", "ArrowLeft", "horizontal")).toBe("c");
    expect(step(values, "c", "ArrowDown", "vertical")).toBe("a");
    expect(step(values, "a", "ArrowUp", "vertical")).toBe("c");
  });

  it("honours the axis so an unrelated arrow is left alone", () => {
    expect(step(values, "a", "ArrowDown", "horizontal")).toBeUndefined();
    expect(step(values, "a", "ArrowRight", "vertical")).toBeUndefined();
    expect(step(values, "a", "ArrowRight", "both")).toBe("b");
    expect(step(values, "a", "ArrowDown", "both")).toBe("b");
  });

  it("jumps to the ends", () => {
    expect(step(values, "b", "Home", "horizontal")).toBe("a");
    expect(step(values, "b", "End", "horizontal")).toBe("c");
  });

  it("starts from the end the press implies when nothing is selected", () => {
    expect(step(values, undefined, "ArrowRight", "horizontal")).toBe("a");
    expect(step(values, undefined, "ArrowLeft", "horizontal")).toBe("c");
    expect(step(values, "missing", "ArrowRight", "horizontal")).toBe("a");
  });

  it("returns nothing for an empty group or a key that is not navigation", () => {
    expect(step([], "a", "ArrowRight", "both")).toBeUndefined();
    expect(step(values, "a", "Enter", "both")).toBeUndefined();
    expect(step(values, "a", "x", "both")).toBeUndefined();
  });
});
