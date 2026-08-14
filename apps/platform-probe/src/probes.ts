import { absoluteHighResolutionTime, round } from "./metrics";
import type {
  CanvasProbeResult,
  SabLatencyPayload,
  SelfDrivePayload,
  TimingProbeResult,
  WorkerCapabilities,
  WorkerRafPayload,
} from "./protocol";
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
}

interface ProbeWasmExports extends WebAssembly.Exports {
  doper_probe_abi_version(): number;
  doper_probe_mix(value: number): number;
}

interface WasmManifest {
  readonly gzipBytes: number;
  readonly rawBytes: number;
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

    return {
      durationMs: round(draw.durationMs + scrollCopy.durationMs),
      operations: draw.operations,
      operationsPerSecond: round(draw.operationsPerSecond),
      scrollCopyOperations: scrollCopy.operations,
      scrollCopyOperationsPerSecond: round(scrollCopy.operationsPerSecond),
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
    const source = await response.arrayBuffer();
    const instance = await WebAssembly.instantiate(source, {});
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
    };
  }

  dispose(): void {
    this.#worker.dispose();
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

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
