import "./style.css";

import { EditingProbe, type EditingProbeSnapshot } from "./editing-probe";
import type { CanvasProbeResult, TimingProbeResult } from "./protocol";
import { PlatformProbeRunner, type EnvironmentSnapshot, type WasmProbeResult } from "./probes";

interface ProbeReport {
  build: {
    readonly id: string;
    readonly mode: string;
  };
  canvas?: {
    readonly mainThread?: CanvasProbeResult;
    readonly worker?: CanvasProbeResult;
  };
  editing?: EditingProbeSnapshot;
  environment?: EnvironmentSnapshot;
  errors?: Record<string, string>;
  finishedAt?: string;
  sabLatency?: TimingProbeResult;
  selfDrive?: TimingProbeResult;
  startedAt?: string;
  version: 1;
  wasm?: WasmProbeResult;
  workerRaf?: TimingProbeResult;
}

const runner = new PlatformProbeRunner();
const configuredBuildId: unknown = Reflect.get(import.meta.env, "VITE_DOPER_BUILD_ID");
const report: ProbeReport = {
  build: {
    id:
      typeof configuredBuildId === "string" && configuredBuildId.length > 0
        ? configuredBuildId
        : "local-uncommitted",
    mode: import.meta.env.MODE,
  },
  version: 1,
};
const runButton = element<HTMLButtonElement>("run-all");
const exportButton = element<HTMLButtonElement>("export");
const runState = element<HTMLElement>("run-state");
const editorMode = element<HTMLElement>("editor-mode");
const editorLog = element<HTMLElement>("editor-log");
const editingProbe = new EditingProbe(element<HTMLCanvasElement>("editor"), (snapshot) => {
  report.editing = snapshot;
  editorMode.textContent = snapshot.mode === "edit-context" ? "EditContext" : "Input proxy";
  editorLog.textContent =
    snapshot.events.length > 0 ? snapshot.events.join("\n") : "No editing events";
});

runButton.addEventListener("click", () => {
  void runAll();
});
exportButton.addEventListener("click", exportReport);
window.addEventListener("beforeunload", () => {
  editingProbe.dispose();
  runner.dispose();
});

void initialize();

async function initialize(): Promise<void> {
  try {
    report.environment = await runner.environment();
    renderCapabilities(report.environment);
  } catch (error) {
    runState.textContent = "Initialization failed";
    renderError("capabilities", error);
  }
}

async function runAll(): Promise<void> {
  runButton.disabled = true;
  exportButton.disabled = true;
  runState.textContent = "Running";
  report.startedAt = new Date().toISOString();
  delete report.finishedAt;
  delete report.canvas;
  delete report.sabLatency;
  delete report.selfDrive;
  delete report.wasm;
  delete report.workerRaf;
  report.errors = {};

  try {
    report.environment = await runner.environment();
    renderCapabilities(report.environment);

    const workerRaf = await runProbe(
      "worker-raf",
      "worker-raf-result",
      () => runner.workerRaf(),
      compactTimingResult,
    );
    if (workerRaf !== undefined) {
      report.workerRaf = workerRaf;
    }
    const sabLatency = await runProbe(
      "sab-latency",
      "sab-result",
      () => runner.sabLatency(),
      compactTimingResult,
    );
    if (sabLatency !== undefined) {
      report.sabLatency = sabLatency;
    }
    const selfDrive = await runProbe(
      "self-drive",
      "stall-result",
      () => runner.selfDriveDuringMainThreadStall(),
      compactTimingResult,
    );
    if (selfDrive !== undefined) {
      report.selfDrive = selfDrive;
    }
    const workerCanvas = await runProbe("worker-canvas", "canvas-result", () =>
      runner.offscreenCanvas(),
    );
    const mainCanvas = await runProbe("main-canvas", "canvas-result", () =>
      Promise.resolve(runner.mainThreadCanvas(element<HTMLCanvasElement>("main-benchmark"))),
    );
    if (workerCanvas !== undefined || mainCanvas !== undefined) {
      report.canvas = {
        ...(mainCanvas === undefined ? {} : { mainThread: mainCanvas }),
        ...(workerCanvas === undefined ? {} : { worker: workerCanvas }),
      };
      renderJson("canvas-result", report.canvas);
    }
    const wasm = await runProbe("wasm", "wasm-result", () => runner.wasmColdStart());
    if (wasm !== undefined) {
      report.wasm = wasm;
    }
    report.editing = editingProbe.snapshot();
    report.finishedAt = new Date().toISOString();
    runState.textContent =
      Object.keys(report.errors).length === 0 ? "Complete" : "Complete with gaps";
    exportButton.disabled = false;
  } catch (error) {
    runState.textContent = "Failed";
    console.error(error);
    exportButton.disabled = false;
  } finally {
    runButton.disabled = false;
  }
}

async function runProbe<Result>(
  errorKey: string,
  targetId: string,
  probe: () => Promise<Result>,
  presentation: (result: Result) => unknown = (result) => result,
): Promise<Result | undefined> {
  const target = element<HTMLElement>(targetId);
  target.textContent = "Running…";
  try {
    const result = await probe();
    renderJson(targetId, presentation(result));
    return result;
  } catch (error) {
    renderError(targetId, error);
    if (report.errors !== undefined) {
      report.errors[errorKey] = error instanceof Error ? error.message : String(error);
    }
    return undefined;
  }
}

function compactTimingResult(result: TimingProbeResult): unknown {
  return { durationMs: result.durationMs, summary: result.summary };
}

function renderCapabilities(environment: EnvironmentSnapshot): void {
  const entries: readonly [string, string][] = [
    ["Cross-origin isolated", yesNo(environment.crossOriginIsolated)],
    ["SharedArrayBuffer", yesNo(environment.sharedArrayBuffer)],
    ["OffscreenCanvas", yesNo(environment.offscreenCanvas)],
    ["Worker rAF", yesNo(environment.worker.requestAnimationFrame)],
    ["EditContext", yesNo(environment.editContext)],
    ["CPU threads", String(environment.hardwareConcurrency)],
    ["Device pixel ratio", String(environment.devicePixelRatio)],
    ["Viewport", `${String(environment.viewport.width)} × ${String(environment.viewport.height)}`],
  ];
  const target = element<HTMLElement>("capabilities");
  target.replaceChildren(
    ...entries.map(([label, value]) => {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value;
      wrapper.append(term, description);
      return wrapper;
    }),
  );
}

function renderJson(targetId: string, value: unknown): void {
  element<HTMLElement>(targetId).textContent = JSON.stringify(value, null, 2);
}

function renderError(targetId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const target = document.getElementById(targetId);
  if (target !== null) {
    target.textContent = `ERROR: ${message}`;
  }
}

function exportReport(): void {
  report.editing = editingProbe.snapshot();
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.download = `doper-platform-probe-${new Date().toISOString().replaceAll(":", "-")}.json`;
  link.href = URL.createObjectURL(blob);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

function element<ElementType extends HTMLElement>(id: string): ElementType {
  const value = document.getElementById(id);
  if (value === null) {
    throw new Error(`Missing required element #${id}`);
  }
  return value as ElementType;
}
