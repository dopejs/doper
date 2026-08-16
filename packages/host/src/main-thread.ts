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
  VIRTUAL_REFILL_HEADER_REQUEST_COUNT_INDEX,
  VIRTUAL_REFILL_HEADER_VERSION_INDEX,
  VIRTUAL_REFILL_HEADER_WORDS,
  VIRTUAL_REFILL_RECORD_END_INDEX,
  VIRTUAL_REFILL_RECORD_NODE_ID_INDEX,
  VIRTUAL_REFILL_RECORD_START_INDEX,
  VIRTUAL_REFILL_RECORD_WORDS,
  VIRTUAL_REFILL_VERSION,
} from "./generated";

/** Minimal binding implemented by the generated WASM Core wrapper. */
export interface CoreClient {
  commit(mutations: Uint8Array): Uint8Array;
  input?(input: Uint8Array): Uint8Array | undefined;
  advance?(elapsedSeconds: number): Uint8Array | undefined;
  frame_diagnostics?(): Uint32Array;
  free?(): void;
  set_viewport?(width: number, height: number): void;
  set_device_pixel_ratio?(value: number): Uint8Array | undefined;
  is_poisoned?(): boolean;
  take_glyph_resources?(): Uint8Array;
  take_virtual_refills?(): Uint32Array;
}

