import { describe, expect, it } from "vitest";

import { createElement } from "./element";
import { isMemoComponent, memo, shallowEqual } from "./memo";

const Component = (props: { readonly label: string }): string => props.label;

describe("memo", () => {
  it("wraps a component with a realm-safe brand", () => {
    const wrapped = memo(Component);
    expect(isMemoComponent(wrapped)).toBe(true);
    expect(wrapped.component).toBe(Component);
    expect(isMemoComponent(Component)).toBe(false);
    expect(isMemoComponent(null)).toBe(false);
  });

  it("keeps a custom compare function", () => {
    const compare = (): boolean => true;
    expect(memo(Component, compare).compare).toBe(compare);
  });

  it("is accepted as an element type", () => {
    const element = createElement(memo(Component), { label: "x" });
    expect(isMemoComponent(element.type)).toBe(true);
  });
});

describe("shallowEqual", () => {
  it("compares values with Object.is and key sets", () => {
    expect(shallowEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual({}, {})).toBe(true);
  });

  it("rejects renamed keys holding undefined", () => {
    expect(shallowEqual({ a: undefined }, { b: undefined })).toBe(false);
  });

  it("compares function props by reference", () => {
    const handler = (): void => {};
    expect(shallowEqual({ f: handler }, { f: handler })).toBe(true);
    expect(shallowEqual({ f: () => {} }, { f: () => {} })).toBe(false);
  });
});
