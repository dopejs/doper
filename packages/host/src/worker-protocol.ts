import type { FrameReport } from "./main-thread";
import type { VirtualRefillRange } from "./main-thread";
import type { NonPassiveRegion } from "./main-thread";
import type {
  EditingCharacterBounds,
  EditingGeometryFrame,
  EditingGeometryRect,
  LayoutGeometryFrame,
  LayoutGeometryRecord,
  SemanticNode,
} from "./main-thread";
import type { HostTransportMode } from "./capabilities";
import type { RenderClockMetrics } from "./render-clock";
import type { EditTransaction, EventTransaction } from "@dopejs/pingo-editing";
import type { MediaFramePath } from "./media";

export const WORKER_PROTOCOL_VERSION = 12 as const;

export interface WorkerPrepareMessage {
  readonly abiVersion: number;
  readonly kind: "pingo:prepare";
  readonly protocolVersion: number;
  readonly sessionId: number;
}

export interface WorkerActivateMessage {
  readonly canvas: OffscreenCanvas;
  /** Main-thread device pixel ratio; a worker cannot observe it itself. */
  readonly devicePixelRatio: number;
  readonly height: number;
  readonly incrementalPicturesEnabled: boolean;
  readonly kind: "pingo:activate";
  readonly mode: Exclude<HostTransportMode, "main-thread">;
  readonly rasterCache: boolean;
  readonly reducedMotion: boolean;
  readonly inputRingBuffer?: SharedArrayBuffer;
  readonly ringBuffer?: SharedArrayBuffer;
  readonly sessionId: number;
  readonly width: number;
}

export interface WorkerClockAnchorMessage {
  readonly kind: "pingo:clock-anchor";
  readonly sequence: number;
  readonly sessionId: number;
  readonly timestamp: number;
}

export interface WorkerShutdownMessage {
  readonly kind: "pingo:shutdown";
  readonly sessionId: number;
}

export interface WorkerInputMessage {
  readonly bytes: Uint8Array;
  readonly kind: "pingo:input";
  readonly sessionId: number;
}

/** New canvas size, in logical pixels and the ratio they are drawn at. */
export interface WorkerResizeMessage {
  readonly devicePixelRatio: number;
  readonly height: number;
  readonly kind: "pingo:resize";
  readonly sessionId: number;
  readonly width: number;
}

export interface WorkerInputWakeMessage {
  readonly kind: "pingo:input-wake";
  readonly sessionId: number;
}

export interface WorkerReducedMotionMessage {
  readonly kind: "pingo:reduced-motion";
  readonly reduced: boolean;
  readonly sessionId: number;
}

export interface WorkerMediaFrameMessage {
  readonly kind: "pingo:media-frame";
  readonly resourceId: number;
  readonly source: CanvasImageSource;
  readonly path: Exclude<MediaFramePath, "html-media">;
  readonly sessionId: number;
}

export type RenderWorkerInboundMessage =
  | WorkerActivateMessage
  | WorkerClockAnchorMessage
  | WorkerInputMessage
  | WorkerInputWakeMessage
  | WorkerMediaFrameMessage
  | WorkerPrepareMessage
  | WorkerReducedMotionMessage
  | WorkerResizeMessage
  | WorkerShutdownMessage;

export interface RenderWorkerCapabilities {
  readonly offscreenCanvas: boolean;
  readonly sharedArrayBuffer: boolean;
}

export interface WorkerPreparedMessage {
  readonly capabilities: RenderWorkerCapabilities;
  readonly kind: "pingo:prepared";
  readonly sessionId: number;
}

export interface WorkerReadyMessage {
  readonly kind: "pingo:ready";
  readonly mode: Exclude<HostTransportMode, "main-thread">;
  readonly sessionId: number;
}

export interface WorkerFrameMessage {
  readonly kind: "pingo:frame";
  readonly report: FrameReport;
  readonly sessionId: number;
}

export interface WorkerClockMetricsMessage {
  readonly kind: "pingo:clock-metrics";
  readonly metrics: RenderClockMetrics;
  readonly sessionId: number;
}

