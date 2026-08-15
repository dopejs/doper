import { describe, expect, it, vi } from "vitest";

import { RenderWorkerClient } from "./worker-client";

describe("RenderWorkerClient", () => {
  it("performs prepare/activate/shutdown handshakes and forwards diagnostics", async () => {
    const worker = new FakeWorker();
    const onFrame = vi.fn();
    const onClockMetrics = vi.fn();
    const onVirtualRefills = vi.fn();
    const client = new RenderWorkerClient(worker, {
      onClockMetrics,
      onFrame,
      onVirtualRefills,
      sessionId: 9,
    });
    worker.onPost = (message) => {
      if (hasKind(message, "doper:prepare")) {
        worker.emitMessage({
          capabilities: { offscreenCanvas: true, sharedArrayBuffer: true },
          kind: "doper:prepared",
          sessionId: 9,
        });
      } else if (hasKind(message, "doper:activate")) {
        worker.emitMessage({ kind: "doper:ready", mode: "post-message", sessionId: 9 });
      } else if (hasKind(message, "doper:shutdown")) {
        worker.emitMessage({ kind: "doper:shutdown-complete", sessionId: 9 });
      }
    };

    await expect(client.prepare()).resolves.toEqual({
      offscreenCanvas: true,
      sharedArrayBuffer: true,
    });
    expect(client.state).toBe("prepared");
    await client.activate({
      canvas: {} as OffscreenCanvas,
      height: 100,
      mode: "post-message",
      rasterCache: true,
      width: 200,
    });
    expect(client.state).toBe("ready");
    worker.emitMessage({
      kind: "doper:frame",
      report: {
        commands: 1,
        displayListBytes: 16,
        maximumPictureDepth: 0,
        mutationBytes: 20,
        pictures: 0,
      },
      sessionId: 9,
    });
    worker.emitMessage({
      kind: "doper:clock-metrics",
      metrics: {
        acceptedAnchors: 1,
        anchoredFrames: 2,
        frames: 3,
        ignoredAnchors: 0,
        maximumFrameGapMs: 17,
        overruns: 0,
        running: true,
        selfDrivenFrames: 1,
      },
      sessionId: 9,
    });
    worker.emitMessage({
      kind: "doper:virtual-refill",
      requests: [{ nodeId: 0x0010_0001, start: 4, end: 8 }],
      sessionId: 9,
    });
    expect(onFrame).toHaveBeenCalledOnce();
    expect(onClockMetrics).toHaveBeenCalledOnce();
    expect(onVirtualRefills).toHaveBeenCalledWith([{ nodeId: 0x0010_0001, start: 4, end: 8 }]);
    client.postClockAnchor(1, 123);
    expect(worker.posts.at(-1)).toMatchObject({ kind: "doper:clock-anchor", sequence: 1 });
    const input = Uint8Array.of(1, 2, 3, 4);
    client.postInput(input);
    expect(worker.posts.at(-1)).toMatchObject({ kind: "doper:input", bytes: input });
    expect((worker.posts.at(-1) as { bytes: Uint8Array }).bytes).not.toBe(input);
    expect(input).toEqual(Uint8Array.of(1, 2, 3, 4));
    await client.close();
    expect(client.state).toBe("closed");
    expect(worker.terminated).toBe(true);
  });

  it("rejects activation contract errors before transferring canvas", async () => {
    const worker = preparedWorker(3);
    const client = new RenderWorkerClient(worker, { sessionId: 3 });
    await client.prepare();
    await expect(
      client.activate({
        canvas: {} as OffscreenCanvas,
        height: 1,
        mode: "sab",
        rasterCache: true,
        width: 1,
      }),
    ).rejects.toThrow(/ring buffer/u);
    expect(client.state).toBe("prepared");
    client.terminate();
  });

  it("fails activation when the Worker acknowledges a different transport mode", async () => {
    const worker = preparedWorker(14);
    const onFatal = vi.fn();
    const client = new RenderWorkerClient(worker, { onFatal, sessionId: 14 });
    await client.prepare();
    worker.onPost = (message) => {
      if (hasKind(message, "doper:activate")) {
        worker.emitMessage({ kind: "doper:ready", mode: "post-message", sessionId: 14 });
      }
    };

    await expect(
      client.activate({
        canvas: {} as OffscreenCanvas,
        height: 1,
        mode: "sab",
        rasterCache: true,
        inputRingBuffer: new SharedArrayBuffer(64),
        ringBuffer: new SharedArrayBuffer(64),
        width: 1,
      }),
    ).rejects.toThrow(/expected sab/u);
    expect(client.state).toBe("failed");
    expect(onFatal).toHaveBeenCalledOnce();
    client.terminate();
  });

  it("fails pending work on Worker crash and reports fatal exactly once", async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new RenderWorkerClient(worker, { onFatal, sessionId: 4 });
    const preparing = client.prepare();
    worker.emitError("synthetic crash");
    await expect(preparing).rejects.toThrow(/synthetic crash/u);
    expect(client.state).toBe("failed");
    expect(onFatal).toHaveBeenCalledOnce();
    worker.emitError("duplicate crash");
    expect(onFatal).toHaveBeenCalledOnce();
    client.terminate();
  });

  it("ignores stale-session messages during replacement", async () => {
    const worker = new FakeWorker();
    const client = new RenderWorkerClient(worker, { sessionId: 12 });
    const preparing = client.prepare();
    worker.emitMessage({ kind: "doper:prepared", sessionId: 11 });
    worker.emitMessage({
      capabilities: { offscreenCanvas: false, sharedArrayBuffer: false },
      kind: "doper:prepared",
      sessionId: 11,
    });
    expect(client.state).toBe("preparing");
    worker.emitMessage({
      capabilities: { offscreenCanvas: true, sharedArrayBuffer: false },
      kind: "doper:prepared",
      sessionId: 12,
    });
    await preparing;
    expect(client.capabilities?.offscreenCanvas).toBe(true);
    client.terminate();
  });

  it("fails the active handshake on a malformed lifecycle response", async () => {
    const worker = new FakeWorker();
    const onFatal = vi.fn();
    const client = new RenderWorkerClient(worker, { onFatal, sessionId: 13 });
    const preparing = client.prepare();
    worker.emitMessage({ kind: "doper:prepared", sessionId: 13 });
    await expect(preparing).rejects.toThrow(/malformed/u);
    expect(client.state).toBe("failed");
    expect(onFatal).toHaveBeenCalledOnce();
    client.terminate();
  });
});

