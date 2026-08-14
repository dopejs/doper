import { describe, expect, it } from "vitest";

import { absoluteHighResolutionTime, percentile, summarize } from "./metrics";

describe("absoluteHighResolutionTime", () => {
  it("makes timestamps with different global time origins comparable", () => {
    const mainPublishedAt = absoluteHighResolutionTime(100, 34.5);
    const workerObservedAt = absoluteHighResolutionTime(125, 10);

    expect(workerObservedAt - mainPublishedAt).toBe(0.5);
  });
});

describe("summarize", () => {
  it("sorts samples without mutating the input", () => {
    const samples = [4, 1, 3, 2];
    const result = summarize(samples);

    expect(samples).toEqual([4, 1, 3, 2]);
    expect(result).toMatchObject({ count: 4, max: 4, mean: 2.5, min: 1 });
  });

  it("rejects empty and non-finite sample sets", () => {
    expect(() => summarize([])).toThrow("empty sample set");
    expect(() => summarize([Number.NaN, Number.POSITIVE_INFINITY])).toThrow("empty sample set");
  });
});

describe("percentile", () => {
  it("interpolates between neighboring samples", () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([0, 10, 20], 0.95)).toBeCloseTo(19);
  });

  it("validates the quantile", () => {
    expect(() => percentile([1], -0.1)).toThrow(RangeError);
    expect(() => percentile([1], 1.1)).toThrow(RangeError);
  });
});
