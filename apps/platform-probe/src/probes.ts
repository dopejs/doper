import { absoluteHighResolutionTime, round } from "./metrics";
import type {
  CanvasProbeResult,
  FrameContinuityResult,
  RenderContinuityPayload,
  SabLatencyPayload,
  SelfDrivePayload,
  TimingProbeResult,
  TransportMatrixResult,
  TransportMode,
  TransportProbeOutcome,
  WorkerCapabilities,
  WorkerRafPayload,
} from "./protocol";
import { analyzeContinuity, selectTransport } from "./transport";
import { ProbeWorkerClient } from "./worker-client";

export interface EnvironmentSnapshot {
  readonly crossOriginIsolated: boolean;
  readonly deviceMemoryGiB: number | null;
  readonly devicePixelRatio: number;
  readonly editContext: boolean;
  readonly hardwareConcurrency: number;
  readonly offscreenCanvas: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly timeOrigin: number;
  readonly userAgent: string;
  readonly viewport: { readonly height: number; readonly width: number };
  readonly worker: WorkerCapabilities;
}

export interface WasmProbeResult {
  readonly abiVersion: number;
  readonly compileAndInstantiateMs: number;
  readonly fetchMs: number;
  readonly firstCallMs: number;
  readonly gzipBytes: number;
  readonly mixedValue: number;
  readonly rawBytes: number;
  readonly strategy: "instantiate" | "instantiateStreaming";
}

export interface WasmBudgetProbeResult {
  readonly compileAndInstantiateMs: number;
  readonly fetchMs: number;
  readonly firstCallMs: number;
  readonly graphemeCount: number;
  readonly gzipBytes: number;
  readonly headroomBytes: number;
  readonly maximumGzipBytes: number;
  readonly productBudgetBytes: number;
  readonly rawBytes: number;
  readonly strategy: "instantiate" | "instantiateStreaming";
}

interface ProbeWasmExports extends WebAssembly.Exports {
  doper_probe_abi_version(): number;
  doper_probe_mix(value: number): number;
}

interface WasmManifest {
  readonly gzipBytes: number;
  readonly rawBytes: number;
}

interface WasmBudgetExports extends WebAssembly.Exports {
  doper_budget_grapheme_count(): number;
}

interface WasmBudgetManifest extends WasmManifest {
  readonly headroomBytes: number;
  readonly maximumGzipBytes: number;
  readonly productBudgetBytes: number;
}

export class PlatformProbeRunner {
  readonly #worker = new ProbeWorkerClient();

  async environment(): Promise<EnvironmentSnapshot> {
    const worker = await this.#worker.call<WorkerCapabilities>("capabilities", undefined);
    const navigatorWithMemory = navigator as Navigator & { readonly deviceMemory?: number };
    return {
      crossOriginIsolated,
      deviceMemoryGiB: navigatorWithMemory.deviceMemory ?? null,
      devicePixelRatio,
      editContext: typeof Reflect.get(window, "EditContext") === "function",
      hardwareConcurrency: navigator.hardwareConcurrency,
      offscreenCanvas: typeof OffscreenCanvas === "function",
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      timeOrigin: performance.timeOrigin,
      userAgent: navigator.userAgent,
      viewport: { height: innerHeight, width: innerWidth },
      worker,
    };
  }

  workerRaf(frameCount = 60): Promise<TimingProbeResult> {
    const payload: WorkerRafPayload = { frameCount };
    return this.#worker.call("worker-raf", payload, 5000);
  }

  async sabLatency(sampleCount = 60): Promise<TimingProbeResult> {
    if (typeof SharedArrayBuffer !== "function") {
      throw new Error("SharedArrayBuffer is unavailable");
    }

    const buffer = new SharedArrayBuffer(16);
    const sequence = new Int32Array(buffer, 0, 1);
    const timestamp = new Float64Array(buffer, 8, 1);
    const payload: SabLatencyPayload = { buffer, sampleCount };
    const result = this.#worker.call<TimingProbeResult>("sab-latency", payload, 12_000);

    let frame = 0;
    const publish = (): void => {
      timestamp[0] = absoluteHighResolutionTime(performance.timeOrigin, performance.now());
      Atomics.store(sequence, 0, (Atomics.load(sequence, 0) + 1) | 0);
      frame += 1;
      if (frame < sampleCount + 10) {
        requestAnimationFrame(publish);
      }
    };
    requestAnimationFrame(publish);

    return result;
  }

  async selfDriveDuringMainThreadStall(stallMs = 200): Promise<TimingProbeResult> {
    const payload: SelfDrivePayload = { durationMs: stallMs + 250 };
    const result = this.#worker.call<TimingProbeResult>("self-drive", payload, 5000);
    await delay(50);
    blockMainThread(stallMs);
    return result;
  }

