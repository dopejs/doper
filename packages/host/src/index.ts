export {
  CanvasFrameSink,
  createCanvasRoot,
  createDefaultRasterCache,
  parseSemantics,
  type SemanticNode,
  type CanvasRootOptions,
  type CoreClient,
  type CoreFrameDiagnostics,
  type EditingCharacterBounds,
  type EditingGeometryFrame,
  type EditingGeometryRect,
  type FrameReport,
  type NonPassiveRegion,
  type VirtualRefillRange,
} from "./main-thread";
export { createWasmCore, type WasmCoreInput } from "./wasm";
export { ABI_VERSION } from "./generated";
export {
  verifyWasmIntegrity,
  WasmIntegrityError,
  type WasmIntegrityManifest,
} from "./integrity";
export {
  detectHostCapabilities,
  selectHostTransport,
  type CapabilityEnvironment,
  type HostCapabilities,
  type HostTransportDecision,
  type HostTransportMode,
  type HostTransportPolicy,
  type HostTransportPreference,
  type TransferableCanvasCandidate,
} from "./capabilities";
export {
  PostMessageMutationReceiver,
  PostMessageMutationTransport,
  type PostMessageMutationReceiverOptions,
  type PostMessageTransportMetrics,
  type PostMessageTransportOptions,
} from "./post-message";
export {
  HybridRenderClock,
  nextAlignedFrame,
  type HybridRenderClockOptions,
  type RenderClockFrame,
  type RenderClockMetrics,
  type RenderClockScheduler,
} from "./render-clock";
export {
  createHostedCanvasRoot,
  type ClockAnchorDriver,
  type HostInputTransportMetrics,
  type HostMutationTransportMetrics,
  type HostedCanvasRoot,
  type HostedCanvasRootOptions,
  type ScrollTarget,
} from "./hosted-root";
export {
  SabMutationReceiver,
  SabMutationTransport,
  type SabMutationReceiverOptions,
  type SabMutationTransportMetrics,
  type SabMutationTransportOptions,
} from "./sab-transport";
export {
  BinaryReplayRecorder,
  ReplayRecordingError,
  decodeReplayRecording,
  encodeReplayRecording,
  replayRecording,
  type ReplayDataClassification,
  type ReplayHandlers,
  type ReplayRecord,
  type ReplayRecording,
} from "./recording";
export { SabMutationRing, type SabMutationFrame, type SabMutationRingMetrics } from "./sab-ring";
export {
  SystemTextMetricError,
  decodeSystemTextMetricBatch,
  encodeSystemTextMetricBatch,
  type SystemTextMetric,
  type SystemTextMetricDelta,
} from "./system-text-metrics";
