import { describe, expect, it } from "vitest";

import { summarizeReports, validateProbeReport } from "./summarize-probes.mjs";

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

  it("keeps archived warmups visible without using them as trend samples", () => {
    const batchId = "50000000-0000-4000-8000-000000000000";
    const warmup = report({
      collection: { batchId, kind: "warmup", sequence: 1, total: 1 },
      roleId: "desktop-chromium",
      runId: "50000000-0000-4000-8000-000000000001",
    });
    const sample = report({
      collection: { batchId, kind: "sample", sequence: 1, total: 1 },
      roleId: "desktop-chromium",
      runId: "50000000-0000-4000-8000-000000000002",
    });
    const summary = summarizeReports([warmup, sample], "2026-08-14T00:10:00.000Z");

    expect(summary.runs).toHaveLength(2);
    expect(summary.trends).toEqual([]);
  });

  it("does not compare different platform roles on the same physical device", () => {
    const chromiumBatch = "30000000-0000-4000-8000-000000000000";
    const safariBatch = "40000000-0000-4000-8000-000000000000";
    const summary = summarizeReports(
      [
        {
          ...batchReport(chromiumBatch, 1, 16, 17, 1000, "30000000-0000-4000-8000-000000000001"),
          roleId: "desktop-chromium",
        },
        {
          ...batchReport(chromiumBatch, 2, 16, 17, 1000, "30000000-0000-4000-8000-000000000002"),
          roleId: "desktop-chromium",
        },
        {
          ...batchReport(safariBatch, 1, 16, 17, 1000, "40000000-0000-4000-8000-000000000001"),
          roleId: "desktop-safari",
        },
        {
          ...batchReport(safariBatch, 2, 16, 17, 1000, "40000000-0000-4000-8000-000000000002"),
          roleId: "desktop-safari",
        },
      ],
      "2026-08-14T00:10:00.000Z",
    );

    expect(summary.batches.map((batch) => batch.roleId)).toEqual([
      "desktop-chromium",
      "desktop-safari",
    ]);
    expect(summary.reproducibility).toEqual([]);
  });

  it("reports SAB backpressure throughput and rejects inconsistent claimed evidence", async () => {
    const backpressure = {
      acceptedCount: 3,
      acceptedPerSecond: 300,
      backpressureHandled: true,
      capacity: 2,
      consumedCount: 3,
      consumedSequences: [1, 2, 4],
      drained: true,
      droppedCount: 1,
      durationMs: 10,
      finalReadCursor: 3,
      finalWriteCursor: 3,
      highWatermark: 2,
      latestAcceptedSequence: 4,
      latestConsumedSequence: 4,
      producedCount: 4,
      sequenceMonotonic: true,
    };
    const validReport = report({ sabBackpressure: backpressure });
    expect(
      summarizeReports([validReport], "2026-08-14T00:10:00.000Z").runs[0].metrics
        .sabBackpressureAcceptedPerSecond.value,
    ).toBe(300);
    await expect(validateProbeReport(validReport)).resolves.toBe(validReport);

    const corrupted = report({
      sabBackpressure: { ...backpressure, consumedSequences: [1, 4, 2] },
    });
    await expect(validateProbeReport(corrupted)).rejects.toThrow(/inconsistent SAB backpressure/u);

    const forgedCursors = report({
      sabBackpressure: {
        ...backpressure,
        finalReadCursor: 99,
        finalWriteCursor: 99,
      },
    });
    await expect(validateProbeReport(forgedCursors)).rejects.toThrow(
      /inconsistent SAB backpressure/u,
    );
  });

  it("recomputes postMessage credit, acknowledgement, and drain evidence", async () => {
    const messageBackpressure = {
      acceptedCount: 3,
      acceptedPerSecond: 300,
      acknowledgementsMatch: true,
      acknowledgedCount: 3,
      acknowledgedSequences: [1, 2, 4],
      backpressureHandled: true,
      capacity: 2,
      consumedCount: 3,
      consumedSequences: [1, 2, 4],
      drained: true,
      droppedCount: 1,
      durationMs: 10,
      finalInFlight: 0,
      highWatermark: 2,
      latestAcceptedSequence: 4,
      latestAcknowledgedSequence: 4,
      latestConsumedSequence: 4,
      producedCount: 4,
      sequenceMonotonic: true,
    };
    const validReport = report({ messageBackpressure });
    await expect(validateProbeReport(validReport)).resolves.toBe(validReport);
    expect(
      summarizeReports([validReport], "2026-08-14T00:10:00.000Z").runs[0].metrics
        .messageBackpressureAcceptedPerSecond.value,
    ).toBe(300);

    const forgedAck = report({
      messageBackpressure: {
        ...messageBackpressure,
        acknowledgedSequences: [1, 4, 2],
      },
    });
    await expect(validateProbeReport(forgedAck)).rejects.toThrow(
      /inconsistent postMessage backpressure/u,
    );

    const forgedThroughput = report({
      messageBackpressure: {
        ...messageBackpressure,
        acceptedPerSecond: 999_999,
      },
    });
    await expect(validateProbeReport(forgedThroughput)).rejects.toThrow(
      /inconsistent postMessage backpressure/u,
    );
  });

  it("recomputes postMessage payload samples, summaries, and throughput", async () => {
    const messageCopyCost = {
      cases: [
        {
          effectiveMiBPerSecond: 0.488,
          iterations: 2,
          payloadBytes: 1024,
          receivedCount: 2,
          roundTripMs: [1, 3],
          summary: { count: 2, max: 3, mean: 2, min: 1, p50: 2, p95: 2.9, p99: 2.98 },
          totalBytes: 2048,
          verified: true,
        },
      ],
    };
    const validReport = report({ messageCopyCost });
    await expect(validateProbeReport(validReport)).resolves.toBe(validReport);

    const forgedSummary = report({
      messageCopyCost: {
        cases: [
          { ...messageCopyCost.cases[0], summary: { ...messageCopyCost.cases[0].summary, p95: 0 } },
        ],
      },
    });
    await expect(validateProbeReport(forgedSummary)).rejects.toThrow(
      /inconsistent postMessage payload cost/u,
    );
  });

  it("recomputes timing and transport summaries from raw samples", async () => {
    const validReport = report({ transport: validTransport() });
    await expect(validateProbeReport(validReport)).resolves.toBe(validReport);

    const forgedTiming = structuredClone(validReport);
    forgedTiming.workerRaf.summary.p95 = 0;
    await expect(validateProbeReport(forgedTiming)).rejects.toThrow(/summary that does not match/u);

    const forgedTransport = structuredClone(validReport);
    const recommended = forgedTransport.transport.recommendedMode;
    forgedTransport.transport.modes[recommended].result.maxFrameGapMs = 0;
    await expect(validateProbeReport(forgedTransport)).rejects.toThrow(
      /inconsistent transport frame evidence/u,
    );
  });
});

function validTransport() {
  const summary = { count: 1, max: 16, mean: 16, min: 16, p50: 16, p95: 16, p99: 16 };
  return {
    modes: {
      "main-thread": {
        result: {
          anchorLatencySamples: [],
          continuousDuringStall: false,
          durationMs: 16,
          finalPixelRgba: [1, 2, 3, 255],
          frameIntervals: [16],
          frameSummary: summary,
          framesDuringStall: 0,
          maxFrameGapMs: 16,
          missedFrameBudget: 0,
          mode: "main-thread",
          paintOperations: 2,
          phaseErrorSamples: [],
          renderedFrames: 2,
        },
        status: "ok",
      },
      "post-message": { reason: "not selected", status: "unsupported" },
      "sab": { reason: "not selected", status: "unsupported" },
    },
    recommendedMode: "main-thread",
  };
}

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
