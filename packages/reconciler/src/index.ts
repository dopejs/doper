export {
  ABI_VERSION,
  Invalidation,
  NodeKind,
  Prop,
  ResourceKind,
  PROP_METADATA,
} from "./generated.js";
export {
  MutationEncodingError,
  NULL_NODE_ID,
  decodeMutationBatch,
  encodeMutationBatch,
  type Mutation,
  type MutationBatch,
} from "./mutation-stream.js";
export { NodeIdAllocator, NodeIdError, decodeNodeId, type DecodedNodeId } from "./node-id.js";
export { createRoot, type DoperRoot, type MutationSink, type RootOptions } from "./reconciler.js";
