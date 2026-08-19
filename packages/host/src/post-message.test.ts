import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeMutationBatch, encodeMutationBatch, Prop } from "@dopejs/pingo-reconciler";

import { PostMessageMutationReceiver, PostMessageMutationTransport } from "./post-message";

afterEach(() => vi.useRealTimers());

describe("PostMessageMutationTransport", () => {
  it("bounds in-flight work, preserves order, copies payloads, and drains on ACK", async () => {
    const [main, worker] = linkedEndpoints();
    const consumed: Array<{ bytes: number[]; sequence: number }> = [];
    const receiver = new PostMessageMutationReceiver(
      worker,
      (sequence, bytes) => {
        consumed.push({ bytes: [...bytes], sequence });
      },
      { sessionId: 7 },
    );
    const sender = new PostMessageMutationTransport(main, {
      maxBufferedFrames: 4,
      maxInFlight: 2,
      sessionId: 7,
    });
    const first = Uint8Array.of(1, 2, 3, 4);
    sender.enqueue(10, first);
    first.fill(9);
    sender.enqueue(11, Uint8Array.of(5, 6, 7, 8));
    sender.enqueue(12, Uint8Array.of(9, 10, 11, 12));
    await sender.drain();

    expect(consumed).toEqual([
      { bytes: [1, 2, 3, 4], sequence: 10 },
      { bytes: [5, 6, 7, 8], sequence: 11 },
      { bytes: [9, 10, 11, 12], sequence: 12 },
    ]);
    expect(sender.metrics()).toMatchObject({
      acknowledged: 3,
      bufferedBytes: 0,
      highWatermark: 3,
      inFlight: 0,
      queued: 0,
      sent: 3,
    });
    await sender.close();
    receiver.dispose();
  });

  it("applies explicit bounded backpressure without accepting a partial frame", async () => {
    const [main, worker] = linkedEndpoints();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const receiver = new PostMessageMutationReceiver(worker, () => blocked, { sessionId: 1 });
    const sender = new PostMessageMutationTransport(main, {
      maxBufferedBytes: 12,
      maxBufferedFrames: 3,
      maxInFlight: 1,
      sessionId: 1,
    });
    sender.enqueue(1, frame(1));
    sender.enqueue(2, frame(2));
    sender.enqueue(3, frame(3));
    expect(() => sender.enqueue(4, frame(4))).toThrow(/full/u);
    expect(sender.metrics()).toMatchObject({ highWatermark: 3, rejected: 1 });
    release?.();
    await sender.drain();
    expect(sender.metrics().latestAcknowledgedSequence).toBe(3);
    receiver.dispose();
  });

  it("merges complete pending transactions without dropping mutation order", async () => {
    const [main, worker] = linkedEndpoints();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consumed: Array<{ sequence: number; values: number[] }> = [];
    const receiver = new PostMessageMutationReceiver(
      worker,
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
    const sender = new PostMessageMutationTransport(main, {
      maxBufferedFrames: 2,
      maxInFlight: 1,
      sessionId: 8,
    });

    sender.enqueue(1, mutationFrame(1, 1));
    sender.enqueue(2, mutationFrame(2, 2));
    sender.enqueue(3, mutationFrame(3, 3));
    expect(sender.metrics()).toMatchObject({ latestAcceptedSequence: 3, merged: 1, rejected: 0 });

    release?.();
    await sender.drain();
    expect(consumed).toEqual([
      { sequence: 1, values: [1] },
      { sequence: 3, values: [2, 3] },
    ]);
    expect(sender.metrics()).toMatchObject({ acknowledged: 2, latestAcknowledgedSequence: 3 });
    receiver.dispose();
  });

  it("fails closed on out-of-order ACK and ignores stale sessions", async () => {
    const [main, worker] = linkedEndpoints();
    const onError = vi.fn();
    const sender = new PostMessageMutationTransport(main, {
      maxInFlight: 2,
      onError,
      sessionId: 42,
    });
    sender.enqueue(8, frame(8));
    worker.postMessage({
      frameSeq: 8,
      kind: "doper:mutation-ack",
      sessionId: 41,
      version: 1,
    });
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    worker.postMessage({
      frameSeq: 9,
      kind: "doper:mutation-ack",
      sessionId: 42,
      version: 1,
    });
    await expect(sender.drain()).rejects.toThrow(/out of order/u);
    expect(onError).toHaveBeenCalledOnce();
    expect(() => sender.enqueue(9, frame(9))).toThrow(/out of order/u);
  });

  it("rejects non-contiguous sequences and invalid payloads before sending", () => {
    const [main] = linkedEndpoints();
    const sender = new PostMessageMutationTransport(main, { sessionId: 2 });
    expect(() => sender.enqueue(1, Uint8Array.of(1))).toThrow(/aligned/u);
    sender.enqueue(5, frame(5));
    expect(() => sender.enqueue(7, frame(7))).toThrow(/contiguous/u);
    sender.abort();
  });

  it("fails closed on a malformed current-session response", async () => {
    const [main, worker] = linkedEndpoints();
    const onError = vi.fn();
    const sender = new PostMessageMutationTransport(main, { onError, sessionId: 5 });
    sender.enqueue(1, frame(1));
    worker.postMessage({ kind: "doper:mutation-ack", sessionId: 5, version: 1 });
    await expect(sender.drain()).rejects.toThrow(/malformed/u);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("times out a stalled Worker and rejects every drain waiter", async () => {
    vi.useFakeTimers();
    const [main] = linkedEndpoints();
    const onError = vi.fn();
    const sender = new PostMessageMutationTransport(main, {
      acknowledgementTimeoutMs: 25,
      onError,
      sessionId: 6,
    });
    sender.enqueue(1, frame(1));
    const first = sender.drain().catch((error: unknown) => error);
    const second = sender.drain().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    const firstError = await first;
    const secondError = await second;
    expect(firstError).toBeInstanceOf(Error);
    expect(secondError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toMatch(/timed out/u);
    expect((secondError as Error).message).toMatch(/timed out/u);
    expect(sender.metrics()).toMatchObject({ timeouts: 1 });
    expect(onError).toHaveBeenCalledOnce();
  });
});

interface TestEndpoint {
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
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
    postMessage: (message, transfer = []) => {
      const clone = structuredClone(message, { transfer: [...transfer] });
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
