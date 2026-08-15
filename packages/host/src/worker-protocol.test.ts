import { describe, expect, it } from "vitest";

import {
  isRenderWorkerInboundEnvelope,
  isRenderWorkerInboundMessage,
  isRenderWorkerOutboundEnvelope,
  isRenderWorkerOutboundMessage,
} from "./worker-protocol";

describe("render Worker protocol validation", () => {
  it("accepts complete messages and rejects malformed fields", () => {
    expect(
      isRenderWorkerInboundMessage({
        abiVersion: 1,
        kind: "doper:prepare",
        protocolVersion: 1,
        sessionId: 7,
      }),
    ).toBe(true);
    expect(
      isRenderWorkerInboundMessage({
        kind: "doper:clock-anchor",
        sequence: 1,
        sessionId: 7,
        timestamp: Number.NaN,
      }),
    ).toBe(false);
    expect(
      isRenderWorkerOutboundMessage({
        capabilities: { offscreenCanvas: true, sharedArrayBuffer: false },
        kind: "doper:prepared",
        sessionId: 7,
      }),
    ).toBe(true);
    expect(
      isRenderWorkerOutboundMessage({
        capabilities: { offscreenCanvas: "yes", sharedArrayBuffer: false },
        kind: "doper:prepared",
        sessionId: 7,
      }),
    ).toBe(false);
  });

  it("recognizes protocol envelopes independently from payload validity", () => {
    expect(isRenderWorkerInboundEnvelope({ kind: "doper:activate" })).toBe(true);
    expect(isRenderWorkerOutboundEnvelope({ kind: "doper:frame" })).toBe(true);
    expect(isRenderWorkerOutboundEnvelope({ kind: "doper:mutation-ack" })).toBe(false);
    expect(isRenderWorkerInboundEnvelope(null)).toBe(false);
  });

  it("validates frame diagnostics and clock metrics before callbacks", () => {
    expect(
      isRenderWorkerOutboundMessage({
        kind: "doper:frame",
        report: {
          commands: 1,
          displayListBytes: 16,
          maximumPictureDepth: 0,
          mutationBytes: 20,
          pictures: 0,
          rasterCache: {
            budgetBytes: 1024,
            bypassedFrames: 0,
            bytes: 512,
            compositedTiles: 1,
            entries: 1,
            evictions: 0,
            hits: 1,
            misses: 1,
          },
          rasterFrame: { bypassed: false, hits: 1, misses: 0 },
        },
        sessionId: 9,
      }),
    ).toBe(true);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "doper:clock-metrics",
        metrics: {
          acceptedAnchors: 1,
          anchoredFrames: 2,
          frames: 3,
          ignoredAnchors: 0,
          maximumFrameGapMs: Number.POSITIVE_INFINITY,
          overruns: 0,
          running: true,
          selfDrivenFrames: 1,
        },
        sessionId: 9,
      }),
    ).toBe(false);
  });
});
