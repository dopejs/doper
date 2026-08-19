import {
  createRoot,
  decodeMutationBatch,
  type CoreDrivenDoperRoot,
  type DoperRoot,
  type MutationSink,
  type RootOptions,
} from "@dopejs/doper-reconciler";
import { SemanticTreeMirror } from "@dopejs/doper-a11y";
import {
  decodeInputBatch,
  encodeInputBatch,
  EVENT_FLAG_PRECISE_WHEEL,
  NativeTextInputBridge,
  type EditTransaction,
  type EditingGeometry,
  type EventTransaction,
  type InputCommand,
} from "@dopejs/doper-editing";

import { MAX_INPUT_BYTES, MAX_MUTATION_BYTES } from "./generated";
import {
  CanvasFrameSink,
  createDefaultRasterCache,
  type CoreClient,
  type EditingGeometryFrame,
  type EditingGeometryRect,
  type FrameReport,
  type NonPassiveRegion,
  type SemanticNode,
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
  /** Forces the centralized textarea fallback for qualification or known-bad EditContext builds. */
  readonly nativeTextInputMode?: "auto" | "textarea-proxy";
  readonly onCanvasReplaced?: (canvas: HTMLCanvasElement, previous: HTMLCanvasElement) => void;
  readonly onClockMetrics?: (metrics: RenderClockMetrics) => void;
  readonly onFrame?: (report: FrameReport) => void;
  readonly onHostError?: (error: Error) => void;
  readonly onModeChange?: (mode: HostTransportMode, decision: HostTransportDecision) => void;
  readonly onVirtualRefills?: (requests: readonly VirtualRefillRange[]) => void;
  readonly onEditTransaction?: (transaction: EditTransaction) => void;
  readonly onEventTransaction?: (transaction: EventTransaction) => void;
  readonly onNonPassiveRegions?: (regions: readonly NonPassiveRegion[]) => void;
  readonly onSemantics?: (nodes: readonly SemanticNode[]) => void;
  /** Disables the DOM accessibility mirror; enabled whenever the canvas is mounted. */
  readonly accessibility?: boolean;
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
  focusEditable(target: ScrollTarget): void;
  blurEditable(): void;
  updateEditingGeometry(geometry: EditingGeometry): void;
  inputTransportMetrics(): HostInputTransportMetrics;
  resize(width: number, height: number): void;
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
  #eventSequence = 1;
  readonly #eventTimestamps = new Map<number, number>();
  #wheelGesture: { readonly precise: boolean; readonly timestamp: number } | undefined;
  #pendingWheel:
    { deltaX: number; deltaY: number; event: WheelEvent; readonly flags: number } | undefined;
  #wheelFrame: number | undefined;
  /** Newest requested window per virtual list, awaiting a single render. */
  readonly #pendingRefills = new Map<number, VirtualRefillRange>();
  #refillFrame: number | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #observedSize: string | undefined;
  #inputDirectFrames = 0;
  #inputRing: SabMutationRing | undefined;
  #inputSabFallbackFrames = 0;
  #inputBridge: NativeTextInputBridge;
  #lastInputRingMetrics: SabMutationRingMetrics | undefined;
  #mode: HostTransportMode = "main-thread";
  #lastTransportMetrics: HostMutationTransportMetrics | undefined;
  #nonPassiveRegions: readonly NonPassiveRegion[] = [];
  #editingGeometry: EditingGeometryFrame | undefined;
  #textDragPointer: number | undefined;
  #semanticMirror: SemanticTreeMirror | undefined;
  #mainFrameTimestamp: number | undefined;
  #recovery: Promise<void> | undefined;
  #recovering = false;
  #root: CoreDrivenDoperRoot | undefined;
  #transferred = false;
  #transport: MutationTransport | undefined;
  #unmounted = false;
  #eventListenersAttached = false;

  public constructor(canvas: HTMLCanvasElement, options: HostedCanvasRootOptions) {
    if (!(canvas instanceof HTMLCanvasElement))
      throw new TypeError("canvas must be HTMLCanvasElement");
    this.#canvas = canvas;
    this.#options = options;
    this.#inputBridge = this.createInputBridge(canvas);
    if (options.accessibility !== false && typeof canvas.insertAdjacentElement === "function") {
      this.#semanticMirror = new SemanticTreeMirror(canvas, {
        onFocusRequest: (nodeId) => {
          try {
            this.focusEditable(nodeId);
          } catch (cause) {
            this.#options.onHostError?.(toError(cause, "semantic focus request failed"));
          }
        },
      });
    }
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
      // Advance first: reverse-stream handlers may reentrantly send new input.
      this.#inputSequence = nextSequence(frameSeq);
      sink.input(bytes);
      this.#inputDirectFrames += 1;
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

  /** Activates native text services for one mounted EditableText node. */
  public focusEditable(target: ScrollTarget): void {
    const nodeId = scrollNodeId(target);
    const state = this.requireCoreRoot().editableState(nodeId);
    if (state === undefined) throw new Error(`node ${String(nodeId)} is not an editable target`);
    this.sendInputCommands([{ type: "focusEditable", nodeId }]);
    this.#inputBridge.activate(state);
  }

  /** Ends the active native editing surface without creating per-widget DOM. */
  public blurEditable(): void {
    const nodeId = this.#inputBridge.activeNodeId;
    if (nodeId !== undefined) this.sendInputCommands([{ type: "blurEditable", nodeId }]);
    this.#inputBridge.deactivate();
  }

  /** Supplies Core-derived editor and caret bounds to the OS input service. */
  public updateEditingGeometry(geometry: EditingGeometry): void {
    this.#inputBridge.updateGeometry(geometry);
  }

  public async initialize(): Promise<void> {
    if (this.#root !== undefined) throw new Error("hosted root is already initialized");
    if (this.#decision.mode === "main-thread") {
      await this.initializeMainThread(this.#canvas);
      this.attachCanvasEventListeners();
      return;
    }
    try {
      await this.initializeWorker(this.#decision.mode);
    } catch (cause) {
      const error = toError(cause, "render Worker initialization failed");
      this.#options.onHostError?.(error);
      this.disposeWorkerRuntime(error);
      if (this.#transferred) {
        this.#canvas = replaceTransferredCanvas(this.#canvas, this.#options);
        this.replaceInputBridge(this.#canvas);
      }
      this.#decision = runtimeFallbackDecision(this.#decision, error);
      await this.initializeMainThread(this.#canvas);
    }
    this.attachCanvasEventListeners();
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
      onEditTransaction: (transaction) => this.handleEditTransaction(transaction),
      onEventTransaction: (transaction) => this.handleEventTransaction(transaction),
      onNonPassiveRegions: (regions) => this.handleNonPassiveRegions(regions),
      onEditingGeometry: (frame) => this.handleEditingGeometry(frame),
      onSemantics: (nodes) => this.handleSemantics(nodes),
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
      devicePixelRatio: devicePixelRatioOf(this.#canvas),
      height: positiveDimension(this.logicalHeight(), "canvas height"),
      mode: selectedMode,
      rasterCache: this.#options.rasterCache !== false,
      ...(inputRingBuffer === undefined ? {} : { inputRingBuffer }),
      ...(ringBuffer === undefined ? {} : { ringBuffer }),
      width: positiveDimension(this.logicalWidth(), "canvas width"),
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
    this.sendInputCommands(commands);
  }

  private sendInputCommands(commands: readonly InputCommand[]): void {
    const frameSeq = this.#inputSequence;
    this.dispatchInput(encodeInputBatch({ frameSeq, commands }));
  }

  private readonly handleCanvasPointerEvent = (event: PointerEvent): void => {
    switch (event.type) {
      case "pointerdown":
      case "pointerup":
      case "pointermove":
      case "pointercancel":
        this.dispatchCanvasEvent(event.type, event, 0, 0);
    }
  };

  private readonly handleCanvasClick = (event: MouseEvent): void => {
    this.dispatchCanvasEvent("click", event, 0, 0);
  };

  private readonly handleCanvasWheel = (event: WheelEvent): void => {
    const scale =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? Math.max(1, this.#canvas.clientHeight)
          : 1;
    const flags = this.classifyWheel(event);
    // A pointing device emits one event per display refresh, and each one used
    // to become its own Core transaction: a frame painted and the whole canvas
    // replayed for a picture that the next event superseded before it could be
    // seen. Merging a frame's worth of deltas into one command keeps every
    // pixel of motion while paying for one replay instead of dozens.
    // Suppression has to stay synchronous: a deferred preventDefault arrives
    // after the browser has already scrolled the page, so the canvas and the
    // page move together.
    this.suppressWheelDefault(event);
    const pending = this.#pendingWheel;
    if (pending !== undefined && pending.flags === flags) {
      pending.deltaX += event.deltaX * scale;
      pending.deltaY += event.deltaY * scale;
      pending.event = event;
      return;
    }
    this.flushWheel();
    this.#pendingWheel = {
      deltaX: event.deltaX * scale,
      deltaY: event.deltaY * scale,
      event,
      flags,
    };
    if (typeof requestAnimationFrame === "function") {
      this.#wheelFrame = requestAnimationFrame(() => {
        this.#wheelFrame = undefined;
        this.flushWheel();
      });
    } else {
      this.flushWheel();
    }
  };

  /**
   * Cancels the browser's own scrolling when Core owns the wheel here.
   *
   * Runs on the event itself rather than on the coalesced flush, because
   * `preventDefault` is only honoured while the event is being dispatched.
   */
  private suppressWheelDefault(event: WheelEvent): void {
    if (!event.cancelable || this.#nonPassiveRegions.length === 0) return;
    const rect = this.#canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const x = ((event.clientX - rect.left) * this.logicalWidth()) / rect.width;
    const y = ((event.clientY - rect.top) * this.logicalHeight()) / rect.height;
    const suppressed = this.#nonPassiveRegions.some(
      (region) =>
        (region.flags & 1) !== 0 &&
        x >= region.left &&
        x < region.right &&
        y >= region.top &&
        y < region.bottom,
    );
    if (suppressed) event.preventDefault();
  }

  /** Sends the merged wheel delta collected during this frame, if any. */
  private flushWheel(): void {
    const pending = this.#pendingWheel;
    if (pending === undefined) return;
    this.#pendingWheel = undefined;
    this.dispatchCanvasEvent("wheel", pending.event, pending.deltaX, pending.deltaY, pending.flags);
  }

  /**
   * Classifies a wheel sample as a high-precision gesture or a discrete notch.
   *
   * Core applies high-precision deltas one-to-one and animates discrete
   * notches, so a misclassification changes feel rather than distance. The
   * decision is per gesture, not per event: a classic wheel produces
   * multiple-of-120 legacy deltas spaced far apart, while a trackpad streams
   * samples at display rate. A gesture that shows either trackpad trait stays
   * high-precision until it ends, and an unknown platform stays
   * high-precision so the applied motion matches the raw delta.
   */
  private classifyWheel(event: WheelEvent): number {
    const timestamp = Number.isFinite(event.timeStamp) ? event.timeStamp : 0;
    const previous = this.#wheelGesture;
    const continuing =
      previous !== undefined && timestamp - previous.timestamp <= WHEEL_GESTURE_GAP_MS;
    if (continuing && previous.precise) {
      this.#wheelGesture = { precise: true, timestamp };
      return EVENT_FLAG_PRECISE_WHEEL;
    }
    const legacy = (event as { readonly wheelDeltaY?: unknown }).wheelDeltaY;
    const notched =
      event.deltaMode !== 0 ||
      (typeof legacy === "number" && legacy !== 0 && legacy % WHEEL_NOTCH_LEGACY_DELTA === 0);
    const streaming = continuing && timestamp - previous.timestamp < WHEEL_STREAM_INTERVAL_MS;
    const precise = !notched || streaming;
    this.#wheelGesture = { precise, timestamp };
    return precise ? EVENT_FLAG_PRECISE_WHEEL : 0;
  }

  private dispatchCanvasEvent(
    kind: "click" | "pointercancel" | "pointerdown" | "pointermove" | "pointerup" | "wheel",
    event: MouseEvent,
    deltaX: number,
    deltaY: number,
    flags = 0,
  ): void {
    if (this.#closing || this.#unmounted || this.#recovering) return;
    const rect = this.#canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const x = ((event.clientX - rect.left) * this.logicalWidth()) / rect.width;
    const y = ((event.clientY - rect.top) * this.logicalHeight()) / rect.height;
    const pointerId = kind.startsWith("pointer") ? (event as PointerEvent).pointerId >>> 0 : 0;
    // Wheel suppression runs on the listener instead, because this dispatch is
    // deferred to the coalescing frame and `preventDefault` is only honoured
    // while the event is being dispatched.
    const suppressionFlag =
      kind === "wheel" ? 0 : (event as PointerEvent).pointerType === "touch" ? 2 : 0;
    const suppressed =
      suppressionFlag !== 0 &&
      this.#nonPassiveRegions.some(
        (region) =>
          (region.flags & suppressionFlag) !== 0 &&
          x >= region.left &&
          x < region.right &&
          y >= region.top &&
          y < region.bottom,
      );
    if (suppressed) {
      if (event.cancelable) event.preventDefault();
      if (
        kind === "pointerdown" &&
        pointerId !== 0 &&
        typeof this.#canvas.setPointerCapture === "function"
      ) {
        this.#canvas.setPointerCapture(pointerId);
      }
    }
    if (
      (kind === "pointerup" || kind === "pointercancel") &&
      pointerId !== 0 &&
      typeof this.#canvas.hasPointerCapture === "function" &&
      this.#canvas.hasPointerCapture(pointerId)
    ) {
      this.#canvas.releasePointerCapture(pointerId);
    }
    const modifiers =
      (event.shiftKey ? 1 : 0) |
      (event.ctrlKey ? 2 : 0) |
      (event.altKey ? 4 : 0) |
      (event.metaKey ? 8 : 0);
    const timestampKey = kind === "wheel" ? -1 : pointerId;
    const timestamp = Number.isFinite(event.timeStamp) ? event.timeStamp : 0;
    const previousTimestamp = this.#eventTimestamps.get(timestampKey);
    if (kind === "pointerup" || kind === "pointercancel") {
      this.#eventTimestamps.delete(timestampKey);
    } else {
      this.#eventTimestamps.set(timestampKey, timestamp);
    }
    const elapsedMs =
      previousTimestamp === undefined || timestamp <= previousTimestamp
        ? 1000 / 60
        : Math.min(1000, timestamp - previousTimestamp);
    this.blurEditableOutsideActiveEditor(kind, x, y);
    this.synthesizeTextSelection(kind, x, y, pointerId, event.shiftKey);
    const eventId = this.#eventSequence;
    this.#eventSequence = nextSequence(eventId);
    try {
      this.sendInputCommands([
        {
          type: "dispatchEvent",
          eventId,
          kind,
          flags,
          x,
          y,
          deltaX,
          deltaY,
          buttons: event.buttons & 0xffff,
          modifiers,
          pointerId,
          elapsedMicros: Math.max(1, Math.min(1_000_000, Math.round(elapsedMs * 1000))),
        },
      ]);
    } catch (cause) {
      this.#options.onHostError?.(toError(cause, `${kind} dispatch failed`));
    }
  }

  /**
   * Ends the session when a press lands anywhere but the active editor.
   *
   * Core reports only a hit target, so a press on empty canvas produces no
   * event transaction at all and cannot drive this. The active editor's control
   * bounds already come back with the editing geometry, so the decision is made
   * here and synchronously, the way a native input loses focus.
   */
  private blurEditableOutsideActiveEditor(
    kind: "click" | "pointercancel" | "pointerdown" | "pointermove" | "pointerup" | "wheel",
    x: number,
    y: number,
  ): void {
    if (kind !== "pointerdown") return;
    const activeNodeId = this.#inputBridge.activeNodeId;
    if (activeNodeId === undefined) return;
    const geometry = this.#editingGeometry;
    // Bounds unknown: blurring on a guess would end a session the press was
    // actually inside of, which is worse than leaving it focused for a frame.
    if (geometry === undefined || geometry.nodeId !== activeNodeId) return;
    const bounds = geometry.controlBounds;
    if (
      x >= bounds.left &&
      x < bounds.left + bounds.width &&
      y >= bounds.top &&
      y < bounds.top + bounds.height
    ) {
      return;
    }
    try {
      this.blurEditable();
    } catch (cause) {
      this.#options.onHostError?.(toError(cause, "editable blur failed"));
    }
  }

  /**
   * Ends the session when a press lands outside the canvas entirely.
   *
   * The engine never sees those events, so without this the session outlives
   * every interaction with the rest of the page. The accessibility mirror and
   * the input proxy are the engine's own surfaces and do not count as outside.
   */
  private readonly handleDocumentPointerDown = (event: Event): void => {
    if (this.#closing || this.#unmounted) return;
    if (this.#inputBridge.activeNodeId === undefined) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.#canvas === target || this.#canvas.contains(target)) return;
    if (this.#inputBridge.ownsNode(target)) return;
    if (this.#semanticMirror?.container.contains(target) === true) return;
    try {
      this.blurEditable();
    } catch (cause) {
      this.#options.onHostError?.(toError(cause, "editable blur failed"));
    }
  };

  /** Turns raw pointer input over the active editor into caret placement. */
  private synthesizeTextSelection(
    kind: "click" | "pointercancel" | "pointerdown" | "pointermove" | "pointerup" | "wheel",
    x: number,
    y: number,
    pointerId: number,
    shiftKey: boolean,
  ): void {
    const activeNodeId = this.#inputBridge.activeNodeId;
    if (activeNodeId === undefined) {
      this.#textDragPointer = undefined;
      return;
    }
    const send = (extend: boolean, word: boolean): void => {
      try {
        this.sendInputCommands([{ type: "placeCaret", nodeId: activeNodeId, x, y, extend, word }]);
      } catch (cause) {
        this.#options.onHostError?.(toError(cause, "caret placement failed"));
      }
    };
    switch (kind) {
      case "pointerdown": {
        const geometry = this.#editingGeometry;
        const inside =
          geometry !== undefined &&
          geometry.nodeId === activeNodeId &&
          x >= geometry.controlBounds.left &&
          x < geometry.controlBounds.left + geometry.controlBounds.width &&
          y >= geometry.controlBounds.top &&
          y < geometry.controlBounds.top + geometry.controlBounds.height;
        if (!inside) return;
        this.#textDragPointer = pointerId;
        send(shiftKey, false);
        return;
      }
      case "pointermove":
        if (this.#textDragPointer === pointerId) send(true, false);
        return;
      case "pointerup":
      case "pointercancel":
        if (this.#textDragPointer === pointerId) this.#textDragPointer = undefined;
        return;
      default:
    }
  }

  private readonly handleCanvasDoubleClick = (event: Event): void => {
    const mouse = event as MouseEvent;
    const activeNodeId = this.#inputBridge.activeNodeId;
    const geometry = this.#editingGeometry;
    if (activeNodeId === undefined || geometry === undefined || geometry.nodeId !== activeNodeId) {
      return;
    }
    const rect = this.#canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const x = ((mouse.clientX - rect.left) * this.logicalWidth()) / rect.width;
    const y = ((mouse.clientY - rect.top) * this.logicalHeight()) / rect.height;
    if (
      x < geometry.controlBounds.left ||
      x >= geometry.controlBounds.left + geometry.controlBounds.width ||
      y < geometry.controlBounds.top ||
      y >= geometry.controlBounds.top + geometry.controlBounds.height
    ) {
      return;
    }
    try {
      this.sendInputCommands([
        { type: "placeCaret", nodeId: activeNodeId, x, y, extend: false, word: true },
      ]);
    } catch (cause) {
      this.#options.onHostError?.(toError(cause, "word selection failed"));
    }
  };

  private attachCanvasEventListeners(): void {
    this.observeCanvasSize();
    if (this.#eventListenersAttached) return;
    if (typeof this.#canvas.addEventListener !== "function") return;
    const pointerPassive = !this.#nonPassiveRegions.some((region) => (region.flags & 2) !== 0);
    const wheelPassive = !this.#nonPassiveRegions.some((region) => (region.flags & 1) !== 0);
    this.applyTouchAction(!pointerPassive);
    this.#canvas.addEventListener("pointerdown", this.handleCanvasPointerEvent, {
      passive: pointerPassive,
    });
    this.#canvas.addEventListener("pointerup", this.handleCanvasPointerEvent, {
      passive: pointerPassive,
    });
    this.#canvas.addEventListener("pointermove", this.handleCanvasPointerEvent, {
      passive: pointerPassive,
    });
    this.#canvas.addEventListener("pointercancel", this.handleCanvasPointerEvent, {
      passive: pointerPassive,
    });
    this.#canvas.addEventListener("click", this.handleCanvasClick, { passive: true });
    this.#canvas.addEventListener("dblclick", this.handleCanvasDoubleClick, { passive: true });
    this.#canvas.addEventListener("wheel", this.handleCanvasWheel, { passive: wheelPassive });
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      // Capture, so a handler that stops propagation cannot strand the session.
      document.addEventListener("pointerdown", this.handleDocumentPointerDown, {
        capture: true,
        passive: true,
      });
    }
    this.#eventListenersAttached = true;
  }

  private detachCanvasEventListeners(): void {
    if (this.#wheelFrame !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.#wheelFrame);
    }
    this.#wheelFrame = undefined;
    this.#pendingWheel = undefined;
    if (this.#refillFrame !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.#refillFrame);
    }
    this.#refillFrame = undefined;
    this.#pendingRefills.clear();
    if (!this.#eventListenersAttached) return;
    if (typeof this.#canvas.removeEventListener !== "function") return;
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("pointerdown", this.handleDocumentPointerDown, {
        capture: true,
      });
    }
    this.#canvas.removeEventListener("pointerdown", this.handleCanvasPointerEvent);
    this.#canvas.removeEventListener("pointerup", this.handleCanvasPointerEvent);
    this.#canvas.removeEventListener("pointermove", this.handleCanvasPointerEvent);
    this.#canvas.removeEventListener("pointercancel", this.handleCanvasPointerEvent);
    this.#canvas.removeEventListener("click", this.handleCanvasClick);
    this.#canvas.removeEventListener("dblclick", this.handleCanvasDoubleClick);
    this.#canvas.removeEventListener("wheel", this.handleCanvasWheel);
    this.applyTouchAction(false);
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#eventListenersAttached = false;
  }

  private async initializeMainThread(canvas: HTMLCanvasElement): Promise<void> {
    const width = positiveDimension(this.logicalWidth(), "canvas width");
    const height = positiveDimension(this.logicalHeight(), "canvas height");
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
      (transaction) => this.handleEditTransaction(transaction),
      (transaction) => this.handleEventTransaction(transaction),
      (regions) => this.handleNonPassiveRegions(regions),
      (frame) => this.handleEditingGeometry(frame),
      (nodes) => this.handleSemantics(nodes),
    );
    this.#frameSink = sink;
    this.#recoverableSink.install(sink);
    this.#root ??= createRoot(this.#recoverableSink, this.#options);
    this.#mode = "main-thread";
    this.startMainThreadClock(sink);
    this.#options.onModeChange?.(this.#mode, this.#decision);
  }

  private handleEditTransaction(transaction: EditTransaction): void {
    const errors: Error[] = [];
    try {
      this.#root?.applyEditTransaction(transaction);
    } catch (cause) {
      errors.push(toError(cause, "Shell edit transaction handler failed"));
    }
    try {
      this.#inputBridge.applyTransaction(transaction);
    } catch (cause) {
      this.#inputBridge.deactivate();
      errors.push(toError(cause, "native edit transaction synchronization failed"));
    }
    try {
      this.#options.onEditTransaction?.(transaction);
    } catch (cause) {
      errors.push(toError(cause, "host edit transaction observer failed"));
    }
    for (const error of errors) this.#options.onHostError?.(error);
  }

  private handleEventTransaction(transaction: EventTransaction): void {
    try {
      this.#root?.applyEventTransaction(transaction);
      this.#options.onEventTransaction?.(transaction);
    } catch (cause) {
      this.#options.onHostError?.(toError(cause, "event transaction handler failed"));
    }
    this.autoFocusEditableTarget(transaction);
  }

  /** Clicking a mounted editable activates native text services engine-side. */
  private autoFocusEditableTarget(transaction: EventTransaction): void {
    if (transaction.kind !== "pointerdown") return;
    if (this.#inputBridge.activeNodeId === transaction.target) return;
    const state = this.#root?.editableState(transaction.target);
    if (state === undefined) return;
    try {
      this.focusEditable(transaction.target);
      this.#textDragPointer = transaction.pointerId;
      this.sendInputCommands([
        {
          type: "placeCaret",
          nodeId: transaction.target,
          x: transaction.x,
          y: transaction.y,
          extend: (transaction.modifiers & 1) !== 0,
          word: false,
        },
      ]);
    } catch (cause) {
      this.#options.onHostError?.(new Error(`editable auto-focus failed: ${String(cause)}`));
    }
  }

  /**
   * Tells the browser not to claim touch gestures Core owns.
   *
   * A non-passive listener and `preventDefault` are not enough on a touch
   * screen: the browser decides at pointerdown whether the compositor pans the
   * page, and once it has, the events are no longer cancelable. `touch-action`
   * is the only thing consulted for that decision, so a canvas that owns
   * scrolling must say so in CSS as well -- otherwise a drag scrolls the page
   * and the list never moves.
   */
  /**
   * Resizes the drawing surface to a new logical size.
   *
   * The canvas keeps a backing store in device pixels while Core lays out in
   * logical ones, so a size change has to reach both or the frame is drawn at
   * one size and stretched to another.
   */
  public resize(width: number, height: number): void {
    if (this.#closing || this.#unmounted) return;
    if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
      throw new RangeError("resize dimensions must be positive and finite");
    }
    const ratio = devicePixelRatioOf(this.#canvas);
    if (this.#client !== undefined && this.#mode !== "main-thread") {
      // The worker owns the transferred canvas, so it does the resizing.
      this.#client.postResize(width, height, ratio);
      return;
    }
    this.#frameSink?.resize(width, height, ratio);
  }

  /**
   * Follows the canvas's own box so an application does not have to.
   *
   * Every canvas-backed application faces this the moment a window is resized
   * or a phone is rotated, and a missed resize does not fail loudly: the last
   * frame is simply stretched to the new box. Observing here makes the default
   * correct; `resize` stays public for a caller that drives its own layout.
   */
  private observeCanvasSize(): void {
    if (typeof ResizeObserver !== "function" || this.#resizeObserver !== undefined) return;
    this.#observedSize = `${String(this.#canvas.width)}x${String(this.#canvas.height)}`;
    this.#resizeObserver = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.contentRect;
      if (box === undefined || box.width <= 0 || box.height <= 0) return;
      const ratio = devicePixelRatioOf(this.#canvas);
      const next = `${String(Math.round(box.width * ratio))}x${String(Math.round(box.height * ratio))}`;
      if (next === this.#observedSize) return;
      this.#observedSize = next;
      try {
        this.resize(box.width, box.height);
      } catch (cause) {
        this.#options.onHostError?.(toError(cause, "canvas resize failed"));
      }
    });
    this.#resizeObserver.observe(this.#canvas);
  }

  private applyTouchAction(owned: boolean): void {
    const style = (this.#canvas as { style?: { touchAction?: string } }).style;
    if (style === undefined) return;
    style.touchAction = owned ? "none" : "";
  }

  private handleNonPassiveRegions(regions: readonly NonPassiveRegion[]): void {
    const previousPointer = this.#nonPassiveRegions.some((region) => (region.flags & 2) !== 0);
    const previousWheel = this.#nonPassiveRegions.some((region) => (region.flags & 1) !== 0);
    this.#nonPassiveRegions = regions.map((region) => Object.freeze({ ...region }));
    const nextPointer = this.#nonPassiveRegions.some((region) => (region.flags & 2) !== 0);
    const nextWheel = this.#nonPassiveRegions.some((region) => (region.flags & 1) !== 0);
    if (
      this.#eventListenersAttached &&
      (previousPointer !== nextPointer || previousWheel !== nextWheel)
    ) {
      this.detachCanvasEventListeners();
      this.attachCanvasEventListeners();
    }
    this.#options.onNonPassiveRegions?.(this.#nonPassiveRegions);
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

  /**
   * Renders the newest requested window for each virtual list, once.
   *
   * A window request is an absolute range rather than a delta, so a later
   * request for the same node replaces an earlier one outright. Rendering each
   * batch separately makes the Shell walk windows the offset has already left,
   * and during a gesture those stale renders queue up faster than they drain,
   * which is what left the viewport on placeholders long after the fingers
   * stopped. Dropping a superseded window cannot lose work: Core re-requests
   * any window it still lacks after {@link REFILL_RETRY_FRAMES}.
   */
  private deferVirtualRefills(requests: readonly VirtualRefillRange[]): void {
    if (requests.length === 0) return;
    const pending = this.#pendingRefills;
    const scheduled = pending.size > 0;
    for (const { end, nodeId, start } of requests) pending.set(nodeId, { end, nodeId, start });
    if (scheduled) return;
    // Flushed per frame, not per microtask. Core emits a window every render
    // frame, and each arrives in its own message, so a microtask flush gave
    // every one of them its own render: during a gesture the Shell rebuilt the
    // whole window nine times in sixty milliseconds, each rebuild one stride
    // behind the last, and the commits queued up so Core kept seeing windows
    // the offset had long left. Coalescing to one flush per frame renders only
    // the newest window and costs at most a frame of latency on a path that is
    // already asynchronous.
    const flush = (): void => {
      this.#refillFrame = undefined;
      const owned = [...pending.values()];
      pending.clear();
      if (this.#closing || this.#unmounted) return;
      try {
        this.#root?.refillVirtualRanges(owned);
        this.#options.onVirtualRefills?.(owned);
      } catch (cause) {
        this.#options.onHostError?.(toError(cause, "virtual refill handler failed"));
      }
    };
    if (typeof requestAnimationFrame === "function") {
      this.#refillFrame = requestAnimationFrame(flush);
    } else {
      queueMicrotask(flush);
    }
  }

  private async recoverToMainThread(error: Error): Promise<void> {
    const activeEditor = this.#inputBridge.activeNodeId;
    this.#inputBridge.deactivate();
    this.#recoverableSink.beginRecovery();
    this.detachCanvasEventListeners();
    this.disposeWorkerRuntime(error);
    this.#canvas = replaceTransferredCanvas(this.#canvas, this.#options);
    this.replaceInputBridge(this.#canvas);
    this.#transferred = false;
    this.#decision = runtimeFallbackDecision(this.#decision, error);
    try {
      await this.initializeMainThread(this.#canvas);
      this.attachCanvasEventListeners();
      if (activeEditor !== undefined) {
        const state = this.#root?.editableState(activeEditor);
        if (state !== undefined) this.#inputBridge.activate(state);
      }
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
    this.detachCanvasEventListeners();
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
    this.#inputBridge.dispose();
    this.#semanticMirror?.dispose();
    this.#semanticMirror = undefined;
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

  private requireCoreRoot(): CoreDrivenDoperRoot {
    if (this.#root === undefined) throw new Error("hosted root is not initialized");
    return this.#root;
  }

  /**
   * Scene coordinates are logical (CSS) pixels while the canvas backing store
   * is sized in device pixels, so every viewport and pointer coordinate is
   * converted here rather than at each call site.
   */
  private logicalWidth(): number {
    return this.#canvas.width / devicePixelRatioOf(this.#canvas);
  }

  private logicalHeight(): number {
    return this.#canvas.height / devicePixelRatioOf(this.#canvas);
  }

  private createInputBridge(canvas: HTMLCanvasElement): NativeTextInputBridge {
    return new NativeTextInputBridge(canvas, {
      dispatch: (command) => this.sendInputCommands([command]),
      ...(this.#options.nativeTextInputMode === "textarea-proxy" ? { editContext: null } : {}),
      onError: (error) => this.#options.onHostError?.(error),
      onSubmit: (nodeId) => this.#root?.submitEditable(nodeId),
      requestCharacterBounds: (nodeId, start, end) => {
        this.sendInputCommands([{ type: "requestCharacterBounds", nodeId, start, end }]);
      },
    });
  }

  /** Mirrors the committed semantic tree into the accessibility DOM. */
  private handleSemantics(nodes: readonly SemanticNode[]): void {
    try {
      this.#semanticMirror?.update(nodes);
    } catch (cause) {
      this.#options.onHostError?.(toError(cause, "semantic mirror update failed"));
    }
    this.#options.onSemantics?.(nodes);
  }

  /** Feeds Core-computed editor geometry to the IME bridge automatically. */
  private handleEditingGeometry(frame: EditingGeometryFrame): void {
    this.#editingGeometry = frame;
    if (this.#inputBridge.activeNodeId !== frame.nodeId) return;
    const toDomRect = (rect: EditingGeometryRect): DOMRect =>
      new DOMRect(rect.left, rect.top, rect.width, rect.height);
    const characters = frame.characterBounds;
    try {
      this.#inputBridge.updateGeometry({
        controlBounds: toDomRect(frame.controlBounds),
        selectionBounds: toDomRect(frame.selectionBounds),
        ...(characters.length === 0
          ? {}
          : {
              characterBounds: (start: number, end: number): readonly DOMRect[] => {
                const rects: DOMRect[] = [];
                for (let unit = start; unit < end; unit += 1) {
                  const record = characters.find(
                    (character) => character.start <= unit && unit < character.end,
                  );
                  if (record === undefined) return rects;
                  rects.push(toDomRect(record.rect));
                }
                return rects;
              },
            }),
      });
    } catch (cause) {
      this.#options.onHostError?.(toError(cause, "editing geometry synchronization failed"));
    }
  }

  private replaceInputBridge(canvas: HTMLCanvasElement): void {
    this.#inputBridge.dispose();
    this.#inputBridge = this.createInputBridge(canvas);
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

/** Legacy wheel-delta quantum a classic notched mouse wheel always reports. */
const WHEEL_NOTCH_LEGACY_DELTA = 120;
/** Silence after which the next wheel sample starts a new gesture. */
const WHEEL_GESTURE_GAP_MS = 200;
/** Inter-sample spacing only a continuous trackpad stream stays below. */
const WHEEL_STREAM_INTERVAL_MS = 30;

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

/**
 * Validates a logical canvas dimension, which is legitimately fractional.
 *
 * The logical size is the backing store divided by the device pixel ratio, and
 * a phone's ratio is routinely fractional -- 2.75 or 3.5 -- so that quotient
 * almost never lands on an integer. Requiring one rejected every such device
 * with a message that said the value was not positive when it was. Rounding
 * instead would be worse: the viewport Core lays out against would disagree
 * with the backing store by a sub-pixel and the replay scale would drift.
 */
function positiveDimension(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
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

/** Backing-store to CSS pixel ratio; the sink scales replay by the same value. */
function devicePixelRatioOf(_canvas: HTMLCanvasElement): number {
  const value = (globalThis as { readonly devicePixelRatio?: unknown }).devicePixelRatio;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

function toError(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}
