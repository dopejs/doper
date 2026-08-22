import {
  Fragment,
  PingoFont,
  createElement,
  isMemoComponent,
  isPingoElement,
  normalizeChildren,
  shallowEqual,
  type AnyPingoElement,
  type Color,
  type CommonProps,
  type PingoNode,
  type PingoEvent,
  type PingoEventHandler,
  type EditableTextProps,
  type FunctionComponent,
  PingoImage,
  type PingoMediaError,
  type PingoMediaEvent,
  type HostType,
  type ImageProps,
  type Key,
  type MemoComponent,
  type NodeHandle,
  type PropsAreEqual,
  type ViewHandle,
  type VideoProps,
  type Ref,
  type VirtualListProps,
  type VirtualViewProps,
} from "@dopejs/pingo-jsx";
import { ComponentScope } from "@dopejs/pingo-runtime/internal";
import {
  isContextProvider,
  signal,
  type ContextProvider,
  type LayoutGeometry,
  type LayoutGeometryAccess,
  type LayoutRect,
  type PingoContext,
  type Signal,
} from "@dopejs/pingo-runtime";
import type { EditTransaction, EventTransaction, InputEventKind } from "@dopejs/pingo-editing";
import {
  STYLE_KEYWORD_IDS,
  resolveInteractionStyles,
  type ComputedStyle,
  type PingoStyleNodeType,
  type PingoStyleSheet,
  type ResolveInteractionStylesResult,
  type StyleDiagnostic,
  type StylePropertyName,
} from "@dopejs/pingo-style";

import {
  MAX_OBSERVED_GEOMETRY_NODES,
  MAX_VIRTUAL_ITEMS,
  NodeKind,
  Prop,
  ResourceKind,
  VirtualAxis,
} from "./generated";
import { encodeAnimationResource } from "./animation-resource";
import { encodeComputedStyleResource } from "./computed-style-resource";
import {
  encodeMutationBatch,
  NULL_NODE_ID,
  OBSERVE_GEOMETRY_FLAG_ACTIVE,
  type Mutation,
} from "./mutation-stream";
import { NodeIdAllocator } from "./node-id";
import {
  ResourcePool,
  encodeAffine,
  encodeImageBitmap,
  encodeVideoFrameDescriptor,
  encodeSfntFont,
  encodeSolidPaint,
  encodeTextStyle,
  encodeUtf8,
} from "./resource-pool";

/** Synchronous main-thread or transport adapter for committed mutation bytes. */
export interface MutationSink {
  commit(bytes: Uint8Array): void;
}

/** Scheduling and fatal-state hooks for one reconciler root. */
export interface RootOptions {
  readonly schedule?: (task: () => void) => void;
  readonly onFatalError?: (error: Error) => void;
  readonly onPostCommitError?: (error: Error) => void;
  /** Immutable stylesheet registration order for this root. */
  readonly styleSheets?: readonly PingoStyleSheet[];
  /** Independent rollback switch for Shell style resolution. Defaults to enabled. */
  readonly styleResolverEnabled?: boolean;
  /** Independent rollback switch for pseudo-state variants. Defaults to enabled. */
  readonly interactionStylesEnabled?: boolean;
  /** Independent rollback switch for the M6 foundation component facade. Defaults to enabled. */
  readonly foundationComponentsEnabled?: boolean;
  /** Independent rollback switch for Core presentation animation. Defaults to enabled. */
  readonly coreAnimationEnabled?: boolean;
  /** Independent rollback switch for the M8 media pipeline. Defaults to enabled. */
  readonly videoEnabled?: boolean;
  /** Receives deterministic per-node style diagnostics before commit. */
  readonly onStyleDiagnostics?: (
    diagnostics: readonly StyleDiagnostic[],
    context: { readonly nodeId: number; readonly hostType: HostType },
  ) => void;
  /** Host bridge for imperative capture/focus requests issued by node handles. */
  readonly onInteractionRequest?: (request: InteractionRequest) => void;
  /**
   * Called when the observed set becomes non-empty or empty again.
   *
   * Lets the Host skip the per-frame geometry export entirely while nothing is
   * measured, which is the whole benefit the old opt-in flag bought without
   * asking anyone to configure it.
   */
  readonly onLayoutObservationChange?: (active: boolean) => void;
  /** Host bridge for mounting, updating, and releasing browser-owned media state. */
  readonly onMediaBinding?: (binding: MediaBinding | undefined, nodeId: number) => void;
}

/** Serializable media configuration; browser objects remain owned by Host. */
export interface MediaBinding {
  readonly nodeId: number;
  readonly resourceId: number;
  readonly src: string;
  readonly autoPlay: boolean;
  readonly loop: boolean;
  readonly muted: boolean;
  readonly crossOrigin?: "anonymous" | "use-credentials";
  readonly preload: "auto" | "metadata" | "none";
}

