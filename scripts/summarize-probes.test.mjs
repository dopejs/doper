import { describe, expect, it } from "vitest";

import { summarizeReports } from "./summarize-probes.mjs";

function report(overrides) {
  return {
    build: { id: "build-a", mode: "production" },
    deviceId: "android-low-01",
    errors: {},
    finishedAt: "2026-08-14T00:00:00.000Z",
    runId: "00000000-0000-4000-8000-000000000001",
    version: 1,
    workerRaf: {
      durationMs: 1000,
      samples: [16, 17],
      summary: { count: 2, max: 17, mean: 16.5, min: 16, p50: 16.5, p95: 16.95, p99: 16.99 },
    },
    ...overrides,
  };
}

describe("summarizeReports", () => {
  it("sorts runs and computes same-build reproducibility deltas", () => {
    const second = report({
      finishedAt: "2026-08-14T00:01:00.000Z",
      runId: "00000000-0000-4000-8000-000000000002",
      workerRaf: {
        durationMs: 1000,
        samples: [17, 18],
        summary: { count: 2, max: 18, mean: 17.5, min: 17, p50: 17.5, p95: 17.7975, p99: 17.9595 },
      },
    });
    const summary = summarizeReports([second, report({})], "2026-08-14T00:02:00.000Z");

    expect(summary.runs.map((run) => run.runId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(summary.reproducibility[0].metrics.workerRafP95Ms.relativeChangePercent).toBeCloseTo(
      5,
      4,
    );
  });

  it("keeps failed and incomplete reports visible", () => {
    const summary = summarizeReports(
      [report({ errors: { wasm: "fetch failed" }, finishedAt: undefined })],
      "2026-08-14T00:02:00.000Z",
    );

    expect(summary.runs[0]).toMatchObject({
      complete: false,
      errors: { wasm: "fetch failed" },
      finishedAt: null,
    });
  });
});
