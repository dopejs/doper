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
  it("assesses reproducibility between complete sample batches", () => {
    const batchA = "10000000-0000-4000-8000-000000000000";
    const batchB = "20000000-0000-4000-8000-000000000000";
    const reports = [
      batchReport(batchA, 1, 16, 17, 1000, "00000000-0000-4000-8000-000000000001"),
      batchReport(batchA, 2, 16, 17, 1020, "00000000-0000-4000-8000-000000000002"),
      batchReport(batchB, 1, 16.8, 17.85, 1030, "00000000-0000-4000-8000-000000000003"),
      batchReport(batchB, 2, 16.8, 17.85, 1040, "00000000-0000-4000-8000-000000000004"),
    ];
    const summary = summarizeReports(reports, "2026-08-14T00:10:00.000Z");

    expect(summary.version).toBe(2);
    expect(summary.batches).toHaveLength(2);
    expect(summary.reproducibility[0].pass).toBe(true);
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

function batchReport(batchId, sequence, low, high, throughput, runId) {
  return report({
    canvas: {
      worker: {
        durationMs: 500,
        operations: 500,
        operationsPerSecond: throughput,
        scrollCopyOperations: 100,
        scrollCopyOperationsPerSecond: 200,
        tileSizes: [],
      },
    },
    collection: { batchId, kind: "sample", sequence, total: 2 },
    finishedAt: `2026-08-14T00:0${String(sequence)}:00.000Z`,
    runId,
    workerRaf: {
      durationMs: 1000,
      samples: [low, high],
      summary: {
        count: 2,
        max: high,
        mean: (low + high) / 2,
        min: low,
        p50: (low + high) / 2,
        p95: high,
        p99: high,
      },
    },
  });
}
