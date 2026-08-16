import {
  createRoot,
  decodeMutationBatch,
  type CoreDrivenDoperRoot,
  type DoperRoot,
  type MutationSink,
  type RootOptions,
} from "@dopejs/doper-reconciler";
import { decodeInputBatch, encodeInputBatch, type InputCommand } from "@dopejs/doper-editing";

import { MAX_INPUT_BYTES, MAX_MUTATION_BYTES } from "./generated";
import {
  CanvasFrameSink,
  createDefaultRasterCache,
  type CoreClient,
  type FrameReport,
  type VirtualRefillRange,
} from "./main-thread";
import {
  detectHostCapabilities,
  selectHostTransport,
  type CapabilityEnvironment,
  type HostCapabilities,
  type HostTransportDecision,
  type HostTransportMode,
  type HostTransportPolicy,
} from "./capabilities";
import { PostMessageMutationTransport, type PostMessageTransportMetrics } from "./post-message";
import { SabMutationRing, type SabMutationRingMetrics } from "./sab-ring";
import { SabMutationTransport, type SabMutationTransportMetrics } from "./sab-transport";
import { MutationSceneSnapshot } from "./scene-snapshot";
import { MutationTransportBackpressureError } from "./transport-errors";
import { createWasmCore } from "./wasm";
import {
  createRenderWorker,
  RenderWorkerClient,
  type RenderWorkerClientOptions,
} from "./worker-client";
import type { RenderClockMetrics } from "./render-clock";

interface MutationTransport {
  abort(reason?: Error): void;
  close(): Promise<void>;
  enqueue(frameSeq: number, bytes: Uint8Array): void;
  metrics(): HostMutationTransportMetrics;
}

export type HostMutationTransportMetrics =
  PostMessageTransportMetrics | SabMutationTransportMetrics;

/** Snapshot of the low-latency Input Stream path selected by the Host. */
export interface HostInputTransportMetrics {
  readonly directFrames: number;
  readonly mode: HostTransportMode;
  readonly ring?: SabMutationRingMetrics;
  readonly sabFallbackFrames: number;
}

export interface ClockAnchorDriver {
  cancel(handle: number): void;
  readonly timeOrigin: number;
  request(callback: (timestamp: number) => void): number;
}

/** Generation-bearing scroll target accepted from a JSX ref or raw host handle. */
export type ScrollTarget = number | { readonly nodeId: number };

export interface HostedCanvasRootOptions extends RootOptions {
  readonly capabilities?: HostCapabilities;
  readonly capabilityEnvironment?: CapabilityEnvironment;
  readonly clockAnchorDriver?: ClockAnchorDriver | null;
  readonly coreFactory?: (width: number, height: number) => Promise<CoreClient>;
  readonly initializationTimeoutMs?: number;
  readonly mutationAcknowledgementTimeoutMs?: number;
  readonly mutationBufferBytes?: number;
  readonly onCanvasReplaced?: (canvas: HTMLCanvasElement, previous: HTMLCanvasElement) => void;
  readonly onClockMetrics?: (metrics: RenderClockMetrics) => void;
  readonly onFrame?: (report: FrameReport) => void;
  readonly onHostError?: (error: Error) => void;
  readonly onModeChange?: (mode: HostTransportMode, decision: HostTransportDecision) => void;
  readonly onVirtualRefills?: (requests: readonly VirtualRefillRange[]) => void;
  readonly rasterCache?: boolean;
  readonly transport?: HostTransportPolicy;
  readonly workerFactory?: () => Worker;
}

/** Public root whose transport can fail over without replacing Shell component state. */
export interface HostedCanvasRoot extends DoperRoot {
  readonly canvas: HTMLCanvasElement;
  readonly decision: HostTransportDecision;
  readonly mode: HostTransportMode;
  close(): Promise<void>;
  dispatchInput(bytes: Uint8Array): void;
  beginScroll(target: ScrollTarget): void;
  scrollBy(target: ScrollTarget, deltaX: number, deltaY: number, elapsedMs: number): void;
  endScroll(target: ScrollTarget): void;
  cancelScroll(target: ScrollTarget): void;
  inputTransportMetrics(): HostInputTransportMetrics;
  transportMetrics(): HostMutationTransportMetrics | undefined;
}

