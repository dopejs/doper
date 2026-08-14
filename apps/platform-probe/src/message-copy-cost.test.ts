import { describe, expect, it } from "vitest";

import { analyzeMessageCopyCost, payloadChecksum } from "./message-copy-cost";

describe("postMessage payload cost analysis", () => {
  it("preserves raw samples and derives throughput", () => {
    expect(analyzeMessageCopyCost(1024, 2, [1, 3], { receivedCount: 2, verified: true })).toEqual({
      effectiveMiBPerSecond: 0.488,
      iterations: 2,
      payloadBytes: 1024,
      receivedCount: 2,
      roundTripMs: [1, 3],
      summary: { count: 2, max: 3, mean: 2, min: 1, p50: 2, p95: 2.9, p99: 2.98 },
      totalBytes: 2048,
      verified: true,
    });
  });

  it("checks every payload byte deterministically", () => {
    expect(payloadChecksum(new Uint8Array([1, 2, 3]))).toBe(1_456_420_779);
    expect(payloadChecksum(new Uint8Array([1, 2, 4]))).not.toBe(1_456_420_779);
  });
});
