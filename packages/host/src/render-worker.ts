/// <reference lib="webworker" />

import { decodeMutationBatch } from "@dopejs/pingo-reconciler";
import { decodeInputBatch } from "@dopejs/pingo-editing";

import { MINIMUM_READABLE_ABI_VERSION } from "./generated";
import { CanvasFrameSink, createDefaultRasterCache, type CoreClient } from "./main-thread";
import { PostMessageMutationReceiver } from "./post-message";
import { HybridRenderClock } from "./render-clock";
import { SabMutationRing } from "./sab-ring";
import { SabMutationReceiver } from "./sab-transport";
import { createWasmCore, initializeWasm } from "./wasm";
import {
  WORKER_PROTOCOL_VERSION,
  isRenderWorkerInboundEnvelope,
  isRenderWorkerInboundMessage,
  type RenderWorkerInboundMessage,
  type RenderWorkerOutboundMessage,
  type WorkerActivateMessage,
} from "./worker-protocol";

const scope = self as DedicatedWorkerGlobalScope;
let sessionId = 0;
let prepared = false;
let active = false;
let failed = false;
let core: CoreClient | undefined;
let sink: CanvasFrameSink | undefined;
let postMessageReceiver: PostMessageMutationReceiver | undefined;
let sabReceiver: SabMutationReceiver | undefined;
let inputRing: SabMutationRing | undefined;
let clock: HybridRenderClock | undefined;
let clockFramesSinceReport = 0;
let operations = Promise.resolve();

scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (!isRenderWorkerInboundMessage(message)) {
    if (isRenderWorkerInboundEnvelope(message))
      fatal(new Error("render Worker request is malformed"));
    return;
  }
  if (message.kind === "pingo:clock-anchor") {
    if (message.sessionId === sessionId && active)
      clock?.anchor(message.sequence, message.timestamp);
    return;
  }
  operations = operations.then(() => handle(message)).catch((cause: unknown) => fatal(cause));
});

async function handle(message: RenderWorkerInboundMessage): Promise<void> {
  if (failed) return;
  switch (message.kind) {
    case "pingo:prepare":
      if (prepared || active) throw new Error("render Worker was prepared more than once");
      if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) {
        throw new Error("render Worker protocol version mismatch");
      }
      // The streams themselves are self-describing, so a main thread newer than
      // this worker is workable: unknown instructions its producer marked
      // optional get stepped over. Refusing the handshake on inequality would
      // hard-fail a deploy the stream layer could have carried.
      if (message.abiVersion < MINIMUM_READABLE_ABI_VERSION) {
        throw new Error("render Worker ABI version predates self-describing instructions");
      }
      sessionId = positiveU32(message.sessionId, "sessionId");
      await initializeWasm();
      prepared = true;
      post({
        capabilities: {
          offscreenCanvas: typeof OffscreenCanvas === "function",
          sharedArrayBuffer: typeof SharedArrayBuffer === "function",
        },
        kind: "pingo:prepared",
        sessionId,
      });
      return;
    case "pingo:activate":
      await activate(message);
      return;
    case "pingo:shutdown":
      if (message.sessionId !== sessionId) return;
      disposeRuntime();
      post({ kind: "pingo:shutdown-complete", sessionId });
      scope.close();
      return;
    case "pingo:resize":
      if (!active || message.sessionId !== sessionId) return;
      // Applied straight away rather than queued: the canvas is already the new
      // size on screen, so every frame until this lands would be stretched.
      sink?.resize(message.width, message.height, message.devicePixelRatio);
      return;
    case "pingo:input":
      if (!active || message.sessionId !== sessionId) return;
      drainInputRing();
      // Queue rather than apply: the render clock drains the queue once per
      // frame, so a burst costs one canvas replay instead of one per event.
      pendingInput.push(message.bytes);
      return;
    case "pingo:input-wake":
      if (!active || message.sessionId !== sessionId) return;
      drainInputRing();
      return;
    case "pingo:reduced-motion":
      if (!active || message.sessionId !== sessionId) return;
      sink?.setReducedMotion(message.reduced);
      return;
    case "pingo:clock-anchor":
      return;
  }
}

