export {
  CanvasFrameSink,
  createCanvasRoot,
  type CanvasRootOptions,
  type CoreClient,
  type CoreFrameDiagnostics,
  type FrameReport,
} from "./main-thread.js";
export { createWasmCore, type WasmCoreInput } from "./wasm.js";
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
} from "./recording.js";
export { SabMutationRing, type SabMutationFrame, type SabMutationRingMetrics } from "./sab-ring.js";
