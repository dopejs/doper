/// <reference lib="webworker" />

import { absoluteHighResolutionTime, round, summarize } from "./metrics";
import {
  attachSabSequenceRing,
  ringCursors,
  sequenceRingFinished,
  takeSequence,
  waitForSequence,
} from "./backpressure";
import type {
  CanvasProbeResult,
  ClockAnchorMessage,
  FrameContinuityResult,
  MessageBackpressureAck,
  MessageBackpressurePayload,
  MessageBackpressurePortMessage,
  MessageBackpressureWorkerResult,
  MessageCopyCostAck,
  MessageCopyCostPayload,
  MessageCopyCostPortMessage,
  MessageCopyCostWorkerResult,
  RenderContinuityPayload,
  SabBackpressurePayload,
  SabBackpressureWorkerResult,
  SabLatencyPayload,
  SelfDrivePayload,
  TimingProbeResult,
  WorkerCapabilities,
  WorkerInboundMessage,
  WorkerRafPayload,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";
import { analyzeContinuity, clampPhaseCorrection, nextAlignedFrame } from "./transport";
import { payloadChecksum } from "./message-copy-cost";

const scope = self as DedicatedWorkerGlobalScope;
let latestMessageAnchor: ClockAnchorMessage | null = null;

scope.addEventListener("message", (event: MessageEvent<WorkerInboundMessage>) => {
  if (event.data.kind === "clock-anchor") {
    latestMessageAnchor = event.data;
    return;
  }
  void handleRequest(event.data);
});

async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    const result = await run(request);
    post({ id: request.id, result });
  } catch (error) {
    post({
      error: error instanceof Error ? error.message : String(error),
      id: request.id,
    });
  }
}

function run(request: WorkerRequest): unknown {
  switch (request.method) {
    case "capabilities":
      return capabilities();
    case "message-backpressure":
      return messageBackpressureProbe(request.payload as MessageBackpressurePayload);
    case "message-copy-cost":
      return messageCopyCostProbe(request.payload as MessageCopyCostPayload);
    case "offscreen-canvas":
      return offscreenCanvasProbe();
    case "render-continuity":
      return renderContinuityProbe(request.payload as RenderContinuityPayload);
    case "sab-backpressure":
      return sabBackpressureProbe(request.payload as SabBackpressurePayload);
    case "sab-latency":
      return sabLatencyProbe(request.payload as SabLatencyPayload);
    case "self-drive":
      return selfDriveProbe(request.payload as SelfDrivePayload);
    case "worker-raf":
      return workerRafProbe(request.payload as WorkerRafPayload);
  }
}

async function messageCopyCostProbe(
  payload: MessageCopyCostPayload,
): Promise<MessageCopyCostWorkerResult> {
  if (!(payload.port instanceof MessagePort)) {
    throw new TypeError("message copy cost probe requires a transferred MessagePort");
  }
  if (
    !Number.isInteger(payload.payloadBytes) ||
    payload.payloadBytes < 1 ||
    payload.payloadBytes > 4_194_304
  ) {
    throw new RangeError("message copy payloadBytes must be from 1 to 4194304");
  }
  if (!Number.isInteger(payload.iterations) || payload.iterations < 1 || payload.iterations > 256) {
    throw new RangeError("message copy iterations must be from 1 to 256");
  }
  if (
    !Number.isInteger(payload.expectedChecksum) ||
    payload.expectedChecksum < 0 ||
    payload.expectedChecksum > 0xffffffff
  ) {
    throw new RangeError("message copy expectedChecksum must be a uint32");
  }

  return new Promise<MessageCopyCostWorkerResult>((resolve, reject) => {
    let receivedCount = 0;
    const cleanup = (): void => {
      payload.port.removeEventListener("message", handleMessage);
      payload.port.close();
    };
    const fail = (error: unknown): void => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const handleMessage = (event: MessageEvent<MessageCopyCostPortMessage>): void => {
      try {
        const message = event.data;
        if (message.kind === "done") {
          if (receivedCount !== payload.iterations) {
            throw new Error("message copy stream ended before every payload was received");
          }
          cleanup();
          resolve({ receivedCount, verified: true });
          return;
        }
        if (
          message.kind !== "payload" ||
          message.sequence !== receivedCount + 1 ||
          !(message.data instanceof ArrayBuffer) ||
          message.data.byteLength !== payload.payloadBytes
        ) {
          throw new Error("message copy stream contains an invalid payload");
        }
        const checksum = payloadChecksum(new Uint8Array(message.data));
        if (checksum !== payload.expectedChecksum) {
          throw new Error("message copy payload checksum mismatch");
        }
        receivedCount += 1;
        const acknowledgement: MessageCopyCostAck = {
          checksum,
          kind: "ack",
          sequence: message.sequence,
        };
        payload.port.postMessage(acknowledgement);
      } catch (error) {
        fail(error);
      }
    };
    payload.port.addEventListener("message", handleMessage);
    payload.port.start();
  });
}