type Listener = (event: never) => void;

class FakeWorker {
  readonly #listeners = {
    error: new Set<Listener>(),
    message: new Set<Listener>(),
    messageerror: new Set<Listener>(),
  };
  public onPost: ((message: unknown) => void) | undefined;
  public readonly posts: unknown[] = [];
  public terminated = false;

  public addEventListener(type: "error" | "message" | "messageerror", listener: Listener): void {
    this.#listeners[type].add(listener);
  }

  public removeEventListener(type: "error" | "message" | "messageerror", listener: Listener): void {
    this.#listeners[type].delete(listener);
  }

  public postMessage(message: unknown): void {
    this.posts.push(message);
    this.onPost?.(message);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public emitMessage(data: unknown): void {
    for (const listener of this.#listeners.message) listener({ data } as never);
  }

  public emitError(message: string): void {
    for (const listener of this.#listeners.error) {
      listener({ error: new Error(message), message } as never);
    }
  }
}

function preparedWorker(sessionId: number): FakeWorker {
  const worker = new FakeWorker();
  worker.onPost = (message) => {
    if (hasKind(message, "doper:prepare")) {
      worker.emitMessage({
        capabilities: { offscreenCanvas: true, sharedArrayBuffer: true },
        kind: "doper:prepared",
        sessionId,
      });
    }
  };
  return worker;
}

function hasKind(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === kind;
}