  offscreenCanvas(): Promise<CanvasProbeResult> {
    return this.#worker.call("offscreen-canvas", undefined, 5000);
  }

  async transportMatrix(canvas: HTMLCanvasElement): Promise<TransportMatrixResult> {
    const environment = await this.environment();
    const recommendedMode = selectTransport(environment);
    const modes: Record<TransportMode, TransportProbeOutcome> = {
      "sab":
        environment.crossOriginIsolated &&
        environment.sharedArrayBuffer &&
        environment.worker.sharedArrayBuffer
          ? await this.#captureOutcome(() => this.#workerContinuity("sab"))
          : {
              reason: "Cross-origin isolation or SharedArrayBuffer is unavailable",
              status: "unsupported",
            },
      "post-message": environment.worker.offscreenCanvas
        ? await this.#captureOutcome(() => this.#workerContinuity("post-message"))
        : { reason: "Worker OffscreenCanvas is unavailable", status: "unsupported" },
      "main-thread": await this.#captureOutcome(() => this.#mainThreadContinuity(canvas)),
    };
    return { modes, recommendedMode };
  }

  mainThreadCanvas(canvas: HTMLCanvasElement): CanvasProbeResult {
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) {
      throw new Error("Main-thread Canvas2D context is unavailable");
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

  async wasmColdStart(): Promise<WasmProbeResult> {
    const fetchStartedAt = performance.now();
    const [response, manifestResponse] = await Promise.all([
      fetch("/wasm/doper_probe.wasm", { cache: "no-store" }),
      fetch("/wasm/manifest.json", { cache: "no-store" }),
    ]);
    const fetchMs = performance.now() - fetchStartedAt;
    if (!response.ok || !manifestResponse.ok) {
      throw new Error(`WASM probe assets unavailable (${String(response.status)})`);
    }

    const manifest = (await manifestResponse.json()) as WasmManifest;
    const compileStartedAt = performance.now();
    const supportsStreaming = typeof WebAssembly.instantiateStreaming === "function";
    const instance = supportsStreaming
      ? await WebAssembly.instantiateStreaming(response, {})
      : await WebAssembly.instantiate(await response.arrayBuffer(), {});
    const compileAndInstantiateMs = performance.now() - compileStartedAt;
    const exports = instance.instance.exports as ProbeWasmExports;
    const callStartedAt = performance.now();
    const mixedValue = exports.doper_probe_mix(42);
    const firstCallMs = performance.now() - callStartedAt;

    return {
      abiVersion: exports.doper_probe_abi_version(),
      compileAndInstantiateMs: round(compileAndInstantiateMs),
      fetchMs: round(fetchMs),
      firstCallMs: round(firstCallMs),
      gzipBytes: manifest.gzipBytes,
      mixedValue,
      rawBytes: manifest.rawBytes,
      strategy: supportsStreaming ? "instantiateStreaming" : "instantiate",
    };
  }

  async wasmBudgetColdStart(): Promise<WasmBudgetProbeResult> {
    const fetchStartedAt = performance.now();
    const [response, manifestResponse] = await Promise.all([
      fetch("/wasm/doper_budget.wasm", { cache: "no-store" }),
      fetch("/wasm/budget-manifest.json", { cache: "no-store" }),
    ]);
    const fetchMs = performance.now() - fetchStartedAt;
    if (!response.ok || !manifestResponse.ok) {
      throw new Error(`WASM budget assets unavailable (${String(response.status)})`);
    }

    const manifest = (await manifestResponse.json()) as WasmBudgetManifest;
    const compileStartedAt = performance.now();
    const supportsStreaming = typeof WebAssembly.instantiateStreaming === "function";
    const instance = supportsStreaming
      ? await WebAssembly.instantiateStreaming(response, {})
      : await WebAssembly.instantiate(await response.arrayBuffer(), {});
    const compileAndInstantiateMs = performance.now() - compileStartedAt;
    const exports = instance.instance.exports as WasmBudgetExports;
    const callStartedAt = performance.now();
    const graphemeCount = exports.doper_budget_grapheme_count();
    const firstCallMs = performance.now() - callStartedAt;

    return {
      compileAndInstantiateMs: round(compileAndInstantiateMs),
      fetchMs: round(fetchMs),
      firstCallMs: round(firstCallMs),
      graphemeCount,
      gzipBytes: manifest.gzipBytes,
      headroomBytes: manifest.headroomBytes,
      maximumGzipBytes: manifest.maximumGzipBytes,
      productBudgetBytes: manifest.productBudgetBytes,
      rawBytes: manifest.rawBytes,
      strategy: supportsStreaming ? "instantiateStreaming" : "instantiate",
    };
  }

  dispose(): void {
    this.#worker.dispose();
  }

  async #workerContinuity(
    mode: Exclude<TransportMode, "main-thread">,
  ): Promise<FrameContinuityResult> {
    const targetFrameMs = 1000 / 60;
    const startAtEpochMs = absoluteNow() + 200;
    const stallStartEpochMs = startAtEpochMs + 100;
    const stallEndEpochMs = stallStartEpochMs + 200;
    const anchorBuffer = mode === "sab" ? new SharedArrayBuffer(16) : undefined;
    const payload: RenderContinuityPayload = {
      ...(anchorBuffer === undefined ? {} : { anchorBuffer }),
      durationMs: 500,
      mode,
      stallEndEpochMs,
      stallStartEpochMs,
      startAtEpochMs,
      targetFrameMs,
    };
    const result = this.#worker.call<FrameContinuityResult>("render-continuity", payload, 5000);
    const stopPublishing = this.#publishClockAnchors(mode, anchorBuffer);
    try {
      await delayUntilEpoch(stallStartEpochMs);
      blockMainThread(stallEndEpochMs - stallStartEpochMs);
      return await result;
    } finally {
      stopPublishing();
    }
  }

