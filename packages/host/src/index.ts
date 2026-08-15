export {
  CanvasFrameSink,
  createCanvasRoot,
  type CanvasRootOptions,
  type CoreClient,
  type CoreFrameDiagnostics,
  type FrameReport,
} from "./main-thread";
export { createWasmCore, type WasmCoreInput } from "./wasm";
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
