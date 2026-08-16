import { ABI_VERSION } from "./generated";
import type { FrameReport } from "./main-thread";
import type { NonPassiveRegion, VirtualRefillRange } from "./main-thread";
import type { HostTransportMode } from "./capabilities";
import type { RenderClockMetrics } from "./render-clock";
import type { EditTransaction, EventTransaction } from "@dopejs/doper-editing";
import {
  WORKER_PROTOCOL_VERSION,
  isRenderWorkerOutboundEnvelope,
  isRenderWorkerOutboundMessage,
  type RenderWorkerCapabilities,
  type WorkerActivateMessage,
  type WorkerClockAnchorMessage,
  type WorkerInputMessage,
  type WorkerInputWakeMessage,
  type WorkerPrepareMessage,
  type WorkerShutdownMessage,
} from "./worker-protocol";

export type RenderWorkerState =
  "created" | "preparing" | "prepared" | "activating" | "ready" | "failed" | "closed";

interface WorkerLike {
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: "messageerror", listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "messageerror", listener: (event: MessageEvent<unknown>) => void): void;
  terminate(): void;
}

export interface RenderWorkerClientOptions {
  readonly initializationTimeoutMs?: number;
  readonly onClockMetrics?: (metrics: RenderClockMetrics) => void;
  readonly onFatal?: (error: Error) => void;
  readonly onFrame?: (report: FrameReport) => void;
  readonly onVirtualRefills?: (requests: readonly VirtualRefillRange[]) => void;
  readonly onEditTransaction?: (transaction: EditTransaction) => void;
  readonly onEventTransaction?: (transaction: EventTransaction) => void;
  readonly onNonPassiveRegions?: (regions: readonly NonPassiveRegion[]) => void;
  readonly sessionId: number;
}

export interface RenderWorkerActivation {
  readonly canvas: OffscreenCanvas;
  readonly height: number;
  readonly mode: Exclude<HostTransportMode, "main-thread">;
  readonly rasterCache: boolean;
  readonly inputRingBuffer?: SharedArrayBuffer;
  readonly ringBuffer?: SharedArrayBuffer;
  readonly width: number;
}

/** Main-side lifecycle and handshake owner for one replaceable render Worker. */
export class RenderWorkerClient {
  readonly #initializationTimeoutMs: number;
  readonly #onClockMetrics: ((metrics: RenderClockMetrics) => void) | undefined;
  readonly #onFatal: ((error: Error) => void) | undefined;
  readonly #onFrame: ((report: FrameReport) => void) | undefined;
  readonly #onVirtualRefills: ((requests: readonly VirtualRefillRange[]) => void) | undefined;
  readonly #onEditTransaction: ((transaction: EditTransaction) => void) | undefined;
  readonly #onEventTransaction: ((transaction: EventTransaction) => void) | undefined;
  readonly #onNonPassiveRegions: ((regions: readonly NonPassiveRegion[]) => void) | undefined;
  readonly #sessionId: number;
  readonly #worker: WorkerLike;
  #capabilities: RenderWorkerCapabilities | undefined;
  #fatalError: Error | undefined;
  #pending:
    | {
        readonly expected: "doper:prepared" | "doper:ready" | "doper:shutdown-complete";
        readonly reject: (error: Error) => void;
        readonly resolve: () => void;
        readonly timer: number;
      }
    | undefined;
  #readyMode: Exclude<HostTransportMode, "main-thread"> | undefined;
  #state: RenderWorkerState = "created";