export interface WorkerVirtualRefillMessage {
  readonly kind: "pingo:virtual-refill";
  readonly requests: readonly VirtualRefillRange[];
  readonly sessionId: number;
}

export interface WorkerEditTransactionMessage {
  readonly kind: "pingo:edit-transaction";
  readonly sessionId: number;
  readonly transaction: EditTransaction;
}

export interface WorkerEventTransactionMessage {
  readonly kind: "pingo:event-transaction";
  readonly sessionId: number;
  readonly transaction: EventTransaction;
}

export interface WorkerNonPassiveRegionsMessage {
  readonly kind: "pingo:non-passive-regions";
  readonly regions: readonly NonPassiveRegion[];
  readonly sessionId: number;
}

export interface WorkerEditingGeometryMessage {
  readonly frame: EditingGeometryFrame;
  readonly kind: "pingo:editing-geometry";
  readonly sessionId: number;
}

export interface WorkerSemanticsMessage {
  readonly kind: "pingo:semantics";
  readonly nodes: readonly SemanticNode[];
  readonly sessionId: number;
}

export interface WorkerLayoutGeometryMessage {
  readonly frame: LayoutGeometryFrame;
  readonly kind: "pingo:layout-geometry";
  readonly sessionId: number;
}

export interface WorkerFatalMessage {
  readonly error: string;
  readonly kind: "pingo:fatal";
  readonly sessionId: number;
}

export interface WorkerShutdownCompleteMessage {
  readonly kind: "pingo:shutdown-complete";
  readonly sessionId: number;
}

export type RenderWorkerOutboundMessage =
  | WorkerClockMetricsMessage
  | WorkerEditTransactionMessage
  | WorkerEventTransactionMessage
  | WorkerNonPassiveRegionsMessage
  | WorkerEditingGeometryMessage
  | WorkerSemanticsMessage
  | WorkerLayoutGeometryMessage
  | WorkerFatalMessage
  | WorkerFrameMessage
  | WorkerPreparedMessage
  | WorkerReadyMessage
  | WorkerVirtualRefillMessage
  | WorkerShutdownCompleteMessage;

export function isRenderWorkerInboundMessage(value: unknown): value is RenderWorkerInboundMessage {
  if (!isRecord(value) || !isPositiveU32(value.sessionId)) return false;
  switch (value.kind) {
    case "pingo:prepare":
      return isPositiveU32(value.abiVersion) && isPositiveU32(value.protocolVersion);
    case "pingo:resize":
      return (
        isPositiveFinite(value.devicePixelRatio) &&
        isPositiveFinite(value.width) &&
        isPositiveFinite(value.height)
      );
    case "pingo:activate":
      return (
        isWorkerMode(value.mode) &&
        isPositiveFinite(value.devicePixelRatio) &&
        isPositiveFinite(value.width) &&
        isPositiveFinite(value.height) &&
        isRecord(value.canvas) &&
        typeof value.rasterCache === "boolean" &&
        typeof value.incrementalPicturesEnabled === "boolean" &&
        typeof value.reducedMotion === "boolean" &&
        (value.mode === "post-message" ||
          (isSharedArrayBuffer(value.ringBuffer) && isSharedArrayBuffer(value.inputRingBuffer)))
      );
    case "pingo:clock-anchor":
      return isPositiveU32(value.sequence) && isFiniteNumber(value.timestamp);
    case "pingo:input":
      return value.bytes instanceof Uint8Array;
    case "pingo:input-wake":
      return true;
    case "pingo:reduced-motion":
      return typeof value.reduced === "boolean";
    case "pingo:media-frame":
      return (
        isPositiveU32(value.resourceId) &&
        isRecord(value.source) &&
        (value.path === "image-bitmap" || value.path === "video-frame")
      );
    case "pingo:shutdown":
      return true;
    default:
      return false;
  }
}

