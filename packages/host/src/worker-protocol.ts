import type { FrameReport } from "./main-thread";
import type { VirtualRefillRange } from "./main-thread";
import type { HostTransportMode } from "./capabilities";
import type { RenderClockMetrics } from "./render-clock";
import type { EditTransaction } from "@dopejs/doper-editing";

export const WORKER_PROTOCOL_VERSION = 3 as const;

export interface WorkerPrepareMessage {
  readonly abiVersion: number;
  readonly kind: "doper:prepare";
  readonly protocolVersion: number;
  readonly sessionId: number;
}

export interface WorkerActivateMessage {
  readonly canvas: OffscreenCanvas;
  readonly height: number;
  readonly kind: "doper:activate";
  readonly mode: Exclude<HostTransportMode, "main-thread">;
  readonly rasterCache: boolean;
  readonly inputRingBuffer?: SharedArrayBuffer;
  readonly ringBuffer?: SharedArrayBuffer;
  readonly sessionId: number;
  readonly width: number;
}

export interface WorkerClockAnchorMessage {
  readonly kind: "doper:clock-anchor";
  readonly sequence: number;
  readonly sessionId: number;
  readonly timestamp: number;
}

export interface WorkerShutdownMessage {
  readonly kind: "doper:shutdown";
  readonly sessionId: number;
}

export interface WorkerInputMessage {
  readonly bytes: Uint8Array;
  readonly kind: "doper:input";
  readonly sessionId: number;
}

export interface WorkerInputWakeMessage {
  readonly kind: "doper:input-wake";
  readonly sessionId: number;
}

export type RenderWorkerInboundMessage =
  | WorkerActivateMessage
  | WorkerClockAnchorMessage
  | WorkerInputMessage
  | WorkerInputWakeMessage
  | WorkerPrepareMessage
  | WorkerShutdownMessage;

export interface RenderWorkerCapabilities {
  readonly offscreenCanvas: boolean;
  readonly sharedArrayBuffer: boolean;
}

export interface WorkerPreparedMessage {
  readonly capabilities: RenderWorkerCapabilities;
  readonly kind: "doper:prepared";
  readonly sessionId: number;
}

export interface WorkerReadyMessage {
  readonly kind: "doper:ready";
  readonly mode: Exclude<HostTransportMode, "main-thread">;
  readonly sessionId: number;
}

export interface WorkerFrameMessage {
  readonly kind: "doper:frame";
  readonly report: FrameReport;
  readonly sessionId: number;
}

export interface WorkerClockMetricsMessage {
  readonly kind: "doper:clock-metrics";
  readonly metrics: RenderClockMetrics;
  readonly sessionId: number;
}

export interface WorkerVirtualRefillMessage {
  readonly kind: "doper:virtual-refill";
  readonly requests: readonly VirtualRefillRange[];
  readonly sessionId: number;
}

export interface WorkerEditTransactionMessage {
  readonly kind: "doper:edit-transaction";
  readonly sessionId: number;
  readonly transaction: EditTransaction;
}

export interface WorkerFatalMessage {
  readonly error: string;
  readonly kind: "doper:fatal";
  readonly sessionId: number;
}

export interface WorkerShutdownCompleteMessage {
  readonly kind: "doper:shutdown-complete";
  readonly sessionId: number;
}

export type RenderWorkerOutboundMessage =
  | WorkerClockMetricsMessage
  | WorkerEditTransactionMessage
  | WorkerFatalMessage
  | WorkerFrameMessage
  | WorkerPreparedMessage
  | WorkerReadyMessage
  | WorkerVirtualRefillMessage
  | WorkerShutdownCompleteMessage;

export function isRenderWorkerInboundMessage(value: unknown): value is RenderWorkerInboundMessage {
  if (!isRecord(value) || !isPositiveU32(value.sessionId)) return false;
  switch (value.kind) {
    case "doper:prepare":
      return isPositiveU32(value.abiVersion) && isPositiveU32(value.protocolVersion);
    case "doper:activate":
      return (
        isWorkerMode(value.mode) &&
        isPositiveFinite(value.width) &&
        isPositiveFinite(value.height) &&
        isRecord(value.canvas) &&
        typeof value.rasterCache === "boolean" &&
        (value.mode === "post-message" ||
          (isSharedArrayBuffer(value.ringBuffer) && isSharedArrayBuffer(value.inputRingBuffer)))
      );
    case "doper:clock-anchor":
      return isPositiveU32(value.sequence) && isFiniteNumber(value.timestamp);
    case "doper:input":
      return value.bytes instanceof Uint8Array;
    case "doper:input-wake":
      return true;
    case "doper:shutdown":
      return true;
    default:
      return false;
  }
}

export function isRenderWorkerInboundEnvelope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.kind === "doper:prepare" ||
    value.kind === "doper:activate" ||
    value.kind === "doper:clock-anchor" ||
    value.kind === "doper:input" ||
    value.kind === "doper:input-wake" ||
    value.kind === "doper:shutdown"
  );
}

export function isRenderWorkerOutboundMessage(
  value: unknown,
): value is RenderWorkerOutboundMessage {
  if (!isRecord(value) || !isPositiveU32(value.sessionId)) return false;
  switch (value.kind) {
    case "doper:prepared":
      return (
        isRecord(value.capabilities) &&
        typeof value.capabilities.offscreenCanvas === "boolean" &&
        typeof value.capabilities.sharedArrayBuffer === "boolean"
      );
    case "doper:ready":
      return isWorkerMode(value.mode);
    case "doper:frame":
      return isFrameReport(value.report);
    case "doper:clock-metrics":
      return isClockMetrics(value.metrics);
    case "doper:virtual-refill":
      return Array.isArray(value.requests) && value.requests.every(isVirtualRefillRange);
    case "doper:edit-transaction":
      return isEditTransaction(value.transaction);
    case "doper:fatal":
      return typeof value.error === "string";
    case "doper:shutdown-complete":
      return true;
    default:
      return false;
  }
}

