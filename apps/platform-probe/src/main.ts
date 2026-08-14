import "./style.css";

import { EditingProbe, type EditingProbeSnapshot } from "./editing-probe";
import type { CanvasProbeResult, TimingProbeResult, TransportMatrixResult } from "./protocol";
import {
  PlatformProbeRunner,
  type EnvironmentSnapshot,
  type WasmBudgetProbeResult,
  type WasmProbeResult,
} from "./probes";

interface ProbeReport {
  build: {
    readonly id: string;
    readonly mode: string;
  };
  canvas?: {
    readonly mainThread?: CanvasProbeResult;
    readonly worker?: CanvasProbeResult;
  };
  collection?:
    | { readonly kind: "single" }
    | {
        readonly batchId: string;
        readonly kind: "sample" | "warmup";
        readonly sequence: number;
        readonly total: number;
      };
  deviceId: string;
  editing?: EditingProbeSnapshot;
  environment?: EnvironmentSnapshot;
  errors?: Record<string, string>;
  finishedAt?: string;
  runId: string;
  sabLatency?: TimingProbeResult;
  selfDrive?: TimingProbeResult;
  startedAt?: string;
  transport?: TransportMatrixResult;
  version: 1;
  wasm?: WasmProbeResult;
  wasmBudget?: WasmBudgetProbeResult;
  workerRaf?: TimingProbeResult;
}

const runner = new PlatformProbeRunner();
const searchParameters = new URLSearchParams(location.search);
const configuredBuildId: unknown = Reflect.get(import.meta.env, "VITE_DOPER_BUILD_ID");
const configuredDeviceId: unknown = Reflect.get(import.meta.env, "VITE_DOPER_DEVICE_ID");
const requestedDeviceId = searchParameters.get("deviceId");
const deviceId =
  requestedDeviceId !== null && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(requestedDeviceId)
    ? requestedDeviceId
    : typeof configuredDeviceId === "string" && configuredDeviceId.length > 0
      ? configuredDeviceId
      : "local-dev";
const report: ProbeReport = {
  build: {
    id:
      typeof configuredBuildId === "string" && configuredBuildId.length > 0
        ? configuredBuildId
        : "local-uncommitted",
    mode: import.meta.env.MODE,
  },
  deviceId,
  runId: crypto.randomUUID(),
  version: 1,
};
Reflect.set(window, "__DOPER_PLATFORM_PROBE_REPORT__", report);
const runButton = element<HTMLButtonElement>("run-all");
const exportButton = element<HTMLButtonElement>("export");
const archiveButton = element<HTMLButtonElement>("archive");
const archiveState = element<HTMLElement>("archive-state");
const collectorAuth = element<HTMLLabelElement>("collector-auth");
const collectorToken = element<HTMLInputElement>("collector-token");
const batchControls = element<HTMLElement>("batch-controls");
const batchWarmups = element<HTMLInputElement>("batch-warmups");
const batchSamples = element<HTMLInputElement>("batch-samples");
const batchButton = element<HTMLButtonElement>("run-batch");
const batchState = element<HTMLElement>("batch-state");
const runState = element<HTMLElement>("run-state");
const editorMode = element<HTMLElement>("editor-mode");
const editorLog = element<HTMLElement>("editor-log");
const imeLanguage = element<HTMLSelectElement>("ime-language");
const imeInputMethod = element<HTMLInputElement>("ime-input-method");
const imeExportButton = element<HTMLButtonElement>("export-ime");
const imeExportState = element<HTMLElement>("ime-export-state");
const forceInputProxy = searchParameters.get("editing") === "proxy";
const collectorEnabled = searchParameters.get("collector") === "1";
collectorAuth.hidden = !collectorEnabled;
batchControls.hidden = !collectorEnabled;
let batchRunning = false;
let initialized = false;
let imeExported = false;
let probeRunning = false;
let uploadRunning = false;
const editingRecordingId = crypto.randomUUID();
const editingRecordedAt = new Date().toISOString();
const editingProbe = new EditingProbe(
  element<HTMLCanvasElement>("editor"),
  (snapshot) => {
    report.editing = snapshot;
    editorMode.textContent = snapshot.mode === "edit-context" ? "EditContext" : "Input proxy";
    editorLog.textContent =
      snapshot.events.length > 0 ? snapshot.events.join("\n") : "No editing events";
    imeExportButton.disabled = snapshot.records.length === 0 || imeExported;
    syncImeRecording(snapshot);
    syncReportSnapshot();
  },
  { forceInputProxy },
);

