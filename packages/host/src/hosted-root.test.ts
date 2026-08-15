import { ABI_VERSION } from "@dopejs/doper-reconciler";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHostedCanvasRoot } from "./hosted-root";
import type { CoreClient } from "./main-thread";

const DISPLAY_LIST_MAGIC = 0x4450_4f44;

afterEach(() => vi.unstubAllGlobals());

describe("createHostedCanvasRoot", () => {
  it("uses the deterministic main-thread path when Worker policy is disabled", async () => {
    installCanvasGlobal();
    const canvas = new FakeCanvas();
    const core = fakeCore();
    const onModeChange = vi.fn();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      coreFactory: () => Promise.resolve(core),
      onModeChange,
      transport: { pageWorkerEnabled: false },
    });
    expect(root.mode).toBe("main-thread");
    root.render(undefined);
    expect(core.commits).toHaveLength(1);
    await root.close();
    expect(core.commits).toHaveLength(2);
    expect(core.freed).toBe(true);
    expect(onModeChange).toHaveBeenCalledWith("main-thread", expect.any(Object));
  });

  it("falls back before canvas transfer when Worker preparation fails", async () => {
    installCanvasGlobal();
    const canvas = new FakeCanvas();
    const worker = new FakeWorker();
    worker.onPost = (message) => {
      if (hasKind(message, "doper:prepare")) {
        worker.emitMessage({
          error: "WASM unavailable",
          kind: "doper:fatal",
          sessionId: sessionOf(message),
        });
      }
    };
    const onHostError = vi.fn();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: allCapabilities(),
      clockAnchorDriver: null,
      coreFactory: () => Promise.resolve(fakeCore()),
      onHostError,
      workerFactory: () => worker as unknown as Worker,
    });
    expect(root.mode).toBe("main-thread");
    expect(canvas.transferCount).toBe(0);
    expect(worker.terminated).toBe(true);
    expect((onHostError.mock.calls[0]?.[0] as Error | undefined)?.message).toMatch(
      /WASM unavailable/u,
    );
    await root.close();
  });

  it("replaces a transferred canvas and rebuilds current Scene after Worker crash", async () => {
    installCanvasGlobal();
    const canvas = new FakeCanvas();
    const worker = readyWorker();
    const fallbackCore = fakeCore();
    const modes: string[] = [];
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: { ...allCapabilities(), crossOriginIsolated: false },
      clockAnchorDriver: null,
      coreFactory: () => Promise.resolve(fallbackCore),
      onModeChange: (mode) => modes.push(mode),
      workerFactory: () => worker as unknown as Worker,
    });
    expect(root.mode).toBe("post-message");
    root.render(undefined);
    await Promise.resolve();
    worker.emitError("synthetic render crash");
    await waitFor(() => root.mode === "main-thread");

    expect(root.canvas).not.toBe(canvas);
    expect(canvas.replacement).toBe(root.canvas);
    expect(fallbackCore.commits).toHaveLength(1);
    expect(modes).toEqual(["post-message", "main-thread"]);
    await root.close();
    expect(fallbackCore.commits).toHaveLength(2);
  });

  it("detects a stalled Worker and recovers the last accepted Shell state", async () => {
    installCanvasGlobal();
    const canvas = new FakeCanvas();
    const worker = readyWorker(false);
    const fallbackCore = fakeCore();
    const onHostError = vi.fn();
    const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
      capabilities: { ...allCapabilities(), crossOriginIsolated: false },
      clockAnchorDriver: null,
      coreFactory: () => Promise.resolve(fallbackCore),
      mutationAcknowledgementTimeoutMs: 5,
      onHostError,
      workerFactory: () => worker as unknown as Worker,
    });
    root.render(undefined);
    await waitFor(() => root.mode === "main-thread");
    expect(fallbackCore.commits).toHaveLength(1);
    expect((onHostError.mock.calls[0]?.[0] as Error | undefined)?.message).toMatch(/timed out/u);
    await root.close();
  });

  it("treats bounded transport exhaustion as recoverable and rebuilds the latest Scene", async () => {
    for (const preference of ["post-message", "sab"] as const) {
      installCanvasGlobal();
      const canvas = new FakeCanvas();
      const worker = readyWorker(false);
      const fallbackCore = fakeCore();
      const onHostError = vi.fn();
      const root = await createHostedCanvasRoot(canvas as unknown as HTMLCanvasElement, {
        capabilities: allCapabilities(),
        clockAnchorDriver: null,
        coreFactory: () => Promise.resolve(fallbackCore),
        mutationBufferBytes: 4,
        onHostError,
        transport: { preference, strict: true },
        workerFactory: () => worker as unknown as Worker,
      });

      root.render("latest state");
      await waitFor(() => root.mode === "main-thread");

      expect(root.failed).toBe(false);
      expect(fallbackCore.commits).toHaveLength(1);
      expect(root.transportMetrics()).toMatchObject({ mode: preference, rejected: 1 });
      expect((onHostError.mock.calls[0]?.[0] as Error | undefined)?.message).toMatch(/buffer/u);
      await root.close();
    }
  });
});

