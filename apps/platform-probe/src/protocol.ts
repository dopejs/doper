import type { SampleSummary } from "./metrics";

export type WorkerMethod =
  "capabilities" | "offscreen-canvas" | "sab-latency" | "self-drive" | "worker-raf";

export interface WorkerRequest {
  readonly id: number;
  readonly method: WorkerMethod;
  readonly payload: unknown;
}

export interface WorkerResponse {
  readonly error?: string;
  readonly id: number;
  readonly result?: unknown;
}

export interface WorkerCapabilities {
  readonly offscreenCanvas: boolean;
  readonly requestAnimationFrame: boolean;
  readonly sharedArrayBuffer: boolean;
}

export interface TimingProbeResult {
  readonly durationMs: number;
  readonly samples: readonly number[];
  readonly summary: SampleSummary;
}

export interface CanvasProbeResult {
  readonly durationMs: number;
  readonly operations: number;
  readonly operationsPerSecond: number;
  readonly scrollCopyOperations: number;
  readonly scrollCopyOperationsPerSecond: number;
}

export interface SabLatencyPayload {
  readonly buffer: SharedArrayBuffer;
  readonly sampleCount: number;
}

export interface WorkerRafPayload {
  readonly frameCount: number;
}

export interface SelfDrivePayload {
  readonly durationMs: number;
}