runButton.addEventListener("click", () => {
  report.collection = { kind: "single" };
  void runAll();
});
exportButton.addEventListener("click", exportReport);
archiveButton.addEventListener("click", () => {
  void archiveReport();
});
batchButton.addEventListener("click", () => {
  void runBatch();
});
imeInputMethod.addEventListener("input", () => syncImeRecording(editingProbe.snapshot()));
imeLanguage.addEventListener("change", () => syncImeRecording(editingProbe.snapshot()));
imeExportButton.addEventListener("click", exportImeRecording);
window.addEventListener("beforeunload", () => {
  editingProbe.dispose();
  runner.dispose();
});

void initialize();
updateControls();

async function initialize(): Promise<void> {
  try {
    report.environment = await runner.environment();
    renderCapabilities(report.environment);
    syncReportSnapshot();
    initialized = true;
    updateControls();
    if (searchParameters.get("autorun") === "1") {
      report.collection = { kind: "single" };
      await runAll();
    }
  } catch (error) {
    runState.textContent = "Initialization failed";
    renderError("capabilities", error);
  }
}

async function runAll(): Promise<void> {
  if (probeRunning || !initialized) {
    return;
  }
  probeRunning = true;
  updateControls();
  archiveState.textContent = "";
  runState.textContent = "Running";
  report.runId = crypto.randomUUID();
  report.startedAt = new Date().toISOString();
  delete report.finishedAt;
  delete report.canvas;
  delete report.sabLatency;
  delete report.selfDrive;
  delete report.transport;
  delete report.wasm;
  delete report.wasmBudget;
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
    const transport = await runProbe(
      "transport",
      "transport-result",
      () => runner.transportMatrix(element<HTMLCanvasElement>("continuity-benchmark")),
      compactTransportMatrix,
    );
    if (transport !== undefined) {
      report.transport = transport;
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
    const wasmBudget = await runProbe("wasm-budget", "wasm-budget-result", () =>
      runner.wasmBudgetColdStart(),
    );
    if (wasmBudget !== undefined) {
      report.wasmBudget = wasmBudget;
    }
    report.editing = editingProbe.snapshot();
    report.finishedAt = new Date().toISOString();
    runState.textContent =
      Object.keys(report.errors).length === 0 ? "Complete" : "Complete with gaps";
    syncReportSnapshot();
  } catch (error) {
    report.errors ??= {};
    report.errors.run = error instanceof Error ? error.message : String(error);
    report.finishedAt = new Date().toISOString();
    runState.textContent = "Failed";
    console.error(error);
    syncReportSnapshot();
  } finally {
    probeRunning = false;
    updateControls();
  }
}

