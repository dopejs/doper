import { describe, expect, it } from "vitest";

import { createSvg, parseColor, parseTransform, PingoSvgError, shapeData } from "./svg";

function attributes(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

describe("createSvg", () => {
  it("reads the view box and one shape per drawable element", () => {
    const svg = createSvg(
      `<svg viewBox="0 0 24 24"><path d="M0 0 L1 1"/><circle cx="5" cy="5" r="2"/></svg>`,
    );
    expect(svg.viewBox).toEqual([0, 0, 24, 24]);
    expect(svg.shapes).toHaveLength(2);
  });

  it("falls back to width and height when there is no view box", () => {
    // Exported icons routinely omit viewBox; refusing them would reject files
    // every design tool produces.
    expect(createSvg(`<svg width="16" height="16"><path d="M0 0 L1 1"/></svg>`).viewBox).toEqual([
      0, 0, 16, 16,
    ]);
  });

  it("inherits presentation attributes through groups", () => {
    const svg = createSvg(
      `<svg viewBox="0 0 10 10"><g stroke="#ff0000" stroke-width="3"><path d="M0 0 L1 1"/></g></svg>`,
    );
    expect(svg.shapes[0]?.stroke).toBe(0xff0000ff);
    expect(svg.shapes[0]?.strokeWidth).toBe(3);
  });

  it("does not leak a group's attributes to its siblings", () => {
    // The stack has to pop on the closing tag, or every later shape inherits
    // paint from a group it was never inside.
    const svg = createSvg(
      `<svg viewBox="0 0 10 10"><g stroke="#ff0000"><path d="M0 0 L1 1"/></g><path d="M2 2 L3 3"/></svg>`,
    );
    expect(svg.shapes[0]?.stroke).toBe(0xff0000ff);
    expect(svg.shapes[1]?.stroke).toBeUndefined();
  });

  it("keeps fill=none distinct from an absent fill", () => {
    // Stroke-only icon sets say "outline, no body" with fill="none"; treating
    // it as "no fill attribute" would flood every outline icon solid.
    const outline = createSvg(
      `<svg viewBox="0 0 10 10"><path d="M0 0 L1 1" fill="none" stroke="#000000"/></svg>`,
    );
    expect(outline.shapes[0]?.filled).toBe(false);

    const plain = createSvg(`<svg viewBox="0 0 10 10"><path d="M0 0 L1 1"/></svg>`);
    expect(plain.shapes[0]?.filled).toBe(true);
  });

  it("treats currentColor as inheriting rather than as a colour", () => {
    const svg = createSvg(
      `<svg viewBox="0 0 10 10"><path d="M0 0 L1 1" fill="currentColor"/></svg>`,
    );
    expect(svg.shapes[0]?.fill).toBeUndefined();
    expect(svg.shapes[0]?.filled).toBe(true);
  });

  it("composes nested transforms in document order", () => {
    const svg = createSvg(
      `<svg viewBox="0 0 10 10"><g transform="translate(2 3)"><g transform="scale(2)"><path d="M1 1 L2 2"/></g></g></svg>`,
    );
    expect(svg.shapes[0]?.transform).toEqual([2, 0, 0, 2, 2, 3]);
  });

  it("rejects an element outside the subset by name", () => {
    // Naming it is the point: a silently dropped <text> is a blank icon with no
    // explanation.
    expect(() => createSvg(`<svg viewBox="0 0 1 1"><text>hi</text></svg>`)).toThrow(
      /unsupported svg element <text>/u,
    );
  });

  it("rejects a document with nothing to draw", () => {
    expect(() => createSvg(`<svg viewBox="0 0 1 1"></svg>`)).toThrow(PingoSvgError);
    expect(() => createSvg(`not markup`)).toThrow(PingoSvgError);
  });

  it("rejects a degenerate view box", () => {
    expect(() => createSvg(`<svg viewBox="0 0 0 5"><path d="M0 0"/></svg>`)).toThrow(PingoSvgError);
    expect(() => createSvg(`<svg viewBox="0 0 5"><path d="M0 0"/></svg>`)).toThrow(PingoSvgError);
  });
});

describe("parseColor", () => {
  it("expands every hex length", () => {
    expect(parseColor("#f00")).toBe(0xff0000ff);
    expect(parseColor("#ff0000")).toBe(0xff0000ff);
    expect(parseColor("#ff000080")).toBe(0xff000080);
    expect(parseColor("#f008")).toBe(0xff000088);
  });

  it("maps the inheriting keywords to undefined", () => {
    for (const keyword of ["none", "transparent", "currentColor", "CURRENTCOLOR"]) {
      expect(parseColor(keyword)).toBeUndefined();
    }
  });

  it("rejects a named colour rather than guessing", () => {
    // A partial name table would render some documents and silently blacken
    // others, which is worse than refusing.
    expect(() => parseColor("rebeccapurple")).toThrow(PingoSvgError);
    expect(() => parseColor("rgb(1,2,3)")).toThrow(PingoSvgError);
  });
});

describe("parseTransform", () => {
  it("builds the primitive transforms", () => {
    expect(parseTransform("translate(2,3)")).toEqual([1, 0, 0, 1, 2, 3]);
    expect(parseTransform("scale(2)")).toEqual([2, 0, 0, 2, 0, 0]);
    expect(parseTransform("matrix(1 2 3 4 5 6)")).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rotates about a point when given one", () => {
    // Exported icons use the three-argument form constantly; treating it as the
    // two-argument form silently moves the artwork.
    const [, , , , e, f] = parseTransform("rotate(180 5 5)");
    expect(e).toBeCloseTo(10);
    expect(f).toBeCloseTo(10);
  });

  it("applies a list left to right", () => {
    expect(parseTransform("translate(1 1) scale(2)")).toEqual([2, 0, 0, 2, 1, 1]);
  });

  it("rejects an unsupported function and a malformed matrix", () => {
    expect(() => parseTransform("skewX(10)")).toThrow(PingoSvgError);
    expect(() => parseTransform("matrix(1 2 3)")).toThrow(PingoSvgError);
  });
});

describe("shapeData", () => {
  it("expands a rect, including the implied second radius", () => {
    // rx alone implies ry, which is what rounded icon frames rely on.
    const rounded = shapeData("rect", attributes({ width: "10", height: "10", rx: "2" }));
    expect(rounded).toContain("A2 2");
    const square = shapeData("rect", attributes({ width: "10", height: "10" }));
    expect(square).not.toContain("A");
  });

  it("clamps a radius larger than half the side", () => {
    const data = shapeData("rect", attributes({ width: "10", height: "10", rx: "99" }));
    expect(data).toContain("A5 5");
  });

  it("closes a polygon but not a polyline", () => {
    expect(shapeData("polygon", attributes({ points: "0,0 1,0 1,1" }))?.endsWith("Z")).toBe(true);
    expect(shapeData("polyline", attributes({ points: "0,0 1,0 1,1" }))?.endsWith("Z")).toBe(false);
  });

  it("drops a shape with no extent instead of emitting an empty node", () => {
    expect(shapeData("circle", attributes({ r: "0" }))).toBeUndefined();
    expect(shapeData("rect", attributes({ width: "0", height: "5" }))).toBeUndefined();
    expect(shapeData("polygon", attributes({ points: "1,1" }))).toBeUndefined();
    expect(shapeData("path", attributes({ d: "  " }))).toBeUndefined();
  });

  it("refuses a non-numeric attribute", () => {
    expect(() => shapeData("circle", attributes({ r: "wide" }))).toThrow(PingoSvgError);
  });
});
