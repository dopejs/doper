import { describe, expect, it } from "vitest";

import {
  analyzeContinuity,
  clampPhaseCorrection,
  nextAlignedFrame,
  selectTransport,
} from "./transport";

describe("frame continuity", () => {
  it("accepts a continuously rendered stall window", () => {
    const timestamps = Array.from({ length: 31 }, (_, index) => 1000 + index * 16.667);
    const result = analyzeContinuity({
      finalPixelRgba: [1, 2, 3, 255],
      frameTimestamps: timestamps,
      mode: "sab",
      paintOperations: timestamps.length,
      stallEndEpochMs: 1300,
      stallStartEpochMs: 1100,
      targetFrameMs: 16.667,
    });

    expect(result.continuousDuringStall).toBe(true);
    expect(result.framesDuringStall).toBeGreaterThanOrEqual(10);
    expect(result.missedFrameBudget).toBe(0);
  });

  it("detects a main-thread-sized rendering gap", () => {
    const result = analyzeContinuity({
      finalPixelRgba: [1, 2, 3, 255],
      frameTimestamps: [1000, 1016.667, 1033.334, 1250, 1266.667],
      mode: "main-thread",
      paintOperations: 5,
      stallEndEpochMs: 1233.334,
      stallStartEpochMs: 1033.334,
      targetFrameMs: 16.667,
    });

    expect(result.continuousDuringStall).toBe(false);
    expect(result.maxFrameGapMs).toBeGreaterThan(200);
    expect(result.missedFrameBudget).toBeGreaterThan(10);
  });
});

describe("phase locking", () => {
  it("selects the next phase strictly after now", () => {
    expect(nextAlignedFrame(1049, 1000, 16)).toBe(1064);
  });

  it("caps a correction so one anchor cannot cause a frame jump", () => {
    expect(clampPhaseCorrection(8)).toBe(2);
    expect(clampPhaseCorrection(-8)).toBe(-2);
  });
});

describe("transport selection", () => {
  const worker = {
    offscreenCanvas: true,
    requestAnimationFrame: true,
    sharedArrayBuffer: true,
  };

  it("prefers SAB only for an isolated host and capable worker", () => {
    expect(selectTransport({ crossOriginIsolated: true, worker })).toBe("sab");
  });

  it("falls back to postMessage without cross-origin isolation", () => {
    expect(selectTransport({ crossOriginIsolated: false, worker })).toBe("post-message");
  });

  it("falls back to main-thread rendering without Worker OffscreenCanvas", () => {
    expect(
      selectTransport({
        crossOriginIsolated: true,
        worker: { ...worker, offscreenCanvas: false },
      }),
    ).toBe("main-thread");
  });
});