/** Imperative interaction request forwarded to the active Host transport. */
export type InteractionRequest =
  | { readonly type: "setPointerCapture"; readonly nodeId: number; readonly pointerId: number }
  | { readonly type: "releasePointerCapture"; readonly nodeId: number; readonly pointerId: number }
  | { readonly type: "focus"; readonly nodeId: number }
  | { readonly type: "blur"; readonly nodeId: number }
  | { readonly type: "scrollTo"; readonly nodeId: number; readonly x: number; readonly y: number }
  | {
      readonly type: "scrollBy";
      readonly nodeId: number;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | {
      readonly type: "setScrollVelocity";
      readonly nodeId: number;
      readonly velocityX: number;
      readonly velocityY: number;
    }
  | { readonly type: "mediaPlay" | "mediaPause"; readonly nodeId: number }
  | { readonly type: "mediaSeek"; readonly nodeId: number; readonly timeSeconds: number };

/** Public lifecycle for a localized component/host tree. */
export interface PingoRoot {
  render(node: PingoNode): void;
  flushSync(): void;
  invokeCallback(callbackId: number): void;
  unmount(): void;
  styleMetrics(): StyleRuntimeMetrics;
  readonly failed: boolean;
}

/** Cumulative Shell style work for rollout, hot-path, and migration diagnostics. */
export interface StyleRuntimeMetrics {
  readonly cacheHits: number;
  readonly diagnostics: number;
  readonly interactionVariants: number;
  readonly resolutions: number;
}

/** Internal Host contract for applying asynchronous Core virtual windows. */
export interface CoreDrivenPingoRoot extends PingoRoot {
  refillVirtualRanges(requests: readonly VirtualRangeRequest[]): void;
  applyEditTransaction(transaction: EditTransaction): void;
  applyEventTransaction(transaction: EventTransaction): void;
  editableState(nodeId: number): EditableStateSnapshot | undefined;
  submitEditable(nodeId: number): void;
  resetInteractionState(): void;
  updateMediaMetadata(nodeId: number, width: number, height: number): void;
  applyMediaEvent(nodeId: number, event: PingoMediaEvent | PingoMediaError): void;
  activateNode(nodeId: number): void;
  applyLayoutGeometry(records: readonly LayoutGeometryReport[], viewport?: LayoutRect): void;
  layoutObservationDeferrals(): number;
}

/** Shell-owned durable state used to activate one native editing surface. */
export interface EditableStateSnapshot {
  readonly inputMode: string;
  readonly multiline: boolean;
  readonly nodeId: number;
  readonly password: boolean;
  readonly readOnly: boolean;
  readonly revision: bigint;
  readonly selection: { readonly anchor: number; readonly focus: number };
  readonly value: string;
}

/** Core-planned full preheat window to materialize outside the render frame. */
export interface VirtualRangeRequest {
  readonly end: number;
  readonly nodeId: number;
  readonly start: number;
}

interface RootOwner {
  readonly kind: "root";
  children: Instance[];
}

interface BaseInstance {
  readonly key: Key | null;
  parent: Owner;
  mounted: boolean;
  /**
   * The descriptor this instance was last updated from.
   *
   * Re-diffing the identical element object cannot produce a mutation, so a
   * caller that deliberately reuses one -- as a virtual list does for the items
   * that stayed inside the window -- can skip the walk entirely.
   */
  descriptor?: ChildDescriptor;
}

interface HostInstance extends BaseInstance {
  readonly kind: "host";
  readonly type: HostType;
  readonly nodeId: number;
  props: Readonly<Record<string, unknown>>;
  children: Instance[];
  scalars: Map<Prop, number>;
  vectors: Map<Prop, readonly [number, number, number, number]>;
  resources: Map<string, number>;
  computedStyle: ComputedStyle | undefined;
  computedStyleBytes: Uint8Array | undefined;
  onTapId: number | undefined;
  ref: Ref<NodeHandle> | undefined;
  scrollPosition: readonly [number, number] | undefined;
  virtualItemIndex: number | undefined;
  virtualItems: Map<number, PingoNode>;
  virtualKeys: Map<number, Key>;
  /** Wrapper elements per index, reused so unchanged items skip re-diffing. */
  virtualWrappers: Map<number, PingoNode>;
  virtualList: NormalizedVirtualList | undefined;
  virtualRange: readonly [number, number] | undefined;
  editable: NormalizedEditable | undefined;
  editableSelection: { anchor: number; focus: number } | undefined;
  onEditTransaction: ((transaction: EditTransaction) => void) | undefined;
  onSubmit: (() => void) | undefined;
  eventHandlers: Map<EventHandlerKey, PingoEventHandler>;
  media: NormalizedMedia | undefined;
  mediaResourceId: number | undefined;
  mediaNaturalSize: readonly [number, number] | undefined;
}

interface ComponentInstance extends BaseInstance {
  readonly kind: "component";
  readonly type: FunctionComponent<never> | MemoComponent<never> | ContextProvider<unknown>;
  props: Readonly<Record<string, unknown>>;
  children: Instance[];
  readonly scope: ComponentScope;
  /** Present when this instance is a context provider element. */
  contextValue: { context: PingoContext<unknown>; signal: Signal<unknown> } | undefined;
}

type Instance = HostInstance | ComponentInstance;
type Owner = RootOwner | HostInstance | ComponentInstance;
type ChildDescriptor = AnyPingoElement | string;

interface NormalizedHostProps {
  readonly children: PingoNode;
  readonly ref: Ref<NodeHandle> | undefined;
  readonly scalars: Map<Prop, number>;
  readonly vectors: Map<Prop, readonly [number, number, number, number]>;
  readonly background: Uint8Array | undefined;
  readonly transform: Uint8Array | undefined;
  readonly semantics: Map<Prop, string>;
  readonly onTap: (() => void) | undefined;
  readonly text:
    | {
        readonly value: string;
        readonly paint: Uint8Array;
        readonly fontFamily: string;
        readonly font: Uint8Array | undefined;
        readonly fontSize: number;
        readonly lineHeight: number;
        readonly fontWeight: number;
        readonly fontStyle: "normal" | "italic";
        readonly textAlign: "start" | "end" | "left" | "right" | "center" | "justify";
        readonly whiteSpace: "normal" | "nowrap" | "pre" | "pre-line" | "pre-wrap";
        readonly overflowWrap: "normal" | "break-word" | "anywhere";
        readonly textOverflow: "clip" | "ellipsis";
      }
    | undefined;
  readonly image: Uint8Array | undefined;
  readonly media: NormalizedMedia | undefined;
  readonly scrollPosition: readonly [number, number] | undefined;
  readonly virtualItemIndex: number | undefined;
  readonly virtualList: NormalizedVirtualList | undefined;
  readonly editable: NormalizedEditable | undefined;
  readonly eventHandlers: Map<EventHandlerKey, PingoEventHandler>;
  readonly computedStyle: ComputedStyle | undefined;
  readonly computedStyleBytes: Uint8Array | undefined;
  readonly animationBytes: Uint8Array | undefined;
  readonly styleDiagnostics: readonly StyleDiagnostic[];
}

interface NormalizedMedia {
  readonly width: number;
  readonly height: number;
  readonly poster: PingoImage | undefined;
  readonly binding: Omit<MediaBinding, "nodeId" | "resourceId">;
  readonly onPlay: ((event: PingoMediaEvent) => void) | undefined;
  readonly onPause: ((event: PingoMediaEvent) => void) | undefined;
  readonly onEnded: ((event: PingoMediaEvent) => void) | undefined;
  readonly onLoadedMetadata: ((event: PingoMediaEvent) => void) | undefined;
  readonly onTimeUpdate: ((event: PingoMediaEvent) => void) | undefined;
  readonly onError: ((error: PingoMediaError) => void) | undefined;
}

type EventHandlerKey = `${InputEventKind}:${"bubble" | "capture"}`;

interface NormalizedEditable {
  readonly revision: bigint;
  readonly flags: number;
  readonly maxGraphemes: number;
  readonly inputMode: string;
  readonly value: string;
  readonly onTransaction: ((transaction: EditTransaction) => void) | undefined;
  readonly onSubmit: (() => void) | undefined;
}

interface NormalizedVirtualList {
  readonly axis: "x" | "y";
  readonly itemCount: number;
  readonly estimatedItemSize: number;
  readonly baseOverscanViewports: number;
  readonly velocityHorizonSeconds: number;
  readonly maximumAheadViewports: number;
  readonly renderItem: (index: number) => PingoNode;
  readonly getItemKey: ((index: number) => Key) | undefined;
}

interface CallbackEntry {
  readonly id: number;
  readonly callback: () => void;
  references: number;
}

const COMMON_KEYS = new Set([
  "backgroundColor",
  "animation",
  "children",
  "className",
  "direction",
  "gap",
  "height",
  "key",
  "maxHeight",
  "maxWidth",
  "minHeight",
  "minWidth",
  "onTap",
  "onPointerDownCapture",
  "onPointerDown",
  "onPointerUpCapture",
  "onPointerUp",
  "onPointerMoveCapture",
  "onPointerMove",
  "onPointerCancelCapture",
  "onPointerCancel",
  "onPointerOverCapture",
  "onPointerOver",
  "onPointerOutCapture",
  "onPointerOut",
  "onPointerEnterCapture",
  "onPointerEnter",
  "onPointerLeaveCapture",
  "onPointerLeave",
  "onGotPointerCaptureCapture",
  "onGotPointerCapture",
  "onLostPointerCaptureCapture",
  "onLostPointerCapture",
  "onFocusCapture",
  "onFocus",
  "onBlurCapture",
  "onBlur",
  "onFocusInCapture",
  "onFocusIn",
  "onFocusOutCapture",
  "onFocusOut",
  "onClickCapture",
  "onClick",
  "onWheelCapture",
  "onWheel",
  "onKeyDownCapture",
  "onKeyDown",
  "onKeyUpCapture",
  "onKeyUp",
  "opacity",
  "padding",
  "ref",
  "semanticLabel",
  "semanticRole",
  "semanticValue",
  "style",
  "transform",
  "transition",
  "width",
]);
const TEXT_KEYS = new Set([
  ...COMMON_KEYS,
  "color",
  "font",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "value",
]);
const EDITABLE_KEYS = new Set([
  ...TEXT_KEYS,
  "controller",
  "inputMode",
  "maxGraphemes",
  "multiline",
  "onSubmit",
  "onTransaction",
  "password",
  "readOnly",
  "revision",
]);
const SCROLL_KEYS = new Set([...COMMON_KEYS, "scrollX", "scrollY"]);
const CONTAINER_KEYS = new Set([...SCROLL_KEYS, "virtual"]);
const IMAGE_KEYS = new Set([...[...COMMON_KEYS].filter((key) => key !== "children"), "source"]);
const VIDEO_KEYS = new Set([
  ...[...COMMON_KEYS].filter((key) => key !== "children"),
  "autoPlay",
  "crossOrigin",
  "loop",
  "muted",
  "onEnded",
  "onError",
  "onLoadedMetadata",
  "onPause",
  "onPlay",
  "onTimeUpdate",
  "poster",
  "preload",
  "src",
]);
const VIRTUAL_LIST_KEYS = new Set([
  ...[...SCROLL_KEYS].filter((key) => key !== "children"),
  "baseOverscanViewports",
  "estimatedItemHeight",
  "itemCount",
  "maximumAheadViewports",
  "renderItem",
  "velocityHorizonSeconds",
]);
const VIRTUAL_ITEM_INDEX = Symbol("pingo.virtualItemIndex");
const FOUNDATION_COMPONENT = Symbol.for("dopejs.pingo.foundation-component");

interface StyleResolutionContext {
  readonly coreAnimationEnabled: boolean;
  readonly enabled: boolean;
  readonly foundationComponentsEnabled: boolean;
  readonly interactionStylesEnabled: boolean;
  readonly videoEnabled: boolean;
  readonly parentStyle: ComputedStyle | undefined;
  readonly styleSheets: readonly PingoStyleSheet[];
  readonly recordResolution: (result: ResolveInteractionStylesResult) => void;
}

/** Creates one deterministic component tree and Mutation Stream producer. */
export function createRoot(sink: MutationSink, options: RootOptions = {}): CoreDrivenPingoRoot {
  return new ReconcilerRoot(sink, options);
}

class ReconcilerRoot implements CoreDrivenPingoRoot {
  readonly #sink: MutationSink;
  readonly #schedule: (task: () => void) => void;
  readonly #onFatalError: ((error: Error) => void) | undefined;
  readonly #onPostCommitError: ((error: Error) => void) | undefined;
  readonly #styleSheets: readonly PingoStyleSheet[];
  readonly #styleResolverEnabled: boolean;
  readonly #interactionStylesEnabled: boolean;
  readonly #foundationComponentsEnabled: boolean;
  readonly #coreAnimationEnabled: boolean;
  readonly #videoEnabled: boolean;
  readonly #onStyleDiagnostics:
    | ((
        diagnostics: readonly StyleDiagnostic[],
        context: { readonly nodeId: number; readonly hostType: HostType },
      ) => void)
    | undefined;
  readonly #onInteractionRequest: ((request: InteractionRequest) => void) | undefined;
  readonly #onLayoutObservationChange: ((active: boolean) => void) | undefined;
  readonly #onMediaBinding:
    ((binding: MediaBinding | undefined, nodeId: number) => void) | undefined;
  readonly #pointerCaptures = new Map<number, number>();
  #focusedNodeId: number | undefined;
  readonly #allocator = new NodeIdAllocator();
  readonly #resources = new ResourcePool();
  readonly #callbacksByFunction = new Map<() => void, CallbackEntry>();
  readonly #callbacksById = new Map<number, CallbackEntry>();
  readonly #owner: RootOwner = { kind: "root", children: [] };
  readonly #dirtyComponents = new Set<ComponentInstance>();
  readonly #liveScopes = new Set<ComponentScope>();
  readonly #hostsByNodeId = new Map<number, HostInstance>();
  readonly #renderedScopes = new Set<ComponentScope>();
  readonly #scopesPendingDisposal = new Set<ComponentScope>();
  readonly #postCommitCleanups: Array<() => void> = [];
  readonly #postCommitAttachments: Array<() => void> = [];
  #nextCallbackId = 1;
  #rootNodeId: number | undefined;
  #frameSequence = 1;
  #mutations: Mutation[] | undefined;
  #scheduled = false;
  /**
   * Observation changes waiting for the next commit, keyed by node id.
   *
   * A map rather than a list: toggling a node on and off before the commit
   * should send one command, not two, and the last state is the true one.
   */
  readonly #pendingObservations = new Map<number, boolean>();
  /** Latest geometry Core reported, keyed by generation-bearing node id. */
  readonly #layoutGeometry = new Map<number, LayoutGeometry>();
  /**
   * Who to wake when a node's geometry changes.
   *
   * Reference-counted by construction: the first subscriber turns observation
   * on and the last one off, so two components watching the same node cost one
   * slot in Core's bounded set.
   */
  readonly #geometrySubscribers = new Map<number, Set<() => void>>();
  /** Nodes currently holding a slot in Core's bounded observation set. */
  readonly #observedNodes = new Set<number>();
  /**
   * Nodes wanting a slot, oldest first.
   *
   * The Shell enforces the cap as policy because it is the only side that knows
   * the count and can retry: a command Core rejected is never resent, so a
   * subscription refused there would stay undefined until its component
   * remounted. Core keeps its own cap as a defensive backstop.
   */
  readonly #deferredObservations: number[] = [];
  #layoutObservationDeferrals = 0;
  /** Visible surface, supplied by the Host with each geometry frame. */
  #viewport: LayoutRect | undefined;
  readonly #viewportSubscribers = new Set<() => void>();
  #performing = false;
  #unmounted = false;
  #failed = false;
  #styleCacheHits = 0;
  #styleDiagnostics = 0;
  #styleInteractionVariants = 0;
  #styleResolutions = 0;

  public constructor(sink: MutationSink, options: RootOptions) {
    this.#sink = sink;
    this.#schedule = options.schedule ?? ((task) => queueMicrotask(task));
    this.#onFatalError = options.onFatalError;
    this.#onPostCommitError = options.onPostCommitError;
    this.#styleSheets = Object.freeze([...(options.styleSheets ?? [])]);
    this.#styleResolverEnabled = options.styleResolverEnabled ?? true;
    this.#interactionStylesEnabled = options.interactionStylesEnabled ?? true;
    this.#foundationComponentsEnabled = options.foundationComponentsEnabled ?? true;
    this.#coreAnimationEnabled = options.coreAnimationEnabled ?? true;
    this.#videoEnabled = options.videoEnabled ?? true;
    this.#onStyleDiagnostics = options.onStyleDiagnostics;
    this.#onInteractionRequest = options.onInteractionRequest;
    this.#onLayoutObservationChange = options.onLayoutObservationChange;
    this.#onMediaBinding = options.onMediaBinding;
  }

  public get failed(): boolean {
    return this.#failed;
  }

  public styleMetrics(): StyleRuntimeMetrics {
    return Object.freeze({
      cacheHits: this.#styleCacheHits,
      diagnostics: this.#styleDiagnostics,
      interactionVariants: this.#styleInteractionVariants,
      resolutions: this.#styleResolutions,
    });
  }

  public render(node: PingoNode): void {
    this.assertUsable();
    this.perform(() => {
      const rootNodeId = this.ensureRootNode();
      this.#owner.children = this.reconcileChildren(
        this.#owner,
        rootNodeId,
        this.#owner.children,
        node,
      );
    });
  }

  public flushSync(): void {
    this.assertUsable();
    // Pending observations count as work. Effects run after the commit, so a
    // subscribe or withdraw they trigger arrives with nothing else dirty;
    // returning early here would strand it and Core would keep reporting a node
    // nobody watches for the life of the application.
    if (this.#performing) return;
    if (this.#dirtyComponents.size === 0 && this.#pendingObservations.size === 0) return;
    this.#scheduled = false;
    this.perform(() => this.flushDirtyComponents());
  }

  public invokeCallback(callbackId: number): void {
    this.assertUsable();
    const callback = this.#callbacksById.get(callbackId)?.callback;
    if (callback === undefined) throw new Error(`unknown callback ${String(callbackId)}`);
    callback();
  }

  public refillVirtualRanges(requests: readonly VirtualRangeRequest[]): void {
    this.assertUsable();
    const candidates: readonly VirtualRangeRequest[] = requests;
    if (!Array.isArray(requests)) {
      throw new TypeError("virtual refill requests must be an array");
    }
    const latest = new Map<number, VirtualRangeRequest>();
    for (const request of candidates) {
      if (request === null || typeof request !== "object") {
        throw new TypeError("virtual refill request must be an object");
      }
      assertU32(request.nodeId, "virtual refill nodeId");
      assertU32(request.start, "virtual refill start");
      assertU32(request.end, "virtual refill end");
      if (request.start >= request.end)
        throw new RangeError("virtual refill range must be non-empty");
      latest.set(request.nodeId, request);
    }
    const applicable = [...latest.values()]
      .filter((request) => {
        const instance = this.#hostsByNodeId.get(request.nodeId);
        return instance?.mounted === true && instance.virtualList !== undefined;
      })
      .sort((left, right) => left.nodeId - right.nodeId);
    if (applicable.length === 0) return;
    this.perform(() => {
      for (const request of applicable) {
        const instance = this.#hostsByNodeId.get(request.nodeId);
        if (instance === undefined || instance.virtualList === undefined) continue;
        const config = instance.virtualList;
        if (config === undefined) throw new Error("virtual list instance lost its configuration");
        // A queued Core window may race a newer application render that shrank
        // itemCount. The Shell's latest durable value wins: clamp overlap and
        // ignore a window wholly beyond the new end instead of failing the root.
        if (request.start >= config.itemCount) continue;
        this.materializeVirtualWindow(
          instance,
          request.start,
          Math.min(request.end, config.itemCount),
        );
      }
    });
  }

  public applyEditTransaction(transaction: EditTransaction): void {
    this.assertUsable();
    if (transaction === null || typeof transaction !== "object") {
      throw new TypeError("edit transaction must be an object");
    }
    assertU32(transaction.nodeId, "edit transaction nodeId");
    const instance = this.#hostsByNodeId.get(transaction.nodeId);
    if (instance === undefined || !instance.mounted) return;
    if (instance.type !== "editableText" || instance.editable === undefined) {
      throw new Error(`edit transaction targeted non-editable node ${String(transaction.nodeId)}`);
    }
    const current = instance.editable;
    if (transaction.baseRevision !== current.revision) {
      throw new Error(
        `edit transaction base revision ${String(transaction.baseRevision)} does not match Shell revision ${String(current.revision)}`,
      );
    }
    if (transaction.revision <= transaction.baseRevision) {
      throw new Error("edit transaction revision must increase");
    }
    const value =
      transaction.delta === undefined
        ? current.value
        : applyUtf16Replacement(
            current.value,
            transaction.delta.range.start,
            transaction.delta.range.end,
            transaction.delta.text,
          );
    instance.editable = { ...current, revision: transaction.revision, value };
    instance.editableSelection = {
      anchor: transaction.selection.anchor,
      focus: transaction.selection.focus,
    };
    instance.onEditTransaction?.(transaction);
  }

  public applyEventTransaction(transaction: EventTransaction): void {
    this.assertUsable();
    validateEventTransaction(transaction);
    if (transaction.path[0] !== this.#rootNodeId) return;
    const path = transaction.path
      .slice(1)
      .map((nodeId) => this.#hostsByNodeId.get(nodeId))
      .filter((instance): instance is HostInstance => instance?.mounted === true);
    if (path.length !== transaction.path.length - 1 || path.at(-1)?.nodeId !== transaction.target) {
      return;
    }

    if (transaction.kind === "gotpointercapture") {
      this.#pointerCaptures.set(transaction.pointerId, transaction.target);
    } else if (
      transaction.kind === "lostpointercapture" &&
      this.#pointerCaptures.get(transaction.pointerId) === transaction.target
    ) {
      this.#pointerCaptures.delete(transaction.pointerId);
    } else if (transaction.kind === "focus") {
      this.#focusedNodeId = transaction.target;
    } else if (transaction.kind === "blur" && this.#focusedNodeId === transaction.target) {
      this.#focusedNodeId = undefined;
    }

    const state = new PropagationState(transaction, (nodeId) => this.nodeHandle(nodeId));
    const errors: Error[] = [];
    const target = path.at(-1);
    if (target === undefined) return;
    const ancestors = path.slice(0, -1);
    for (const instance of ancestors) {
      this.invokeEventHandler(instance, transaction.kind, "capture", state, errors);
      if (state.propagationStopped) break;
    }
    if (!state.propagationStopped) {
      this.invokeEventHandler(target, transaction.kind, "capture", state, errors);
      if (!state.immediatePropagationStopped) {
        this.invokeEventHandler(target, transaction.kind, "bubble", state, errors);
      }
    }
    if (!state.propagationStopped && eventBubbles(transaction.kind)) {
      for (const instance of [...ancestors].reverse()) {
        this.invokeEventHandler(instance, transaction.kind, "bubble", state, errors);
        if (state.propagationStopped) break;
      }
    }
    if (errors.length === 0) return;
    if (this.#onPostCommitError !== undefined) {
      for (const error of errors) this.#onPostCommitError(error);
      return;
    }
    const [firstError] = errors;
    if (errors.length === 1 && firstError !== undefined) throw firstError;
    throw new AggregateError(errors, "event handlers failed", { cause: firstError });
  }

  public editableState(nodeId: number): EditableStateSnapshot | undefined {
    this.assertUsable();
    assertU32(nodeId, "editable state nodeId");
    const instance = this.#hostsByNodeId.get(nodeId);
    if (instance === undefined || !instance.mounted || instance.editable === undefined) return;
    const editable = instance.editable;
    const selection = instance.editableSelection ?? {
      anchor: editable.value.length,
      focus: editable.value.length,
    };
    return Object.freeze({
      inputMode: editable.inputMode,
      multiline: (editable.flags & 1) !== 0,
      nodeId,
      password: (editable.flags & 4) !== 0,
      readOnly: (editable.flags & 2) !== 0,
      revision: editable.revision,
      selection: Object.freeze({ ...selection }),
      value: editable.value,
    });
  }

  public resetInteractionState(): void {
    this.#pointerCaptures.clear();
    this.#focusedNodeId = undefined;
  }

  public updateMediaMetadata(nodeId: number, width: number, height: number): void {
    this.assertUsable();
    assertU32(nodeId, "media metadata nodeId");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError("media metadata dimensions must be positive integers");
    }
    const instance = this.#hostsByNodeId.get(nodeId);
    if (instance?.mounted !== true || instance.media === undefined) return;
    if (instance.media.width === width && instance.media.height === height) return;
    this.perform(() => {
      instance.mediaNaturalSize = [width, height];
      const media: NormalizedMedia = {
        ...instance.media!,
        width,
        height,
        poster:
          instance.media?.poster?.width === width && instance.media.poster.height === height
            ? instance.media.poster
            : undefined,
      };
      this.replaceResourceProp(
        instance,
        "video-frame",
        Prop.VideoFrame,
        ResourceKind.VideoFrame,
        encodeVideoFrameDescriptor(width, height, media.poster),
      );
      this.updateMediaBinding(instance, media);
    });
  }

  public applyMediaEvent(nodeId: number, event: PingoMediaEvent | PingoMediaError): void {
    this.assertUsable();
    const instance = this.#hostsByNodeId.get(nodeId);
    const media = instance?.mounted === true ? instance.media : undefined;
    if (media === undefined) return;
    try {
      if (!("type" in event)) media.onError?.(event);
      else if (event.type === "play") media.onPlay?.(event);
      else if (event.type === "pause") media.onPause?.(event);
      else if (event.type === "ended") media.onEnded?.(event);
      else if (event.type === "loadedmetadata") media.onLoadedMetadata?.(event);
      else media.onTimeUpdate?.(event);
    } catch (cause) {
      const error = toError(cause, "media event handler failed");
      if (this.#onPostCommitError === undefined) throw error;
      this.#onPostCommitError(error);
    }
  }

  public activateNode(nodeId: number): void {
    this.assertUsable();
    const instance = this.#hostsByNodeId.get(nodeId);
    if (instance?.mounted !== true || instance.onTapId === undefined) return;
    this.invokeCallback(instance.onTapId);
  }

  public submitEditable(nodeId: number): void {
    this.assertUsable();
    assertU32(nodeId, "editable submit nodeId");
    const instance = this.#hostsByNodeId.get(nodeId);
    if (instance === undefined || !instance.mounted || instance.editable === undefined) return;
    instance.onSubmit?.();
  }

  public unmount(): void {
    if (this.#unmounted) return;
    this.assertUsable();
    this.perform(() => {
      for (const child of this.#owner.children) this.disposeInstance(child, true);
      this.#owner.children = [];
      if (this.#rootNodeId !== undefined) {
        this.mutations().push({ type: "removeNode", nodeId: this.#rootNodeId });
        this.#allocator.release(this.#rootNodeId);
        this.#rootNodeId = undefined;
      }
      // A sink failure leaves the root fatally failed either way. Marking the
      // shell state here also makes unmount final when a post-commit ref or
      // effect callback throws after Core accepted the frame.
      this.#unmounted = true;
      this.#dirtyComponents.clear();
    });
  }

  private perform(operation: () => void): void {
    if (this.#performing) throw new Error("reconciler root cannot commit recursively");
    this.#performing = true;
    this.#mutations = [];
    this.drainPendingObservations();
    this.#renderedScopes.clear();
    this.#scopesPendingDisposal.clear();
    this.#postCommitCleanups.length = 0;
    this.#postCommitAttachments.length = 0;
    try {
      operation();
      const mutations = this.mutations();
      if (mutations.length > 0) {
        const bytes = encodeMutationBatch({
          frameSeq: this.#frameSequence,
          mutations,
        });
        this.#sink.commit(bytes);
        this.#frameSequence = nextU32Sequence(this.#frameSequence);
      }
    } catch (cause) {
      const error = toError(cause, "reconciler commit failed");
      this.#failed = true;
      const secondaryErrors = this.disposeShellAfterFailedCommit();
      if (this.#onFatalError !== undefined) {
        try {
          this.#onFatalError(error);
        } catch (hookCause) {
          secondaryErrors.push(toError(hookCause, "fatal error handler failed"));
        }
      }
      if (secondaryErrors.length > 0) {
        throw new AggregateError(
          [error, ...secondaryErrors],
          "reconciler commit and fatal cleanup failed",
          { cause },
        );
      }
      throw error;
    } finally {
      this.#mutations = undefined;
      this.#performing = false;
    }
    this.flushPostCommitWork();
  }

  private flushPostCommitWork(): void {
    let firstError: Error | undefined;
    const reporterErrors: Error[] = [];
    const report = (error: Error): void => {
      if (this.#onPostCommitError === undefined) return;
      try {
        this.#onPostCommitError(error);
      } catch (cause) {
        reporterErrors.push(toError(cause, "post-commit error handler failed"));
      }
    };
    for (const scope of this.#scopesPendingDisposal) {
      try {
        scope.dispose();
      } catch (cause) {
        const error = toError(cause, "component effect disposal failed");
        firstError ??= error;
        report(error);
      } finally {
        this.#liveScopes.delete(scope);
      }
    }
    for (const work of [...this.#postCommitCleanups, ...this.#postCommitAttachments]) {
      try {
        work();
      } catch (cause) {
        const error = toError(cause, "post-commit callback failed");
        firstError ??= error;
        report(error);
      }
    }
    for (const scope of this.#renderedScopes) {
      try {
        scope.flushEffects();
      } catch (cause) {
        const error = toError(cause, "component effect failed");
        firstError ??= error;
        report(error);
      }
    }
    this.#postCommitCleanups.length = 0;
    this.#postCommitAttachments.length = 0;
    this.#renderedScopes.clear();
    this.#scopesPendingDisposal.clear();
    const reporterError = reporterErrors[0];
    if (reporterErrors.length === 1 && reporterError !== undefined) throw reporterError;
    if (reporterErrors.length > 1) {
      throw new AggregateError(reporterErrors, "post-commit error handlers failed", {
        cause: reporterError,
      });
    }
    if (firstError !== undefined && this.#onPostCommitError === undefined) throw firstError;
  }

  private disposeShellAfterFailedCommit(): Error[] {
    const secondaryErrors: Error[] = [];
    const report = (error: Error): void => {
      if (this.#onPostCommitError === undefined) {
        secondaryErrors.push(error);
        return;
      }
      try {
        this.#onPostCommitError(error);
      } catch (cause) {
        secondaryErrors.push(toError(cause, "post-commit error handler failed"));
      }
    };
    for (const scope of this.#liveScopes) {
      try {
        scope.dispose();
      } catch (cause) {
        report(toError(cause, "component effect disposal failed"));
      }
    }
    for (const cleanup of this.#postCommitCleanups) {
      try {
        cleanup();
      } catch (cause) {
        report(toError(cause, "ref cleanup failed"));
      }
    }
    this.detachCurrentRefs(this.#owner.children, report);
    this.#liveScopes.clear();
    this.#scopesPendingDisposal.clear();
    this.#dirtyComponents.clear();
    this.#renderedScopes.clear();
    this.#postCommitCleanups.length = 0;
    this.#postCommitAttachments.length = 0;
    this.#owner.children = [];
    this.#callbacksByFunction.clear();
    this.#callbacksById.clear();
    this.#hostsByNodeId.clear();
    this.#resources.discard();
    return secondaryErrors;
  }

  private detachCurrentRefs(instances: readonly Instance[], report: (error: Error) => void): void {
    for (const instance of instances) {
      if (instance.kind === "host" && instance.ref !== undefined) {
        try {
          assignRef(instance.ref, null);
        } catch (cause) {
          report(toError(cause, "ref cleanup failed"));
        }
      }
      this.detachCurrentRefs(instance.children, report);
    }
  }

  private ensureRootNode(): number {
    if (this.#rootNodeId !== undefined) return this.#rootNodeId;
    const root = this.#allocator.allocate();
    this.#rootNodeId = root;
    this.mutations().push({
      type: "createNode",
      nodeId: root,
      kind: NodeKind.Root,
      parent: NULL_NODE_ID,
      beforeSibling: NULL_NODE_ID,
    });
    return root;
  }

  private reconcileChildren(
    owner: Owner,
    coreParent: number,
    previous: Instance[],
    node: PingoNode,
  ): Instance[] {
    const descriptors = normalizeChildren(node);
    assertUniqueKeys(descriptors);
    const oldHostOrder = flattenHostRoots(previous);
    const keyed = new Map<Key, Instance>();
    const unkeyed: Instance[] = [];
    for (const child of previous) {
      if (child.key === null) unkeyed.push(child);
      else keyed.set(child.key, child);
    }
    const used = new Set<Instance>();
    const next: Instance[] = [];
    let unkeyedIndex = 0;
    for (const descriptor of descriptors) {
      const key = descriptorKey(descriptor);
      const candidate = key === null ? unkeyed[unkeyedIndex++] : keyed.get(key);
      if (candidate !== undefined && compatible(candidate, descriptor)) {
        used.add(candidate);
        if (candidate.descriptor === descriptor) {
          // Same element object as last time: nothing below it can differ.
          this.#styleCacheHits += 1;
          next.push(candidate);
        } else {
          next.push(this.updateInstance(candidate, descriptor, coreParent));
        }
      } else {
        if (candidate !== undefined) {
          used.add(candidate);
          this.disposeInstance(candidate, true);
        }
        next.push(this.mountInstance(owner, descriptor, coreParent));
      }
    }
    for (const child of previous) {
      if (!used.has(child)) this.disposeInstance(child, true);
    }
    this.reorderHostRoots(coreParent, oldHostOrder, flattenHostRoots(next));
    return next;
  }

  private mountInstance(owner: Owner, descriptor: ChildDescriptor, coreParent: number): Instance {
    const instance = this.mountInstanceInner(owner, descriptor, coreParent);
    instance.descriptor = descriptor;
    return instance;
  }

  private mountInstanceInner(
    owner: Owner,
    descriptor: ChildDescriptor,
    coreParent: number,
  ): Instance {
    if (typeof descriptor === "string") {
      return this.mountHost(owner, "text", null, { value: descriptor }, coreParent);
    }
    if (typeof descriptor.type === "string") {
      return this.mountHost(owner, descriptor.type, descriptor.key, descriptor.props, coreParent);
    }
    if (descriptor.type === Fragment) {
      throw new Error("Fragment must be flattened before reconciliation");
    }
    const instance: ComponentInstance = {
      kind: "component",
      type: descriptor.type,
      key: descriptor.key,
      parent: owner,
      props: descriptor.props,
      children: [],
      scope: new ComponentScope(
        () => this.enqueueComponent(instance),
        (context) => this.lookupContext(instance, context),
        this.#layoutGeometryAccess,
      ),
      mounted: true,
      contextValue: isContextProvider(descriptor.type)
        ? { context: descriptor.type.context, signal: signal(descriptor.props.value) }
        : undefined,
    };
    this.#liveScopes.add(instance.scope);
    this.renderComponent(instance, coreParent);
    return instance;
  }

  private mountHost(
    owner: Owner,
    type: HostType,
    key: Key | null,
    props: Readonly<Record<string, unknown>>,
    coreParent: number,
  ): HostInstance {
    const nodeId = this.#allocator.allocate();
    const normalized = normalizeHostProps(type, props, {
      coreAnimationEnabled: this.#coreAnimationEnabled,
      enabled: this.#styleResolverEnabled,
      foundationComponentsEnabled: this.#foundationComponentsEnabled,
      interactionStylesEnabled: this.#interactionStylesEnabled,
      videoEnabled: this.#videoEnabled,
      parentStyle: nearestComputedStyle(owner),
      recordResolution: (result) => this.recordStyleResolution(result),
      styleSheets: this.#styleSheets,
    });
    const instance: HostInstance = {
      kind: "host",
      type,
      key,
      parent: owner,
      nodeId,
      props,
      children: [],
      scalars: new Map(),
      vectors: new Map(),
      resources: new Map(),
      computedStyle: undefined,
      computedStyleBytes: undefined,
      onTapId: undefined,
      ref: undefined,
      scrollPosition: undefined,
      virtualItemIndex: undefined,
      virtualItems: new Map(),
      virtualKeys: new Map(),
      virtualWrappers: new Map(),
      virtualList: undefined,
      virtualRange: undefined,
      editable: undefined,
      editableSelection: undefined,
      onEditTransaction: undefined,
      onSubmit: undefined,
      eventHandlers: new Map(),
      media: undefined,
      mediaResourceId: undefined,
      mediaNaturalSize: undefined,
      mounted: true,
    };
    this.mutations().push({
      type: "createNode",
      nodeId,
      kind: hostNodeKind(type),
      parent: coreParent,
      beforeSibling: NULL_NODE_ID,
    });
    this.reportStyleDiagnostics(instance, normalized.styleDiagnostics);
    this.applyHostProps(instance, normalized);
    this.#hostsByNodeId.set(nodeId, instance);
    instance.props = props;
    if (allowsHostChildren(type)) {
      instance.children = this.reconcileChildren(
        instance,
        nodeId,
        instance.children,
        normalized.children,
      );
    }
    this.updateRef(instance, normalized.ref);
    return instance;
  }

  private updateInstance(
    instance: Instance,
    descriptor: ChildDescriptor,
    coreParent: number,
  ): Instance {
    instance.descriptor = descriptor;
    if (instance.kind === "component") {
      if (typeof descriptor === "string" || !isPingoElement(descriptor)) {
        throw new Error("component descriptor changed unexpectedly");
      }
      if (isContextProvider(instance.type) && instance.contextValue !== undefined) {
        // Providers never bail out: children structure must reconcile, and the
        // value signal delivers fine-grained updates to subscribed consumers.
        const next = descriptor.props.value;
        if (!Object.is(instance.contextValue.signal.peek(), next)) {
          instance.contextValue.signal.set(next);
        }
      }
      const compare = isMemoComponent(instance.type)
        ? ((instance.type.compare ?? shallowEqual) as PropsAreEqual<Record<string, unknown>>)
        : undefined;
      if (compare !== undefined && compare(instance.props, descriptor.props)) {
        // Props equal: keep the previous subtree and its closures; store the
        // fresh props for the next comparison (React memo semantics).
        instance.props = descriptor.props;
        return instance;
      }
      instance.props = descriptor.props;
      this.renderComponent(instance, coreParent);
      return instance;
    }
    const props =
      typeof descriptor === "string" ? ({ value: descriptor } as const) : descriptor.props;
    const normalized = normalizeHostProps(instance.type, props, {
      coreAnimationEnabled: this.#coreAnimationEnabled,
      enabled: this.#styleResolverEnabled,
      foundationComponentsEnabled: this.#foundationComponentsEnabled,
      interactionStylesEnabled: this.#interactionStylesEnabled,
      videoEnabled: this.#videoEnabled,
      parentStyle: nearestComputedStyle(instance.parent),
      recordResolution: (result) => this.recordStyleResolution(result),
      styleSheets: this.#styleSheets,
    });
    const previousVirtualList = instance.virtualList;
    this.reportStyleDiagnostics(instance, normalized.styleDiagnostics);
    this.applyHostProps(instance, normalized);
    instance.props = props;
    if (allowsHostChildren(instance.type)) {
      instance.children = this.reconcileChildren(
        instance,
        instance.nodeId,
        instance.children,
        normalized.children,
      );
    }
    if (
      instance.virtualList !== undefined &&
      instance.virtualRange !== undefined &&
      (previousVirtualList?.renderItem !== instance.virtualList?.renderItem ||
        previousVirtualList?.getItemKey !== instance.virtualList?.getItemKey ||
        previousVirtualList?.itemCount !== instance.virtualList?.itemCount)
    ) {
      const [start, end] = instance.virtualRange;
      const itemCount = instance.virtualList?.itemCount ?? 0;
      if (
        previousVirtualList?.renderItem !== instance.virtualList?.renderItem ||
        previousVirtualList?.getItemKey !== instance.virtualList?.getItemKey
      ) {
        instance.virtualItems.clear();
        instance.virtualKeys.clear();
        instance.virtualWrappers.clear();
      }
      instance.virtualRange = undefined;
      this.materializeVirtualWindow(instance, Math.min(start, itemCount), Math.min(end, itemCount));
    }
    this.updateRef(instance, normalized.ref);
    return instance;
  }

  private renderComponent(instance: ComponentInstance, coreParent: number): void {
    this.#dirtyComponents.delete(instance);
    const output = instance.scope.render(() => {
      const type = instance.type;
      const component = (
        isMemoComponent(type)
          ? type.component
          : isContextProvider(type)
            ? (props: { readonly children?: PingoNode }) => props.children ?? null
            : type
      ) as FunctionComponent<Record<string, unknown>>;
      return component(instance.props);
    });
    instance.children = this.reconcileChildren(instance, coreParent, instance.children, output);
    this.#renderedScopes.add(instance.scope);
  }

  /** Walks the owner chain (components and hosts) to the nearest provider of `context`. */
  private lookupContext(
    instance: ComponentInstance,
    context: PingoContext<unknown>,
  ): Signal<unknown> | undefined {
    let owner: Owner = instance.parent;
    while (owner.kind !== "root") {
      if (owner.kind === "component" && owner.contextValue !== undefined) {
        if (owner.contextValue.context === context) return owner.contextValue.signal;
      }
      owner = owner.parent;
    }
    return undefined;
  }

  private applyHostProps(instance: HostInstance, next: NormalizedHostProps): void {
    if (instance.media?.binding.src !== next.media?.binding.src) {
      instance.mediaNaturalSize = undefined;
    }
    const media = resolveMediaNaturalSize(next.media, instance.mediaNaturalSize);
    this.diffScalars(instance, next.scalars);
    this.diffVectors(instance, next.vectors);
    this.replaceResourceProp(
      instance,
      "background",
      Prop.BackgroundColor,
      ResourceKind.Paint,
      next.background,
    );
    this.replaceResourceProp(
      instance,
      "transform",
      Prop.Transform,
      ResourceKind.Affine,
      next.transform,
    );
    for (const [prop, value] of next.semantics) {
      this.replaceResourceProp(
        instance,
        `semantic:${String(prop)}`,
        prop,
        ResourceKind.Utf8String,
        encodeUtf8(value),
      );
    }
    for (const prop of [Prop.SemanticRole, Prop.SemanticLabel, Prop.SemanticValue]) {
      if (!next.semantics.has(prop)) {
        this.replaceResourceProp(
          instance,
          `semantic:${String(prop)}`,
          prop,
          ResourceKind.Utf8String,
          undefined,
        );
      }
    }
    this.replaceCallback(instance, next.onTap);
    instance.eventHandlers = next.eventHandlers;
    this.replaceResourceProp(instance, "text:font", Prop.Font, ResourceKind.Font, next.text?.font);
    this.replaceResourceProp(instance, "image", Prop.Image, ResourceKind.Image, next.image);
    this.replaceResourceProp(
      instance,
      "video-frame",
      Prop.VideoFrame,
      ResourceKind.VideoFrame,
      media === undefined
        ? undefined
        : encodeVideoFrameDescriptor(media.width, media.height, media.poster),
    );
    this.updateMediaBinding(instance, media);
    this.replaceResourceProp(
      instance,
      "computed-style",
      Prop.ComputedStyle,
      ResourceKind.ComputedStyle,
      next.computedStyleBytes,
    );
    this.replaceResourceProp(
      instance,
      "animation",
      Prop.Animation,
      ResourceKind.Animation,
      next.animationBytes,
    );
    const inheritedStyleChanged = !equalComputedStyles(instance.computedStyle, next.computedStyle);
    instance.computedStyle = next.computedStyle;
    instance.computedStyleBytes = next.computedStyleBytes;
    if (next.text !== undefined) this.replaceTextRun(instance, next.text);
    if (next.editable !== undefined) {
      if (!equalEditable(instance.editable, next.editable)) {
        this.mutations().push({
          type: "configureEditable",
          nodeId: instance.nodeId,
          revision: next.editable.revision,
          flags: next.editable.flags,
          maxGraphemes: next.editable.maxGraphemes,
        });
      }
      const previous = instance.editable;
      if (previous !== undefined && next.editable.revision < previous.revision) {
        instance.editable = {
          ...next.editable,
          revision: previous.revision,
          value: previous.value,
        };
      } else if (
        previous !== undefined &&
        next.editable.revision === previous.revision &&
        next.editable.value !== previous.value
      ) {
        instance.editable = { ...next.editable, value: previous.value };
      } else {
        instance.editable = next.editable;
        if (previous === undefined || next.editable.revision > previous.revision) {
          instance.editableSelection = {
            anchor: next.editable.value.length,
            focus: next.editable.value.length,
          };
        }
      }
      instance.onEditTransaction = next.editable.onTransaction;
      instance.onSubmit = next.editable.onSubmit;
    }
    if (next.scrollPosition !== undefined) {
      if (!equalPair(instance.scrollPosition, next.scrollPosition)) {
        this.mutations().push({
          type: "scrollTo",
          nodeId: instance.nodeId,
          x: next.scrollPosition[0],
          y: next.scrollPosition[1],
          behavior: 0,
        });
        instance.scrollPosition = next.scrollPosition;
      }
    } else {
      instance.scrollPosition = undefined;
    }
    if (next.virtualList !== undefined) {
      if (!equalVirtualListPolicy(instance.virtualList, next.virtualList)) {
        this.mutations().push({
          type: "configureVirtualList",
          nodeId: instance.nodeId,
          itemCount: next.virtualList.itemCount,
          estimatedItemSize: next.virtualList.estimatedItemSize,
          baseOverscanViewports: next.virtualList.baseOverscanViewports,
          velocityHorizonSeconds: next.virtualList.velocityHorizonSeconds,
          maximumAheadViewports: next.virtualList.maximumAheadViewports,
          axis: next.virtualList.axis === "x" ? VirtualAxis.X : VirtualAxis.Y,
        });
      }
      instance.virtualList = next.virtualList;
    }
    if (next.virtualItemIndex !== undefined) {
      if (instance.virtualItemIndex !== next.virtualItemIndex) {
        this.mutations().push({
          type: "setVirtualItem",
          nodeId: instance.nodeId,
          itemIndex: next.virtualItemIndex,
        });
      }
      instance.virtualItemIndex = next.virtualItemIndex;
    }
    if (inheritedStyleChanged && instance.children.length > 0) {
      this.refreshInheritedStyles(instance);
    }
  }

  private refreshInheritedStyles(owner: HostInstance): void {
    const stack = [...owner.children].reverse();
    while (stack.length > 0) {
      const instance = stack.pop();
      if (instance === undefined || !instance.mounted) continue;
      if (instance.kind === "component") {
        for (let index = instance.children.length - 1; index >= 0; index -= 1) {
          const child = instance.children[index];
          if (child !== undefined) stack.push(child);
        }
        continue;
      }
      const normalized = normalizeHostProps(instance.type, instance.props, {
        coreAnimationEnabled: this.#coreAnimationEnabled,
        enabled: this.#styleResolverEnabled,
        foundationComponentsEnabled: this.#foundationComponentsEnabled,
        interactionStylesEnabled: this.#interactionStylesEnabled,
        videoEnabled: this.#videoEnabled,
        parentStyle: nearestComputedStyle(instance.parent),
        recordResolution: (result) => this.recordStyleResolution(result),
        styleSheets: this.#styleSheets,
      });
      this.reportStyleDiagnostics(instance, normalized.styleDiagnostics);
      const changed = !equalComputedStyles(instance.computedStyle, normalized.computedStyle);
      this.replaceResourceProp(
        instance,
        "computed-style",
        Prop.ComputedStyle,
        ResourceKind.ComputedStyle,
        normalized.computedStyleBytes,
      );
      instance.computedStyle = normalized.computedStyle;
      instance.computedStyleBytes = normalized.computedStyleBytes;
      if (!changed) continue;
      for (let index = instance.children.length - 1; index >= 0; index -= 1) {
        const child = instance.children[index];
        if (child !== undefined) stack.push(child);
      }
    }
  }

  private reportStyleDiagnostics(
    instance: Pick<HostInstance, "nodeId" | "type">,
    diagnostics: readonly StyleDiagnostic[],
  ): void {
    if (diagnostics.length === 0) return;
    this.#onStyleDiagnostics?.(diagnostics, {
      nodeId: instance.nodeId,
      hostType: instance.type,
    });
  }

  private recordStyleResolution(result: ResolveInteractionStylesResult): void {
    this.#styleResolutions += 1;
    this.#styleDiagnostics += result.diagnostics.length;
    this.#styleInteractionVariants += result.variants.length;
  }

  private materializeVirtualWindow(instance: HostInstance, start: number, end: number): void {
    if (instance.virtualRange?.[0] === start && instance.virtualRange[1] === end) return;
    const config = instance.virtualList;
    if (config === undefined) throw new Error("virtual list instance has no configuration");
    const children: PingoNode[] = [];
    const windowKeys = new Set<Key>();
    for (let index = start; index < end; index += 1) {
      const itemKey = config.getItemKey?.(index) ?? index;
      if (
        (typeof itemKey !== "string" && typeof itemKey !== "number") ||
        (typeof itemKey === "number" && !Number.isFinite(itemKey))
      ) {
        throw new TypeError("getItemKey must return a finite number or string");
      }
      if (windowKeys.has(itemKey)) {
        throw new Error(`getItemKey returned duplicate key ${String(itemKey)}`);
      }
      windowKeys.add(itemKey);
      if (instance.virtualKeys.get(index) !== itemKey) {
        instance.virtualItems.delete(index);
        instance.virtualWrappers.delete(index);
        instance.virtualKeys.set(index, itemKey);
      }
      let wrapper = instance.virtualWrappers.get(index);
      if (wrapper === undefined) {
        let child = instance.virtualItems.get(index);
        if (!instance.virtualItems.has(index)) {
          child = config.renderItem(index);
          instance.virtualItems.set(index, child);
        }
        const props = {
          children: child,
          [VIRTUAL_ITEM_INDEX]: index,
        } as Record<string | symbol, unknown>;
        wrapper = createElement(
          "container",
          props as unknown as Record<string, unknown>,
          `pingo:virtual:${typeof itemKey}:${String(itemKey)}`,
        );
        instance.virtualWrappers.set(index, wrapper);
      }
      children.push(wrapper);
    }
    instance.children = this.reconcileChildren(
      instance,
      instance.nodeId,
      instance.children,
      children,
    );
    for (const index of instance.virtualItems.keys()) {
      if (index < start || index >= end) {
        instance.virtualItems.delete(index);
        instance.virtualKeys.delete(index);
      }
    }
    for (const index of instance.virtualWrappers.keys()) {
      if (index < start || index >= end) instance.virtualWrappers.delete(index);
    }
    instance.virtualRange = [start, end];
  }

  private diffScalars(instance: HostInstance, next: Map<Prop, number>): void {
    for (const prop of instance.scalars.keys()) {
      if (!next.has(prop)) {
        this.mutations().push({ type: "clearProp", nodeId: instance.nodeId, prop });
      }
    }
    for (const [prop, value] of next) {
      if (!Object.is(instance.scalars.get(prop), value)) {
        this.mutations().push({ type: "setF32", nodeId: instance.nodeId, prop, value });
      }
    }
    instance.scalars = next;
  }

  private diffVectors(
    instance: HostInstance,
    next: Map<Prop, readonly [number, number, number, number]>,
  ): void {
    for (const prop of instance.vectors.keys()) {
      if (!next.has(prop)) {
        this.mutations().push({ type: "clearProp", nodeId: instance.nodeId, prop });
      }
    }
    for (const [prop, value] of next) {
      if (!equalQuad(instance.vectors.get(prop), value)) {
        this.mutations().push({ type: "setVec4", nodeId: instance.nodeId, prop, value });
      }
    }
    instance.vectors = next;
  }

  private replaceResourceProp(
    instance: HostInstance,
    binding: string,
    prop: Prop,
    kind: ResourceKind,
    bytes: Uint8Array | undefined,
  ): void {
    const previousId = instance.resources.get(binding);
    if (bytes === undefined) {
      if (previousId === undefined) return;
      this.mutations().push({ type: "clearProp", nodeId: instance.nodeId, prop });
      this.#resources.release(previousId, this.mutations());
      instance.resources.delete(binding);
      return;
    }
    const nextId = this.#resources.replace(previousId, kind, bytes, this.mutations());
    if (nextId !== previousId) {
      this.mutations().push({
        type: "setRef",
        nodeId: instance.nodeId,
        prop,
        resourceId: nextId,
      });
      instance.resources.set(binding, nextId);
    }
  }

  private replaceTextRun(
    instance: HostInstance,
    text: NonNullable<NormalizedHostProps["text"]>,
  ): void {
    const previousPaint = instance.resources.get("text:paint");
    const paintId = this.#resources.replace(
      previousPaint,
      ResourceKind.Paint,
      text.paint,
      this.mutations(),
    );
    instance.resources.set("text:paint", paintId);
    const previousStyle = instance.resources.get("text:style");
    const styleId = this.#resources.replace(
      previousStyle,
      ResourceKind.TextStyle,
      encodeTextStyle(paintId, text.fontSize, text.lineHeight, text.fontWeight, text.fontFamily, {
        fontStyle: STYLE_KEYWORD_IDS[text.fontStyle],
        textAlign: STYLE_KEYWORD_IDS[text.textAlign],
        whiteSpace: STYLE_KEYWORD_IDS[text.whiteSpace],
        overflowWrap: STYLE_KEYWORD_IDS[text.overflowWrap],
        textOverflow: STYLE_KEYWORD_IDS[text.textOverflow],
      }),
      this.mutations(),
    );
    instance.resources.set("text:style", styleId);
    const previousString = instance.resources.get("text:string");
    const stringId = this.#resources.replace(
      previousString,
      ResourceKind.Utf8String,
      encodeUtf8(text.value),
      this.mutations(),
    );
    instance.resources.set("text:string", stringId);
    if (styleId !== previousStyle || stringId !== previousString) {
      this.mutations().push({
        type: "setTextRun",
        nodeId: instance.nodeId,
        stringId,
        styleId,
      });
    }
  }

  private replaceCallback(instance: HostInstance, callback: (() => void) | undefined): void {
    const previousId = instance.onTapId;
    const previous = previousId === undefined ? undefined : this.#callbacksById.get(previousId);
    if (previous?.callback === callback) return;
    const nextId = callback === undefined ? undefined : this.acquireCallback(callback);
    if (nextId === undefined) {
      if (previousId !== undefined) {
        this.mutations().push({
          type: "clearProp",
          nodeId: instance.nodeId,
          prop: Prop.OnTap,
        });
      }
    } else {
      this.mutations().push({
        type: "setRef",
        nodeId: instance.nodeId,
        prop: Prop.OnTap,
        resourceId: nextId,
      });
    }
    if (previousId !== undefined) this.releaseCallback(previousId);
    instance.onTapId = nextId;
  }

  private updateMediaBinding(instance: HostInstance, media: NormalizedMedia | undefined): void {
    const previous = instance.media;
    const previousResourceId = instance.mediaResourceId;
    const resourceId = instance.resources.get("video-frame");
    instance.media = media;
    instance.mediaResourceId = resourceId;
    if (sameMedia(previous, media) && previousResourceId === resourceId) return;
    if (media === undefined || resourceId === undefined) {
      if (previous !== undefined) {
        this.#postCommitCleanups.push(() => this.#onMediaBinding?.(undefined, instance.nodeId));
      }
      return;
    }
    const binding: MediaBinding = Object.freeze({
      ...media.binding,
      nodeId: instance.nodeId,
      resourceId,
    });
    this.#postCommitAttachments.push(() => this.#onMediaBinding?.(binding, instance.nodeId));
  }

  private invokeEventHandler(
    instance: HostInstance,
    kind: InputEventKind,
    phase: "bubble" | "capture",
    state: PropagationState,
    errors: Error[],
  ): void {
    const handler = instance.eventHandlers.get(`${kind}:${phase}`);
    if (handler === undefined) return;
    try {
      handler(state.eventFor(instance.nodeId, phase));
    } catch (cause) {
      errors.push(toError(cause, `${kind} ${phase} event handler failed`));
    }
  }

  private updateRef(instance: HostInstance, next: Ref<NodeHandle> | undefined): void {
    if (instance.ref === next) return;
    const previous = instance.ref;
    if (previous !== undefined) {
      this.#postCommitCleanups.push(() => assignRef(previous, null));
    }
    instance.ref = next;
    if (next !== undefined) {
      const handle = this.nodeHandle(instance.nodeId);
      this.#postCommitAttachments.push(() => assignRef(next, handle));
    }
  }

  private nodeHandle(nodeId: number): ViewHandle {
    const requireMounted = (): void => {
      if (this.#hostsByNodeId.get(nodeId)?.mounted !== true) {
        throw new Error(`node handle ${String(nodeId)} is no longer mounted`);
      }
    };
    const pointer = (pointerId: number): number => {
      assertU32(pointerId, "pointerId");
      if (pointerId === 0) throw new RangeError("pointerId must be non-zero");
      return pointerId;
    };
    const coordinate = (value: number, label: string): number => {
      if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
      return value;
    };
    return Object.freeze({
      nodeId,
      setPointerCapture: (pointerId: number) => {
        requireMounted();
        this.#onInteractionRequest?.({
          type: "setPointerCapture",
          nodeId,
          pointerId: pointer(pointerId),
        });
      },
      releasePointerCapture: (pointerId: number) => {
        requireMounted();
        this.#onInteractionRequest?.({
          type: "releasePointerCapture",
          nodeId,
          pointerId: pointer(pointerId),
        });
      },
      hasPointerCapture: (pointerId: number) =>
        this.#pointerCaptures.get(pointer(pointerId)) === nodeId,
      focus: () => {
        requireMounted();
        this.#onInteractionRequest?.({ type: "focus", nodeId });
      },
      blur: () => {
        requireMounted();
        this.#onInteractionRequest?.({ type: "blur", nodeId });
      },
      scrollTo: (x: number, y: number) => {
        requireMounted();
        this.#onInteractionRequest?.({
          type: "scrollTo",
          nodeId,
          x: coordinate(x, "scroll x"),
          y: coordinate(y, "scroll y"),
        });
      },
      scrollBy: (deltaX: number, deltaY: number) => {
        requireMounted();
        this.#onInteractionRequest?.({
          type: "scrollBy",
          nodeId,
          deltaX: coordinate(deltaX, "scroll deltaX"),
          deltaY: coordinate(deltaY, "scroll deltaY"),
        });
      },
      setScrollVelocity: (velocityX: number, velocityY: number) => {
        requireMounted();
        this.#onInteractionRequest?.({
          type: "setScrollVelocity",
          nodeId,
          velocityX: coordinate(velocityX, "scroll velocityX"),
          velocityY: coordinate(velocityY, "scroll velocityY"),
        });
      },
      play: () => {
        requireMounted();
        this.#onInteractionRequest?.({ type: "mediaPlay", nodeId });
      },
      pause: () => {
        requireMounted();
        this.#onInteractionRequest?.({ type: "mediaPause", nodeId });
      },
      seek: (timeSeconds: number) => {
        requireMounted();
        this.#onInteractionRequest?.({
          type: "mediaSeek",
          nodeId,
          timeSeconds: coordinate(timeSeconds, "media seek time"),
        });
      },
    });
  }

  private disposeInstance(instance: Instance, emitHostRemove: boolean): void {
    if (!instance.mounted) return;
    instance.mounted = false;
    if (instance.kind === "component") {
      this.#dirtyComponents.delete(instance);
      for (const child of instance.children) this.disposeInstance(child, emitHostRemove);
      instance.children = [];
      this.#scopesPendingDisposal.add(instance.scope);
      return;
    }
    for (const [pointerId, owner] of this.#pointerCaptures) {
      if (owner === instance.nodeId) this.#pointerCaptures.delete(pointerId);
    }
    if (this.#focusedNodeId === instance.nodeId) this.#focusedNodeId = undefined;
    for (const child of instance.children) this.disposeInstance(child, false);
    instance.children = [];
    instance.virtualItems.clear();
    for (const resourceId of instance.resources.values()) {
      this.#resources.release(resourceId, this.mutations());
    }
    instance.resources.clear();
    if (instance.media !== undefined) {
      this.#postCommitCleanups.push(() => this.#onMediaBinding?.(undefined, instance.nodeId));
    }
    instance.eventHandlers.clear();
    if (instance.onTapId !== undefined) this.releaseCallback(instance.onTapId);
    if (instance.ref !== undefined) {
      const ref = instance.ref;
      this.#postCommitCleanups.push(() => assignRef(ref, null));
    }
    if (emitHostRemove) {
      this.mutations().push({ type: "removeNode", nodeId: instance.nodeId });
    }
    this.#hostsByNodeId.delete(instance.nodeId);
    this.#allocator.release(instance.nodeId);
  }

  private reorderHostRoots(
    coreParent: number,
    previousOrder: readonly number[],
    desiredOrder: readonly number[],
  ): void {
    const desiredSet = new Set(desiredOrder);
    const current = previousOrder.filter((nodeId) => desiredSet.has(nodeId));
    for (const nodeId of desiredOrder) {
      if (!current.includes(nodeId)) current.push(nodeId);
    }
    const currentPositions = new Map(current.map((nodeId, index) => [nodeId, index]));
    const desiredPositions = desiredOrder.map((nodeId) => {
      const position = currentPositions.get(nodeId);
      if (position === undefined) throw new Error("host order lost a desired node");
      return position;
    });
    const stationary = longestIncreasingSubsequencePositions(desiredPositions);
    let before: number = NULL_NODE_ID;
    for (let index = desiredOrder.length - 1; index >= 0; index -= 1) {
      const nodeId = desiredOrder[index];
      if (nodeId === undefined) continue;
      const currentIndex = current.indexOf(nodeId);
      if (currentIndex < 0) throw new Error("host order lost a desired node");
      if (!stationary.has(index)) {
        this.mutations().push({
          type: "reparent",
          nodeId,
          newParent: coreParent,
          beforeSibling: before,
        });
        current.splice(currentIndex, 1);
        const beforeIndex = before === NULL_NODE_ID ? current.length : current.indexOf(before);
        current.splice(beforeIndex, 0, nodeId);
      }
      before = nodeId;
    }
  }

  private enqueueComponent(instance: ComponentInstance): void {
    if (!instance.mounted || this.#failed || this.#unmounted) return;
    this.#dirtyComponents.add(instance);
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(() => {
      if (!this.#scheduled || this.#failed || this.#unmounted) return;
      this.#scheduled = false;
      this.flushSync();
    });
  }

  private flushDirtyComponents(): void {
    const dirty = [...this.#dirtyComponents]
      .filter((instance) => instance.mounted)
      .sort((left, right) => instanceDepth(left) - instanceDepth(right));
    this.#dirtyComponents.clear();
    const processed = new Set<ComponentInstance>();
    for (const instance of dirty) {
      if (!instance.mounted || hasProcessedAncestor(instance, processed)) continue;
      const coreParent = nearestCoreParent(instance.parent, this.#rootNodeId);
      this.renderComponent(instance, coreParent);
      processed.add(instance);
    }
  }

  private acquireCallback(callback: () => void): number {
    const existing = this.#callbacksByFunction.get(callback);
    if (existing !== undefined) {
      existing.references += 1;
      return existing.id;
    }
    if (this.#nextCallbackId > 0xffff_ffff) throw new RangeError("callback id space exhausted");
    const entry: CallbackEntry = {
      id: this.#nextCallbackId,
      callback,
      references: 1,
    };
    this.#nextCallbackId += 1;
    this.#callbacksByFunction.set(callback, entry);
    this.#callbacksById.set(entry.id, entry);
    return entry.id;
  }

  private releaseCallback(id: number): void {
    const entry = this.#callbacksById.get(id);
    if (entry === undefined || entry.references <= 0) {
      throw new Error(`callback ${String(id)} has an invalid reference count`);
    }
    entry.references -= 1;
    if (entry.references !== 0) return;
    this.#callbacksById.delete(id);
    this.#callbacksByFunction.delete(entry.callback);
  }

  readonly #layoutGeometryAccess: LayoutGeometryAccess = {
    observe: (nodeId, notify) => {
      let subscribers = this.#geometrySubscribers.get(nodeId);
      if (subscribers === undefined) {
        subscribers = new Set();
        this.#geometrySubscribers.set(nodeId, subscribers);
        this.claimObservationSlot(nodeId);
      }
      subscribers.add(notify);
      return () => {
        const current = this.#geometrySubscribers.get(nodeId);
        if (current === undefined) return;
        current.delete(notify);
        if (current.size > 0) return;
        this.#geometrySubscribers.delete(nodeId);
        this.#layoutGeometry.delete(nodeId);
        this.releaseObservationSlot(nodeId);
      };
    },
    read: (nodeId) => this.#layoutGeometry.get(nodeId),
    viewport: () => this.#viewport,
    observeViewport: (notify) => {
      this.#viewportSubscribers.add(notify);
      return () => {
        this.#viewportSubscribers.delete(notify);
      };
    },
  };

  /** Takes a slot when one is free, otherwise queues for the next release. */
  private claimObservationSlot(nodeId: number): void {
    if (this.#observedNodes.size === 0) this.#onLayoutObservationChange?.(true);
    if (this.#observedNodes.size < MAX_OBSERVED_GEOMETRY_NODES) {
      this.#observedNodes.add(nodeId);
      this.observeGeometry(nodeId, true);
      return;
    }
    this.#deferredObservations.push(nodeId);
    this.#layoutObservationDeferrals += 1;
  }

  private releaseObservationSlot(nodeId: number): void {
    const deferred = this.#deferredObservations.indexOf(nodeId);
    if (deferred >= 0) {
      // Never took a slot, so nothing to withdraw.
      this.#deferredObservations.splice(deferred, 1);
      return;
    }
    if (!this.#observedNodes.delete(nodeId)) return;
    // Withdraw only if the node still exists; Core prunes observations whose
    // node no longer resolves, and a stale id would be rejected.
    if (this.#hostsByNodeId.get(nodeId)?.mounted === true) {
      this.observeGeometry(nodeId, false);
    } else {
      this.#pendingObservations.delete(nodeId);
    }
    // Promote the oldest waiter that still has someone watching it.
    while (this.#deferredObservations.length > 0) {
      const next = this.#deferredObservations.shift();
      if (next === undefined) break;
      if (this.#geometrySubscribers.get(next) === undefined) continue;
      this.#observedNodes.add(next);
      this.observeGeometry(next, true);
      break;
    }
    if (this.#observedNodes.size === 0) this.#onLayoutObservationChange?.(false);
  }

  /**
   * Observations that had to wait for a slot, cumulative.
   *
   * Non-zero means some component asked to be measured and is temporarily
   * reporting `undefined`. Safe, but not something to discover by accident.
   */
  public layoutObservationDeferrals(): number {
    return this.#layoutObservationDeferrals;
  }

  /**
   * Applies one Core geometry frame and wakes the components watching it.
   *
   * Only subscribed nodes are stored: a record for something nobody watches is
   * a leak waiting to happen, and Core should not have been reporting it.
   */
  public applyLayoutGeometry(
    records: readonly LayoutGeometryReport[],
    viewport?: LayoutRect,
  ): void {
    if (this.#failed || this.#unmounted) return;
    if (viewport !== undefined && !equalRect(this.#viewport ?? EMPTY_RECT, viewport)) {
      this.#viewport = viewport;
      for (const notify of this.#viewportSubscribers) notify();
    }
    const woken = new Set<() => void>();
    const reported = new Set<number>();
    for (const record of records) {
      reported.add(record.nodeId);
      const subscribers = this.#geometrySubscribers.get(record.nodeId);
      if (subscribers === undefined) continue;
      const previous = this.#layoutGeometry.get(record.nodeId);
      this.#layoutGeometry.set(record.nodeId, { bounds: record.bounds, clip: record.clip });
      if (equalGeometry(previous, record)) continue;
      for (const notify of subscribers) woken.add(notify);
    }
    // A node that stopped being reported must not keep serving its last value.
    for (const [nodeId, subscribers] of this.#geometrySubscribers) {
      if (reported.has(nodeId) || !this.#layoutGeometry.delete(nodeId)) continue;
      for (const notify of subscribers) woken.add(notify);
    }
    for (const notify of woken) notify();
  }

  /**
   * Requests or withdraws Core geometry reporting for one mounted node.
   *
   * The command rides the next commit rather than a batch of its own, so it is
   * applied in the same transaction as whatever else changed this frame.
   */
  public observeGeometry(nodeId: number, enabled: boolean): void {
    this.assertUsable();
    this.#pendingObservations.set(nodeId, enabled);
    // Scheduled even while committing. Effects run inside the commit, and this
    // frame's observations were already drained, so a change made now belongs
    // to the next one — dropping the schedule would strand it until some
    // unrelated render happened to come along, or forever if none did.
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(() => {
      if (!this.#scheduled || this.#failed || this.#unmounted) return;
      this.#scheduled = false;
      this.flushSync();
    });
  }

  private drainPendingObservations(): void {
    if (this.#pendingObservations.size === 0) return;
    for (const [nodeId, enabled] of this.#pendingObservations) {
      // An unmounted node's observation is dropped rather than sent: Core would
      // reject the stale id, and withdrawal is implied by removal anyway.
      if (this.#hostsByNodeId.get(nodeId)?.mounted !== true) continue;
      this.mutations().push({
        type: "observeGeometry",
        nodeId,
        flags: enabled ? OBSERVE_GEOMETRY_FLAG_ACTIVE : 0,
      });
    }
    this.#pendingObservations.clear();
  }

  private mutations(): Mutation[] {
    if (this.#mutations === undefined) throw new Error("mutation emitted outside a commit");
    return this.#mutations;
  }

  private assertUsable(): void {
    if (this.#failed)
      throw new Error("reconciler root requires remount after a fatal commit error");
    if (this.#unmounted) throw new Error("reconciler root is unmounted");
  }
}

function normalizeHostProps(
  type: HostType,
  props: Readonly<Record<string, unknown>>,
  styleContext: StyleResolutionContext,
): NormalizedHostProps {
  const propertyBag = props as Readonly<Record<PropertyKey, unknown>>;
  if (propertyBag[FOUNDATION_COMPONENT] === true && !styleContext.foundationComponentsEnabled) {
    throw new Error("M6 foundation components are disabled for this root");
  }
  assertAllowedProps(type, props);
  const common = props as CommonProps;
  const scalars = new Map<Prop, number>();
  addOptionalDimension(scalars, Prop.Width, common.width, "width");
  addOptionalDimension(scalars, Prop.Height, common.height, "height");
  addOptionalDimension(scalars, Prop.MinWidth, common.minWidth, "minWidth");
  addOptionalDimension(scalars, Prop.MinHeight, common.minHeight, "minHeight");
  addOptionalDimension(scalars, Prop.MaxWidth, common.maxWidth, "maxWidth");
  addOptionalDimension(scalars, Prop.MaxHeight, common.maxHeight, "maxHeight");
  if (common.opacity !== undefined) {
    if (!Number.isFinite(common.opacity) || common.opacity < 0 || common.opacity > 1) {
      throw new RangeError("opacity must be finite and between zero and one");
    }
    scalars.set(Prop.Opacity, common.opacity);
  }
  if (common.direction !== undefined) {
    if (common.direction !== "column" && common.direction !== "row") {
      throw new TypeError(`unsupported direction ${String(common.direction)}`);
    }
    // The Mutation Stream has no integer prop value type, so the flow axis
    // travels as the exact f32 the layout engine compares against.
    if (common.direction === "row") scalars.set(Prop.Direction, 1);
  }
  if (common.gap !== undefined) {
    if (!Number.isFinite(common.gap) || common.gap < 0) {
      throw new RangeError("gap must be finite and non-negative");
    }
    scalars.set(Prop.Gap, common.gap);
  }
  const vectors = new Map<Prop, readonly [number, number, number, number]>();
  if (common.padding !== undefined) vectors.set(Prop.Padding, normalizePadding(common.padding));
  const semantics = new Map<Prop, string>();
  addOptionalString(semantics, Prop.SemanticRole, common.semanticRole, "semanticRole");
  addOptionalString(semantics, Prop.SemanticLabel, common.semanticLabel, "semanticLabel");
  addOptionalString(semantics, Prop.SemanticValue, common.semanticValue, "semanticValue");
  const ref = normalizeRef(common.ref);
  const onTap = normalizeCallback(common.onTap, "onTap");
  const eventHandlers = normalizeEventHandlers(props);

  let text: NormalizedHostProps["text"];
  if (type === "text" || type === "editableText") {
    const value =
      type === "editableText"
        ? (props as unknown as EditableTextProps).controller === undefined
          ? requireString(props.value, "EditableText value")
          : requireString(
              (props as unknown as EditableTextProps).controller?.value,
              "EditableText controller value",
            )
        : props.value === undefined
          ? primitiveText(props.children)
          : requireString(props.value, "Text value");
    const fontSize = optionalPositive(props.fontSize, 16, "fontSize");
    const lineHeight = optionalPositive(props.lineHeight, fontSize * 1.2, "lineHeight");
    const fontWeight = optionalWeight(props.fontWeight);
    const font = props.font;
    if (font !== undefined && !(font instanceof PingoFont)) {
      throw new TypeError("font must be created by createFont");
    }
    const fontFamily =
      props.fontFamily === undefined
        ? (font?.fallbackFamily ?? "sans-serif")
        : requireNonEmptyString(props.fontFamily, "fontFamily");
    const color = (props.color ?? "#000000") as Color;
    scalars.set(Prop.FontSize, fontSize);
    text = {
      value,
      paint: encodeSolidPaint(color),
      font: font === undefined ? undefined : encodeSfntFont(font),
      fontFamily,
      fontSize,
      lineHeight,
      fontWeight,
      fontStyle: "normal",
      textAlign: "start",
      // The published direct-prop path preserved hard breaks and split long
      // tokens. Keep that behavior unless CSS resolution explicitly supplies
      // its `normal` initial values.
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      textOverflow: "clip",
    };
  }

  let image: Uint8Array | undefined;
  if (type === "image") {
    const source = (props as unknown as ImageProps).source;
    if (!(source instanceof PingoImage)) {
      throw new TypeError("image source must be created by createImage");
    }
    image = encodeImageBitmap(source);
    if (source.label !== "" && !semantics.has(Prop.SemanticLabel)) {
      semantics.set(Prop.SemanticLabel, source.label);
    }
  }

  let media: NormalizedMedia | undefined;
  if (type === "video") {
    if (!styleContext.videoEnabled) throw new Error("M8 Video is disabled for this root");
    const video = props as unknown as VideoProps;
    const src = requireNonEmptyString(video.src, "Video src");
    if (video.poster !== undefined && !(video.poster instanceof PingoImage)) {
      throw new TypeError("video poster must be created by createImage");
    }
    if (
      video.crossOrigin !== undefined &&
      video.crossOrigin !== "anonymous" &&
      video.crossOrigin !== "use-credentials"
    ) {
      throw new TypeError("video crossOrigin must be anonymous or use-credentials");
    }
    if (
      video.preload !== undefined &&
      video.preload !== "auto" &&
      video.preload !== "metadata" &&
      video.preload !== "none"
    ) {
      throw new TypeError("video preload must be auto, metadata, or none");
    }
    const width = video.poster?.width ?? Math.max(1, Math.round(common.width ?? 1));
    const height = video.poster?.height ?? Math.max(1, Math.round(common.height ?? 1));
    media = {
      width,
      height,
      poster: video.poster,
      binding: {
        src,
        autoPlay: video.autoPlay === true,
        loop: video.loop === true,
        muted: video.muted === true,
        ...(video.crossOrigin === undefined ? {} : { crossOrigin: video.crossOrigin }),
        preload: video.preload ?? "metadata",
      },
      onPlay: normalizeMediaCallback(video.onPlay, "onPlay"),
      onPause: normalizeMediaCallback(video.onPause, "onPause"),
      onEnded: normalizeMediaCallback(video.onEnded, "onEnded"),
      onLoadedMetadata: normalizeMediaCallback(video.onLoadedMetadata, "onLoadedMetadata"),
      onTimeUpdate: normalizeMediaCallback(video.onTimeUpdate, "onTimeUpdate"),
      onError: normalizeMediaErrorCallback(video.onError),
    };
  }

  let scrollPosition: readonly [number, number] | undefined;
  if (
    type === "scroll" ||
    type === "virtualList" ||
    (type === "container" &&
      (props.virtual !== undefined || props.scrollX !== undefined || props.scrollY !== undefined))
  ) {
    const x = optionalFinite(props.scrollX, 0, "scrollX");
    const y = optionalFinite(props.scrollY, 0, "scrollY");
    scrollPosition = [x, y];
  }

  let editable: NormalizedEditable | undefined;
  if (type === "editableText") {
    const editableProps = props as unknown as EditableTextProps;
    const controller = editableProps.controller;
    if (
      controller !== undefined &&
      (editableProps.value !== undefined || editableProps.revision !== undefined)
    ) {
      throw new TypeError("EditableText controller is mutually exclusive with value and revision");
    }
    const onTransaction = normalizeEditCallback(editableProps.onTransaction);
    editable = {
      revision: controller?.revision ?? optionalRevision(editableProps.revision),
      flags:
        (editableProps.multiline === true ? 1 : 0) |
        (editableProps.readOnly === true ? 2 : 0) |
        (editableProps.password === true ? 4 : 0),
      maxGraphemes: requireBoundedInteger(
        editableProps.maxGraphemes ?? 1_000_000,
        0,
        1_000_000,
        "maxGraphemes",
      ),
      inputMode: requireInputMode(editableProps.inputMode),
      value:
        controller === undefined
          ? requireString(editableProps.value, "EditableText value")
          : requireString(controller.value, "EditableText controller value"),
      onTransaction:
        controller === undefined
          ? onTransaction
          : (transaction) => {
              controller.applyTransaction(transaction);
              onTransaction?.(transaction);
            },
      onSubmit: normalizeCallback(editableProps.onSubmit, "onSubmit"),
    };
  }

  let virtualList: NormalizedVirtualList | undefined;
  if (type === "virtualList" || (type === "container" && props.virtual !== undefined)) {
    let itemCountValue: unknown;
    let estimatedItemSizeValue: unknown;
    let renderItemValue: unknown;
    let getItemKey: ((index: number) => Key) | undefined;
    let axis: "x" | "y" = "y";
    let baseOverscanViewports: unknown;
    let velocityHorizonSeconds: unknown;
    let maximumAheadViewports: unknown;
    if (type === "virtualList") {
      const virtualProps = props as unknown as VirtualListProps;
      itemCountValue = virtualProps.itemCount;
      estimatedItemSizeValue = virtualProps.estimatedItemHeight;
      renderItemValue = virtualProps.renderItem;
      baseOverscanViewports = virtualProps.baseOverscanViewports;
      velocityHorizonSeconds = virtualProps.velocityHorizonSeconds;
      maximumAheadViewports = virtualProps.maximumAheadViewports;
    } else {
      if (props.children !== undefined || !isPlainRecord(props.virtual)) {
        throw new TypeError(
          "View virtual is a declaration object mutually exclusive with children",
        );
      }
      const virtualProps = props.virtual as unknown as VirtualViewProps;
      if (
        virtualProps.axis !== undefined &&
        virtualProps.axis !== "x" &&
        virtualProps.axis !== "y"
      ) {
        throw new TypeError("View virtual axis must be x or y");
      }
      axis = virtualProps.axis ?? "y";
      itemCountValue = virtualProps.itemCount;
      estimatedItemSizeValue = virtualProps.estimatedItemSize;
      renderItemValue = virtualProps.renderItem;
      baseOverscanViewports = virtualProps.baseOverscanViewports;
      velocityHorizonSeconds = virtualProps.velocityHorizonSeconds;
      maximumAheadViewports = virtualProps.maximumAheadViewports;
      if (virtualProps.getItemKey !== undefined && typeof virtualProps.getItemKey !== "function") {
        throw new TypeError("getItemKey must be a function");
      }
      getItemKey = virtualProps.getItemKey;
    }
    const itemCount = requireBoundedInteger(itemCountValue, 0, MAX_VIRTUAL_ITEMS, "itemCount");
    const estimatedItemSize = requireBoundedFinite(
      estimatedItemSizeValue,
      Number.EPSILON,
      1_000_000_000,
      "estimatedItemSize",
    );
    if (typeof renderItemValue !== "function") {
      throw new TypeError("renderItem must be a function");
    }
    const renderItem = renderItemValue as (index: number) => PingoNode;
    virtualList = {
      axis,
      itemCount,
      estimatedItemSize,
      baseOverscanViewports: optionalBoundedFinite(
        baseOverscanViewports,
        1,
        0,
        64,
        "baseOverscanViewports",
      ),
      velocityHorizonSeconds: optionalBoundedFinite(
        velocityHorizonSeconds,
        0.25,
        0,
        10,
        "velocityHorizonSeconds",
      ),
      maximumAheadViewports: optionalBoundedFinite(
        maximumAheadViewports,
        4,
        0,
        64,
        "maximumAheadViewports",
      ),
      renderItem,
      getItemKey,
    };
  }

  let virtualItemIndex: number | undefined;
  const rawVirtualItemIndex = propertyBag[VIRTUAL_ITEM_INDEX];
  if (rawVirtualItemIndex !== undefined) {
    if (type !== "container") {
      throw new TypeError("virtual item identity is only valid on container nodes");
    }
    virtualItemIndex = requireBoundedInteger(
      rawVirtualItemIndex,
      0,
      MAX_VIRTUAL_ITEMS - 1,
      "virtual item index",
    );
  }
  const styleResolution = resolveHostStyle(type, props, common, editable, styleContext);
  if (text !== undefined && styleResolution !== undefined) {
    text = applyComputedTextStyle(text, styleResolution.style);
    scalars.set(Prop.FontSize, text.fontSize);
  }
  if (virtualList !== undefined && type === "container") {
    const overflow =
      virtualList.axis === "x"
        ? styleResolution?.style.overflowX
        : styleResolution?.style.overflowY;
    if (overflow !== "auto" && overflow !== "hidden" && overflow !== "scroll") {
      throw new TypeError(
        `View virtual requires computed overflow${virtualList.axis.toUpperCase()} to be auto, hidden, or scroll`,
      );
    }
  }
  return {
    children: allowsHostChildren(type) ? (props.children as PingoNode) : undefined,
    ref,
    scalars,
    vectors,
    background:
      common.backgroundColor === undefined ? undefined : encodeSolidPaint(common.backgroundColor),
    transform: common.transform === undefined ? undefined : encodeAffine(common.transform),
    semantics,
    onTap,
    text,
    image,
    media,
    scrollPosition,
    virtualItemIndex,
    virtualList,
    editable,
    eventHandlers,
    computedStyle: styleResolution?.style,
    computedStyleBytes:
      styleResolution === undefined ? undefined : encodeComputedStyleResource(styleResolution),
    animationBytes: styleContext.coreAnimationEnabled
      ? encodeAnimationResource(common.transition, common.animation)
      : undefined,
    styleDiagnostics: styleResolution?.diagnostics ?? [],
  };
}

function applyComputedTextStyle(
  text: NonNullable<NormalizedHostProps["text"]>,
  style: ComputedStyle,
): NonNullable<NormalizedHostProps["text"]> {
  const fontSize = computedPx(style.fontSize, text.fontSize, "fontSize");
  const lineHeight =
    style.lineHeight === "normal"
      ? fontSize * 1.2
      : typeof style.lineHeight === "number"
        ? fontSize * style.lineHeight
        : computedPx(style.lineHeight, text.lineHeight, "lineHeight");
  const fontWeight =
    typeof style.fontWeight === "number" ? optionalWeight(style.fontWeight) : text.fontWeight;
  const fontFamily =
    typeof style.fontFamily === "string" && style.fontFamily.trim() !== ""
      ? style.fontFamily
      : text.fontFamily;
  const color = typeof style.color === "string" ? (style.color as Color) : undefined;
  return {
    ...text,
    paint: color === undefined ? text.paint : encodeSolidPaint(color),
    fontFamily,
    fontSize,
    lineHeight,
    fontWeight,
    fontStyle: style.fontStyle as NonNullable<typeof text.fontStyle>,
    textAlign: style.textAlign as NonNullable<typeof text.textAlign>,
    whiteSpace: style.whiteSpace as NonNullable<typeof text.whiteSpace>,
    overflowWrap: style.overflowWrap as NonNullable<typeof text.overflowWrap>,
    textOverflow: style.textOverflow as NonNullable<typeof text.textOverflow>,
  };
}

function computedPx(value: unknown, fallback: number, property: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.endsWith("px")) {
    throw new TypeError(`${property} must resolve to logical pixels`);
  }
  return optionalPositive(Number(value.slice(0, -2)), fallback, property);
}

function resolveHostStyle(
  type: HostType,
  props: Readonly<Record<string, unknown>>,
  common: CommonProps,
  editable: NormalizedEditable | undefined,
  context: StyleResolutionContext,
): ResolveInteractionStylesResult | undefined {
  if (!context.enabled) return;
  const className = common.className;
  if (className !== undefined && typeof className !== "string") {
    throw new TypeError("className must be a string");
  }
  const inlineStyle = common.style;
  if (inlineStyle !== undefined && !isPlainRecord(inlineStyle)) {
    throw new TypeError("style must be a plain declaration object");
  }
  const hasStyleInput =
    inlineStyle !== undefined ||
    (className !== undefined && className.trim() !== "") ||
    context.styleSheets.length > 0 ||
    context.parentStyle !== undefined;
  if (!hasStyleInput) return;

  const resolved = resolveInteractionStyles({
    nodeType: styleNodeType(type, editable),
    styleSheets: context.styleSheets,
    legacyStyle: legacyStyleForHost(type, props, common),
    ...(className === undefined ? {} : { className }),
    ...(inlineStyle === undefined ? {} : { inlineStyle }),
    ...(context.parentStyle === undefined ? {} : { parentStyle: context.parentStyle }),
  });
  const result = context.interactionStylesEnabled
    ? resolved
    : Object.freeze({
        style: resolved.style,
        diagnostics: resolved.diagnostics,
        variants: Object.freeze([]),
      });
  context.recordResolution(result);
  return result;
}

function styleNodeType(
  type: HostType,
  editable: NormalizedEditable | undefined,
): PingoStyleNodeType {
  switch (type) {
    case "container":
    case "scroll":
    case "virtualList":
      return "view";
    case "text":
      return "text";
    case "image":
      return "image";
    case "video":
      return "video";
    case "editableText":
      return editable !== undefined && (editable.flags & 1) !== 0 ? "textArea" : "input";
  }
}

function legacyStyleForHost(
  type: HostType,
  props: Readonly<Record<string, unknown>>,
  common: CommonProps,
): Readonly<Partial<Record<StylePropertyName, unknown>>> {
  const legacy: Partial<Record<StylePropertyName, unknown>> = {};
  assignDefined(legacy, "width", common.width);
  assignDefined(legacy, "height", common.height);
  assignDefined(legacy, "minWidth", common.minWidth);
  assignDefined(legacy, "minHeight", common.minHeight);
  assignDefined(legacy, "maxWidth", common.maxWidth);
  assignDefined(legacy, "maxHeight", common.maxHeight);
  if (common.padding !== undefined) {
    const [top, right, bottom, left] = normalizePadding(common.padding);
    legacy.paddingTop = top;
    legacy.paddingRight = right;
    legacy.paddingBottom = bottom;
    legacy.paddingLeft = left;
  }
  if (common.direction !== undefined) legacy.flexDirection = common.direction;
  assignDefined(legacy, "rowGap", common.gap);
  assignDefined(legacy, "columnGap", common.gap);
  assignDefined(legacy, "backgroundColor", common.backgroundColor);
  assignDefined(legacy, "opacity", common.opacity);
  if (type === "text" || type === "editableText") {
    assignDefined(legacy, "color", props.color);
    assignDefined(legacy, "fontFamily", props.fontFamily);
    assignDefined(legacy, "fontSize", props.fontSize);
    assignDefined(legacy, "fontWeight", props.fontWeight);
    assignDefined(legacy, "lineHeight", props.lineHeight);
  }
  return legacy;
}

function assignDefined(
  target: Partial<Record<StylePropertyName, unknown>>,
  property: StylePropertyName,
  value: unknown,
): void {
  if (value !== undefined) target[property] = value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hostNodeKind(type: HostType): NodeKind {
  switch (type) {
    case "container":
      return NodeKind.Container;
    case "text":
      return NodeKind.Text;
    case "editableText":
      return NodeKind.EditableText;
    case "image":
      return NodeKind.Image;
    case "video":
      return NodeKind.Video;
    case "scroll":
    case "virtualList":
      return NodeKind.Scroll;
    default:
      throw new TypeError(`unsupported host type ${String(type)}`);
  }
}

function compatible(instance: Instance, descriptor: ChildDescriptor): boolean {
  if (typeof descriptor === "string") return instance.kind === "host" && instance.type === "text";
  if (typeof descriptor.type === "string") {
    return instance.kind === "host" && instance.type === descriptor.type;
  }
  return instance.kind === "component" && instance.type === descriptor.type;
}

function descriptorKey(descriptor: ChildDescriptor): Key | null {
  return typeof descriptor === "string" ? null : descriptor.key;
}

function flattenHostRoots(instances: readonly Instance[]): number[] {
  const result: number[] = [];
  const stack = [...instances].reverse();
  while (stack.length > 0) {
    const instance = stack.pop();
    if (instance === undefined || !instance.mounted) continue;
    if (instance.kind === "host") result.push(instance.nodeId);
    else {
      for (let index = instance.children.length - 1; index >= 0; index -= 1) {
        const child = instance.children[index];
        if (child !== undefined) stack.push(child);
      }
    }
  }
  return result;
}

/** Returns input indices forming one deterministic longest increasing subsequence. */
function longestIncreasingSubsequencePositions(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const predecessors = new Array<number>(values.length).fill(-1);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const tailIndex = tails[middle];
      const tailValue = tailIndex === undefined ? undefined : values[tailIndex];
      if (tailValue !== undefined && tailValue < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) predecessors[index] = tails[low - 1] ?? -1;
    tails[low] = index;
  }
  const positions = new Set<number>();
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    positions.add(cursor);
    cursor = predecessors[cursor] ?? -1;
  }
  return positions;
}

function assertUniqueKeys(descriptors: readonly ChildDescriptor[]): void {
  const keys = new Set<Key>();
  for (const descriptor of descriptors) {
    const key = descriptorKey(descriptor);
    if (key === null) continue;
    if (keys.has(key)) throw new Error(`duplicate child key ${String(key)}`);
    keys.add(key);
  }
}

function allowsHostChildren(type: HostType): boolean {
  return type === "container" || type === "scroll";
}

function addOptionalDimension(
  values: Map<Prop, number>,
  prop: Prop,
  value: number | undefined,
  label: string,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
  values.set(prop, value);
}

function normalizePadding(
  value: number | readonly [number, number, number, number],
): readonly [number, number, number, number] {
  const result = typeof value === "number" ? [value, value, value, value] : value;
  if (result.length !== 4 || result.some((edge) => !Number.isFinite(edge) || edge < 0)) {
    throw new RangeError("padding must contain four finite non-negative edges");
  }
  return [result[0], result[1], result[2], result[3]];
}

function addOptionalString(
  values: Map<Prop, string>,
  prop: Prop,
  value: string | undefined,
  label: string,
): void {
  if (value !== undefined) values.set(prop, requireString(value, label));
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (result.length === 0) throw new RangeError(`${label} must not be empty`);
  return result;
}

function primitiveText(value: unknown): string {
  if (value === undefined || value === null || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  throw new TypeError("Text children must be one string or number");
}

function optionalPositive(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
}

function optionalRevision(value: unknown): bigint {
  if (value === undefined) return 0n;
  if (typeof value === "bigint") {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw new RangeError("revision must be a u64");
    }
    return value;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("revision must be a non-negative safe integer or bigint");
  }
  return BigInt(value);
}

function optionalFinite(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
  return value;
}

function optionalWeight(value: unknown): number {
  if (value === undefined) return 400;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new RangeError("fontWeight must be an integer from 1 through 1000");
  }
  return value;
}

function normalizeCallback(value: unknown, label: string): (() => void) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
  return value as () => void;
}

function normalizeEventHandlers(
  props: Readonly<Record<string, unknown>>,
): Map<EventHandlerKey, PingoEventHandler> {
  const bindings = [
    ["pointerdown:capture", "onPointerDownCapture"],
    ["pointerdown:bubble", "onPointerDown"],
    ["pointerup:capture", "onPointerUpCapture"],
    ["pointerup:bubble", "onPointerUp"],
    ["pointermove:capture", "onPointerMoveCapture"],
    ["pointermove:bubble", "onPointerMove"],
    ["pointercancel:capture", "onPointerCancelCapture"],
    ["pointercancel:bubble", "onPointerCancel"],
    ["pointerover:capture", "onPointerOverCapture"],
    ["pointerover:bubble", "onPointerOver"],
    ["pointerout:capture", "onPointerOutCapture"],
    ["pointerout:bubble", "onPointerOut"],
    ["pointerenter:capture", "onPointerEnterCapture"],
    ["pointerenter:bubble", "onPointerEnter"],
    ["pointerleave:capture", "onPointerLeaveCapture"],
    ["pointerleave:bubble", "onPointerLeave"],
    ["gotpointercapture:capture", "onGotPointerCaptureCapture"],
    ["gotpointercapture:bubble", "onGotPointerCapture"],
    ["lostpointercapture:capture", "onLostPointerCaptureCapture"],
    ["lostpointercapture:bubble", "onLostPointerCapture"],
    ["focus:capture", "onFocusCapture"],
    ["focus:bubble", "onFocus"],
    ["blur:capture", "onBlurCapture"],
    ["blur:bubble", "onBlur"],
    ["focusin:capture", "onFocusInCapture"],
    ["focusin:bubble", "onFocusIn"],
    ["focusout:capture", "onFocusOutCapture"],
    ["focusout:bubble", "onFocusOut"],
    ["click:capture", "onClickCapture"],
    ["click:bubble", "onClick"],
    ["wheel:capture", "onWheelCapture"],
    ["wheel:bubble", "onWheel"],
    ["keydown:capture", "onKeyDownCapture"],
    ["keydown:bubble", "onKeyDown"],
    ["keyup:capture", "onKeyUpCapture"],
    ["keyup:bubble", "onKeyUp"],
    ["contextmenu:capture", "onContextMenuCapture"],
    ["contextmenu:bubble", "onContextMenu"],
  ] as const satisfies readonly (readonly [EventHandlerKey, string])[];
  const result = new Map<EventHandlerKey, PingoEventHandler>();
  for (const [key, property] of bindings) {
    const value = props[property];
    if (value === undefined) continue;
    if (typeof value !== "function") throw new TypeError(`${property} must be a function`);
    result.set(key, value as PingoEventHandler);
  }
  return result;
}

class PropagationState {
  public defaultPrevented = false;
  public propagationStopped = false;
  public immediatePropagationStopped = false;
  readonly #transaction: EventTransaction;
  readonly #handle: (nodeId: number) => NodeHandle;

  public constructor(transaction: EventTransaction, handle: (nodeId: number) => NodeHandle) {
    this.#transaction = transaction;
    this.#handle = handle;
  }

  public eventFor(nodeId: number, phase: "bubble" | "capture"): PingoEvent {
    const transaction = this.#transaction;
    const isDefaultPrevented = (): boolean => this.defaultPrevented;
    const target = this.#handle(transaction.target);
    const currentTarget = this.#handle(nodeId);
    const relatedTarget =
      transaction.relatedTarget === null ? null : this.#handle(transaction.relatedTarget);
    return Object.freeze({
      type: transaction.kind,
      eventId: transaction.eventId,
      target,
      currentTarget,
      relatedTarget,
      eventPhase: nodeId === transaction.target ? 2 : phase === "capture" ? 1 : 3,
      x: transaction.x,
      y: transaction.y,
      deltaX: transaction.deltaX,
      deltaY: transaction.deltaY,
      buttons: transaction.buttons,
      pointerId: transaction.pointerId,
      pointerType: transaction.pointerType,
      isPrimary: transaction.isPrimary,
      pressure: transaction.pressure,
      tiltX: transaction.tiltX,
      tiltY: transaction.tiltY,
      width: transaction.width,
      height: transaction.height,
      elapsedMicros: transaction.elapsedMicros,
      key: transaction.key,
      code: transaction.code,
      repeat: transaction.repeat,
      shiftKey: (transaction.modifiers & 1) !== 0,
      ctrlKey: (transaction.modifiers & 2) !== 0,
      altKey: (transaction.modifiers & 4) !== 0,
      metaKey: (transaction.modifiers & 8) !== 0,
      get defaultPrevented() {
        return isDefaultPrevented();
      },
      preventDefault: () => {
        this.defaultPrevented = true;
      },
      stopPropagation: () => {
        this.propagationStopped = true;
      },
      stopImmediatePropagation: () => {
        this.immediatePropagationStopped = true;
        this.propagationStopped = true;
      },
    });
  }
}

function eventBubbles(kind: InputEventKind): boolean {
  return kind !== "pointerenter" && kind !== "pointerleave" && kind !== "focus" && kind !== "blur";
}

function validateEventTransaction(transaction: EventTransaction): void {
  if (transaction === null || typeof transaction !== "object") {
    throw new TypeError("event transaction must be an object");
  }
  assertU32(transaction.eventId, "event transaction eventId");
  assertU32(transaction.target, "event transaction target");
  if (!Array.isArray(transaction.path) || transaction.path.length === 0) {
    throw new TypeError("event transaction path must be a non-empty array");
  }
  const seen = new Set<number>();
  for (const nodeId of transaction.path) {
    assertU32(nodeId, "event transaction path nodeId");
    if (seen.has(nodeId)) throw new Error("event transaction path contains a cycle");
    seen.add(nodeId);
  }
  if (transaction.path.at(-1) !== transaction.target) {
    throw new Error("event transaction path does not end at target");
  }
}

function normalizeEditCallback(
  value: unknown,
): ((transaction: EditTransaction) => void) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") throw new TypeError("onTransaction must be a function");
  return value as (transaction: EditTransaction) => void;
}

/** One node's geometry as delivered by the Host channel. */
export interface LayoutGeometryReport {
  readonly nodeId: number;
  readonly bounds: LayoutRect;
  readonly clip: LayoutRect;
}

function equalGeometry(previous: LayoutGeometry | undefined, next: LayoutGeometryReport): boolean {
  return (
    previous !== undefined &&
    equalRect(previous.bounds, next.bounds) &&
    equalRect(previous.clip, next.clip)
  );
}

const EMPTY_RECT: LayoutRect = { left: 0, top: 0, width: 0, height: 0 };

function equalRect(left: LayoutRect, right: LayoutRect): boolean {
  // Object.is, not ===: an unclipped node reports infinities, and -0 versus 0
  // would otherwise read as a change every frame.
  return (
    Object.is(left.left, right.left) &&
    Object.is(left.top, right.top) &&
    Object.is(left.width, right.width) &&
    Object.is(left.height, right.height)
  );
}

function normalizeRef(value: unknown): Ref<NodeHandle> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "function") return value as (handle: NodeHandle | null) => void;
  if (typeof value === "object" && value !== null && "current" in value) {
    return value as { current: NodeHandle | null };
  }
  throw new TypeError("ref must be a callback or an object with current");
}

function assertAllowedProps(type: HostType, props: Readonly<Record<string, unknown>>): void {
  const allowed =
    type === "text"
      ? TEXT_KEYS
      : type === "editableText"
        ? EDITABLE_KEYS
        : type === "virtualList"
          ? VIRTUAL_LIST_KEYS
          : type === "scroll"
            ? SCROLL_KEYS
            : type === "image"
              ? IMAGE_KEYS
              : type === "video"
                ? VIDEO_KEYS
                : type === "container"
                  ? CONTAINER_KEYS
                  : COMMON_KEYS;
  for (const key of Object.keys(props)) {
    if (!allowed.has(key)) throw new TypeError(`unknown ${type} prop ${key}`);
  }
}

function normalizeMediaCallback(
  value: unknown,
  label: string,
): ((event: PingoMediaEvent) => void) | undefined {
  if (value === undefined) return;
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
  return value as (event: PingoMediaEvent) => void;
}

function normalizeMediaErrorCallback(
  value: unknown,
): ((error: PingoMediaError) => void) | undefined {
  if (value === undefined) return;
  if (typeof value !== "function") throw new TypeError("onError must be a function");
  return value as (error: PingoMediaError) => void;
}

function assignRef(ref: Ref<NodeHandle>, value: NodeHandle | null): void {
  if (typeof ref === "function") ref(value);
  else ref.current = value;
}

function equalPair(
  left: readonly [number, number] | undefined,
  right: readonly [number, number],
): boolean {
  return left?.[0] === right[0] && left?.[1] === right[1];
}

function sameMedia(left: NormalizedMedia | undefined, right: NormalizedMedia | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.poster === right.poster &&
    left.binding.src === right.binding.src &&
    left.binding.autoPlay === right.binding.autoPlay &&
    left.binding.loop === right.binding.loop &&
    left.binding.muted === right.binding.muted &&
    left.binding.crossOrigin === right.binding.crossOrigin &&
    left.binding.preload === right.binding.preload
  );
}

function resolveMediaNaturalSize(
  media: NormalizedMedia | undefined,
  naturalSize: readonly [number, number] | undefined,
): NormalizedMedia | undefined {
  if (media === undefined || naturalSize === undefined) return media;
  const [width, height] = naturalSize;
  return {
    ...media,
    width,
    height,
    poster:
      media.poster?.width === width && media.poster.height === height ? media.poster : undefined,
  };
}

function equalQuad(
  left: readonly [number, number, number, number] | undefined,
  right: readonly [number, number, number, number],
): boolean {
  return (
    left?.[0] === right[0] &&
    left?.[1] === right[1] &&
    left?.[2] === right[2] &&
    left?.[3] === right[3]
  );
}

function equalVirtualListPolicy(
  left: NormalizedVirtualList | undefined,
  right: NormalizedVirtualList,
): boolean {
  return (
    left?.itemCount === right.itemCount &&
    left.axis === right.axis &&
    left.estimatedItemSize === right.estimatedItemSize &&
    left.baseOverscanViewports === right.baseOverscanViewports &&
    left.velocityHorizonSeconds === right.velocityHorizonSeconds &&
    left.maximumAheadViewports === right.maximumAheadViewports
  );
}

function equalEditable(left: NormalizedEditable | undefined, right: NormalizedEditable): boolean {
  return (
    left?.revision === right.revision &&
    left.flags === right.flags &&
    left.maxGraphemes === right.maxGraphemes
  );
}

function applyUtf16Replacement(
  value: string,
  start: number,
  end: number,
  replacement: string,
): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end) {
    throw new RangeError("edit delta range is invalid");
  }
  if (end > value.length || !isUtf16Boundary(value, start) || !isUtf16Boundary(value, end)) {
    throw new RangeError("edit delta splits a UTF-16 surrogate pair or exceeds the current value");
  }
  return value.slice(0, start) + replacement + value.slice(end);
}

function isUtf16Boundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function assertU32(value: unknown, label: string): asserts value is number {
  requireBoundedInteger(value, 0, 0xffff_ffff, label);
}

const INPUT_MODES = new Set([
  "decimal",
  "email",
  "none",
  "numeric",
  "search",
  "tel",
  "text",
  "url",
]);

function requireInputMode(value: unknown): string {
  if (value === undefined) return "text";
  if (typeof value !== "string" || !INPUT_MODES.has(value)) {
    throw new TypeError("EditableText inputMode is not a supported keyboard hint");
  }
  return value;
}

function requireBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${label} must be an integer from ${String(minimum)} through ${String(maximum)}`,
    );
  }
  return value;
}

function requireBoundedFinite(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be finite and between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return value;
}

function optionalBoundedFinite(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  return value === undefined ? fallback : requireBoundedFinite(value, minimum, maximum, label);
}

function instanceDepth(instance: Instance): number {
  let depth = 0;
  let owner = instance.parent;
  while (owner.kind !== "root") {
    depth += 1;
    owner = owner.parent;
  }
  return depth;
}

function hasProcessedAncestor(
  instance: ComponentInstance,
  processed: Set<ComponentInstance>,
): boolean {
  let owner = instance.parent;
  while (owner.kind !== "root") {
    if (owner.kind === "component" && processed.has(owner)) return true;
    owner = owner.parent;
  }
  return false;
}

function nearestCoreParent(owner: Owner, rootNodeId: number | undefined): number {
  let cursor = owner;
  while (cursor.kind === "component") cursor = cursor.parent;
  if (cursor.kind === "host") return cursor.nodeId;
  if (rootNodeId === undefined) throw new Error("component has no Core root parent");
  return rootNodeId;
}

function nearestComputedStyle(owner: Owner): ComputedStyle | undefined {
  let cursor = owner;
  while (cursor.kind === "component") cursor = cursor.parent;
  return cursor.kind === "host" ? cursor.computedStyle : undefined;
}

function equalComputedStyles(
  left: ComputedStyle | undefined,
  right: ComputedStyle | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const leftKeys = Object.keys(left) as StylePropertyName[];
  const rightKeys = Object.keys(right) as StylePropertyName[];
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((property) => Object.is(left[property], right[property]));
}

function nextU32Sequence(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function toError(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}
