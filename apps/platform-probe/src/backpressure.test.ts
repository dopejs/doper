import { describe, expect, it } from "vitest";

import {
  analyzeMessageBackpressure,
  analyzeSabBackpressure,
  attachSabSequenceRing,
  createSabSequenceRing,
  finishSequenceRing,
  sequenceRingFinished,
  takeSequence,
  tryPublishSequence,
} from "./backpressure";

describe("bounded SAB sequence ring", () => {
  it("rejects overflow without overwriting unread entries and drains in order", () => {
    const { ring } = createSabSequenceRing(2);
    expect(tryPublishSequence(ring, 1)).toBe(true);
    expect(tryPublishSequence(ring, 2)).toBe(true);
    expect(tryPublishSequence(ring, 3)).toBe(false);
    expect(takeSequence(ring)).toBe(1);
    expect(tryPublishSequence(ring, 4)).toBe(true);
    finishSequenceRing(ring);
    expect(takeSequence(ring)).toBe(2);
    expect(takeSequence(ring)).toBe(4);
    expect(sequenceRingFinished(ring)).toBe(true);
  });

  it("validates capacity, byte length, and ring magic before attachment", () => {
    expect(() => createSabSequenceRing(1)).toThrow(/capacity/u);
    expect(() => attachSabSequenceRing(new SharedArrayBuffer(16), 8)).toThrow(/byteLength/u);
    expect(() => attachSabSequenceRing(new SharedArrayBuffer(48), 8)).toThrow(/magic/u);
  });

  it("requires explicit loss accounting, monotonic consumption, and final drain", () => {
    const valid = analyzeSabBackpressure(
      2,
      {
        acceptedCount: 3,
        droppedCount: 1,
        highWatermark: 2,
        latestAcceptedSequence: 4,
        producedCount: 4,
      },
      {
        consumedSequences: [1, 2, 4],
        durationMs: 10,
        finalReadCursor: 3,
        finalWriteCursor: 3,
      },
    );
    expect(valid.backpressureHandled).toBe(true);
    expect(valid.acceptedPerSecond).toBe(300);

    expect(
      analyzeSabBackpressure(
        2,
        {
          acceptedCount: 3,
          droppedCount: 1,
          highWatermark: 2,
          latestAcceptedSequence: 4,
          producedCount: 4,
        },
        { ...valid, consumedSequences: [1, 4, 2] },
      ).backpressureHandled,
    ).toBe(false);
  });

  it("requires postMessage acknowledgements to exactly match consumed sequences", () => {
    const valid = analyzeMessageBackpressure(
      2,
      {
        acceptedCount: 3,
        acknowledgedSequences: [1, 2, 4],
        droppedCount: 1,
        finalInFlight: 0,
        highWatermark: 2,
        latestAcceptedSequence: 4,
        producedCount: 4,
      },
      { consumedSequences: [1, 2, 4], durationMs: 10 },
    );
    expect(valid).toMatchObject({
      acknowledgementsMatch: true,
      backpressureHandled: true,
      drained: true,
    });

    expect(
      analyzeMessageBackpressure(
        2,
        {
          acceptedCount: 3,
          acknowledgedSequences: [1, 4, 2],
          droppedCount: 1,
          finalInFlight: 0,
          highWatermark: 2,
          latestAcceptedSequence: 4,
          producedCount: 4,
        },
        { consumedSequences: [1, 2, 4], durationMs: 10 },
      ).backpressureHandled,
    ).toBe(false);
  });
});