/** Creates the M2 capability-driven Worker root with a production M1 fallback. */
export async function createHostedCanvasRoot(
  canvas: HTMLCanvasElement,
  options: HostedCanvasRootOptions = {},
): Promise<HostedCanvasRoot> {
  const controller = new HostedCanvasRootController(canvas, options);
  await controller.initialize();
  return controller;
}

class HostedCanvasRootController implements HostedCanvasRoot {
  readonly #options: HostedCanvasRootOptions;
  readonly #recoverableSink = new RecoverableMutationSink();
  #anchorHandle: number | undefined;
  #canvas: HTMLCanvasElement;
  #client: RenderWorkerClient | undefined;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #core: CoreClient | undefined;
  #decision: HostTransportDecision;
  #frameSink: CanvasFrameSink | undefined;
  #inputSequence = 1;
  #inputDirectFrames = 0;
  #inputRing: SabMutationRing | undefined;
  #inputSabFallbackFrames = 0;
  #lastInputRingMetrics: SabMutationRingMetrics | undefined;
  #mode: HostTransportMode = "main-thread";
  #lastTransportMetrics: HostMutationTransportMetrics | undefined;
  #mainFrameTimestamp: number | undefined;
  #recovery: Promise<void> | undefined;
  #recovering = false;
  #root: CoreDrivenDoperRoot | undefined;
  #transferred = false;
  #transport: MutationTransport | undefined;
  #unmounted = false;

  public constructor(canvas: HTMLCanvasElement, options: HostedCanvasRootOptions) {
    if (!(canvas instanceof HTMLCanvasElement))
      throw new TypeError("canvas must be HTMLCanvasElement");
    this.#canvas = canvas;
    this.#options = options;
    const capabilities =
      options.capabilities ?? detectHostCapabilities(canvas, options.capabilityEnvironment);
    this.#decision = selectHostTransport(capabilities, options.transport);
  }

  public get canvas(): HTMLCanvasElement {
    return this.#canvas;
  }

  public get decision(): HostTransportDecision {
    return this.#decision;
  }

  public get failed(): boolean {
    return this.requireRoot().failed;
  }

  public get mode(): HostTransportMode {
    return this.#mode;
  }

  /** Current Worker queue state, or the final snapshot retained after runtime fallback. */
  public transportMetrics(): HostMutationTransportMetrics | undefined {
    return this.#transport?.metrics() ?? this.#lastTransportMetrics;
  }

  public inputTransportMetrics(): HostInputTransportMetrics {
    const ring = this.#inputRing?.metrics() ?? this.#lastInputRingMetrics;
    return {
      directFrames: this.#inputDirectFrames,
      mode: this.#mode,
      ...(ring === undefined ? {} : { ring }),
      sabFallbackFrames: this.#inputSabFallbackFrames,
    };
  }