export function isRenderWorkerOutboundEnvelope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.kind === "doper:prepared" ||
    value.kind === "doper:ready" ||
    value.kind === "doper:frame" ||
    value.kind === "doper:clock-metrics" ||
    value.kind === "doper:virtual-refill" ||
    value.kind === "doper:edit-transaction" ||
    value.kind === "doper:fatal" ||
    value.kind === "doper:shutdown-complete"
  );
}

function isEditTransaction(value: unknown): value is EditTransaction {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.nodeId) ||
    value.nodeId > 0xffff_ffff ||
    typeof value.baseRevision !== "bigint" ||
    typeof value.revision !== "bigint" ||
    value.baseRevision < 0n ||
    value.revision <= value.baseRevision ||
    !isRecord(value.selection) ||
    !isU32(value.selection.anchor) ||
    !isU32(value.selection.focus) ||
    !isAffinity(value.selection.anchorAffinity) ||
    !isAffinity(value.selection.focusAffinity) ||
    !isTransactionKind(value.kind)
  ) {
    return false;
  }
  if (value.delta !== undefined) {
    if (
      !isRecord(value.delta) ||
      typeof value.delta.text !== "string" ||
      !isRange(value.delta.range)
    ) {
      return false;
    }
  }
  return value.composition === undefined || isRange(value.composition);
}

function isRange(value: unknown): boolean {
  return isRecord(value) && isU32(value.start) && isU32(value.end) && value.start <= value.end;
}

function isU32(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 0xffff_ffff;
}

function isAffinity(value: unknown): boolean {
  return value === "upstream" || value === "downstream";
}

function isTransactionKind(value: unknown): boolean {
  return (
    value === "edit" ||
    value === "composition" ||
    value === "undo" ||
    value === "redo" ||
    value === "external"
  );
}

function isVirtualRefillRange(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.nodeId) &&
    value.nodeId <= 0xffff_ffff &&
    isNonNegativeInteger(value.start) &&
    value.start <= 0xffff_ffff &&
    isNonNegativeInteger(value.end) &&
    value.end <= 0xffff_ffff &&
    value.start < value.end
  );
}

function isFrameReport(value: unknown): value is FrameReport {
  if (!isRecord(value)) return false;
  if (
    !isNonNegativeInteger(value.commands) ||
    !isNonNegativeInteger(value.pictures) ||
    !isNonNegativeInteger(value.maximumPictureDepth) ||
    !isNonNegativeInteger(value.mutationBytes) ||
    !isNonNegativeInteger(value.displayListBytes)
  )
    return false;
  if (
    value.cause !== undefined &&
    value.cause !== "mutation" &&
    value.cause !== "input" &&
    value.cause !== "animation"
  )
    return false;
  if (value.inputBytes !== undefined && !isNonNegativeInteger(value.inputBytes)) return false;
  if (value.animationDeltaMs !== undefined && !isNonNegativeFinite(value.animationDeltaMs))
    return false;
  if (value.core !== undefined && !isCoreDiagnostics(value.core)) return false;
  if (value.rasterCache !== undefined && !isRasterMetrics(value.rasterCache)) return false;
  return value.rasterFrame === undefined || isRasterFrame(value.rasterFrame);
}

function isCoreDiagnostics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const counters = [
    value.frameSeq,
    value.sceneNodes,
    value.dirtyLayoutNodes,
    value.dirtyPaintNodes,
    value.dirtyPaintSelfNodes,
    value.dirtyHitNodes,
    value.dirtySemanticsNodes,
    value.layoutChangedNodes,
    value.layoutVisitedNodes,
    value.displayCommands,
    value.pictureBuilds,
    value.pictureCacheHits,
    value.pictureSubtreeBuilds,
    value.pictureSubtreeCacheHits,
    value.overInvalidatedFrames,
  ];
  return (
    counters.every(isNonNegativeInteger) &&
    typeof value.paintRebuilt === "boolean" &&
    typeof value.pictureHash === "bigint" &&
    value.pictureHash >= 0n
  );
}

function isRasterMetrics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    value.budgetBytes,
    value.bypassedFrames,
    value.bytes,
    value.compositedTiles,
    value.entries,
    value.evictions,
    value.hits,
    value.misses,
  ].every(isNonNegativeInteger);
}

function isRasterFrame(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.bypassed === "boolean" &&
    isNonNegativeInteger(value.hits) &&
    isNonNegativeInteger(value.misses)
  );
}

function isClockMetrics(value: unknown): value is RenderClockMetrics {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.acceptedAnchors) &&
    isNonNegativeInteger(value.anchoredFrames) &&
    isNonNegativeInteger(value.frames) &&
    isNonNegativeInteger(value.ignoredAnchors) &&
    isNonNegativeFinite(value.maximumFrameGapMs) &&
    isNonNegativeInteger(value.overruns) &&
    typeof value.running === "boolean" &&
    isNonNegativeInteger(value.selfDrivenFrames)
  );
}

function isWorkerMode(value: unknown): value is Exclude<HostTransportMode, "main-thread"> {
  return value === "post-message" || value === "sab";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveU32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 0xffff_ffff;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer;
}
