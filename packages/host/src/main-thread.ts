import {
  Canvas2DReplayer,
  Canvas2DResourceRegistry,
  RasterTileCache,
  type Canvas2DContext,
  type RasterFrameResult,
  type RasterTileCacheMetrics,
  type ReplayStats,
} from "@dopejs/doper-backend-canvas2d";
import {
  createRoot,
  decodeMutationBatch,
  type DoperRoot,
  type MutationSink,
  type ResourceKind,
  type RootOptions,
} from "@dopejs/doper-reconciler";

import {
  FRAME_DIAGNOSTICS_DIRTY_HIT_NODES_INDEX,
  FRAME_DIAGNOSTICS_DIRTY_LAYOUT_NODES_INDEX,
  FRAME_DIAGNOSTICS_DIRTY_PAINT_NODES_INDEX,
  FRAME_DIAGNOSTICS_DIRTY_PAINT_SELF_NODES_INDEX,
  FRAME_DIAGNOSTICS_DIRTY_SEMANTICS_NODES_INDEX,
  FRAME_DIAGNOSTICS_DISPLAY_COMMANDS_INDEX,
  FRAME_DIAGNOSTICS_FRAME_SEQ_INDEX,
  FRAME_DIAGNOSTICS_LAYOUT_CHANGED_NODES_INDEX,
  FRAME_DIAGNOSTICS_LAYOUT_VISITED_NODES_INDEX,
  FRAME_DIAGNOSTICS_OVER_INVALIDATED_FRAMES_INDEX,
  FRAME_DIAGNOSTICS_PAINT_REBUILT_INDEX,
  FRAME_DIAGNOSTICS_PICTURE_BUILDS_INDEX,
  FRAME_DIAGNOSTICS_PICTURE_CACHE_HITS_INDEX,
  FRAME_DIAGNOSTICS_PICTURE_HASH_HIGH_INDEX,
  FRAME_DIAGNOSTICS_PICTURE_HASH_LOW_INDEX,
  FRAME_DIAGNOSTICS_PICTURE_SUBTREE_BUILDS_INDEX,
  FRAME_DIAGNOSTICS_PICTURE_SUBTREE_CACHE_HITS_INDEX,
  FRAME_DIAGNOSTICS_SCENE_NODES_INDEX,
  FRAME_DIAGNOSTICS_VERSION,
  FRAME_DIAGNOSTICS_VERSION_INDEX,
  FRAME_DIAGNOSTICS_WORDS,
} from "./generated";

/** Minimal binding implemented by the generated WASM Core wrapper. */
export interface CoreClient {
  commit(mutations: Uint8Array): Uint8Array;
  frame_diagnostics?(): Uint32Array;
  free?(): void;
  set_viewport?(width: number, height: number): void;
  is_poisoned?(): boolean;
}

/** Deterministic Core phase-work and invalidation diagnostics. */
export interface CoreFrameDiagnostics {
  readonly frameSeq: number;
  readonly sceneNodes: number;
  readonly dirtyLayoutNodes: number;
  readonly dirtyPaintNodes: number;
  readonly dirtyPaintSelfNodes: number;
  readonly dirtyHitNodes: number;
  readonly dirtySemanticsNodes: number;
  readonly layoutChangedNodes: number;
  readonly layoutVisitedNodes: number;
  readonly displayCommands: number;
  readonly paintRebuilt: boolean;
  readonly pictureBuilds: number;
  readonly pictureCacheHits: number;
  readonly pictureSubtreeBuilds: number;
  readonly pictureSubtreeCacheHits: number;
  readonly overInvalidatedFrames: number;
  readonly pictureHash: bigint;
}

/** Diagnostics emitted after one Core frame and Canvas replay both succeed. */
export interface FrameReport extends ReplayStats {
  readonly mutationBytes: number;
  readonly displayListBytes: number;
  readonly core?: CoreFrameDiagnostics;
  readonly rasterCache?: RasterTileCacheMetrics;
  readonly rasterFrame?: Pick<RasterFrameResult<ReplayStats>, "bypassed" | "hits" | "misses">;
}

/** Main-thread M1 root configuration and observability callbacks. */
export interface CanvasRootOptions extends RootOptions {
  readonly onFrame?: (report: FrameReport) => void;
}

type ResourceAction =
  | {
      readonly type: "define";
      readonly id: number;
      readonly kind: ResourceKind;
      readonly bytes: Uint8Array;
    }
  | { readonly type: "release"; readonly id: number; readonly kind: ResourceKind };

/** Transactional bridge from reconciler frames to Core resources and Canvas. */
export class CanvasFrameSink implements MutationSink {
  readonly #context: Canvas2DContext;
  readonly #core: CoreClient;
  readonly #resources: Canvas2DResourceRegistry;
  readonly #replayer: Canvas2DReplayer;
  readonly #resourceKinds = new Map<number, ResourceKind>();
  readonly #onFrame: ((report: FrameReport) => void) | undefined;
  readonly #rasterCache: RasterTileCache<ReplayStats> | undefined;
  #devicePixelRatio = 1;
  #lastDisplayList: Uint8Array | undefined;
  #lastPictureKey: string | undefined;
  #resourceRevision = 0;

