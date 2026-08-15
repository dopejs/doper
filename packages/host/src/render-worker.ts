/// <reference lib="webworker" />

import { decodeMutationBatch } from "@dopejs/doper-reconciler";
import { decodeInputBatch } from "@dopejs/doper-editing";

import { ABI_VERSION } from "./generated";
import { CanvasFrameSink, createDefaultRasterCache, type CoreClient } from "./main-thread";
import { PostMessageMutationReceiver } from "./post-message";
import { HybridRenderClock } from "./render-clock";
import { SabMutationRing } from "./sab-ring";
import { SabMutationReceiver } from "./sab-transport";
import { createWasmCore } from "./wasm";
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
  if (message.kind === "doper:clock-anchor") {
    if (message.sessionId === sessionId && active)
      clock?.anchor(message.sequence, message.timestamp);
    return;
  }
  operations = operations.then(() => handle(message)).catch((cause: unknown) => fatal(cause));
});

async function handle(message: RenderWorkerInboundMessage): Promise<void> {
  if (failed) return;
  switch (message.kind) {
    case "doper:prepare":
      if (prepared || active) throw new Error("render Worker was prepared more than once");
      if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) {
        throw new Error("render Worker protocol version mismatch");
      }
      if (message.abiVersion !== ABI_VERSION) throw new Error("render Worker ABI version mismatch");
      sessionId = positiveU32(message.sessionId, "sessionId");
      await verifyWasmStartup();
      prepared = true;
      post({
        capabilities: {
          offscreenCanvas: typeof OffscreenCanvas === "function",
          sharedArrayBuffer: typeof SharedArrayBuffer === "function",
        },
        kind: "doper:prepared",
        sessionId,
      });
      return;
    case "doper:activate":
      await activate(message);
      return;
    case "doper:shutdown":
      if (message.sessionId !== sessionId) return;
      disposeRuntime();
      post({ kind: "doper:shutdown-complete", sessionId });
      scope.close();
      return;
    case "doper:input":
      if (!active || message.sessionId !== sessionId) return;
      drainInputRing();
      sink?.input(message.bytes);
      return;
    case "doper:input-wake":
      if (!active || message.sessionId !== sessionId) return;
      drainInputRing();
      return;
    case "doper:clock-anchor":
      return;
  }
}

async function verifyWasmStartup(): Promise<void> {
  const probe = await createWasmCore(1, 1);
  probe.free?.();
}

async function activate(message: WorkerActivateMessage): Promise<void> {
  if (!prepared || active) throw new Error("render Worker activation is out of order");
  if (message.sessionId !== sessionId) throw new Error("render Worker activation session mismatch");
  if (!(message.canvas instanceof OffscreenCanvas))
    throw new TypeError("activation canvas is invalid");
  const context = message.canvas.getContext("2d", { alpha: true });
  if (context === null) throw new Error("OffscreenCanvas 2D context is unavailable");
  core = await createWasmCore(message.width, message.height);
  sink = new CanvasFrameSink(
    context,
    core,
    (report) => {
      post({ kind: "doper:frame", report, sessionId });
    },
    message.rasterCache ? createDefaultRasterCache(context, fatal) : undefined,
    (requests) => post({ kind: "doper:virtual-refill", requests, sessionId }),
  );
  const consume = (frameSeq: number, bytes: Uint8Array): void => {
    const decoded = decodeMutationBatch(bytes);
    if (decoded.frameSeq !== frameSeq)
      throw new Error("transport and Mutation Stream sequences differ");
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
    sink?.advance(frame.deltaMs / 1000);
    clockFramesSinceReport += 1;
    if (clockFramesSinceReport >= 60) {
      clockFramesSinceReport = 0;
      const metrics = clock?.metrics();
      if (metrics !== undefined) post({ kind: "doper:clock-metrics", metrics, sessionId });
    }
  });
  active = true;
  post({ kind: "doper:ready", mode: message.mode, sessionId });
}

function disposeRuntime(): void {
  clock?.stop();
  postMessageReceiver?.dispose();
  sabReceiver?.dispose();
  core?.free?.();
  clock = undefined;
  postMessageReceiver = undefined;
  sabReceiver = undefined;
  inputRing = undefined;
  sink = undefined;
  core = undefined;
  active = false;
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
    post({ kind: "doper:fatal", error: error.message, sessionId });
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
