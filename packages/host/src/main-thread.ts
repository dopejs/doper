import {
  Canvas2DReplayer,
  Canvas2DResourceRegistry,
  RasterTileCache,
  type CanvasSystemTextPair,
  type Canvas2DContext,
  type RasterFrameResult,
  type RasterTileCacheMetrics,
  type ReplayStats,
} from "@dopejs/doper-backend-canvas2d";
import {
  createRoot,
  decodeMutationBatch,
  type DoperRoot,
  type CoreDrivenDoperRoot,
  type MutationSink,
  type ResourceKind,
  type RootOptions,
} from "@dopejs/doper-reconciler";
import {
  decodeEditTransactionBatch,
  decodeEventTransactionBatch,
  type EditTransaction,
  type EventTransaction,
} from "@dopejs/doper-editing";

import { encodeSystemTextMetricBatch } from "./system-text-metrics";

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
  FRAME_DIAGNOSTICS_VIRTUAL_MATERIALIZED_END_INDEX,
  FRAME_DIAGNOSTICS_VIRTUAL_MATERIALIZED_START_INDEX,
  FRAME_DIAGNOSTICS_VIRTUAL_VISIBLE_END_INDEX,
  FRAME_DIAGNOSTICS_VIRTUAL_VISIBLE_START_INDEX,
  FRAME_DIAGNOSTICS_VISIBLE_PLACEHOLDERS_INDEX,
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
  EDITING_GEOMETRY_CHARACTER_END_INDEX,
  EDITING_GEOMETRY_CHARACTER_LEFT_BITS_INDEX,
  EDITING_GEOMETRY_CHARACTER_START_INDEX,
  EDITING_GEOMETRY_CHARACTER_WORDS,
  EDITING_GEOMETRY_HEADER_CHARACTER_COUNT_INDEX,
  EDITING_GEOMETRY_HEADER_NODE_ID_INDEX,
  EDITING_GEOMETRY_HEADER_SELECTION_END_INDEX,
  EDITING_GEOMETRY_HEADER_SELECTION_START_INDEX,
  EDITING_GEOMETRY_HEADER_VERSION_INDEX,
  EDITING_GEOMETRY_HEADER_WORDS,
  EDITING_GEOMETRY_RECT_HEIGHT_BITS_INDEX,
  EDITING_GEOMETRY_RECT_LEFT_BITS_INDEX,
  EDITING_GEOMETRY_RECT_TOP_BITS_INDEX,
  EDITING_GEOMETRY_RECT_WIDTH_BITS_INDEX,
  EDITING_GEOMETRY_RECT_WORDS,
  EDITING_GEOMETRY_VERSION,
  NULL_NODE_ID,
  SEMANTICS_HEADER_NODE_COUNT_INDEX,
  SEMANTICS_HEADER_VERSION_INDEX,
  SEMANTICS_HEADER_WORDS,
  SEMANTICS_RECORD_FLAGS_INDEX,
  SEMANTICS_RECORD_HEIGHT_BITS_INDEX,
  SEMANTICS_RECORD_LABEL_BYTES_INDEX,
  SEMANTICS_RECORD_LEFT_BITS_INDEX,
  SEMANTICS_RECORD_NODE_ID_INDEX,
  SEMANTICS_RECORD_ROLE_BYTES_INDEX,
  SEMANTICS_RECORD_TOP_BITS_INDEX,
  SEMANTICS_RECORD_VALUE_BYTES_INDEX,
  SEMANTICS_RECORD_WIDTH_BITS_INDEX,
  SEMANTICS_RECORD_WORDS,
  SEMANTICS_VERSION,
  NON_PASSIVE_REGION_HEADER_REGION_COUNT_INDEX,
  NON_PASSIVE_REGION_HEADER_VERSION_INDEX,
  NON_PASSIVE_REGION_HEADER_WORDS,
  NON_PASSIVE_REGION_RECORD_BOTTOM_BITS_INDEX,
  NON_PASSIVE_REGION_RECORD_FLAGS_INDEX,
  NON_PASSIVE_REGION_RECORD_LEFT_BITS_INDEX,
  NON_PASSIVE_REGION_RECORD_RIGHT_BITS_INDEX,
  NON_PASSIVE_REGION_RECORD_TOP_BITS_INDEX,
  NON_PASSIVE_REGION_RECORD_WORDS,
  NON_PASSIVE_REGION_VERSION,
} from "./generated";