class FakeCanvas {
  public height = 80;
  public width = 160;
  public replacement: unknown;
  public transferCount = 0;

  public cloneNode(): FakeCanvas {
    const clone = new FakeCanvas();
    clone.height = this.height;
    clone.width = this.width;
    return clone;
  }

  public getContext(): object {
    return {
      canvas: this,
      clearRect() {},
      drawImage() {},
      resetTransform() {},
      restore() {},
      save() {},
      translate() {},
    };
  }

  public replaceWith(replacement: unknown): void {
    this.replacement = replacement;
  }

  public transferControlToOffscreen(): object {
    this.transferCount += 1;
    return {};
  }
}

interface FakeCore extends CoreClient {
  readonly commits: Uint8Array[];
  freed: boolean;
}

function fakeCore(): FakeCore {
  const commits: Uint8Array[] = [];
  return {
    commit: (bytes) => {
      commits.push(bytes.slice());
      return emptyDisplayList();
    },
    commits,
    free() {
      this.freed = true;
    },
    freed: false,
  };
}

type Listener = (event: never) => void;

class FakeWorker {
  readonly #listeners = {
    error: new Set<Listener>(),
    message: new Set<Listener>(),
    messageerror: new Set<Listener>(),
  };
  public onPost: ((message: unknown) => void) | undefined;
  public terminated = false;

  public addEventListener(type: "error" | "message" | "messageerror", listener: Listener): void {
    this.#listeners[type].add(listener);
  }

  public removeEventListener(type: "error" | "message" | "messageerror", listener: Listener): void {
    this.#listeners[type].delete(listener);
  }

  public postMessage(message: unknown): void {
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

function readyWorker(acknowledgeMutations = true): FakeWorker {
  const worker = new FakeWorker();
  let sessionId = 0;
  worker.onPost = (message) => {
    if (hasKind(message, "doper:prepare")) {
      sessionId = sessionOf(message);
      worker.emitMessage({
        capabilities: { offscreenCanvas: true, sharedArrayBuffer: true },
        kind: "doper:prepared",
        sessionId,
      });
    } else if (hasKind(message, "doper:activate")) {
      worker.emitMessage({
        kind: "doper:ready",
        mode: (message as { mode: "post-message" | "sab" }).mode,
        sessionId,
      });
    } else if (hasKind(message, "doper:mutation")) {
      if (!acknowledgeMutations) return;
      const frameSeq = (message as { frameSeq: number }).frameSeq;
      queueMicrotask(() => {
        worker.emitMessage({ frameSeq, kind: "doper:mutation-ack", sessionId, version: 1 });
      });
    } else if (hasKind(message, "doper:shutdown")) {
      worker.emitMessage({ kind: "doper:shutdown-complete", sessionId });
    }
  };
  return worker;
}

function sessionOf(value: unknown): number {
  if (typeof value !== "object" || value === null) throw new Error("message is not an object");
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "number") throw new Error("message session is missing");
  return sessionId;
}

function installCanvasGlobal(): void {
  vi.stubGlobal("HTMLCanvasElement", FakeCanvas);
}

function allCapabilities() {
  return {
    crossOriginIsolated: true,
    offscreenCanvas: true,
    sharedArrayBuffer: true,
    transferableCanvas: true,
    worker: true,
  } as const;
}

function emptyDisplayList(): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, DISPLAY_LIST_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, 16, true);
  view.setUint32(8, 16, true);
  return bytes;
}

function hasKind(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === kind;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}