  async #mainThreadContinuity(canvas: HTMLCanvasElement): Promise<FrameContinuityResult> {
    const context = canvas.getContext("2d", { alpha: false });
    if (context === null) {
      throw new Error("Main-thread Canvas2D context is unavailable for continuity rendering");
    }

    const targetFrameMs = 1000 / 60;
    const startAtEpochMs = absoluteNow() + 200;
    const stallStartEpochMs = startAtEpochMs + 100;
    const stallEndEpochMs = stallStartEpochMs + 200;
    const frameTimestamps: number[] = [];
    let paintOperations = 0;
    const rendering = (async (): Promise<FrameContinuityResult> => {
      await delayUntilEpoch(startAtEpochMs);
      const endAtEpochMs = startAtEpochMs + 500;
      let nextDeadline = performance.now();
      while (absoluteNow() < endAtEpochMs) {
        await delayUntilMonotonic(nextDeadline);
        paintMainThreadContinuityFrame(context, paintOperations);
        paintOperations += 1;
        frameTimestamps.push(absoluteNow());
        nextDeadline += targetFrameMs;
        if (nextDeadline < performance.now() - targetFrameMs) {
          nextDeadline = performance.now();
        }
      }
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return analyzeContinuity({
        finalPixelRgba: [...pixel],
        frameTimestamps,
        mode: "main-thread",
        paintOperations,
        stallEndEpochMs,
        stallStartEpochMs,
        targetFrameMs,
      });
    })();

    await delayUntilEpoch(stallStartEpochMs);
    blockMainThread(stallEndEpochMs - stallStartEpochMs);
    return rendering;
  }

  #publishClockAnchors(
    mode: Exclude<TransportMode, "main-thread">,
    anchorBuffer: SharedArrayBuffer | undefined,
  ): () => void {
    const sequenceView = anchorBuffer === undefined ? null : new Int32Array(anchorBuffer, 0, 1);
    const timestampView = anchorBuffer === undefined ? null : new Float64Array(anchorBuffer, 8, 1);
    let sequence = 0;
    let animationFrame = 0;
    let stopped = false;
    const publish = (timestamp: number): void => {
      if (stopped) {
        return;
      }
      sequence += 1;
      const absoluteTimestamp = absoluteHighResolutionTime(performance.timeOrigin, timestamp);
      if (mode === "sab" && sequenceView !== null && timestampView !== null) {
        timestampView[0] = absoluteTimestamp;
        Atomics.store(sequenceView, 0, sequence);
      } else {
        this.#worker.publishClockAnchor(sequence, absoluteTimestamp);
      }
      animationFrame = requestAnimationFrame(publish);
    };
    animationFrame = requestAnimationFrame(publish);
    return () => {
      stopped = true;
      cancelAnimationFrame(animationFrame);
    };
  }

  async #captureOutcome(
    probe: () => Promise<FrameContinuityResult>,
  ): Promise<TransportProbeOutcome> {
    try {
      return { result: await probe(), status: "ok" };
    } catch (error) {
      return {
        reason: error instanceof Error ? error.message : String(error),
        status: "error",
      };
    }
  }
}

export function blockMainThread(durationMs: number): void {
  const deadline = performance.now() + durationMs;
  while (performance.now() < deadline) {
    // This is an intentional M0 fault-injection probe.
  }
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

function tileSizeScan(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
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

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
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

function paintMainThreadContinuityFrame(context: CanvasRenderingContext2D, sequence: number): void {
  context.fillStyle = `hsl(${String(sequence % 360)} 70% 45%)`;
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  context.fillStyle = "#ffffff";
  context.fillRect((sequence * 7) % Math.max(1, context.canvas.width - 16), 72, 16, 36);
}
