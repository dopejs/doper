import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMutationBatch, encodeMutationBatch, Prop } from "@dopejs/pingo-reconciler";

import { SabMutationRing } from "./sab-ring";
import { SabMutationReceiver, SabMutationTransport } from "./sab-transport";

afterEach(() => vi.useRealTimers());

describe("SabMutationTransport", () => {
  it("queues beyond ring capacity, preserves order, acknowledges, and drains", async () => {
    const [main, worker] = linkedEndpoints();
    const { buffer, ring } = SabMutationRing.create(2, 16);
    const consumed: number[] = [];
    const receiver = new SabMutationReceiver(
      worker,
      SabMutationRing.attach(buffer),
      (sequence) => {
        consumed.push(sequence);
      },
      { sessionId: 7 },
    );
    const sender = new SabMutationTransport(main, ring, {
      maxBufferedFrames: 8,
      sessionId: 7,
    });
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      sender.enqueue(sequence, frame(sequence));
    }
    await sender.drain();
    await receiver.whenIdle();
    expect(consumed).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sender.metrics()).toMatchObject({
      acknowledged: 6,
      bufferedBytes: 0,
      highWatermark: 6,
      publishedAwaitingAck: 0,
      queued: 0,
    });
    await sender.close();
    expect(receiver.drain()).toBe(0);
    receiver.dispose();
  });

  it("bounds pending memory without partially accepting later frames", async () => {
    const [main, worker] = linkedEndpoints();
    const { buffer, ring } = SabMutationRing.create(2, 8);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const receiver = new SabMutationReceiver(
      worker,
      SabMutationRing.attach(buffer),
      () => blocked,
      {
        sessionId: 1,
      },
    );
    const sender = new SabMutationTransport(main, ring, {
      maxBufferedBytes: 12,
      maxBufferedFrames: 3,
      sessionId: 1,
    });
    sender.enqueue(4, frame(4));
    sender.enqueue(5, frame(5));
    sender.enqueue(6, frame(6));
    expect(() => sender.enqueue(7, frame(7))).toThrow(/full/u);
    expect(sender.metrics()).toMatchObject({ highWatermark: 3, rejected: 1 });
    release?.();
    await sender.drain();
    receiver.dispose();
  });

  it("merges only the newest unpublished transactions and preserves every mutation", async () => {
    const [main, worker] = linkedEndpoints();
    const { buffer, ring } = SabMutationRing.create(2, 256);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consumed: Array<{ sequence: number; values: number[] }> = [];
    const receiver = new SabMutationReceiver(
      worker,
      SabMutationRing.attach(buffer),
      async (sequence, bytes) => {
        const batch = decodeMutationBatch(bytes);
        consumed.push({
          sequence,
          values: batch.mutations.flatMap((mutation) =>
            mutation.type === "setF32" ? [mutation.value] : [],
          ),
        });
        if (sequence === 1) await blocked;
      },
      { sessionId: 8 },
    );
    const sender = new SabMutationTransport(main, ring, {
      maxBufferedFrames: 3,
      sessionId: 8,
    });

    sender.enqueue(1, mutationFrame(1, 1));
    sender.enqueue(2, mutationFrame(2, 2));
    sender.enqueue(3, mutationFrame(3, 3));
    sender.enqueue(4, mutationFrame(4, 4));
    expect(sender.metrics()).toMatchObject({ latestAcceptedSequence: 4, merged: 1, rejected: 0 });

    release?.();
    await sender.drain();
    await receiver.whenIdle();
    expect(consumed).toEqual([
      { sequence: 1, values: [1] },
      { sequence: 2, values: [2] },
      { sequence: 4, values: [3, 4] },
    ]);
    expect(sender.metrics()).toMatchObject({ acknowledged: 3, latestAcknowledgedSequence: 4 });
    receiver.dispose();
  });

  it("fails closed on wrong acknowledgements and ignores stale sessions", async () => {
    const [main, worker] = linkedEndpoints();
    const { ring } = SabMutationRing.create(2, 8);
    const onError = vi.fn();
    const sender = new SabMutationTransport(main, ring, { onError, sessionId: 11 });
    sender.enqueue(20, frame(20));
    worker.postMessage({ frameSeq: 20, kind: "doper:sab-ack", sessionId: 10, version: 1 });
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    worker.postMessage({ frameSeq: 21, kind: "doper:sab-ack", sessionId: 11, version: 1 });
    await expect(sender.drain()).rejects.toThrow(/out of order/u);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("validates slot budget and contiguous frame sequences", () => {
    const [main] = linkedEndpoints();
    const { ring } = SabMutationRing.create(2, 4);
    const sender = new SabMutationTransport(main, ring, { sessionId: 2 });
    expect(() => sender.enqueue(1, new Uint8Array(8))).toThrow(/slot budget/u);
    sender.enqueue(8, frame(8));
    expect(() => sender.enqueue(10, frame(10))).toThrow(/contiguous/u);
    sender.abort();
  });

  it("fails closed on a malformed current-session response", async () => {
    const [main, worker] = linkedEndpoints();
    const { ring } = SabMutationRing.create(2, 8);
    const onError = vi.fn();
    const sender = new SabMutationTransport(main, ring, { onError, sessionId: 5 });
    sender.enqueue(1, frame(1));
    worker.postMessage({ kind: "doper:sab-ack", sessionId: 5, version: 1 });
    await expect(sender.drain()).rejects.toThrow(/malformed/u);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("times out a stalled Worker and exposes the fault counter", async () => {
    vi.useFakeTimers();
    const [main] = linkedEndpoints();
    const { ring } = SabMutationRing.create(2, 8);
    const onError = vi.fn();
    const sender = new SabMutationTransport(main, ring, {
      acknowledgementTimeoutMs: 25,
      onError,
      sessionId: 6,
    });
    sender.enqueue(1, frame(1));
    const draining = sender.drain().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    const error = await draining;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timed out/u);
    expect(sender.metrics()).toMatchObject({ timeouts: 1 });
    expect(onError).toHaveBeenCalledOnce();
  });
});

interface TestEndpoint {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
}

function linkedEndpoints(): readonly [TestEndpoint, TestEndpoint] {
  const mainListeners = new Set<(event: MessageEvent<unknown>) => void>();
  const workerListeners = new Set<(event: MessageEvent<unknown>) => void>();
  return [endpoint(workerListeners, mainListeners), endpoint(mainListeners, workerListeners)];
}

function endpoint(
  target: Set<(event: MessageEvent<unknown>) => void>,
  own: Set<(event: MessageEvent<unknown>) => void>,
): TestEndpoint {
  return {
    addEventListener: (_type, listener) => own.add(listener),
    postMessage: (message) => {
      const clone = structuredClone(message);
      queueMicrotask(() => {
        for (const listener of target) listener({ data: clone } as MessageEvent<unknown>);
      });
    },
    removeEventListener: (_type, listener) => own.delete(listener),
  };
}

function frame(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function mutationFrame(frameSeq: number, value: number): Uint8Array {
  return encodeMutationBatch({
    frameSeq,
    mutations: [{ nodeId: 1, prop: Prop.Width, type: "setF32", value }],
  });
}