async function archiveReport(): Promise<boolean> {
  if (uploadRunning || report.finishedAt === undefined) {
    return false;
  }
  uploadRunning = true;
  updateControls();
  archiveState.textContent = "Uploading…";
  report.editing = editingProbe.snapshot();
  syncReportSnapshot();
  try {
    const response = await fetch("/api/reports", {
      body: JSON.stringify(report),
      headers: {
        ...(collectorToken.value.length === 0
          ? {}
          : { Authorization: `Bearer ${collectorToken.value}` }),
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const result = (await response.json()) as {
      readonly archivedPath?: string;
      readonly error?: string;
    };
    if (!response.ok)
      throw new Error(result.error ?? `collector returned ${String(response.status)}`);
    archiveState.textContent = `Archived: ${result.archivedPath ?? report.runId}`;
    return true;
  } catch (error) {
    archiveState.textContent = `Archive failed: ${error instanceof Error ? error.message : String(error)}`;
    return false;
  } finally {
    uploadRunning = false;
    updateControls();
  }
}

async function runBatch(): Promise<void> {
  if (batchRunning || probeRunning || !collectorEnabled) {
    return;
  }
  try {
    const warmups = boundedInteger(batchWarmups, 0, 10, "warmups");
    const samples = boundedInteger(batchSamples, 1, 50, "samples");
    const batchId = crypto.randomUUID();
    batchRunning = true;
    updateControls();
    for (let index = 0; index < warmups; index += 1) {
      batchState.textContent = `Warmup ${String(index + 1)}/${String(warmups)}`;
      report.collection = {
        batchId,
        kind: "warmup",
        sequence: index + 1,
        total: warmups,
      };
      await runAll();
      if (report.finishedAt === undefined || Object.keys(report.errors ?? {}).length > 0) {
        await archiveReport();
        throw new Error("warmup probe failed; resolve the environment before collecting samples");
      }
    }
    for (let index = 0; index < samples; index += 1) {
      batchState.textContent = `Sample ${String(index + 1)}/${String(samples)}`;
      report.collection = {
        batchId,
        kind: "sample",
        sequence: index + 1,
        total: samples,
      };
      await runAll();
      if (!(await archiveReport())) {
        throw new Error(`sample ${String(index + 1)} could not be archived`);
      }
    }
    batchState.textContent = `Batch complete: ${String(warmups)} warmups + ${String(samples)} archived samples`;
  } catch (error) {
    batchState.textContent = `Batch failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    batchRunning = false;
    updateControls();
  }
}

function boundedInteger(
  input: HTMLInputElement,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const value = input.valueAsNumber;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return value;
}

function updateControls(): void {
  runButton.disabled = !initialized || probeRunning || batchRunning;
  exportButton.disabled = probeRunning || report.finishedAt === undefined;
  archiveButton.disabled =
    !collectorEnabled || probeRunning || uploadRunning || report.finishedAt === undefined;
  batchButton.disabled =
    !initialized || !collectorEnabled || batchRunning || probeRunning || uploadRunning;
  batchWarmups.disabled = batchRunning || probeRunning;
  batchSamples.disabled = batchRunning || probeRunning;
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

function compactTransportMatrix(result: TransportMatrixResult): unknown {
  return {
    recommendedMode: result.recommendedMode,
    modes: Object.fromEntries(
      Object.entries(result.modes).map(([mode, outcome]) => [
        mode,
        outcome.status === "ok"
          ? {
              continuousDuringStall: outcome.result.continuousDuringStall,
              framesDuringStall: outcome.result.framesDuringStall,
              maxFrameGapMs: outcome.result.maxFrameGapMs,
              missedFrameBudget: outcome.result.missedFrameBudget,
              paintOperations: outcome.result.paintOperations,
              renderedFrames: outcome.result.renderedFrames,
              status: outcome.status,
            }
          : outcome,
      ]),
    ),
  };
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
  syncReportSnapshot();
  downloadJson(
    report,
    `doper-platform-probe-${new Date().toISOString().replaceAll(":", "-")}.json`,
  );
}

function exportImeRecording(): void {
  const snapshot = editingProbe.snapshot();
  if (imeInputMethod.value.trim().length === 0) {
    imeExportState.textContent = "Input method and version are required";
    return;
  }
  if (snapshot.records.length === 0) {
    imeExportState.textContent = "Record at least one editing event";
    return;
  }
  if (snapshot.droppedRecords > 0) {
    imeExportState.textContent = "Recording overflowed; start a fresh session";
    return;
  }
  if (snapshot.composing) {
    imeExportState.textContent = "Finish the active composition before export";
    return;
  }
  const recording = buildImeRecording(snapshot);
  syncImeRecording(snapshot);
  downloadJson(recording, `doper-ime-${recording.recordingId}.json`);
  imeExported = true;
  imeExportButton.disabled = true;
  imeExportState.textContent = `Exported recording ${recording.recordingId}; reload for a new session`;
}

function buildImeRecording(snapshot: EditingProbeSnapshot) {
  const navigatorWithUserAgentData = navigator as Navigator & {
    readonly userAgentData?: { readonly platform?: string };
  };
  const softKeyboardObserved = snapshot.records.some((record) => {
    const height = record.data.visualViewportHeight;
    return typeof height === "number" && height < snapshot.initialVisualViewportHeight * 0.8;
  });
  const detectedPlatform =
    navigatorWithUserAgentData.userAgentData?.platform?.trim() ||
    navigator.platform.trim() ||
    "unknown";
  return {
    $schema: "https://dopejs.dev/schemas/ime-recording-v2.json",
    characterBoundsObserved: snapshot.records.some(
      (record) => record.event === "characterboundsupdate",
    ),
    description: `${imeLanguage.value} ${imeInputMethod.value.trim() || "unspecified input method"} via ${snapshot.mode}`,
    droppedRecords: snapshot.droppedRecords,
    environment: {
      browser: navigator.userAgent,
      buildId: report.build.id,
      deviceId: report.deviceId,
      inputMethod: imeInputMethod.value.trim(),
      language: imeLanguage.value,
      locale: navigator.language,
      mode: snapshot.mode,
      os: detectedPlatform,
      userAgent: navigator.userAgent,
    },
    events: snapshot.records,
    finalComposing: snapshot.composing,
    finalSelection: { end: snapshot.selectionEnd, start: snapshot.selectionStart },
    finalText: snapshot.text,
    initialText: snapshot.initialText,
    initialVisualViewportHeight: snapshot.initialVisualViewportHeight,
    provenance: "recorded",
    recordedAt: editingRecordedAt,
    recordingId: editingRecordingId,
    softKeyboardObserved,
    version: 2,
  } as const;
}

function syncImeRecording(snapshot: EditingProbeSnapshot): void {
  element<HTMLScriptElement>("ime-recording").textContent =
    `${JSON.stringify(buildImeRecording(snapshot), null, 2)}\n`;
}

function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.download = filename;
  link.href = URL.createObjectURL(blob);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function syncReportSnapshot(): void {
  element<HTMLScriptElement>("probe-report").textContent = `${JSON.stringify(report, null, 2)}\n`;
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