/** One Core-planned logical range that Shell should materialize asynchronously. */
export interface VirtualRefillRange {
  readonly end: number;
  readonly nodeId: number;
  readonly start: number;
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
  readonly cause?: "animation" | "input" | "mutation";
  readonly inputBytes?: number;
  readonly animationDeltaMs?: number;
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
  readonly #onVirtualRefills: ((requests: readonly VirtualRefillRange[]) => void) | undefined;
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
    onVirtualRefills?: (requests: readonly VirtualRefillRange[]) => void,
  ) {
    this.#context = context;
    this.#core = core;
    this.#onFrame = onFrame;
    this.#rasterCache = rasterCache;
    this.#onVirtualRefills = onVirtualRefills;
    this.#resources = new Canvas2DResourceRegistry();
    this.#replayer = new Canvas2DReplayer();
    this.setDevicePixelRatio(runtimeDevicePixelRatio());
  }

  /** Commits Core before mutating backend state or touching Canvas pixels. */
  public commit(bytes: Uint8Array): void {
    const { actions, frameSeq, nextKinds } = this.preflightResources(bytes);
    const displayList = this.#core.commit(bytes);
    this.emitVirtualRefills();
    if (!(displayList instanceof Uint8Array)) {
      throw new TypeError("Core commit must return Uint8Array DisplayList bytes");
    }
    const coreDiagnostics =
      (this.#onFrame === undefined && this.#rasterCache === undefined) ||
      this.#core.frame_diagnostics === undefined
        ? undefined
        : parseCoreFrameDiagnostics(this.#core.frame_diagnostics(), frameSeq);
    const glyphResources = this.takeGlyphResources();
    if (actions.length > 0 || glyphResources !== undefined) {
      this.#resources.applyResourceTransaction(actions, glyphResources);
    }
    this.#resourceKinds.clear();
    for (const [id, kind] of nextKinds) this.#resourceKinds.set(id, kind);
    if (actions.length > 0 || glyphResources !== undefined) {
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
      cause: "mutation",
      inputBytes: 0,
      mutationBytes: bytes.byteLength,
      displayListBytes: displayList.byteLength,
      ...(coreDiagnostics === undefined ? {} : { core: coreDiagnostics }),
      ...(this.#rasterCache === undefined ? {} : { rasterCache: this.#rasterCache.metrics() }),
      ...(replay.rasterFrame === undefined ? {} : { rasterFrame: replay.rasterFrame }),
    });
  }

  /** Applies one Core Input Stream transaction and replays only changed pixels. */
  public input(bytes: Uint8Array): ReplayStats | null {
    const core = this.#core;
    if (core.input === undefined) throw new Error("Core does not implement Input Stream dispatch");
    const displayList = core.input(bytes);
    this.emitVirtualRefills();
    if (displayList === undefined) return null;
    this.applyDynamicGlyphResources();
    return this.acceptDynamicFrame(displayList, {
      cause: "input",
      inputBytes: bytes.byteLength,
      mutationBytes: 0,
    });
  }

  /** Advances Core-owned animation and replays only when the Picture changes. */
  public advance(elapsedSeconds: number): ReplayStats | null {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      throw new RangeError("elapsedSeconds must be finite and non-negative");
    }
    const core = this.#core;
    if (core.advance === undefined) return this.replayLastFrame();
    const displayList = core.advance(elapsedSeconds);
    this.emitVirtualRefills();
    if (displayList === undefined) return this.replayLastFrame();
    this.applyDynamicGlyphResources();
    return this.acceptDynamicFrame(displayList, {
      animationDeltaMs: elapsedSeconds * 1000,
      cause: "animation",
      inputBytes: 0,
      mutationBytes: 0,
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
    const displayList = this.#core.set_device_pixel_ratio?.(value);
    if (displayList === undefined) return;
    this.applyDynamicGlyphResources();
    this.acceptDynamicFrame(displayList, {
      animationDeltaMs: 0,
      cause: "animation",
      inputBytes: 0,
      mutationBytes: 0,
    });
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

  private acceptDynamicFrame(
    displayList: Uint8Array,
    source: Pick<FrameReport, "animationDeltaMs" | "cause" | "inputBytes" | "mutationBytes">,
  ): ReplayStats {
    if (!(displayList instanceof Uint8Array)) {
      throw new TypeError("Core dynamic frame must return Uint8Array DisplayList bytes");
    }
    const coreDiagnostics =
      (this.#onFrame === undefined && this.#rasterCache === undefined) ||
      this.#core.frame_diagnostics === undefined
        ? undefined
        : parseCoreFrameDiagnostics(this.#core.frame_diagnostics());
    const pictureKey =
      coreDiagnostics === undefined
        ? undefined
        : `${coreDiagnostics.pictureHash.toString(16)}:${String(this.#resourceRevision)}`;
    const replay = this.replay(displayList, pictureKey);
    this.#lastDisplayList = displayList;
    this.#lastPictureKey = pictureKey;
    this.#onFrame?.({
      ...replay.value,
      ...source,
      displayListBytes: displayList.byteLength,
      ...(coreDiagnostics === undefined ? {} : { core: coreDiagnostics }),
      ...(this.#rasterCache === undefined ? {} : { rasterCache: this.#rasterCache.metrics() }),
      ...(replay.rasterFrame === undefined ? {} : { rasterFrame: replay.rasterFrame }),
    });
    return replay.value;
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

  private emitVirtualRefills(): void {
    const core = this.#core;
    if (core.take_virtual_refills === undefined) return;
    const requests = parseVirtualRefills(core.take_virtual_refills());
    if (requests.length > 0) this.#onVirtualRefills?.(requests);
  }

  private takeGlyphResources(): Uint8Array | undefined {
    if (this.#core.take_glyph_resources === undefined) return undefined;
    const bytes = this.#core.take_glyph_resources();
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Core glyph resources must be Uint8Array bytes");
    }
    return bytes.byteLength === 0 ? undefined : bytes;
  }

  private applyDynamicGlyphResources(): void {
    const bytes = this.takeGlyphResources();
    if (bytes === undefined) return;
    this.#resources.applyResourceTransaction([], bytes);
    this.#resourceRevision = nextSequence(this.#resourceRevision);
    this.#rasterCache?.clear();
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

function runtimeDevicePixelRatio(): number {
  const value = (globalThis as { readonly devicePixelRatio?: unknown }).devicePixelRatio;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

function parseCoreFrameDiagnostics(
  words: Uint32Array,
  expectedFrameSeq?: number,
): CoreFrameDiagnostics {
  if (!(words instanceof Uint32Array) || words.length !== FRAME_DIAGNOSTICS_WORDS) {
    throw new TypeError("Core frame diagnostics must use the generated Uint32Array layout");
  }
  if (words[FRAME_DIAGNOSTICS_VERSION_INDEX] !== FRAME_DIAGNOSTICS_VERSION) {
    throw new Error("Core frame diagnostics version is incompatible with Host");
  }
  const frameSeq = requiredWord(words, FRAME_DIAGNOSTICS_FRAME_SEQ_INDEX);
  if (expectedFrameSeq !== undefined && frameSeq !== expectedFrameSeq) {
    throw new Error("Core diagnostics frame sequence mismatch");
  }
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

function parseVirtualRefills(words: Uint32Array): VirtualRefillRange[] {
  if (!(words instanceof Uint32Array) || words.length < VIRTUAL_REFILL_HEADER_WORDS) {
    throw new TypeError("Core virtual refills must use the generated Uint32Array layout");
  }
  if (words[VIRTUAL_REFILL_HEADER_VERSION_INDEX] !== VIRTUAL_REFILL_VERSION) {
    throw new Error("Core virtual refill version is incompatible with Host");
  }
  const count = requiredWord(words, VIRTUAL_REFILL_HEADER_REQUEST_COUNT_INDEX);
  const expected = VIRTUAL_REFILL_HEADER_WORDS + count * VIRTUAL_REFILL_RECORD_WORDS;
  if (!Number.isSafeInteger(expected) || words.length !== expected) {
    throw new TypeError("Core virtual refill request count does not match its payload");
  }
  const requests: VirtualRefillRange[] = [];
  for (let record = 0; record < count; record += 1) {
    const offset = VIRTUAL_REFILL_HEADER_WORDS + record * VIRTUAL_REFILL_RECORD_WORDS;
    const nodeId = requiredWord(words, offset + VIRTUAL_REFILL_RECORD_NODE_ID_INDEX);
    const start = requiredWord(words, offset + VIRTUAL_REFILL_RECORD_START_INDEX);
    const end = requiredWord(words, offset + VIRTUAL_REFILL_RECORD_END_INDEX);
    if (start >= end) throw new RangeError("Core virtual refill range must be non-empty");
    requests.push({ end, nodeId, start });
  }
  return requests;
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
