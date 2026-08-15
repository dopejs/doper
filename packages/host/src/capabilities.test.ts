import { describe, expect, it } from "vitest";

import { detectHostCapabilities, selectHostTransport } from "./capabilities";

const allCapabilities = {
  crossOriginIsolated: true,
  offscreenCanvas: true,
  sharedArrayBuffer: true,
  transferableCanvas: true,
  worker: true,
} as const;

describe("Host capability selection", () => {
  it("selects the complete fallback chain from one immutable snapshot", () => {
    expect(selectHostTransport(allCapabilities).mode).toBe("sab");
    expect(selectHostTransport({ ...allCapabilities, crossOriginIsolated: false }).mode).toBe(
      "post-message",
    );
    expect(selectHostTransport({ ...allCapabilities, worker: false }).mode).toBe("main-thread");
    expect(selectHostTransport({ ...allCapabilities, offscreenCanvas: false }).mode).toBe(
      "main-thread",
    );
    expect(selectHostTransport({ ...allCapabilities, transferableCanvas: false }).mode).toBe(
      "main-thread",
    );
  });

  it("supports reversible global, device, page, and explicit overrides", () => {
    for (const policy of [
      { globalWorkerEnabled: false },
      { deviceWorkerEnabled: false },
      { pageWorkerEnabled: false },
      { preference: "main-thread" as const },
    ]) {
      expect(selectHostTransport(allCapabilities, policy).mode).toBe("main-thread");
    }
    expect(selectHostTransport(allCapabilities, { preference: "post-message" }).mode).toBe(
      "post-message",
    );
  });

  it("degrades forced modes safely or rejects when strict", () => {
    const withoutIsolation = { ...allCapabilities, crossOriginIsolated: false };
    const decision = selectHostTransport(withoutIsolation, { preference: "sab" });
    expect(decision.mode).toBe("post-message");
    expect(decision.reasons.join(" ")).toMatch(/falling back/u);
    expect(() =>
      selectHostTransport(withoutIsolation, { preference: "sab", strict: true }),
    ).toThrow(/unavailable/u);
  });

  it("detects capabilities without invoking or mutating browser APIs", () => {
    class FakeWorker {}
    class FakeOffscreenCanvas {}
    class FakeSharedArrayBuffer {}
    const canvas = { transferControlToOffscreen: () => ({}) };
    expect(
      detectHostCapabilities(canvas, {
        crossOriginIsolated: true,
        OffscreenCanvas: FakeOffscreenCanvas,
        SharedArrayBuffer: FakeSharedArrayBuffer,
        Worker: FakeWorker,
      }),
    ).toEqual(allCapabilities);
  });
});