  public constructor(worker: WorkerLike, options: RenderWorkerClientOptions) {
    this.#worker = worker;
    this.#sessionId = positiveU32(options.sessionId, "sessionId");
    this.#initializationTimeoutMs = boundedTimeout(options.initializationTimeoutMs ?? 10_000);
    this.#onClockMetrics = options.onClockMetrics;
    this.#onFatal = options.onFatal;
    this.#onFrame = options.onFrame;
    this.#onVirtualRefills = options.onVirtualRefills;
    this.#onEditTransaction = options.onEditTransaction;
    this.#onEventTransaction = options.onEventTransaction;
    this.#onNonPassiveRegions = options.onNonPassiveRegions;
    worker.addEventListener("message", this.#handleMessage);
    worker.addEventListener("error", this.#handleError);
    worker.addEventListener("messageerror", this.#handleMessageError);
  }

  public get capabilities(): RenderWorkerCapabilities | undefined {
    return this.#capabilities;
  }

  public get endpoint(): WorkerLike {
    return this.#worker;
  }

  public get sessionId(): number {
    return this.#sessionId;
  }

  public get state(): RenderWorkerState {
    return this.#state;
  }

  public async prepare(): Promise<RenderWorkerCapabilities> {
    this.requireState("created");
    this.#state = "preparing";
    const message: WorkerPrepareMessage = {
      abiVersion: ABI_VERSION,
      kind: "doper:prepare",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      sessionId: this.#sessionId,
    };
    try {
      await this.request("doper:prepared", message);
    } catch (cause) {
      const error = toError(cause, "render Worker prepare failed");
      this.fail(error);
      throw error;
    }
    const capabilities = this.#capabilities;
    if (capabilities === undefined) {
      const error = new Error("render Worker omitted capabilities from prepare response");
      this.fail(error);
      throw error;
    }
    this.#state = "prepared";
    return capabilities;
  }

  public async activate(activation: RenderWorkerActivation): Promise<void> {
    this.requireState("prepared");
    const width = positiveFinite(activation.width, "Worker viewport width");
    const height = positiveFinite(activation.height, "Worker viewport height");
    if (
      activation.mode === "sab" &&
      (activation.ringBuffer === undefined || activation.inputRingBuffer === undefined)
    ) {
      throw new Error("SAB Worker activation requires mutation and input ring buffers");
    }
    this.#state = "activating";
    this.#readyMode = undefined;
    const message: WorkerActivateMessage = {
      canvas: activation.canvas,
      height,
      kind: "doper:activate",
      mode: activation.mode,
      rasterCache: activation.rasterCache,
      ...(activation.inputRingBuffer === undefined
        ? {}
        : { inputRingBuffer: activation.inputRingBuffer }),
      ...(activation.ringBuffer === undefined ? {} : { ringBuffer: activation.ringBuffer }),
      sessionId: this.#sessionId,
      width,
    };
    try {
      await this.request("doper:ready", message, [activation.canvas]);
      if (this.#readyMode !== activation.mode) {
        throw new Error(
          `render Worker activated ${String(this.#readyMode)}, expected ${activation.mode}`,
        );
      }
      this.#readyMode = undefined;
      this.#state = "ready";
    } catch (cause) {
      const error = toError(cause, "render Worker activation failed");
      this.fail(error);
      throw error;
    }
  }

  public postClockAnchor(sequence: number, timestamp: number): void {
    if (this.#state !== "ready") return;
    const message: WorkerClockAnchorMessage = {
      kind: "doper:clock-anchor",
      sequence: positiveU32(sequence, "clock anchor sequence"),
      sessionId: this.#sessionId,
      timestamp: finite(timestamp, "clock anchor timestamp"),
    };
    this.#worker.postMessage(message);
  }

  /** Transfers one immutable Input Stream transaction to the active Worker. */
  public postInput(bytes: Uint8Array): void {
    this.requireState("ready");
    const owned = bytes.slice();
    const message: WorkerInputMessage = {
      bytes: owned,
      kind: "doper:input",
      sessionId: this.#sessionId,
    };
    this.#worker.postMessage(message, [owned.buffer]);
  }

  /** Wakes the Worker to drain committed Input Stream slots without copying payload bytes. */
  public postInputWake(): void {
    this.requireState("ready");
    const message: WorkerInputWakeMessage = {
      kind: "doper:input-wake",
      sessionId: this.#sessionId,
    };
    this.#worker.postMessage(message);
  }

  public async close(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "failed" || this.#state === "created") {
      this.terminate();
      return;
    }
    const message: WorkerShutdownMessage = {
      kind: "doper:shutdown",
      sessionId: this.#sessionId,
    };
    try {
      await this.request("doper:shutdown-complete", message);
    } catch {
      // Shutdown is best-effort; terminate is the bounded completion guarantee.
    }
    this.terminate();
  }

  public terminate(): void {
    if (this.#state === "closed") return;
    this.rejectPending(new Error("render Worker terminated"));
    this.detach();
    this.#worker.terminate();
    this.#state = "closed";
  }

  readonly #handleMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isRenderWorkerOutboundMessage(message)) {
      if (isRenderWorkerOutboundEnvelope(message)) {
        const candidateSession =
          typeof message === "object" && message !== null
            ? (message as { sessionId?: unknown }).sessionId
            : undefined;
        if (
          typeof candidateSession === "number" &&
          Number.isInteger(candidateSession) &&
          candidateSession !== this.#sessionId
        )
          return;
        this.fail(new Error("render Worker response is malformed"));
      }
      return;
    }
    if (message.sessionId !== this.#sessionId) return;
    switch (message.kind) {
      case "doper:prepared":
        this.#capabilities = message.capabilities;
        this.resolvePending(message.kind);
        return;
      case "doper:ready":
        this.#readyMode = message.mode;
        this.resolvePending(message.kind);
        return;
      case "doper:shutdown-complete":
        this.resolvePending(message.kind);
        return;
      case "doper:frame":
        if (this.#state === "ready") this.#onFrame?.(message.report);
        return;
      case "doper:clock-metrics":
        if (this.#state === "ready") this.#onClockMetrics?.(message.metrics);
        return;
      case "doper:virtual-refill":
        if (this.#state === "ready") this.#onVirtualRefills?.(message.requests);
        return;
      case "doper:edit-transaction":
        if (this.#state === "ready") this.#onEditTransaction?.(message.transaction);
        return;
      case "doper:event-transaction":
        if (this.#state === "ready") this.#onEventTransaction?.(message.transaction);
        return;
      case "doper:non-passive-regions":
        if (this.#state === "ready") this.#onNonPassiveRegions?.(message.regions);
        return;
      case "doper:fatal":
        this.fail(new Error(`render Worker failed: ${message.error}`));
    }
  };

  readonly #handleError = (event: ErrorEvent): void => {
    this.fail(new Error(event.message || "render Worker crashed", { cause: event.error }));
  };

  readonly #handleMessageError = (): void => {
    this.fail(new Error("render Worker message could not be deserialized"));
  };

  private request(
    expected: "doper:prepared" | "doper:ready" | "doper:shutdown-complete",
    message: unknown,
    transfer: readonly Transferable[] = [],
  ): Promise<void> {
    if (this.#pending !== undefined) throw new Error("render Worker already has a pending request");
    return new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        if (this.#pending?.expected !== expected) return;
        this.#pending = undefined;
        reject(new Error(`render Worker ${expected} handshake timed out`));
      }, this.#initializationTimeoutMs);
      this.#pending = { expected, reject, resolve, timer };
      try {
        this.#worker.postMessage(message, transfer);
      } catch (cause) {
        clearTimeout(timer);
        this.#pending = undefined;
        reject(toError(cause, "render Worker message failed"));
      }
    });
  }

  private resolvePending(kind: "doper:prepared" | "doper:ready" | "doper:shutdown-complete"): void {
    const pending = this.#pending;
    if (pending === undefined || pending.expected !== kind) {
      this.fail(new Error(`unexpected render Worker response ${kind}`));
      return;
    }
    clearTimeout(pending.timer);
    this.#pending = undefined;
    pending.resolve();
  }

  private rejectPending(error: Error): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending = undefined;
    pending.reject(error);
  }

  private requireState(expected: RenderWorkerState): void {
    if (this.#state !== expected) {
      throw this.#fatalError ?? new Error(`render Worker is ${this.#state}, expected ${expected}`);
    }
  }

  private fail(error: Error): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#fatalError = error;
    this.#state = "failed";
    this.rejectPending(error);
    this.#onFatal?.(error);
  }

  private detach(): void {
    this.#worker.removeEventListener("message", this.#handleMessage);
    this.#worker.removeEventListener("error", this.#handleError);
    this.#worker.removeEventListener("messageerror", this.#handleMessageError);
  }
}

/** Default bundler-resolved production Worker factory. */
export function createRenderWorker(): Worker {
  return new Worker(new URL("./render-worker", import.meta.url), {
    name: "doper-render",
    type: "module",
  });
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 60_000) {
    throw new RangeError("initializationTimeoutMs must be from 1 to 60000");
  }
  return value;
}

function positiveU32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new RangeError(`${label} must be a positive u32`);
  }
  return value;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function toError(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}