async function messageBackpressureProbe(
  payload: MessageBackpressurePayload,
): Promise<MessageBackpressureWorkerResult> {
  validateConsumerDelay(payload.consumerDelayEvery, payload.consumerDelayMs);
  if (!(payload.port instanceof MessagePort)) {
    throw new TypeError("message backpressure probe requires a transferred MessagePort");
  }
  const queue: number[] = [];
  const consumedSequences: number[] = [];
  let done = false;
  let protocolError: Error | null = null;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const pendingWake = wake;
    wake = null;
    pendingWake?.();
  };
  const handleMessage = (event: MessageEvent<MessageBackpressurePortMessage>): void => {
    const message = event.data;
    if (message.kind === "done") {
      if (done) protocolError = new Error("message backpressure stream sent done twice");
      done = true;
    } else if (
      message.kind === "sequence" &&
      Number.isInteger(message.sequence) &&
      message.sequence >= 1 &&
      message.sequence <= 0x7fffffff &&
      !done
    ) {
      queue.push(message.sequence);
      if (queue.length > 1_000_000) {
        protocolError = new Error("message backpressure queue exceeded its safety bound");
      }
    } else {
      protocolError = new Error("message backpressure stream contains an invalid message");
    }
    notify();
  };
  payload.port.addEventListener("message", handleMessage);
  payload.port.start();
  const startedAt = performance.now();
  try {
    while (!done || queue.length > 0) {
      throwIfError(protocolError);
      const sequence = queue.shift();
      if (sequence === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      consumedSequences.push(sequence);
      const acknowledgement: MessageBackpressureAck = { kind: "ack", sequence };
      payload.port.postMessage(acknowledgement);
      if (consumedSequences.length % payload.consumerDelayEvery === 0) {
        await delay(payload.consumerDelayMs);
      }
    }
    throwIfError(protocolError);
    return {
      consumedSequences,
      durationMs: round(performance.now() - startedAt),
    };
  } finally {
    payload.port.removeEventListener("message", handleMessage);
    payload.port.close();
  }
}

async function sabBackpressureProbe(
  payload: SabBackpressurePayload,
): Promise<SabBackpressureWorkerResult> {
  validateConsumerDelay(payload.consumerDelayEvery, payload.consumerDelayMs);
  const ring = attachSabSequenceRing(payload.buffer, payload.capacity);
  const consumedSequences: number[] = [];
  const startedAt = performance.now();
  while (!sequenceRingFinished(ring)) {
    const sequence = takeSequence(ring);
    if (sequence === null) {
      waitForSequence(ring, 100);
      continue;
    }
    consumedSequences.push(sequence);
    if (consumedSequences.length > 1_000_000) {
      throw new Error("SAB backpressure probe exceeded its consumer safety bound");
    }
    if (consumedSequences.length % payload.consumerDelayEvery === 0) {
      await delay(payload.consumerDelayMs);
    }
  }
  const cursors = ringCursors(ring);
  return {
    consumedSequences,
    durationMs: round(performance.now() - startedAt),
    finalReadCursor: cursors.read,
    finalWriteCursor: cursors.write,
  };
}

function validateConsumerDelay(delayEvery: number, delayMs: number): void {
  if (!Number.isInteger(delayEvery) || delayEvery < 1) {
    throw new RangeError("consumerDelayEvery must be a positive integer");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 100) {
    throw new RangeError("consumerDelayMs must be from 0 to 100");
  }
}

function throwIfError(value: unknown): void {
  if (value instanceof Error) throw value;
}