/** Minimal binding implemented by the generated WASM Core wrapper. */
export interface CoreClient {
  commit(mutations: Uint8Array, systemTextMetrics?: Uint8Array): Uint8Array;
  input?(input: Uint8Array): Uint8Array | undefined;
  advance?(elapsedSeconds: number): Uint8Array | undefined;
  frame_diagnostics?(): Uint32Array;
  free?(): void;
  set_viewport?(width: number, height: number): void;
  set_device_pixel_ratio?(value: number): Uint8Array | undefined;
  set_system_text_metrics?(metrics: Uint8Array): Uint8Array | undefined;
  is_poisoned?(): boolean;
  take_glyph_resources?(): Uint8Array;
  take_edit_transactions?(): Uint8Array;
  take_event_transactions?(): Uint8Array;
  non_passive_regions?(): Uint32Array;
  editing_geometry?(): Uint32Array;
  semantics?(): Uint8Array;
  take_virtual_refills?(): Uint32Array;
}

/** One Core-planned logical range that Shell should materialize asynchronously. */
export interface VirtualRefillRange {
  readonly end: number;
  readonly nodeId: number;
  readonly start: number;
}

/** World-space region whose browser default must be decided synchronously. */
export interface NonPassiveRegion {
  readonly bottom: number;
  readonly flags: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

/** Canvas-local logical-pixel rectangle decoded from the editing geometry snapshot. */
export interface EditingGeometryRect {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/** One UTF-16 character range with its world-space rectangle for IME queries. */
export interface EditingCharacterBounds {
  readonly end: number;
  readonly rect: EditingGeometryRect;
  readonly start: number;
}

/** Active-editor geometry snapshot for candidate-window and caret placement. */
export interface EditingGeometryFrame {
  readonly characterBounds: readonly EditingCharacterBounds[];
  readonly controlBounds: EditingGeometryRect;
  readonly nodeId: number;
  readonly selectionBounds: EditingGeometryRect;
  readonly selectionEnd: number;
  readonly selectionStart: number;
}

/** One committed semantic-tree node mirrored into the accessibility DOM. */
export interface SemanticNode {
  readonly bounds: EditingGeometryRect;
  /** True when the node accepts engine focus (editable primitives today). */
  readonly focusable: boolean;
  readonly focused: boolean;
  readonly label: string;
  readonly nodeId: number;
  readonly password: boolean;
  readonly role: string;
  readonly value: string;
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
  /**
   * Visible virtual items still drawn as skeletons this frame.
   *
   * A steady non-zero value means the Shell never caught up and the viewport is
   * showing placeholders rather than content.
   */
  readonly visiblePlaceholders: number;
  /**
   * First and last-plus-one virtual item the viewport intersects.
   *
   * Compare against the windows reported by `onVirtualRefills`: a viewport
   * outside every window Core asked for means the request and the answer have
   * diverged, which a placeholder count alone cannot distinguish from a Shell
   * that is merely slow.
   */
  readonly virtualVisibleStart: number;
  readonly virtualVisibleEnd: number;
  /** Item range the Shell has materialized, as Core sees it. */
  readonly virtualMaterializedStart: number;
  readonly virtualMaterializedEnd: number;
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
  readonly onEditTransaction?: (transaction: EditTransaction) => void;
  readonly onEventTransaction?: (transaction: EventTransaction) => void;
  readonly onNonPassiveRegions?: (regions: readonly NonPassiveRegion[]) => void;
  readonly onEditingGeometry?: (frame: EditingGeometryFrame) => void;
  readonly onSemantics?: (nodes: readonly SemanticNode[]) => void;
}

type ResourceAction =
  | {
      readonly type: "define";
      readonly id: number;
      readonly kind: ResourceKind;
      readonly bytes: Uint8Array;
    }
  | { readonly type: "release"; readonly id: number; readonly kind: ResourceKind };

interface TextPairState extends CanvasSystemTextPair {
  readonly references: number;
}

/** Transactional bridge from reconciler frames to Core resources and Canvas. */
export class CanvasFrameSink implements MutationSink {
  readonly #context: Canvas2DContext;
  readonly #core: CoreClient;
  readonly #resources: Canvas2DResourceRegistry;
  readonly #replayer: Canvas2DReplayer;
  readonly #resourceKinds = new Map<number, ResourceKind>();
  readonly #nodeParents = new Map<number, number>();
  readonly #nodeTextPairs = new Map<number, CanvasSystemTextPair>();
  readonly #textPairState = new Map<string, TextPairState>();
  readonly #onFrame: ((report: FrameReport) => void) | undefined;
  readonly #onVirtualRefills: ((requests: readonly VirtualRefillRange[]) => void) | undefined;
  readonly #rasterCache: RasterTileCache<ReplayStats> | undefined;
  readonly #onAsyncError: ((error: Error) => void) | undefined;
  readonly #onEditTransaction: ((transaction: EditTransaction) => void) | undefined;
  readonly #onEventTransaction: ((transaction: EventTransaction) => void) | undefined;
  readonly #onNonPassiveRegions: ((regions: readonly NonPassiveRegion[]) => void) | undefined;
  readonly #onEditingGeometry: ((frame: EditingGeometryFrame) => void) | undefined;
  readonly #onSemantics: ((nodes: readonly SemanticNode[]) => void) | undefined;
  readonly #fontSet: FontFaceSet | undefined;
  readonly #fontLoadingDone: (() => void) | undefined;
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
    onAsyncError?: (error: Error) => void,
    onEditTransaction?: (transaction: EditTransaction) => void,
    onEventTransaction?: (transaction: EventTransaction) => void,
    onNonPassiveRegions?: (regions: readonly NonPassiveRegion[]) => void,
    onEditingGeometry?: (frame: EditingGeometryFrame) => void,
    onSemantics?: (nodes: readonly SemanticNode[]) => void,
  ) {
    this.#context = context;
    this.#core = core;
    this.#onFrame = onFrame;
    this.#rasterCache = rasterCache;
    this.#onVirtualRefills = onVirtualRefills;
    this.#onAsyncError = onAsyncError;
    this.#onEditTransaction = onEditTransaction;
    this.#onEventTransaction = onEventTransaction;
    this.#onNonPassiveRegions = onNonPassiveRegions;
    this.#onEditingGeometry = onEditingGeometry;
    this.#onSemantics = onSemantics;
    this.#resources = new Canvas2DResourceRegistry();
    this.#replayer = new Canvas2DReplayer();
    this.#fontSet = runtimeFontSet();
    this.#fontLoadingDone =
      this.#fontSet === undefined || this.#core.set_system_text_metrics === undefined
        ? undefined
        : () => {
            try {
              this.refreshSystemTextMetrics();
            } catch (cause) {
              reportAsyncError(
                toError(cause, "system font metric refresh failed"),
                this.#onAsyncError,
              );
            }
          };
    this.setDevicePixelRatio(runtimeDevicePixelRatio());
    if (this.#fontLoadingDone !== undefined) {
      this.#fontSet?.addEventListener("loadingdone", this.#fontLoadingDone);
    }
  }

