import type { SampleSummary } from "./metrics";

export type WorkerMethod =
  | "capabilities"
  | "message-backpressure"
  | "message-copy-cost"
  | "offscreen-canvas"
  | "render-continuity"
  | "sab-backpressure"
  | "sab-latency"
  | "self-drive"
  | "worker-raf";

export type TransportMode = "sab" | "post-message" | "main-thread";

export interface WorkerRequest {
  readonly id: number;
  readonly kind: "request";
  readonly method: WorkerMethod;
  readonly payload: unknown;
}

export interface ClockAnchorMessage {
  readonly kind: "clock-anchor";
  readonly sequence: number;
  readonly timestamp: number;
}

export type WorkerInboundMessage = WorkerRequest | ClockAnchorMessage;

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
  readonly tileSizes: readonly TileSizeProbeResult[];
}

export interface TileSizeProbeResult {
  readonly megapixelsPerSecond: number;
  readonly operations: number;
  readonly operationsPerSecond: number;
  readonly tileSizePx: number;
}

export interface SabLatencyPayload {
  readonly buffer: SharedArrayBuffer;
  readonly sampleCount: number;
}

export interface SabBackpressurePayload {
  readonly buffer: SharedArrayBuffer;
  readonly capacity: number;
  readonly consumerDelayEvery: number;
  readonly consumerDelayMs: number;
}

export interface SabBackpressureWorkerResult {
  readonly consumedSequences: readonly number[];
  readonly durationMs: number;
  readonly finalReadCursor: number;
  readonly finalWriteCursor: number;
}

export interface SabBackpressureResult extends SabBackpressureWorkerResult {
  readonly acceptedCount: number;
  readonly acceptedPerSecond: number;
  readonly backpressureHandled: boolean;
  readonly capacity: number;
  readonly consumedCount: number;
  readonly drained: boolean;
  readonly droppedCount: number;
  readonly highWatermark: number;
  readonly latestAcceptedSequence: number;
  readonly latestConsumedSequence: number;
  readonly producedCount: number;
  readonly sequenceMonotonic: boolean;
}

export interface MessageBackpressurePayload {
  readonly consumerDelayEvery: number;
  readonly consumerDelayMs: number;
  readonly port: MessagePort;
}

export type MessageBackpressurePortMessage =
  { readonly kind: "done" } | { readonly kind: "sequence"; readonly sequence: number };

export interface MessageBackpressureAck {
  readonly kind: "ack";
  readonly sequence: number;
}

export interface MessageBackpressureWorkerResult {
  readonly consumedSequences: readonly number[];
  readonly durationMs: number;
}

export interface MessageBackpressureResult extends MessageBackpressureWorkerResult {
  readonly acceptedCount: number;
  readonly acceptedPerSecond: number;
  readonly acknowledgementsMatch: boolean;
  readonly acknowledgedCount: number;
  readonly acknowledgedSequences: readonly number[];
  readonly backpressureHandled: boolean;
  readonly capacity: number;
  readonly consumedCount: number;
  readonly drained: boolean;
  readonly droppedCount: number;
  readonly finalInFlight: number;
  readonly highWatermark: number;
  readonly latestAcceptedSequence: number;
  readonly latestAcknowledgedSequence: number;
  readonly latestConsumedSequence: number;
  readonly producedCount: number;
  readonly sequenceMonotonic: boolean;
}

export interface MessageCopyCostPayload {
  readonly expectedChecksum: number;
  readonly iterations: number;
  readonly payloadBytes: number;
  readonly port: MessagePort;
}

export type MessageCopyCostPortMessage =
  | { readonly kind: "done" }
  | { readonly data: ArrayBuffer; readonly kind: "payload"; readonly sequence: number };

export interface MessageCopyCostAck {
  readonly checksum: number;
  readonly kind: "ack";
  readonly sequence: number;
}

export interface MessageCopyCostWorkerResult {
  readonly receivedCount: number;
  readonly verified: boolean;
}

export interface MessageCopyCostCaseResult extends MessageCopyCostWorkerResult {
  readonly effectiveMiBPerSecond: number;
  readonly iterations: number;
  readonly payloadBytes: number;
  readonly roundTripMs: readonly number[];
  readonly summary: SampleSummary;
  readonly totalBytes: number;
}

export interface MessageCopyCostResult {
  readonly cases: readonly MessageCopyCostCaseResult[];
}

export interface RenderContinuityPayload {
  readonly anchorBuffer?: SharedArrayBuffer;
  readonly durationMs: number;
  readonly mode: Exclude<TransportMode, "main-thread">;
  readonly stallEndEpochMs: number;
  readonly stallStartEpochMs: number;
  readonly startAtEpochMs: number;
  readonly targetFrameMs: number;
}

export interface FrameContinuityResult {
  readonly anchorLatencySamples: readonly number[];
  readonly anchorLatencySummary?: SampleSummary;
  readonly continuousDuringStall: boolean;
  readonly durationMs: number;
  readonly finalPixelRgba: readonly number[];
  readonly frameIntervals: readonly number[];
  readonly frameSummary: SampleSummary;
  readonly framesDuringStall: number;
  readonly maxFrameGapMs: number;
  readonly missedFrameBudget: number;
  readonly mode: TransportMode;
  readonly paintOperations: number;
  readonly phaseErrorSamples: readonly number[];
  readonly phaseErrorSummary?: SampleSummary;
  readonly renderedFrames: number;
}

export type TransportProbeOutcome =
  | { readonly status: "ok"; readonly result: FrameContinuityResult }
  | { readonly status: "unsupported" | "error"; readonly reason: string };

export interface TransportMatrixResult {
  readonly modes: Readonly<Record<TransportMode, TransportProbeOutcome>>;
  readonly recommendedMode: TransportMode;
}

export interface WorkerRafPayload {
  readonly frameCount: number;
}

export interface SelfDrivePayload {
  readonly durationMs: number;
}
