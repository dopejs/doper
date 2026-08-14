/// <reference lib="webworker" />

import { absoluteHighResolutionTime, round, summarize } from "./metrics";
import type {
  CanvasProbeResult,
  SabLatencyPayload,
  SelfDrivePayload,
  TimingProbeResult,
  WorkerCapabilities,
  WorkerRafPayload,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

const scope = self as DedicatedWorkerGlobalScope;

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
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
    case "offscreen-canvas":
      return offscreenCanvasProbe();
    case "sab-latency":
      return sabLatencyProbe(request.payload as SabLatencyPayload);
    case "self-drive":
      return selfDriveProbe(request.payload as SelfDrivePayload);
    case "worker-raf":
      return workerRafProbe(request.payload as WorkerRafPayload);
  }
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

  return {
    durationMs: round(draw.durationMs + scrollCopy.durationMs),
    operations: draw.operations,
    operationsPerSecond: round(draw.operationsPerSecond),
    scrollCopyOperations: scrollCopy.operations,
    scrollCopyOperationsPerSecond: round(scrollCopy.operationsPerSecond),
  };
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

function post(response: WorkerResponse): void {
  scope.postMessage(response);
}
