import { describe, expect, it } from "vitest";

import { SabMutationRing } from "./sab-ring.js";

describe("SabMutationRing", () => {
  it("publishes detached frames in order and reports explicit backpressure", () => {
    const { buffer, ring: producer } = SabMutationRing.create(2, 32);
    const consumer = SabMutationRing.attach(buffer);
    const first = Uint8Array.of(1, 2, 3, 4);
    expect(producer.tryPublish(7, first)).toBe(true);
    first.fill(9);
    expect(producer.tryPublish(8, Uint8Array.of(5, 6, 7, 8))).toBe(true);
    expect(producer.tryPublish(9, Uint8Array.of(9, 10, 11, 12))).toBe(false);
    expect(producer.metrics()).toMatchObject({
      highWatermark: 2,
      occupancy: 2,
      published: 2,
      rejected: 1,
    });

    expect(consumer.take()).toEqual({ bytes: Uint8Array.of(1, 2, 3, 4), frameSeq: 7 });
    expect(consumer.take()).toEqual({ bytes: Uint8Array.of(5, 6, 7, 8), frameSeq: 8 });
    expect(consumer.take()).toBeNull();
    expect(consumer.metrics()).toMatchObject({ consumed: 2, occupancy: 0 });
  });

  it("wraps unsigned cursors under sustained model-checked traffic", () => {
    const { buffer, ring: producer } = SabMutationRing.create(3, 16);
    const consumer = SabMutationRing.attach(buffer);
    const model: Array<{ readonly bytes: Uint8Array; readonly frameSeq: number }> = [];
    let seed = 0x1234_5678;
    let nextSequence = 1;
    for (let operation = 0; operation < 20_000; operation += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      if ((seed & 1) === 0) {
        const frameSeq = nextSequence++;
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, frameSeq, true);
        const accepted = producer.tryPublish(frameSeq, bytes);
        if (accepted) model.push({ bytes, frameSeq });
        else expect(model).toHaveLength(3);
      } else {
        expect(consumer.take()).toEqual(model.shift() ?? null);
      }
    }
    while (model.length > 0) expect(consumer.take()).toEqual(model.shift());
    expect(consumer.take()).toBeNull();
    expect(consumer.metrics().corruptionFailures).toBe(0);
  });

  it("validates shape, lifecycle, and slot integrity", () => {
    expect(() => SabMutationRing.create(1, 16)).toThrow(/capacity/u);
    expect(() => SabMutationRing.create(2, 15)).toThrow(/aligned/u);
    expect(() => SabMutationRing.attach(new SharedArrayBuffer(16))).toThrow(/truncated/u);
    const { buffer, ring } = SabMutationRing.create(2, 16);
    expect(() => SabMutationRing.attach(buffer.slice(0, -4))).toThrow(/byteLength/u);
    expect(() => ring.tryPublish(1, Uint8Array.of(1))).toThrow(/aligned/u);
    ring.close();
    expect(ring.isDrained()).toBe(true);
    expect(() => ring.tryPublish(1, Uint8Array.of(1, 2, 3, 4))).toThrow(/closed/u);
  });
});