export function isRenderWorkerInboundEnvelope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.kind === "pingo:prepare" ||
    value.kind === "pingo:resize" ||
    value.kind === "pingo:activate" ||
    value.kind === "pingo:clock-anchor" ||
    value.kind === "pingo:input" ||
    value.kind === "pingo:input-wake" ||
    value.kind === "pingo:media-frame" ||
    value.kind === "pingo:reduced-motion" ||
    value.kind === "pingo:shutdown"
  );
}

export function isRenderWorkerOutboundMessage(
  value: unknown,
): value is RenderWorkerOutboundMessage {
  if (!isRecord(value) || !isPositiveU32(value.sessionId)) return false;
  switch (value.kind) {
    case "pingo:prepared":
      return (
        isRecord(value.capabilities) &&
        typeof value.capabilities.offscreenCanvas === "boolean" &&
        typeof value.capabilities.sharedArrayBuffer === "boolean"
      );
    case "pingo:ready":
      return isWorkerMode(value.mode);
    case "pingo:frame":
      return isFrameReport(value.report);
    case "pingo:clock-metrics":
      return isClockMetrics(value.metrics);
    case "pingo:virtual-refill":
      return Array.isArray(value.requests) && value.requests.every(isVirtualRefillRange);
    case "pingo:edit-transaction":
      return isEditTransaction(value.transaction);
    case "pingo:event-transaction":
      return isEventTransaction(value.transaction);
    case "pingo:non-passive-regions":
      return Array.isArray(value.regions) && value.regions.every(isNonPassiveRegion);
    case "pingo:editing-geometry":
      return isEditingGeometryFrame(value.frame);
    case "pingo:semantics":
      return Array.isArray(value.nodes) && value.nodes.every(isSemanticNode);
    case "pingo:layout-geometry":
      return isLayoutGeometryFrame(value.frame);
    case "pingo:fatal":
      return typeof value.error === "string";
    case "pingo:shutdown-complete":
      return true;
    default:
      return false;
  }
}

export function isRenderWorkerOutboundEnvelope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.kind === "pingo:prepared" ||
    value.kind === "pingo:ready" ||
    value.kind === "pingo:frame" ||
    value.kind === "pingo:clock-metrics" ||
    value.kind === "pingo:virtual-refill" ||
    value.kind === "pingo:edit-transaction" ||
    value.kind === "pingo:event-transaction" ||
    value.kind === "pingo:non-passive-regions" ||
    value.kind === "pingo:editing-geometry" ||
    value.kind === "pingo:semantics" ||
    value.kind === "pingo:layout-geometry" ||
    value.kind === "pingo:fatal" ||
    value.kind === "pingo:shutdown-complete"
  );
}

function isSemanticNode(value: unknown): value is SemanticNode {
  return (
    isRecord(value) &&
    isU32(value.nodeId) &&
    typeof value.focusable === "boolean" &&
    typeof value.focused === "boolean" &&
    typeof value.password === "boolean" &&
    typeof value.role === "string" &&
    typeof value.label === "string" &&
    typeof value.value === "string" &&
    !(value.password && value.value !== "") &&
    isEditingGeometryRect(value.bounds)
  );
}

function isEditingGeometryRect(value: unknown): value is EditingGeometryRect {
  return (
    isRecord(value) &&
    isFiniteNumber(value.left) &&
    isFiniteNumber(value.top) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.width >= 0 &&
    value.height >= 0
  );
}

function isEditingCharacterBounds(value: unknown): value is EditingCharacterBounds {
  return (
    isRecord(value) &&
    isU32(value.start) &&
    isU32(value.end) &&
    value.start < value.end &&
    isEditingGeometryRect(value.rect)
  );
}

function isEditingGeometryFrame(value: unknown): value is EditingGeometryFrame {
  return (
    isRecord(value) &&
    isU32(value.nodeId) &&
    isU32(value.selectionStart) &&
    isU32(value.selectionEnd) &&
    value.selectionStart <= value.selectionEnd &&
    isEditingGeometryRect(value.controlBounds) &&
    isEditingGeometryRect(value.selectionBounds) &&
    Array.isArray(value.characterBounds) &&
    value.characterBounds.every(isEditingCharacterBounds)
  );
}