async function renderContinuityProbe(
  payload: RenderContinuityPayload,
): Promise<FrameContinuityResult> {
  if (typeof OffscreenCanvas !== "function") {
    throw new Error("OffscreenCanvas is unavailable for continuity rendering");
  }
  if (payload.mode === "sab" && payload.anchorBuffer === undefined) {
    throw new Error("SAB continuity mode requires an anchor buffer");
  }

  const canvas = new OffscreenCanvas(320, 180);
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) {
    throw new Error("OffscreenCanvas 2D context is unavailable for continuity rendering");
  }

  const sabSequence =
    payload.anchorBuffer === undefined ? null : new Int32Array(payload.anchorBuffer, 0, 1);
  const sabTimestamp =
    payload.anchorBuffer === undefined ? null : new Float64Array(payload.anchorBuffer, 8, 1);
  const frameTimestamps: number[] = [];
  const anchorLatencies: number[] = [];
  const phaseErrors: number[] = [];
  let observedAnchorSequence = -1;
  let paintOperations = 0;

  await delayUntilEpoch(payload.startAtEpochMs);
  const endAtEpochMs = payload.startAtEpochMs + payload.durationMs;
  let nextDeadline = performance.now();

  while (absoluteNow() < endAtEpochMs) {
    await delayUntilMonotonic(nextDeadline);
    const renderedAt = absoluteNow();
    const anchor = readAnchor(payload.mode, sabSequence, sabTimestamp);
    let correction = 0;

    if (anchor !== null && anchor.sequence !== observedAnchorSequence) {
      observedAnchorSequence = anchor.sequence;
      const latency = renderedAt - anchor.timestamp;
      if (latency >= 0 && latency < 1000) {
        anchorLatencies.push(latency);
      }
    }
    if (anchor !== null && renderedAt - anchor.timestamp <= 100) {
      const anchorMonotonic = anchor.timestamp - performance.timeOrigin;
      const alignedDeadline = nextAlignedFrame(
        performance.now(),
        anchorMonotonic,
        payload.targetFrameMs,
      );
      const uncorrectedDeadline = nextDeadline + payload.targetFrameMs;
      correction = clampPhaseCorrection(alignedDeadline - uncorrectedDeadline);
      const nearestPhase =
        anchorMonotonic +
        Math.round((performance.now() - anchorMonotonic) / payload.targetFrameMs) *
          payload.targetFrameMs;
      phaseErrors.push(performance.now() - nearestPhase);
    }

    paintContinuityFrame(context, paintOperations);
    paintOperations += 1;
    frameTimestamps.push(renderedAt);
    nextDeadline += payload.targetFrameMs + correction;
    if (nextDeadline < performance.now() - payload.targetFrameMs) {
      nextDeadline = performance.now();
    }
  }

  const pixel = context.getImageData(0, 0, 1, 1).data;
  return analyzeContinuity({
    anchorLatencies,
    finalPixelRgba: [...pixel],
    frameTimestamps,
    mode: payload.mode,
    paintOperations,
    phaseErrors,
    stallEndEpochMs: payload.stallEndEpochMs,
    stallStartEpochMs: payload.stallStartEpochMs,
    targetFrameMs: payload.targetFrameMs,
  });
}

function capabilities(): WorkerCapabilities {
  return {
    offscreenCanvas: typeof OffscreenCanvas === "function",
    requestAnimationFrame: typeof scope.requestAnimationFrame === "function",
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
  };
}

async function workerRafProbe(payload: WorkerRafPayload): Promise<TimingProbeResult> {
  const workerRaf = scope.requestAnimationFrame?.bind(scope);
  if (workerRaf === undefined) {
    throw new Error("Worker requestAnimationFrame is unavailable");
  }

  const startedAt = performance.now();
  const timestamps: number[] = [];
  await new Promise<void>((resolve) => {
    const step = (timestamp: number): void => {
      timestamps.push(timestamp);
      if (timestamps.length >= payload.frameCount + 1) {
        resolve();
      } else {
        workerRaf(step);
      }
    };
    workerRaf(step);
  });

  const samples = intervals(timestamps);
  return {
    durationMs: round(performance.now() - startedAt),
    samples,
    summary: summarize(samples),
  };
}

async function sabLatencyProbe(payload: SabLatencyPayload): Promise<TimingProbeResult> {
  const sequence = new Int32Array(payload.buffer, 0, 1);
  const timestamp = new Float64Array(payload.buffer, 8, 1);
  const samples: number[] = [];
  const startedAt = performance.now();
  let previousSequence = Atomics.load(sequence, 0);

  while (samples.length < payload.sampleCount && performance.now() - startedAt < 10_000) {
    const currentSequence = Atomics.load(sequence, 0);
    if (currentSequence !== previousSequence) {
      previousSequence = currentSequence;
      const observedAt = absoluteHighResolutionTime(performance.timeOrigin, performance.now());
      samples.push(observedAt - (timestamp[0] ?? observedAt));
    }
    await yieldTask();
  }

  if (samples.length === 0) {
    throw new Error("No shared timestamp samples observed");
  }

  return {
    durationMs: round(performance.now() - startedAt),
    samples: samples.map((sample) => round(sample)),
    summary: summarize(samples),
  };
}