async function activate(message: WorkerActivateMessage): Promise<void> {
  if (!prepared || active) throw new Error("render Worker activation is out of order");
  if (message.sessionId !== sessionId) throw new Error("render Worker activation session mismatch");
  if (!(message.canvas instanceof OffscreenCanvas))
    throw new TypeError("activation canvas is invalid");
  const context = message.canvas.getContext("2d", { alpha: true });
  if (context === null) throw new Error("OffscreenCanvas 2D context is unavailable");
  core = await createWasmCore(message.width, message.height);
  core.set_reduced_motion?.(message.reducedMotion);
  sink = new CanvasFrameSink(
    context,
    core,
    (report) => {
      post({ kind: "pingo:frame", report, sessionId });
    },
    message.rasterCache ? createDefaultRasterCache(context, fatal) : undefined,
    (requests) => post({ kind: "pingo:virtual-refill", requests, sessionId }),
    fatal,
    (transaction) => post({ kind: "pingo:edit-transaction", transaction, sessionId }),
    (transaction) => post({ kind: "pingo:event-transaction", transaction, sessionId }),
    (regions) => post({ kind: "pingo:non-passive-regions", regions, sessionId }),
    (frame) => post({ kind: "pingo:editing-geometry", frame, sessionId }),
    (nodes) => post({ kind: "pingo:semantics", nodes, sessionId }),
  );
  // A worker cannot read devicePixelRatio, so the main thread supplies it;
  // without this the replay scale and glyph raster stay at 1x on HiDPI.
  sink.setDevicePixelRatio(message.devicePixelRatio);
  const consume = (frameSeq: number, bytes: Uint8Array): void => {
    const decoded = decodeMutationBatch(bytes);
    if (decoded.frameSeq !== frameSeq)
      throw new Error("transport and Mutation Stream sequences differ");
    // Deferring input must not reorder it against a commit: a queued drag delta
    // applied after a programmatic scroll would overwrite it.
    drainPendingInput();
    sink?.commit(bytes);
  };
  if (message.mode === "sab") {
    if (message.ringBuffer === undefined || message.inputRingBuffer === undefined) {
      throw new Error("SAB activation omitted mutation or input ring buffer");
    }
    sabReceiver = new SabMutationReceiver(
      scope,
      SabMutationRing.attach(message.ringBuffer),
      consume,
      { onError: fatal, sessionId },
    );
    inputRing = SabMutationRing.attach(message.inputRingBuffer);
  } else {
    postMessageReceiver = new PostMessageMutationReceiver(scope, consume, {
      onError: fatal,
      sessionId,
    });
  }
  clock = new HybridRenderClock({ onError: fatal });
  clock.start((frame) => {
    sabReceiver?.drain();
    drainInputRing();
    drainPendingInput();
    sink?.advance(frame.deltaMs / 1000);
    clockFramesSinceReport += 1;
    if (clockFramesSinceReport >= 60) {
      clockFramesSinceReport = 0;
      const metrics = clock?.metrics();
      if (metrics !== undefined) post({ kind: "pingo:clock-metrics", metrics, sessionId });
    }
  });
  active = true;
  post({ kind: "pingo:ready", mode: message.mode, sessionId });
}

function disposeRuntime(): void {
  clock?.stop();
  postMessageReceiver?.dispose();
  sabReceiver?.dispose();
  sink?.dispose();
  core?.free?.();
  clock = undefined;
  postMessageReceiver = undefined;
  sabReceiver = undefined;
  inputRing = undefined;
  sink = undefined;
  core = undefined;
  active = false;
}

/** Input batches received since the last frame, applied together. */
const pendingInput: Uint8Array[] = [];

/** Applies every queued input batch, replaying the canvas once for the group. */
function drainPendingInput(): void {
  if (pendingInput.length === 0) return;
  sink?.inputBatch(pendingInput.splice(0, pendingInput.length));
}

function drainInputRing(): void {
  const ring = inputRing;
  if (ring === undefined) return;
  for (;;) {
    const frame = ring.take();
    if (frame === null) return;
    const decoded = decodeInputBatch(frame.bytes);
    if (decoded.frameSeq !== frame.frameSeq) {
      throw new Error("transport and Input Stream sequences differ");
    }
    sink?.input(frame.bytes);
  }
}

function fatal(cause: unknown): void {
  if (failed) return;
  failed = true;
  const error = cause instanceof Error ? cause : new Error("render Worker failed", { cause });
  disposeRuntime();
  try {
    post({ kind: "pingo:fatal", error: error.message, sessionId });
  } catch {
    // A native Worker error event is the final recovery signal if posting fails.
  }
}

function post(message: RenderWorkerOutboundMessage): void {
  scope.postMessage(message);
}

function positiveU32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new RangeError(`${label} must be a positive u32`);
  }
  return value;
}