function isLayoutGeometryFrame(value: unknown): value is LayoutGeometryFrame {
  return (
    isRecord(value) &&
    isU32(value.frameSeq) &&
    Array.isArray(value.records) &&
    value.records.every(isLayoutGeometryRecord)
  );
}

function isLayoutGeometryRecord(value: unknown): value is LayoutGeometryRecord {
  return (
    isRecord(value) && isU32(value.nodeId) && isLayoutRect(value.bounds) && isLayoutRect(value.clip)
  );
}

/**
 * Like {@link isEditingGeometryRect} but tolerates infinities.
 *
 * An unclipped node reports an unbounded clip box, so requiring finiteness here
 * would reject the common case. NaN is still refused — it survives every
 * comparison a placement strategy would make.
 */
function isLayoutRect(value: unknown): value is EditingGeometryRect {
  return (
    isRecord(value) &&
    isNonNaNNumber(value.left) &&
    isNonNaNNumber(value.top) &&
    isNonNaNNumber(value.width) &&
    isNonNaNNumber(value.height) &&
    (value.width as number) >= 0 &&
    (value.height as number) >= 0
  );
}

function isNonNaNNumber(value: unknown): boolean {
  return typeof value === "number" && !Number.isNaN(value);
}

function isNonPassiveRegion(value: unknown): value is NonPassiveRegion {
  return (
    isRecord(value) &&
    isU32(value.flags) &&
    value.flags >= 1 &&
    value.flags <= 3 &&
    isFiniteNumber(value.left) &&
    isFiniteNumber(value.top) &&
    isFiniteNumber(value.right) &&
    isFiniteNumber(value.bottom) &&
    value.left < value.right &&
    value.top < value.bottom
  );
}

function isEventTransaction(value: unknown): value is EventTransaction {
  return (
    isRecord(value) &&
    isU32(value.eventId) &&
    isInputEventKind(value.kind) &&
    isU32(value.target) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.deltaX) &&
    isFiniteNumber(value.deltaY) &&
    isU32(value.buttons) &&
    value.buttons <= 0xffff &&
    isU32(value.modifiers) &&
    value.modifiers <= 0x0f &&
    isU32(value.pointerId) &&
    isU32(value.elapsedMicros) &&
    value.elapsedMicros >= 1 &&
    value.elapsedMicros <= 1_000_000 &&
    (value.relatedTarget === null || isU32(value.relatedTarget)) &&
    (value.pointerType === "none" ||
      value.pointerType === "mouse" ||
      value.pointerType === "pen" ||
      value.pointerType === "touch") &&
    typeof value.isPrimary === "boolean" &&
    isFiniteNumber(value.pressure) &&
    value.pressure >= 0 &&
    value.pressure <= 1 &&
    isFiniteNumber(value.tiltX) &&
    value.tiltX >= -90 &&
    value.tiltX <= 90 &&
    isFiniteNumber(value.tiltY) &&
    value.tiltY >= -90 &&
    value.tiltY <= 90 &&
    isFiniteNumber(value.width) &&
    value.width >= 0 &&
    isFiniteNumber(value.height) &&
    value.height >= 0 &&
    Array.isArray(value.path) &&
    value.path.length > 0 &&
    value.path.every(isU32) &&
    new Set(value.path).size === value.path.length &&
    value.path.at(-1) === value.target
  );
}

function isInputEventKind(value: unknown): boolean {
  return (
    value === "pointerdown" ||
    value === "pointerup" ||
    value === "pointermove" ||
    value === "pointercancel" ||
    value === "pointerover" ||
    value === "pointerout" ||
    value === "pointerenter" ||
    value === "pointerleave" ||
    value === "gotpointercapture" ||
    value === "lostpointercapture" ||
    value === "focus" ||
    value === "blur" ||
    value === "focusin" ||
    value === "focusout" ||
    value === "click" ||
    value === "wheel"
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
    value.cause !== "animation" &&
    value.cause !== "media"
  )
    return false;
  if (
    value.cause === "media"
      ? value.mediaPath !== "image-bitmap" && value.mediaPath !== "video-frame"
      : value.mediaPath !== undefined
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