async function selfDriveProbe(payload: SelfDrivePayload): Promise<TimingProbeResult> {
  const timestamps = [performance.now()];
  const startedAt = timestamps[0] ?? performance.now();
  while (performance.now() - startedAt < payload.durationMs) {
    await yieldTask();
    timestamps.push(performance.now());
  }
  const samples = intervals(timestamps);
  return {
    durationMs: round(performance.now() - startedAt),
    samples,
    summary: summarize(samples),
  };
}

function offscreenCanvasProbe(): CanvasProbeResult {
  if (typeof OffscreenCanvas !== "function") {
    throw new Error("OffscreenCanvas is unavailable");
  }

  const canvas = new OffscreenCanvas(1024, 1024);
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) {
    throw new Error("OffscreenCanvas 2D context is unavailable");
  }

  const draw = benchmark(250, (operation) => {
    context.fillStyle = `hsl(${String(operation % 360)} 70% 50%)`;
    context.fillRect(operation % 1000, (operation * 17) % 1000, 24, 24);
  });
  const scrollCopy = benchmark(250, () => {
    context.drawImage(canvas, 0, 1, 1024, 1023, 0, 0, 1024, 1023);
  });
  const tileSizes = tileSizeScan(context, canvas);

  return {
    durationMs: round(draw.durationMs + scrollCopy.durationMs),
    operations: draw.operations,
    operationsPerSecond: round(draw.operationsPerSecond),
    scrollCopyOperations: scrollCopy.operations,
    scrollCopyOperationsPerSecond: round(scrollCopy.operationsPerSecond),
    tileSizes,
  };
}

function tileSizeScan(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
): CanvasProbeResult["tileSizes"] {
  return [128, 256, 512, 1024].map((tileSizePx) => {
    const result = benchmark(100, () => {
      context.drawImage(canvas, 0, 1, tileSizePx, tileSizePx - 1, 0, 0, tileSizePx, tileSizePx - 1);
    });
    return {
      megapixelsPerSecond: round(
        (result.operationsPerSecond * tileSizePx * tileSizePx) / 1_000_000,
      ),
      operations: result.operations,
      operationsPerSecond: round(result.operationsPerSecond),
      tileSizePx,
    };
  });
}

function benchmark(
  durationMs: number,
  operation: (index: number) => void,
): {
  readonly durationMs: number;
  readonly operations: number;
  readonly operationsPerSecond: number;
} {
  const startedAt = performance.now();
  let operations = 0;
  do {
    operation(operations);
    operations += 1;
  } while (performance.now() - startedAt < durationMs);

  const elapsed = performance.now() - startedAt;
  return {
    durationMs: elapsed,
    operations,
    operationsPerSecond: operations / (elapsed / 1000),
  };
}

function readAnchor(
  mode: RenderContinuityPayload["mode"],
  sabSequence: Int32Array | null,
  sabTimestamp: Float64Array | null,
): { readonly sequence: number; readonly timestamp: number } | null {
  if (mode === "post-message") {
    return latestMessageAnchor;
  }
  if (sabSequence === null || sabTimestamp === null) {
    return null;
  }
  return {
    sequence: Atomics.load(sabSequence, 0),
    timestamp: sabTimestamp[0] ?? 0,
  };
}

function paintContinuityFrame(context: OffscreenCanvasRenderingContext2D, sequence: number): void {
  context.fillStyle = `hsl(${String(sequence % 360)} 70% 45%)`;
  context.fillRect(0, 0, 320, 180);
  context.fillStyle = "#ffffff";
  context.fillRect((sequence * 7) % 304, 72, 16, 36);
}

function intervals(timestamps: readonly number[]): number[] {
  const result: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const current = timestamps[index];
    const previous = timestamps[index - 1];
    if (current !== undefined && previous !== undefined) {
      result.push(round(current - previous));
    }
  }
  return result;
}

function yieldTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function absoluteNow(): number {
  return absoluteHighResolutionTime(performance.timeOrigin, performance.now());
}

async function delayUntilEpoch(deadline: number): Promise<void> {
  while (absoluteNow() < deadline) {
    await delay(Math.min(20, Math.max(0, deadline - absoluteNow())));
  }
}

async function delayUntilMonotonic(deadline: number): Promise<void> {
  while (performance.now() < deadline) {
    await delay(Math.min(10, Math.max(0, deadline - performance.now())));
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function post(response: WorkerResponse): void {
  scope.postMessage(response);
}