  /** Routes one versioned Input Stream transaction to the current Core owner. */
  public dispatchInput(bytes: Uint8Array): void {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("input must be Uint8Array");
    if (bytes.byteLength > MAX_INPUT_BYTES) throw new RangeError("input exceeds protocol limit");
    const { frameSeq } = decodeInputBatch(bytes);
    if (this.#closing || this.#unmounted) throw new Error("hosted root is closed");
    if (this.#recovering) throw new Error("hosted root is recovering");
    if (this.#mode === "main-thread") {
      const sink = this.#frameSink;
      if (sink === undefined) throw new Error("main-thread Core is not initialized");
      sink.input(bytes);
      this.#inputDirectFrames += 1;
      this.#inputSequence = nextSequence(frameSeq);
      return;
    }
    const client = this.#client;
    if (client === undefined) throw new Error("render Worker is not initialized");
    const inputRing = this.#inputRing;
    if (this.#mode === "sab" && inputRing !== undefined) {
      if (bytes.byteLength <= inputRing.payloadBytes && inputRing.tryPublish(frameSeq, bytes)) {
        client.postInputWake();
      } else {
        // Preserve sequence order: the wake is posted before the copied
        // fallback, so the Worker drains older shared slots first.
        client.postInputWake();
        client.postInput(bytes);
        this.#inputDirectFrames += 1;
        this.#inputSabFallbackFrames += 1;
      }
    } else {
      client.postInput(bytes);
      this.#inputDirectFrames += 1;
    }
    this.#inputSequence = nextSequence(frameSeq);
  }

  /** Starts direct manipulation and cancels an existing fling. */
  public beginScroll(target: ScrollTarget): void {
    this.sendScroll([{ type: "scrollBegin", nodeId: scrollNodeId(target) }]);
  }

  /** Applies one timed logical content-offset sample. */
  public scrollBy(target: ScrollTarget, deltaX: number, deltaY: number, elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs > 1000) {
      throw new RangeError("elapsedMs must be greater than zero and at most 1000");
    }
    const elapsedMicros = Math.max(1, Math.min(1_000_000, Math.round(elapsedMs * 1000)));
    this.sendScroll([
      {
        type: "scrollDelta",
        nodeId: scrollNodeId(target),
        deltaX,
        deltaY,
        elapsedMicros,
      },
    ]);
  }

  /** Ends direct manipulation and starts the Core-estimated fling. */
  public endScroll(target: ScrollTarget): void {
    this.sendScroll([{ type: "scrollEnd", nodeId: scrollNodeId(target) }]);
  }

  /** Cancels direct manipulation and retains only edge rebound. */
  public cancelScroll(target: ScrollTarget): void {
    this.sendScroll([{ type: "scrollCancel", nodeId: scrollNodeId(target) }]);
  }

  public async initialize(): Promise<void> {
    if (this.#root !== undefined) throw new Error("hosted root is already initialized");
    if (this.#decision.mode === "main-thread") {
      await this.initializeMainThread(this.#canvas);
      return;
    }
    try {
      await this.initializeWorker(this.#decision.mode);
    } catch (cause) {
      const error = toError(cause, "render Worker initialization failed");
      this.#options.onHostError?.(error);
      this.disposeWorkerRuntime(error);
      if (this.#transferred) this.#canvas = replaceTransferredCanvas(this.#canvas, this.#options);
      this.#decision = runtimeFallbackDecision(this.#decision, error);
      await this.initializeMainThread(this.#canvas);
    }
  }

  public render(node: Parameters<DoperRoot["render"]>[0]): void {
    this.requireRoot().render(node);
  }

  public flushSync(): void {
    this.requireRoot().flushSync();
  }

  public invokeCallback(callbackId: number): void {
    this.requireRoot().invokeCallback(callbackId);
  }

  public unmount(): void {
    if (this.#unmounted) return;
    this.requireRoot().unmount();
    this.#unmounted = true;
    void this.close().catch((cause: unknown) => {
      this.#options.onHostError?.(toError(cause, "hosted root close failed"));
    });
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.closeOnce();
    return this.#closePromise;
  }

  private async initializeWorker(mode: Exclude<HostTransportMode, "main-thread">): Promise<void> {
    const workerFactory = this.#options.workerFactory ?? createRenderWorker;
    const clientOptions: RenderWorkerClientOptions = {
      ...(this.#options.initializationTimeoutMs === undefined
        ? {}
        : { initializationTimeoutMs: this.#options.initializationTimeoutMs }),
      ...(this.#options.onClockMetrics === undefined
        ? {}
        : { onClockMetrics: this.#options.onClockMetrics }),
      onFatal: (error) => this.handleWorkerFatal(error),
      ...(this.#options.onFrame === undefined ? {} : { onFrame: this.#options.onFrame }),
      onVirtualRefills: (requests) => this.deferVirtualRefills(requests),
      sessionId: nextSessionId(),
    };
    const client = new RenderWorkerClient(workerFactory(), clientOptions);
    this.#client = client;
    const workerCapabilities = await client.prepare();
    if (!workerCapabilities.offscreenCanvas) {
      throw new Error("render Worker reports OffscreenCanvas unavailable");
    }
    let selectedMode = mode;
    if (mode === "sab" && !workerCapabilities.sharedArrayBuffer) {
      if (this.#options.transport?.strict === true) {
        throw new Error("render Worker reports SharedArrayBuffer unavailable");
      }
      selectedMode = "post-message";
      this.#decision = {
        ...this.#decision,
        mode: selectedMode,
        reasons: [
          ...this.#decision.reasons,
          "Worker SAB unavailable",
          "falling back to post-message",
        ],
      };
    }

    const offscreen = this.#canvas.transferControlToOffscreen();
    this.#transferred = true;
    let transport: MutationTransport;
    let ringBuffer: SharedArrayBuffer | undefined;
    let inputRingBuffer: SharedArrayBuffer | undefined;
    if (selectedMode === "sab") {
      const allocation = SabMutationRing.create(2, MAX_MUTATION_BYTES);
      ringBuffer = allocation.buffer;
      transport = new SabMutationTransport(client.endpoint, allocation.ring, {
        ...(this.#options.mutationAcknowledgementTimeoutMs === undefined
          ? {}
          : { acknowledgementTimeoutMs: this.#options.mutationAcknowledgementTimeoutMs }),
        onError: (error) => this.handleWorkerFatal(error),
        ...(this.#options.mutationBufferBytes === undefined
          ? {}
          : { maxBufferedBytes: this.#options.mutationBufferBytes }),
        sessionId: client.sessionId,
      });
      const inputAllocation = SabMutationRing.create(INPUT_RING_CAPACITY, INPUT_RING_PAYLOAD_BYTES);
      this.#inputRing = inputAllocation.ring;
      inputRingBuffer = inputAllocation.buffer;
    } else {
      transport = new PostMessageMutationTransport(client.endpoint, {
        ...(this.#options.mutationAcknowledgementTimeoutMs === undefined
          ? {}
          : { acknowledgementTimeoutMs: this.#options.mutationAcknowledgementTimeoutMs }),
        onError: (error) => this.handleWorkerFatal(error),
        ...(this.#options.mutationBufferBytes === undefined
          ? {}
          : { maxBufferedBytes: this.#options.mutationBufferBytes }),
        sessionId: client.sessionId,
      });
    }
    this.#transport = transport;
    await client.activate({
      canvas: offscreen,
      height: positiveDimension(this.#canvas.height, "canvas height"),
      mode: selectedMode,
      rasterCache: this.#options.rasterCache !== false,
      ...(inputRingBuffer === undefined ? {} : { inputRingBuffer }),
      ...(ringBuffer === undefined ? {} : { ringBuffer }),
      width: positiveDimension(this.#canvas.width, "canvas width"),
    });
    if (client.state !== "ready") throw new Error("render Worker failed during activation");
    this.#recoverableSink.install(
      new TransportMutationSink(transport, (error) => this.handleWorkerFatal(error)),
    );
    this.#root = createRoot(this.#recoverableSink, this.#options);
    this.#mode = selectedMode;
    this.startClockAnchors(client);
    this.#options.onModeChange?.(this.#mode, this.#decision);
  }

  private sendScroll(commands: readonly InputCommand[]): void {
    const frameSeq = this.#inputSequence;
    this.dispatchInput(encodeInputBatch({ frameSeq, commands }));
  }

  private async initializeMainThread(canvas: HTMLCanvasElement): Promise<void> {
    const width = positiveDimension(canvas.width, "canvas width");
    const height = positiveDimension(canvas.height, "canvas height");
    const context = canvas.getContext("2d", { alpha: true });
    if (context === null) throw new Error("Canvas2D context is unavailable");
    const core = await (this.#options.coreFactory ?? createWasmCore)(width, height);
    this.#core = core;
    const rasterCache =
      this.#options.rasterCache === false
        ? undefined
        : createDefaultRasterCache(context, this.#options.onHostError);
    const sink = new CanvasFrameSink(
      context,
      core,
      this.#options.onFrame,
      rasterCache,
      (requests) => this.deferVirtualRefills(requests),
      this.#options.onHostError,
    );
    this.#frameSink = sink;
    this.#recoverableSink.install(sink);
    this.#root ??= createRoot(this.#recoverableSink, this.#options);
    this.#mode = "main-thread";
    this.startMainThreadClock(sink);
    this.#options.onModeChange?.(this.#mode, this.#decision);
  }

  private handleWorkerFatal(error: Error): void {
    if (
      this.#closing ||
      this.#recovering ||
      this.#mode === "main-thread" ||
      this.#root === undefined
    )
      return;
    this.#options.onHostError?.(error);
    this.#recovering = true;
    this.#recovery = this.recoverToMainThread(error).finally(() => {
      this.#recovering = false;
      this.#recovery = undefined;
    });
  }

  private deferVirtualRefills(requests: readonly VirtualRefillRange[]): void {
    if (requests.length === 0) return;
    const owned = requests.map(({ end, nodeId, start }) => ({ end, nodeId, start }));
    queueMicrotask(() => {
      if (this.#closing || this.#unmounted) return;
      try {
        this.#root?.refillVirtualRanges(owned);
        this.#options.onVirtualRefills?.(owned);
      } catch (cause) {
        this.#options.onHostError?.(toError(cause, "virtual refill handler failed"));
      }
    });
  }

  private async recoverToMainThread(error: Error): Promise<void> {
    this.#recoverableSink.beginRecovery();
    this.disposeWorkerRuntime(error);
    this.#canvas = replaceTransferredCanvas(this.#canvas, this.#options);
    this.#transferred = false;
    this.#decision = runtimeFallbackDecision(this.#decision, error);
    try {
      await this.initializeMainThread(this.#canvas);
    } catch (cause) {
      const recoveryError = toError(cause, "main-thread recovery failed");
      this.#recoverableSink.fail(recoveryError);
      this.#options.onHostError?.(recoveryError);
    }
  }

  private disposeWorkerRuntime(reason: Error): void {
    this.stopClockAnchors();
    const transport = this.#transport;
    this.#transport = undefined;
    if (transport !== undefined) {
      this.#lastTransportMetrics = transport.metrics();
      transport.abort(reason);
    }
    const client = this.#client;
    this.#client = undefined;
    this.closeInputRing();
    client?.terminate();
  }

  private startClockAnchors(client: RenderWorkerClient): void {
    const driver = this.#options.clockAnchorDriver ?? defaultClockAnchorDriver();
    if (driver === null) return;
    let sequence = 1;
    const frame = (timestamp: number): void => {
      if (this.#closing || client.state !== "ready") return;
      client.postClockAnchor(sequence, driver.timeOrigin + timestamp);
      sequence = nextSequence(sequence);
      this.#anchorHandle = driver.request(frame);
    };
    this.#anchorHandle = driver.request(frame);
  }

  private startMainThreadClock(sink: CanvasFrameSink): void {
    const driver = this.#options.clockAnchorDriver ?? defaultClockAnchorDriver();
    if (driver === null) return;
    this.#mainFrameTimestamp = undefined;
    const frame = (timestamp: number): void => {
      if (this.#closing || this.#mode !== "main-thread") return;
      const absolute = driver.timeOrigin + timestamp;
      const previous = this.#mainFrameTimestamp;
      this.#mainFrameTimestamp = absolute;
      sink.advance(previous === undefined ? 0 : Math.max(0, absolute - previous) / 1000);
      this.#anchorHandle = driver.request(frame);
    };
    this.#anchorHandle = driver.request(frame);
  }

  private stopClockAnchors(): void {
    const handle = this.#anchorHandle;
    this.#anchorHandle = undefined;
    this.#mainFrameTimestamp = undefined;
    const driver = this.#options.clockAnchorDriver ?? defaultClockAnchorDriver();
    if (handle !== undefined && driver !== null) driver.cancel(handle);
  }

  private async closeOnce(): Promise<void> {
    this.#closing = true;
    this.stopClockAnchors();
    if (!this.#unmounted && this.#root !== undefined) {
      this.#root.unmount();
      this.#unmounted = true;
    }
    await this.#recovery;
    const transport = this.#transport;
    this.#transport = undefined;
    if (transport !== undefined) {
      await transport.close();
      this.#lastTransportMetrics = transport.metrics();
    }
    const client = this.#client;
    this.#client = undefined;
    if (client !== undefined) await client.close();
    this.closeInputRing();
    this.#frameSink?.dispose();
    this.#core?.free?.();
    this.#core = undefined;
    this.#frameSink = undefined;
  }

  private closeInputRing(): void {
    const ring = this.#inputRing;
    this.#inputRing = undefined;
    if (ring === undefined) return;
    this.#lastInputRingMetrics = ring.metrics();
    ring.close();
  }

  private requireRoot(): DoperRoot {
    if (this.#root === undefined) throw new Error("hosted root is not initialized");
    return this.#root;
  }
}

class TransportMutationSink implements MutationSink {
  readonly #onBackpressure: (error: MutationTransportBackpressureError) => void;
  readonly #transport: MutationTransport;

  public constructor(
    transport: MutationTransport,
    onBackpressure: (error: MutationTransportBackpressureError) => void,
  ) {
    this.#transport = transport;
    this.#onBackpressure = onBackpressure;
  }

  public commit(bytes: Uint8Array): void {
    const { frameSeq } = decodeMutationBatch(bytes);
    try {
      this.#transport.enqueue(frameSeq, bytes);
    } catch (cause) {
      if (!(cause instanceof MutationTransportBackpressureError)) throw cause;
      this.#onBackpressure(cause);
    }
  }
}

class RecoverableMutationSink implements MutationSink {
  readonly #snapshot = new MutationSceneSnapshot();
  #delegate: MutationSink | undefined;
  #failure: Error | undefined;

  public commit(bytes: Uint8Array): void {
    if (this.#failure !== undefined) throw this.#failure;
    const delegate = this.#delegate;
    this.#snapshot.applyAfterAccepted(bytes, () => delegate?.commit(bytes));
  }

  public beginRecovery(): void {
    this.#delegate = undefined;
  }

  public install(delegate: MutationSink): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#snapshot.frameSeq !== undefined) delegate.commit(this.#snapshot.encode());
    this.#delegate = delegate;
  }

  public fail(error: Error): void {
    this.#delegate = undefined;
    this.#failure = error;
  }
}

let sessionSequence = 1;

const INPUT_RING_CAPACITY = 64;
const INPUT_RING_PAYLOAD_BYTES = 4 * 1024;

function nextSessionId(): number {
  const result = sessionSequence;
  sessionSequence = nextSequence(sessionSequence);
  return result;
}

function nextSequence(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function positiveDimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function scrollNodeId(target: ScrollTarget): number {
  const nodeId = typeof target === "number" ? target : target.nodeId;
  if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId > 0xffff_ffff) {
    throw new RangeError("scroll target nodeId must be a u32");
  }
  return nodeId;
}

function runtimeFallbackDecision(
  previous: HostTransportDecision,
  error: Error,
): HostTransportDecision {
  return {
    ...previous,
    mode: "main-thread",
    reasons: [
      ...previous.reasons,
      `Worker runtime failed: ${error.message}`,
      "falling back to main-thread",
    ],
  };
}

function replaceTransferredCanvas(
  previous: HTMLCanvasElement,
  options: HostedCanvasRootOptions,
): HTMLCanvasElement {
  const replacement = previous.cloneNode(false) as HTMLCanvasElement;
  replacement.width = previous.width;
  replacement.height = previous.height;
  previous.replaceWith(replacement);
  options.onCanvasReplaced?.(replacement, previous);
  return replacement;
}

function defaultClockAnchorDriver(): ClockAnchorDriver | null {
  if (
    typeof globalThis.requestAnimationFrame !== "function" ||
    typeof globalThis.cancelAnimationFrame !== "function"
  ) {
    return null;
  }
  return {
    cancel: (handle) => globalThis.cancelAnimationFrame(handle),
    request: (callback) => globalThis.requestAnimationFrame(callback),
    timeOrigin: performance.timeOrigin,
  };
}

function toError(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}
