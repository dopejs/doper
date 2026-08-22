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
        kind: "pingo:prepare",
        protocolVersion: 1,
        sessionId: 7,
      }),
    ).toBe(true);
    expect(
      isRenderWorkerInboundMessage({
        canvas: {},
        height: 100,
        inputRingBuffer: new SharedArrayBuffer(64),
        incrementalPicturesEnabled: true,
        devicePixelRatio: 2,
        kind: "pingo:activate",
        mode: "sab",
        rasterCache: true,
        reducedMotion: false,
        ringBuffer: new SharedArrayBuffer(64),
        sessionId: 7,
        width: 100,
      }),
    ).toBe(true);
    expect(
      isRenderWorkerInboundMessage({
        canvas: {},
        height: 100,
        incrementalPicturesEnabled: true,
        devicePixelRatio: 2,
        kind: "pingo:activate",
        mode: "sab",
        rasterCache: true,
        ringBuffer: new SharedArrayBuffer(64),
        sessionId: 7,
        width: 100,
      }),
    ).toBe(false);
    expect(isRenderWorkerInboundMessage({ kind: "pingo:input-wake", sessionId: 7 })).toBe(true);
    expect(
      isRenderWorkerInboundMessage({
        kind: "pingo:reduced-motion",
        reduced: true,
        sessionId: 7,
      }),
    ).toBe(true);
    expect(
      isRenderWorkerInboundMessage({
        kind: "pingo:reduced-motion",
        reduced: "yes",
        sessionId: 7,
      }),
    ).toBe(false);
    expect(
      isRenderWorkerInboundMessage({
        kind: "pingo:clock-anchor",
        sequence: 1,
        sessionId: 7,
        timestamp: Number.NaN,
      }),
    ).toBe(false);
    expect(
      isRenderWorkerInboundMessage({
        bytes: Uint8Array.of(1, 2, 3, 4),
        kind: "pingo:input",
        sessionId: 7,
      }),
    ).toBe(true);
    expect(isRenderWorkerInboundMessage({ bytes: [], kind: "pingo:input", sessionId: 7 })).toBe(
      false,
    );
    expect(
      isRenderWorkerOutboundMessage({
        capabilities: { offscreenCanvas: true, sharedArrayBuffer: false },
        kind: "pingo:prepared",
        sessionId: 7,
      }),
    ).toBe(true);
    expect(
      isRenderWorkerOutboundMessage({
        capabilities: { offscreenCanvas: "yes", sharedArrayBuffer: false },
        kind: "pingo:prepared",
        sessionId: 7,
      }),
    ).toBe(false);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:non-passive-regions",
        regions: [{ flags: 3, left: 0, top: 0, right: 100, bottom: 80 }],
        sessionId: 7,
      }),
    ).toBe(true);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:non-passive-regions",
        regions: [{ flags: 0, left: 0, top: 0, right: 100, bottom: 80 }],
        sessionId: 7,
      }),
    ).toBe(false);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:event-transaction",
        sessionId: 7,
        transaction: {
          eventId: 1,
          kind: "pointerdown",
          target: 3,
          x: 1,
          y: 2,
          deltaX: 0,
          deltaY: 0,
          buttons: 1,
          modifiers: 0,
          pointerId: 1,
          elapsedMicros: 16_667,
          relatedTarget: null,
          cursor: "auto",
          pointerType: "mouse",
          isPrimary: true,
          pressure: 0.5,
          tiltX: 0,
          tiltY: 0,
          width: 1,
          height: 1,
          path: [1, 2, 3],
        },
      }),
    ).toBe(true);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:event-transaction",
        sessionId: 7,
        transaction: {
          eventId: 1,
          kind: "pointerdown",
          target: 3,
          x: 1,
          y: 2,
          deltaX: 0,
          deltaY: 0,
          buttons: 1,
          modifiers: 0,
          pointerId: 1,
          elapsedMicros: 16_667,
          relatedTarget: null,
          cursor: "auto",
          pointerType: "mouse",
          isPrimary: true,
          pressure: 0.5,
          tiltX: 0,
          tiltY: 0,
          width: 1,
          height: 1,
          path: [1, 2, 2, 3],
        },
      }),
    ).toBe(false);
    const layoutGeometry = (clip: Record<string, number>): unknown => ({
      kind: "pingo:layout-geometry",
      frame: {
        frameSeq: 12,
        records: [{ nodeId: 7, bounds: { left: 1, top: 2, width: 3, height: 4 }, clip }],
      },
      sessionId: 7,
    });
    // An unclipped node reports an unbounded clip, so the validator must admit
    // infinities where the editing-geometry one requires finite numbers.
    expect(
      isRenderWorkerOutboundMessage(
        layoutGeometry({
          left: Number.NEGATIVE_INFINITY,
          top: Number.NEGATIVE_INFINITY,
          width: Number.POSITIVE_INFINITY,
          height: Number.POSITIVE_INFINITY,
        }),
      ),
    ).toBe(true);
    // NaN and negative extents still fail: both would poison a placement
    // comparison instead of failing where they entered.
    expect(
      isRenderWorkerOutboundMessage(
        layoutGeometry({ left: Number.NaN, top: 0, width: 1, height: 1 }),
      ),
    ).toBe(false);
    expect(
      isRenderWorkerOutboundMessage(layoutGeometry({ left: 0, top: 0, width: -1, height: 1 })),
    ).toBe(false);

    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:editing-geometry",
        frame: {
          nodeId: 17,
          selectionStart: 2,
          selectionEnd: 3,
          controlBounds: { left: 5, top: 6, width: 100, height: 20 },
          selectionBounds: { left: 7, top: 8, width: 9, height: 10 },
          characterBounds: [
            { start: 2, end: 3, rect: { left: 11, top: 12, width: 13, height: 14 } },
          ],
        },
        sessionId: 7,
      }),
    ).toBe(true);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:editing-geometry",
        frame: {
          nodeId: 17,
          selectionStart: 4,
          selectionEnd: 3,
          controlBounds: { left: 5, top: 6, width: 100, height: 20 },
          selectionBounds: { left: 7, top: 8, width: 9, height: 10 },
          characterBounds: [],
        },
        sessionId: 7,
      }),
    ).toBe(false);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:editing-geometry",
        frame: {
          nodeId: 17,
          selectionStart: 2,
          selectionEnd: 3,
          controlBounds: { left: 5, top: 6, width: -1, height: 20 },
          selectionBounds: { left: 7, top: 8, width: 9, height: 10 },
          characterBounds: [],
        },
        sessionId: 7,
      }),
    ).toBe(false);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:virtual-refill",
        requests: [{ nodeId: 0x0010_0001, start: 4, end: 8 }],
        sessionId: 7,
      }),
    ).toBe(true);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:virtual-refill",
        requests: [{ nodeId: 1, start: 8, end: 4 }],
        sessionId: 7,
      }),
    ).toBe(false);
  });

  it("recognizes protocol envelopes independently from payload validity", () => {
    expect(isRenderWorkerInboundEnvelope({ kind: "pingo:activate" })).toBe(true);
    expect(isRenderWorkerOutboundEnvelope({ kind: "pingo:frame" })).toBe(true);
    expect(isRenderWorkerOutboundEnvelope({ kind: "pingo:mutation-ack" })).toBe(false);
    expect(isRenderWorkerInboundEnvelope(null)).toBe(false);
  });

  it("validates frame diagnostics and clock metrics before callbacks", () => {
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:frame",
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
    const mediaReport = {
      commands: 1,
      displayListBytes: 16,
      maximumPictureDepth: 0,
      mutationBytes: 0,
      pictures: 0,
    };
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:frame",
        report: { ...mediaReport, cause: "media", mediaPath: "video-frame" },
        sessionId: 9,
      }),
    ).toBe(true);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:frame",
        report: { ...mediaReport, cause: "media" },
        sessionId: 9,
      }),
    ).toBe(false);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:frame",
        report: { ...mediaReport, cause: "mutation", mediaPath: "image-bitmap" },
        sessionId: 9,
      }),
    ).toBe(false);
    expect(
      isRenderWorkerOutboundMessage({
        kind: "pingo:clock-metrics",
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