  /** Commits Core before mutating backend state or touching Canvas pixels. */
  public commit(bytes: Uint8Array): void {
    const { actions, frameSeq, metricDeltas, nextKinds, nextParents, nextTextPairs } =
      this.preflightResources(bytes);
    const metrics = metricDeltas.upserts.length
      ? this.#resources.measureSystemTextPairs(this.#context, actions, metricDeltas.upserts)
      : [];
    const metricBytes =
      metrics.length === 0 && metricDeltas.releases.length === 0
        ? undefined
        : encodeSystemTextMetricBatch([
            ...metrics.map((metric) => ({ type: "upsert" as const, metric })),
            ...metricDeltas.releases.map((pair) => ({ type: "release" as const, ...pair })),
          ]);
    const displayList = this.#core.commit(bytes, metricBytes);
    this.emitVirtualRefills();
    this.emitNonPassiveRegions();
    this.emitEditingGeometry();
    this.emitSemantics();
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
    replaceMap(this.#nodeParents, nextParents);
    replaceMap(this.#nodeTextPairs, nextTextPairs);
    replaceMap(this.#textPairState, countTextPairs(nextTextPairs));
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
    this.emitEditTransactions(this.takeEditTransactions());
  }

  /**
   * Applies several Input Stream transactions and replays the canvas once.
   *
   * A pointing device emits one event per display refresh, and applying each
   * one separately replays the whole canvas for a picture the next event
   * supersedes before it can be seen. When a replay costs more than a frame,
   * that backlog grows for as long as the gesture lasts and the offset keeps
   * catching up long after the fingers stop. Core state still advances for
   * every transaction and the reverse streams still drain; only the
   * intermediate pictures are skipped.
   */
  public inputBatch(batches: readonly Uint8Array[]): ReplayStats | null {
    if (batches.length === 0) return null;
    const core = this.#core;
    if (core.input === undefined) throw new Error("Core does not implement Input Stream dispatch");
    let latest: Uint8Array | undefined;
    let inputBytes = 0;
    for (const bytes of batches) {
      const displayList = core.input(bytes);
      inputBytes += bytes.byteLength;
      this.emitVirtualRefills();
      this.emitNonPassiveRegions();
      this.emitEditingGeometry();
      this.emitSemantics();
      this.emitEventTransactions(this.takeEventTransactions());
      // The final transaction of a burst can be one that draws nothing, such as
      // the end of a drag, so keep the newest picture rather than the newest
      // transaction.
      if (displayList !== undefined) latest = displayList;
    }
    if (latest === undefined) {
      this.emitEditTransactions(this.takeEditTransactions());
      return null;
    }
    this.applyDynamicGlyphResources();
    const result = this.acceptDynamicFrame(latest, {
      cause: "input",
      inputBytes,
      mutationBytes: 0,
    });
    this.emitEditTransactions(this.takeEditTransactions());
    return result;
  }

  /** Applies one Core Input Stream transaction and replays only changed pixels. */
  public input(bytes: Uint8Array): ReplayStats | null {
    const core = this.#core;
    if (core.input === undefined) throw new Error("Core does not implement Input Stream dispatch");
    const displayList = core.input(bytes);
    this.emitVirtualRefills();
    this.emitNonPassiveRegions();
    this.emitEditingGeometry();
    this.emitSemantics();
    this.emitEventTransactions(this.takeEventTransactions());
    if (displayList === undefined) {
      this.emitEditTransactions(this.takeEditTransactions());
      return null;
    }
    this.applyDynamicGlyphResources();
    const result = this.acceptDynamicFrame(displayList, {
      cause: "input",
      inputBytes: bytes.byteLength,
      mutationBytes: 0,
    });
    this.emitEditTransactions(this.takeEditTransactions());
    return result;
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
    this.emitNonPassiveRegions();
    this.emitEditingGeometry();
    this.emitSemantics();
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

  /** Releases browser capability listeners owned by this rendering sink. */
  public dispose(): void {
    if (this.#fontLoadingDone !== undefined) {
      this.#fontSet?.removeEventListener("loadingdone", this.#fontLoadingDone);
    }
  }

  /** Remeasures every active fallback pair after browser font availability changes. */
  public refreshSystemTextMetrics(): ReplayStats | null {
    const update = this.#core.set_system_text_metrics?.bind(this.#core);
    if (update === undefined || this.#textPairState.size === 0) return null;
    const pairs = [...this.#textPairState.values()].map(({ stringId, styleId }) => ({
      stringId,
      styleId,
    }));
    const metrics = this.#resources.measureSystemTextPairs(this.#context, [], pairs);
    const displayList = update(
      encodeSystemTextMetricBatch(metrics.map((metric) => ({ type: "upsert" as const, metric }))),
    );
    if (displayList === undefined) return null;
    this.applyDynamicGlyphResources();
    return this.acceptDynamicFrame(displayList, {
      animationDeltaMs: 0,
      cause: "animation",
      inputBytes: 0,
      mutationBytes: 0,
    });
  }

  /** Invalidates DPR-sensitive raster entries without changing Core logical coordinates. */
  public setDevicePixelRatio(value: number): void {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError("devicePixelRatio must be positive");
    if (value === this.#devicePixelRatio) return;
    this.#devicePixelRatio = value;
    this.#rasterCache?.clear();
    this.refreshSystemTextMetrics();
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
      return { value: this.replayScaled(this.#context, displayList) };
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
      (context) => this.replayScaled(context, displayList),
    );
    return {
      rasterFrame: { bypassed: result.bypassed, hits: result.hits, misses: result.misses },
      value: result.value,
    };
  }

  /**
   * Replays one DisplayList in logical pixels.
   *
   * DisplayList coordinates are logical (CSS) pixels and glyph masks are
   * rasterized at the device pixel ratio, so the backing store scale belongs
   * here: without it logical units land one-to-one on device pixels and the
   * whole scene renders at 1/ratio of its intended size on HiDPI displays.
   */
  private replayScaled(context: Canvas2DContext, displayList: Uint8Array): ReplayStats {
    const ratio = this.#devicePixelRatio;
    if (ratio === 1) return this.#replayer.replay(context, displayList, this.#resources);
    context.save();
    context.scale(ratio, ratio);
    try {
      return this.#replayer.replay(context, displayList, this.#resources);
    } finally {
      context.restore();
    }
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
    readonly metricDeltas: {
      readonly releases: CanvasSystemTextPair[];
      readonly upserts: CanvasSystemTextPair[];
    };
    readonly nextKinds: Map<number, ResourceKind>;
    readonly nextParents: Map<number, number>;
    readonly nextTextPairs: Map<number, CanvasSystemTextPair>;
  } {
    const batch = decodeMutationBatch(bytes);
    const nextKinds = new Map(this.#resourceKinds);
    const nextParents = new Map(this.#nodeParents);
    const nextTextPairs = new Map(this.#nodeTextPairs);
    const children = indexChildren(nextParents);
    const actions: ResourceAction[] = [];
    for (const mutation of batch.mutations) {
      if (mutation.type === "createNode") {
        nextParents.set(mutation.nodeId, mutation.parent);
        addChild(children, mutation.parent, mutation.nodeId);
      } else if (mutation.type === "removeNode") {
        removeHostSubtree(mutation.nodeId, nextParents, nextTextPairs, children);
      } else if (mutation.type === "reparent") {
        const previousParent = nextParents.get(mutation.nodeId);
        if (previousParent !== undefined) removeChild(children, previousParent, mutation.nodeId);
        nextParents.set(mutation.nodeId, mutation.newParent);
        addChild(children, mutation.newParent, mutation.nodeId);
      } else if (mutation.type === "setTextRun") {
        nextTextPairs.set(
          mutation.nodeId,
          Object.freeze({ stringId: mutation.stringId, styleId: mutation.styleId }),
        );
      } else if (mutation.type === "defineResource") {
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
    const nextPairState = countTextPairs(nextTextPairs);
    const upserts = [...nextPairState.entries()]
      .filter(([key]) => !this.#textPairState.has(key))
      .map(([, { stringId, styleId }]) => ({ stringId, styleId }));
    const releases = [...this.#textPairState.entries()]
      .filter(([key]) => !nextPairState.has(key))
      .map(([, { stringId, styleId }]) => ({ stringId, styleId }));
    upserts.sort(compareTextPair);
    releases.sort(compareTextPair);
    return {
      actions,
      frameSeq: batch.frameSeq,
      metricDeltas: { releases, upserts },
      nextKinds,
      nextParents,
      nextTextPairs,
    };
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

  private takeEditTransactions(): readonly EditTransaction[] {
    if (this.#core.take_edit_transactions === undefined) return [];
    const bytes = this.#core.take_edit_transactions();
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Core edit transactions must be Uint8Array bytes");
    }
    return bytes.byteLength === 0 ? [] : decodeEditTransactionBatch(bytes);
  }

  private emitEditTransactions(transactions: readonly EditTransaction[]): void {
    for (const transaction of transactions) this.#onEditTransaction?.(transaction);
  }

  private takeEventTransactions(): readonly EventTransaction[] {
    if (this.#core.take_event_transactions === undefined) return [];
    const bytes = this.#core.take_event_transactions();
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("Core event transactions must be Uint8Array bytes");
    }
    return bytes.byteLength === 0 ? [] : decodeEventTransactionBatch(bytes);
  }

  private emitEventTransactions(transactions: readonly EventTransaction[]): void {
    for (const transaction of transactions) this.#onEventTransaction?.(transaction);
  }

  private emitNonPassiveRegions(): void {
    const snapshot = this.#core.non_passive_regions?.();
    if (snapshot === undefined) return;
    const regions = parseNonPassiveRegions(snapshot);
    this.#onNonPassiveRegions?.(regions);
  }

  private emitEditingGeometry(): void {
    if (this.#onEditingGeometry === undefined) return;
    const snapshot = this.#core.editing_geometry?.();
    if (snapshot === undefined) return;
    const frame = parseEditingGeometry(snapshot);
    if (frame !== undefined) this.#onEditingGeometry(frame);
  }

  private emitSemantics(): void {
    if (this.#onSemantics === undefined) return;
    const snapshot = this.#core.semantics?.();
    if (snapshot === undefined) return;
    this.#onSemantics(parseSemantics(snapshot));
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

function textPairKey(pair: CanvasSystemTextPair): string {
  return `${String(pair.stringId)}:${String(pair.styleId)}`;
}

function compareTextPair(left: CanvasSystemTextPair, right: CanvasSystemTextPair): number {
  return left.stringId - right.stringId || left.styleId - right.styleId;
}

function countTextPairs(
  runs: ReadonlyMap<number, CanvasSystemTextPair>,
): Map<string, TextPairState> {
  const pairs = new Map<string, TextPairState>();
  for (const pair of runs.values()) {
    const key = textPairKey(pair);
    const previous = pairs.get(key);
    pairs.set(
      key,
      Object.freeze({
        ...pair,
        references: (previous?.references ?? 0) + 1,
      }),
    );
  }
  return pairs;
}

function indexChildren(parents: ReadonlyMap<number, number>): Map<number, Set<number>> {
  const children = new Map<number, Set<number>>();
  for (const [node, parent] of parents) addChild(children, parent, node);
  return children;
}

function addChild(children: Map<number, Set<number>>, parent: number, node: number): void {
  let siblings = children.get(parent);
  if (siblings === undefined) {
    siblings = new Set();
    children.set(parent, siblings);
  }
  siblings.add(node);
}

function removeChild(children: Map<number, Set<number>>, parent: number, node: number): void {
  const siblings = children.get(parent);
  siblings?.delete(node);
  if (siblings?.size === 0) children.delete(parent);
}

function removeHostSubtree(
  root: number,
  parents: Map<number, number>,
  textPairs: Map<number, CanvasSystemTextPair>,
  children: Map<number, Set<number>>,
): void {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    const descendants = children.get(node);
    if (descendants !== undefined) pending.push(...descendants);
    const parent = parents.get(node);
    if (parent !== undefined) removeChild(children, parent, node);
    children.delete(node);
    parents.delete(node);
    textPairs.delete(node);
  }
}

function replaceMap<Key, Value>(target: Map<Key, Value>, source: ReadonlyMap<Key, Value>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function runtimeFontSet(): FontFaceSet | undefined {
  const scope = globalThis as typeof globalThis & {
    readonly fonts?: FontFaceSet;
  };
  if (scope.fonts !== undefined) return scope.fonts;
  return typeof document === "undefined" ? undefined : document.fonts;
}

function toError(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}

function reportAsyncError(error: Error, handler: ((error: Error) => void) | undefined): void {
  if (handler !== undefined) {
    handler(error);
    return;
  }
  queueMicrotask(() => {
    throw error;
  });
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
    visiblePlaceholders: requiredWord(words, FRAME_DIAGNOSTICS_VISIBLE_PLACEHOLDERS_INDEX),
    virtualVisibleStart: requiredWord(words, FRAME_DIAGNOSTICS_VIRTUAL_VISIBLE_START_INDEX),
    virtualVisibleEnd: requiredWord(words, FRAME_DIAGNOSTICS_VIRTUAL_VISIBLE_END_INDEX),
    virtualMaterializedStart: requiredWord(
      words,
      FRAME_DIAGNOSTICS_VIRTUAL_MATERIALIZED_START_INDEX,
    ),
    virtualMaterializedEnd: requiredWord(words, FRAME_DIAGNOSTICS_VIRTUAL_MATERIALIZED_END_INDEX),
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

function parseNonPassiveRegions(words: Uint32Array): NonPassiveRegion[] {
  if (!(words instanceof Uint32Array) || words.length < NON_PASSIVE_REGION_HEADER_WORDS) {
    throw new TypeError("Core non-passive regions must use the generated Uint32Array layout");
  }
  if (words[NON_PASSIVE_REGION_HEADER_VERSION_INDEX] !== NON_PASSIVE_REGION_VERSION) {
    throw new Error("Core non-passive region version is incompatible with Host");
  }
  const count = requiredWord(words, NON_PASSIVE_REGION_HEADER_REGION_COUNT_INDEX);
  const expected = NON_PASSIVE_REGION_HEADER_WORDS + count * NON_PASSIVE_REGION_RECORD_WORDS;
  if (!Number.isSafeInteger(expected) || words.length !== expected) {
    throw new TypeError("Core non-passive region count does not match its payload");
  }
  const scratch = new DataView(new ArrayBuffer(4));
  const float = (bits: number): number => {
    scratch.setUint32(0, bits, true);
    return scratch.getFloat32(0, true);
  };
  const regions: NonPassiveRegion[] = [];
  for (let record = 0; record < count; record += 1) {
    const offset = NON_PASSIVE_REGION_HEADER_WORDS + record * NON_PASSIVE_REGION_RECORD_WORDS;
    const flags = requiredWord(words, offset + NON_PASSIVE_REGION_RECORD_FLAGS_INDEX);
    const left = float(requiredWord(words, offset + NON_PASSIVE_REGION_RECORD_LEFT_BITS_INDEX));
    const top = float(requiredWord(words, offset + NON_PASSIVE_REGION_RECORD_TOP_BITS_INDEX));
    const right = float(requiredWord(words, offset + NON_PASSIVE_REGION_RECORD_RIGHT_BITS_INDEX));
    const bottom = float(requiredWord(words, offset + NON_PASSIVE_REGION_RECORD_BOTTOM_BITS_INDEX));
    if (flags === 0 || flags > 3) throw new RangeError("Core non-passive flags are invalid");
    if (![left, top, right, bottom].every(Number.isFinite) || left >= right || top >= bottom) {
      throw new RangeError("Core non-passive region bounds are invalid");
    }
    regions.push({ bottom, flags, left, right, top });
  }
  return regions;
}

function parseEditingGeometry(words: Uint32Array): EditingGeometryFrame | undefined {
  const minimum = EDITING_GEOMETRY_HEADER_WORDS + EDITING_GEOMETRY_RECT_WORDS * 2;
  if (!(words instanceof Uint32Array) || words.length < minimum) {
    throw new TypeError("Core editing geometry must use the generated Uint32Array layout");
  }
  if (words[EDITING_GEOMETRY_HEADER_VERSION_INDEX] !== EDITING_GEOMETRY_VERSION) {
    throw new Error("Core editing geometry version is incompatible with Host");
  }
  const nodeId = requiredWord(words, EDITING_GEOMETRY_HEADER_NODE_ID_INDEX);
  if (nodeId === NULL_NODE_ID) return undefined;
  const selectionStart = requiredWord(words, EDITING_GEOMETRY_HEADER_SELECTION_START_INDEX);
  const selectionEnd = requiredWord(words, EDITING_GEOMETRY_HEADER_SELECTION_END_INDEX);
  if (selectionStart > selectionEnd) {
    throw new RangeError("Core editing geometry selection range is inverted");
  }
  const count = requiredWord(words, EDITING_GEOMETRY_HEADER_CHARACTER_COUNT_INDEX);
  const expected = minimum + count * EDITING_GEOMETRY_CHARACTER_WORDS;
  if (!Number.isSafeInteger(expected) || words.length !== expected) {
    throw new TypeError("Core editing geometry character count does not match its payload");
  }
  const scratch = new DataView(new ArrayBuffer(4));
  const float = (bits: number): number => {
    scratch.setUint32(0, bits, true);
    return scratch.getFloat32(0, true);
  };
  const rect = (offset: number): EditingGeometryRect => {
    const left = float(requiredWord(words, offset + EDITING_GEOMETRY_RECT_LEFT_BITS_INDEX));
    const top = float(requiredWord(words, offset + EDITING_GEOMETRY_RECT_TOP_BITS_INDEX));
    const width = float(requiredWord(words, offset + EDITING_GEOMETRY_RECT_WIDTH_BITS_INDEX));
    const height = float(requiredWord(words, offset + EDITING_GEOMETRY_RECT_HEIGHT_BITS_INDEX));
    if (![left, top, width, height].every(Number.isFinite) || width < 0 || height < 0) {
      throw new RangeError("Core editing geometry rectangle is invalid");
    }
    return { height, left, top, width };
  };
  const controlBounds = rect(EDITING_GEOMETRY_HEADER_WORDS);
  const selectionBounds = rect(EDITING_GEOMETRY_HEADER_WORDS + EDITING_GEOMETRY_RECT_WORDS);
  const characterBounds: EditingCharacterBounds[] = [];
  for (let record = 0; record < count; record += 1) {
    const offset = minimum + record * EDITING_GEOMETRY_CHARACTER_WORDS;
    const start = requiredWord(words, offset + EDITING_GEOMETRY_CHARACTER_START_INDEX);
    const end = requiredWord(words, offset + EDITING_GEOMETRY_CHARACTER_END_INDEX);
    if (start >= end) throw new RangeError("Core editing geometry character range is empty");
    characterBounds.push({
      end,
      rect: rect(offset + EDITING_GEOMETRY_CHARACTER_LEFT_BITS_INDEX),
      start,
    });
  }
  return { characterBounds, controlBounds, nodeId, selectionBounds, selectionEnd, selectionStart };
}

/** Fully validates one untrusted Core semantics snapshot before use. */
export function parseSemantics(bytes: Uint8Array): SemanticNode[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength % 4 !== 0) {
    throw new TypeError("Core semantics must use the generated byte layout");
  }
  const headerBytes = SEMANTICS_HEADER_WORDS * 4;
  if (bytes.byteLength < headerBytes) {
    throw new TypeError("Core semantics snapshot is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(SEMANTICS_HEADER_VERSION_INDEX * 4, true) !== SEMANTICS_VERSION) {
    throw new Error("Core semantics version is incompatible with Host");
  }
  const count = view.getUint32(SEMANTICS_HEADER_NODE_COUNT_INDEX * 4, true);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const nodes: SemanticNode[] = [];
  let offset = headerBytes;
  for (let record = 0; record < count; record += 1) {
    if (offset + SEMANTICS_RECORD_WORDS * 4 > bytes.byteLength) {
      throw new TypeError("Core semantics record is truncated");
    }
    const word = (index: number): number => view.getUint32(offset + index * 4, true);
    const float = (index: number): number => view.getFloat32(offset + index * 4, true);
    const flags = word(SEMANTICS_RECORD_FLAGS_INDEX);
    if ((flags & ~0b111) !== 0) throw new RangeError("Core semantics flags are reserved");
    const bounds = {
      left: float(SEMANTICS_RECORD_LEFT_BITS_INDEX),
      top: float(SEMANTICS_RECORD_TOP_BITS_INDEX),
      width: float(SEMANTICS_RECORD_WIDTH_BITS_INDEX),
      height: float(SEMANTICS_RECORD_HEIGHT_BITS_INDEX),
    };
    if (
      ![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) ||
      bounds.width < 0 ||
      bounds.height < 0
    ) {
      throw new RangeError("Core semantics bounds are invalid");
    }
    const roleBytes = word(SEMANTICS_RECORD_ROLE_BYTES_INDEX);
    const labelBytes = word(SEMANTICS_RECORD_LABEL_BYTES_INDEX);
    const valueBytes = word(SEMANTICS_RECORD_VALUE_BYTES_INDEX);
    const stringStart = offset + SEMANTICS_RECORD_WORDS * 4;
    const stringBytes = roleBytes + labelBytes + valueBytes;
    const paddedEnd = stringStart + stringBytes + ((4 - (stringBytes % 4)) % 4);
    if (
      stringBytes > bytes.byteLength ||
      paddedEnd > bytes.byteLength ||
      !Number.isSafeInteger(paddedEnd)
    ) {
      throw new TypeError("Core semantics strings overflow the snapshot");
    }
    const text = (start: number, length: number): string => {
      try {
        return decoder.decode(bytes.subarray(start, start + length));
      } catch {
        throw new TypeError("Core semantics string is not valid UTF-8");
      }
    };
    nodes.push({
      bounds,
      focusable: (flags & 1) !== 0,
      focused: (flags & 2) !== 0,
      label: text(stringStart + roleBytes, labelBytes),
      nodeId: word(SEMANTICS_RECORD_NODE_ID_INDEX),
      password: (flags & 4) !== 0,
      role: text(stringStart, roleBytes),
      value: text(stringStart + roleBytes + labelBytes, valueBytes),
    });
    offset = paddedEnd;
  }
  if (offset !== bytes.byteLength) {
    throw new TypeError("Core semantics snapshot has trailing bytes");
  }
  return nodes;
}

/** Creates the deterministic main-thread M1 fallback rendering root. */
export function createCanvasRoot(
  context: Canvas2DContext,
  core: CoreClient,
  options: CanvasRootOptions = {},
): DoperRoot {
  const coreRoot: { current: CoreDrivenDoperRoot | undefined } = { current: undefined };
  const sink = new CanvasFrameSink(
    context,
    core,
    options.onFrame,
    undefined,
    undefined,
    options.onPostCommitError,
    (transaction) => {
      coreRoot.current?.applyEditTransaction(transaction);
      options.onEditTransaction?.(transaction);
    },
    (transaction) => {
      coreRoot.current?.applyEventTransaction(transaction);
      options.onEventTransaction?.(transaction);
    },
    options.onNonPassiveRegions,
    options.onEditingGeometry,
    options.onSemantics,
  );
  const root = createRoot(sink, options);
  coreRoot.current = root;
  return {
    render: (node) => root.render(node),
    flushSync: () => root.flushSync(),
    invokeCallback: (callbackId) => root.invokeCallback(callbackId),
    unmount: () => {
      try {
        root.unmount();
      } finally {
        sink.dispose();
      }
    },
    get failed() {
      return root.failed;
    },
  };
}
