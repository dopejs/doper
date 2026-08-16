export {
  ABI_VERSION,
  Invalidation,
  NodeKind,
  Prop,
  ResourceKind,
  PROP_METADATA,
} from "./generated";
export {
  MutationEncodingError,
  NULL_NODE_ID,
  decodeMutationBatch,
  encodeMutationBatch,
  type Mutation,
  type MutationBatch,
} from "./mutation-stream";
export { NodeIdAllocator, NodeIdError, decodeNodeId, type DecodedNodeId } from "./node-id";
export {
  createRoot,
  type CoreDrivenDoperRoot,
  type DoperRoot,
  type EditableStateSnapshot,
  type MutationSink,
  type RootOptions,
  type VirtualRangeRequest,
} from "./reconciler";
