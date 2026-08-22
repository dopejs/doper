import { describe, expect, it } from "vitest";

import { arcToCubics, encodePathData, parsePathData, PathDataError } from "./path-data";

function verbs(data: string): number[] {
  return [...parsePathData(data).verbs];
}

function points(data: string): number[] {
  return [...parsePathData(data).points].map((value) => Math.round(value * 1000) / 1000);
}

describe("parsePathData", () => {
  it("reads absolute and relative forms alike", () => {
    expect(points("M10 10 L20 20")).toEqual([10, 10, 20, 20]);
    expect(points("M10 10 l5 5")).toEqual([10, 10, 15, 15]);
  });

  it("continues a command when coordinates repeat", () => {
    expect(verbs("M0 0 L1 1 2 2 3 3")).toEqual([0, 1, 1, 1]);
  });

  it("treats a repeated moveto as a lineto, which is the grammar's one surprise", () => {
    // "M0 0 1 1" is a move then a line, not two moves.
    expect(verbs("M0 0 1 1")).toEqual([0, 1]);
    expect(points("M0 0 1 1")).toEqual([0, 0, 1, 1]);
  });

  it("expands the shorthand axis commands", () => {
    expect(points("M5 5 H10")).toEqual([5, 5, 10, 5]);
    expect(points("M5 5 V10")).toEqual([5, 5, 5, 10]);
    expect(points("M5 5 h10")).toEqual([5, 5, 15, 5]);
  });

  it("reflects a smooth control point only after a matching curve", () => {
    // After C, S reflects the previous second control through the current point.
    expect(points("M0 0 C1 1 2 2 3 3 S5 5 6 6")).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    ]);
    // After a line, the specification says the control coincides with the point.
    expect(points("M0 0 L3 3 S5 5 6 6")).toEqual([0, 0, 3, 3, 3, 3, 5, 5, 6, 6]);
  });

  it("closes back to the subpath start, not to the origin", () => {
    expect(points("M5 5 L9 9 Z l1 1")).toEqual([5, 5, 9, 9, 6, 6]);
  });

  it("accepts unseparated arc flags", () => {
    // `a1 1 0 011 1` is legal: the flags are single digits and need no
    // separator, so parsing them as numbers would swallow the coordinates.
    const parsed = parsePathData("M0 0 a1 1 0 011 1");
    expect(parsed.verbs[0]).toBe(0);
    expect(parsed.verbs.slice(1).every((verb) => verb === 3)).toBe(true);
  });

  it("rejects data that does not begin with a move", () => {
    expect(() => parsePathData("L1 1")).toThrow(PathDataError);
    expect(() => parsePathData("")).toThrow(PathDataError);
  });

  it("rejects an unknown command and a missing number", () => {
    expect(() => parsePathData("M0 0 K1 1")).toThrow(PathDataError);
    expect(() => parsePathData("M0")).toThrow(PathDataError);
  });
});

describe("arcToCubics", () => {
  it("produces nothing when the endpoints coincide", () => {
    expect(arcToCubics([0, 0], 5, 5, 0, false, true, [0, 0])).toEqual([]);
  });

  it("degenerates to a line when a radius is zero", () => {
    expect(arcToCubics([0, 0], 0, 5, 0, false, true, [10, 0])).toEqual([[0, 0, 10, 0, 10, 0]]);
  });

  it("scales radii that are too small to reach the endpoint", () => {
    // SVG F.6.6 requires this rather than rejecting; real files rely on it.
    const cubics = arcToCubics([0, 0], 1, 1, 0, false, true, [10, 0]);
    const last = cubics[cubics.length - 1];
    expect(last?.[4]).toBeCloseTo(10);
    expect(last?.[5]).toBeCloseTo(0);
  });

  it("splits a large arc into at most a quarter turn per cubic", () => {
    expect(arcToCubics([0, 0], 5, 5, 0, true, true, [10, 0])).toHaveLength(2);
    expect(arcToCubics([0, 0], 5, 5, 0, false, true, [10, 0])).toHaveLength(2);
  });

  it("ends exactly on the requested endpoint", () => {
    const cubics = arcToCubics([3, 4], 6, 2, 30, true, false, [9, 1]);
    const last = cubics[cubics.length - 1];
    expect(last?.[4]).toBeCloseTo(9);
    expect(last?.[5]).toBeCloseTo(1);
  });
});

describe("encodePathData", () => {
  it("writes a header the Core can decode", () => {
    const bytes = encodePathData("M0 0 L10 10 Z", [0, 0, 24, 24]);
    const view = new DataView(bytes.buffer);
    expect(bytes[0]).toBe(1);
    expect(view.getUint32(4, true)).toBe(3);
    expect(view.getUint32(8, true)).toBe(4);
    expect(view.getFloat32(20, true)).toBe(24);
  });

  it("aligns the point array to four bytes", () => {
    // Three verbs leaves a one-byte gap; a misaligned Float32 read is undefined.
    const bytes = encodePathData("M0 0 L1 1 Z", [0, 0, 1, 1]);
    expect(bytes.byteLength % 4).toBe(0);
  });

  it("marks the fill rule", () => {
    expect(encodePathData("M0 0 L1 1", [0, 0, 1, 1], "evenodd")[2]).toBe(1);
    expect(encodePathData("M0 0 L1 1", [0, 0, 1, 1])[2]).toBe(0);
  });

  it("refuses a degenerate view box", () => {
    expect(() => encodePathData("M0 0 L1 1", [0, 0, 0, 10])).toThrow(PathDataError);
  });
});