  public constructor(
    context: Canvas2DContext,
    core: CoreClient,
    onFrame?: (report: FrameReport) => void,
    rasterCache?: RasterTileCache<ReplayStats>,
  ) {
    this.#context = context;
    this.#core = core;
    this.#onFrame = onFrame;
    this.#rasterCache = rasterCache;
    this.#resources = new Canvas2DResourceRegistry();
    this.#replayer = new Canvas2DReplayer();
  }

  /** Commits Core before mutating backend state or touching Canvas pixels. */
  public commit(bytes: Uint8Array): void {
    const { actions, frameSeq, nextKinds } = this.preflightResources(bytes);
    const displayList = this.#core.commit(bytes);
    if (!(displayList instanceof Uint8Array)) {
      throw new TypeError("Core commit must return Uint8Array DisplayList bytes");
    }
    const coreDiagnostics =
      (this.#onFrame === undefined && this.#rasterCache === undefined) ||
      this.#core.frame_diagnostics === undefined
        ? undefined
        : parseCoreFrameDiagnostics(this.#core.frame_diagnostics(), frameSeq);
    for (const action of actions) {
      if (action.type === "define") {
        this.#resources.defineEncodedResource(action.id, action.kind, action.bytes);
      } else {
        this.#resources.releaseEncodedResource(action.id, action.kind);
      }
    }
    this.#resourceKinds.clear();
    for (const [id, kind] of nextKinds) this.#resourceKinds.set(id, kind);
    if (actions.length > 0) {
      this.#resourceRevision = nextSequence(this.#resourceRevision);
      this.#rasterCache?.clear();
    }
    const pictureKey =
      coreDiagnostics === undefined
        ? undefined
        : `${coreDiagnostics.pictureHash.toString(16)}:${String(this.#resourceRevision)}`;
    const replay = this.replay(displayList, pictureKey);
    this.#lastDisplayList = displayList;
    this.#lastPictureKey = pictureKey;
    this.#onFrame?.({
      ...replay.value,
      mutationBytes: bytes.byteLength,
      displayListBytes: displayList.byteLength,
      ...(coreDiagnostics === undefined ? {} : { core: coreDiagnostics }),
      ...(this.#rasterCache === undefined ? {} : { rasterCache: this.#rasterCache.metrics() }),
      ...(replay.rasterFrame === undefined ? {} : { rasterFrame: replay.rasterFrame }),
    });
  }

  /** Replays the last fully accepted immutable frame for a Worker-owned render tick. */
  public replayLastFrame(): ReplayStats | null {
    const displayList = this.#lastDisplayList;
    return displayList === undefined ? null : this.replay(displayList, this.#lastPictureKey).value;
  }

  /** Returns a stable snapshot for diagnostics without exposing mutable cache state. */
  public rasterCacheMetrics(): RasterTileCacheMetrics | undefined {
    return this.#rasterCache?.metrics();
  }

  /** Invalidates DPR-sensitive raster entries without changing Core logical coordinates. */
  public setDevicePixelRatio(value: number): void {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError("devicePixelRatio must be positive");
    if (value === this.#devicePixelRatio) return;
    this.#devicePixelRatio = value;
    this.#rasterCache?.clear();
  }

  private replay(
    displayList: Uint8Array,
    pictureKey: string | undefined,
  ): {
    readonly rasterFrame?: Pick<RasterFrameResult<ReplayStats>, "bypassed" | "hits" | "misses">;
    readonly value: ReplayStats;
  } {
    const cache = this.#rasterCache;
    if (cache === undefined || pictureKey === undefined) {
      return { value: this.#replayer.replay(this.#context, displayList, this.#resources) };
    }
    const canvas = this.#context.canvas;
    const result = cache.render(
      this.#context,
      {
        devicePixelRatio: this.#devicePixelRatio,
        height: canvas.height,
        pictureKey,
        width: canvas.width,
      },
      (context) => this.#replayer.replay(context, displayList, this.#resources),
    );
    return {
      rasterFrame: { bypassed: result.bypassed, hits: result.hits, misses: result.misses },
      value: result.value,
    };
  }

  private preflightResources(bytes: Uint8Array): {
    readonly actions: ResourceAction[];
    readonly frameSeq: number;
    readonly nextKinds: Map<number, ResourceKind>;
  } {
    const batch = decodeMutationBatch(bytes);
    const nextKinds = new Map(this.#resourceKinds);
    const actions: ResourceAction[] = [];
    for (const mutation of batch.mutations) {
      if (mutation.type === "defineResource") {
        if (nextKinds.has(mutation.resourceId)) {
          throw new Error(`resource ${String(mutation.resourceId)} is already defined in host`);
        }
        nextKinds.set(mutation.resourceId, mutation.kind);
        actions.push({
          type: "define",
          id: mutation.resourceId,
          kind: mutation.kind,
          bytes: mutation.bytes,
        });
      } else if (mutation.type === "releaseResource") {
        const kind = nextKinds.get(mutation.resourceId);
        if (kind === undefined) {
          throw new Error(`resource ${String(mutation.resourceId)} is not defined in host`);
        }
        nextKinds.delete(mutation.resourceId);
        actions.push({ type: "release", id: mutation.resourceId, kind });
      }
    }
    return { actions, frameSeq: batch.frameSeq, nextKinds };
  }
}

/** Four-screen default budget; callers can replace it for device-specific policy. */
export function createDefaultRasterCache(
  context: Canvas2DContext,
  onError?: (error: Error) => void,
): RasterTileCache<ReplayStats> {
  const pixels = context.canvas.width * context.canvas.height;
  const budgetBytes = Math.min(1024 * 1024 * 1024, Math.max(4, pixels * 4 * 4));
  return new RasterTileCache<ReplayStats>({
    budgetBytes,
    ...(onError === undefined ? {} : { onError }),
  });
}

function nextSequence(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function parseCoreFrameDiagnostics(
  words: Uint32Array,
  expectedFrameSeq: number,
): CoreFrameDiagnostics {
  if (!(words instanceof Uint32Array) || words.length !== FRAME_DIAGNOSTICS_WORDS) {
    throw new TypeError("Core frame diagnostics must use the generated Uint32Array layout");
  }
  if (words[FRAME_DIAGNOSTICS_VERSION_INDEX] !== FRAME_DIAGNOSTICS_VERSION) {
    throw new Error("Core frame diagnostics version is incompatible with Host");
  }
  const frameSeq = requiredWord(words, FRAME_DIAGNOSTICS_FRAME_SEQ_INDEX);
  if (frameSeq !== expectedFrameSeq) throw new Error("Core diagnostics frame sequence mismatch");
  const rebuilt = requiredWord(words, FRAME_DIAGNOSTICS_PAINT_REBUILT_INDEX);
  if (rebuilt > 1) throw new Error("Core diagnostics paintRebuilt must be zero or one");
  const low = requiredWord(words, FRAME_DIAGNOSTICS_PICTURE_HASH_LOW_INDEX);
  const high = requiredWord(words, FRAME_DIAGNOSTICS_PICTURE_HASH_HIGH_INDEX);
  return {
    frameSeq,
    sceneNodes: requiredWord(words, FRAME_DIAGNOSTICS_SCENE_NODES_INDEX),
    dirtyLayoutNodes: requiredWord(words, FRAME_DIAGNOSTICS_DIRTY_LAYOUT_NODES_INDEX),
    dirtyPaintNodes: requiredWord(words, FRAME_DIAGNOSTICS_DIRTY_PAINT_NODES_INDEX),
    dirtyPaintSelfNodes: requiredWord(words, FRAME_DIAGNOSTICS_DIRTY_PAINT_SELF_NODES_INDEX),
    dirtyHitNodes: requiredWord(words, FRAME_DIAGNOSTICS_DIRTY_HIT_NODES_INDEX),
    dirtySemanticsNodes: requiredWord(words, FRAME_DIAGNOSTICS_DIRTY_SEMANTICS_NODES_INDEX),
    layoutChangedNodes: requiredWord(words, FRAME_DIAGNOSTICS_LAYOUT_CHANGED_NODES_INDEX),
    layoutVisitedNodes: requiredWord(words, FRAME_DIAGNOSTICS_LAYOUT_VISITED_NODES_INDEX),
    displayCommands: requiredWord(words, FRAME_DIAGNOSTICS_DISPLAY_COMMANDS_INDEX),
    paintRebuilt: rebuilt === 1,
    pictureBuilds: requiredWord(words, FRAME_DIAGNOSTICS_PICTURE_BUILDS_INDEX),
    pictureCacheHits: requiredWord(words, FRAME_DIAGNOSTICS_PICTURE_CACHE_HITS_INDEX),
    pictureSubtreeBuilds: requiredWord(words, FRAME_DIAGNOSTICS_PICTURE_SUBTREE_BUILDS_INDEX),
    pictureSubtreeCacheHits: requiredWord(
      words,
      FRAME_DIAGNOSTICS_PICTURE_SUBTREE_CACHE_HITS_INDEX,
    ),
    overInvalidatedFrames: requiredWord(words, FRAME_DIAGNOSTICS_OVER_INVALIDATED_FRAMES_INDEX),
    pictureHash: BigInt(low) | (BigInt(high) << 32n),
  };
}

function requiredWord(words: Uint32Array, index: number): number {
  const value = words[index];
  if (value === undefined) throw new TypeError("Core frame diagnostics are truncated");
  return value;
}

/** Creates the deterministic main-thread M1 fallback rendering root. */
export function createCanvasRoot(
  context: Canvas2DContext,
  core: CoreClient,
  options: CanvasRootOptions = {},
): DoperRoot {
  const sink = new CanvasFrameSink(context, core, options.onFrame);
  return createRoot(sink, options);
}
