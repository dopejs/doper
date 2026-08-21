import { describe, expect, it, vi } from "vitest";

import { RenderWorkerClient } from "./worker-client";

describe("RenderWorkerClient", () => {
  it("performs prepare/activate/shutdown handshakes and forwards diagnostics", async () => {
    const worker = new FakeWorker();
    const onFrame = vi.fn();
    const onClockMetrics = vi.fn();
    const onVirtualRefills = vi.fn();
    const onEventTransaction = vi.fn();
    const onNonPassiveRegions = vi.fn();
    const client = new RenderWorkerClient(worker, {
      onClockMetrics,
      onFrame,
      onVirtualRefills,
      onEventTransaction,
      onNonPassiveRegions,
      sessionId: 9,
    });
    worker.onPost = (message) => {
      if (hasKind(message, "pingo:prepare")) {
        worker.emitMessage({
          capabilities: { offscreenCanvas: true, sharedArrayBuffer: true },
          kind: "pingo:prepared",
          sessionId: 9,
        });
      } else if (hasKind(message, "pingo:activate")) {
        worker.emitMessage({ kind: "pingo:ready", mode: "post-message", sessionId: 9 });
      } else if (hasKind(message, "pingo:shutdown")) {
        worker.emitMessage({ kind: "pingo:shutdown-complete", sessionId: 9 });
      }
    };

    await expect(client.prepare()).resolves.toEqual({
      offscreenCanvas: true,
      sharedArrayBuffer: true,
    });
    expect(client.state).toBe("prepared");
    await client.activate({
      canvas: {} as OffscreenCanvas,
      devicePixelRatio: 1,
      height: 100,
      mode: "post-message",
      rasterCache: true,
      reducedMotion: false,
      width: 200,
    });
    expect(client.state).toBe("ready");
    client.postReducedMotion(true);
    expect(worker.posts.at(-1)).toEqual({
      kind: "pingo:reduced-motion",
      reduced: true,
      sessionId: 9,
    });
    worker.emitMessage({
      kind: "pingo:frame",
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
      kind: "pingo:clock-metrics",
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
      kind: "pingo:virtual-refill",
      requests: [{ nodeId: 0x0010_0001, start: 4, end: 8 }],
      sessionId: 9,
    });
    expect(onFrame).toHaveBeenCalledOnce();
    expect(onClockMetrics).toHaveBeenCalledOnce();
    expect(onVirtualRefills).toHaveBeenCalledWith([{ nodeId: 0x0010_0001, start: 4, end: 8 }]);
    worker.emitMessage({
      kind: "pingo:event-transaction",
      sessionId: 9,
      transaction: {
        eventId: 1,
        kind: "click",
        target: 2,
        x: 1,
        y: 2,
        deltaX: 0,
        deltaY: 0,
        buttons: 0,
        modifiers: 0,
        pointerId: 0,
        elapsedMicros: 16_667,
        relatedTarget: null,
        cursor: "auto",
        pointerType: "none",
        isPrimary: false,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
        width: 0,
        height: 0,
        path: [1, 2],
      },
    });
    expect(onEventTransaction).toHaveBeenCalledOnce();
    worker.emitMessage({
      kind: "pingo:non-passive-regions",
      regions: [{ flags: 1, left: 0, top: 0, right: 50, bottom: 40 }],
      sessionId: 9,
    });
    expect(onNonPassiveRegions).toHaveBeenCalledWith([
      { flags: 1, left: 0, top: 0, right: 50, bottom: 40 },
    ]);
    client.postClockAnchor(1, 123);
    expect(worker.posts.at(-1)).toMatchObject({ kind: "pingo:clock-anchor", sequence: 1 });
    const input = Uint8Array.of(1, 2, 3, 4);
    client.postInput(input);
    expect(worker.posts.at(-1)).toMatchObject({ kind: "pingo:input", bytes: input });
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
        devicePixelRatio: 1,
        height: 1,
        mode: "sab",
        rasterCache: true,
        reducedMotion: false,
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
      if (hasKind(message, "pingo:activate")) {
        worker.emitMessage({ kind: "pingo:ready", mode: "post-message", sessionId: 14 });
      }
    };

    await expect(
      client.activate({
        canvas: {} as OffscreenCanvas,
        devicePixelRatio: 1,
        height: 1,
        mode: "sab",
        rasterCache: true,
        reducedMotion: false,
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
    worker.emitMessage({ kind: "pingo:prepared", sessionId: 11 });
    worker.emitMessage({
      capabilities: { offscreenCanvas: false, sharedArrayBuffer: false },
      kind: "pingo:prepared",
      sessionId: 11,
    });
    expect(client.state).toBe("preparing");
    worker.emitMessage({
      capabilities: { offscreenCanvas: true, sharedArrayBuffer: false },
      kind: "pingo:prepared",
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
    worker.emitMessage({ kind: "pingo:prepared", sessionId: 13 });
    await expect(preparing).rejects.toThrow(/malformed/u);
    expect(client.state).toBe("failed");
    expect(onFatal).toHaveBeenCalledOnce();
    client.terminate();
  });

  it("closes a media transferable when Worker submission fails", async () => {
    const worker = preparedWorker(15);
    const client = new RenderWorkerClient(worker, { sessionId: 15 });
    await client.prepare();
    worker.onPost = (message) => {
      if (hasKind(message, "pingo:activate")) {
        worker.emitMessage({ kind: "pingo:ready", mode: "post-message", sessionId: 15 });
      }
    };
    await client.activate({
      canvas: {} as OffscreenCanvas,
      devicePixelRatio: 1,
      height: 1,
      mode: "post-message",
      rasterCache: false,
      reducedMotion: false,
      width: 1,
    });
    const close = vi.fn();
    worker.postError = new Error("transfer failed");
    expect(() =>
      client.postMediaFrame(4, { close } as unknown as CanvasImageSource, "video-frame"),
    ).toThrow(/transfer failed/u);
    expect(close).toHaveBeenCalledOnce();
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
  public postError: Error | undefined;
  public terminated = false;

  public addEventListener(type: "error" | "message" | "messageerror", listener: Listener): void {
    this.#listeners[type].add(listener);
  }

  public removeEventListener(type: "error" | "message" | "messageerror", listener: Listener): void {
    this.#listeners[type].delete(listener);
  }

  public postMessage(message: unknown): void {
    if (this.postError !== undefined) throw this.postError;
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
    if (hasKind(message, "pingo:prepare")) {
      worker.emitMessage({
        capabilities: { offscreenCanvas: true, sharedArrayBuffer: true },
        kind: "pingo:prepared",
        sessionId,
      });
    }
  };
  return worker;
}

function hasKind(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === kind;
}
