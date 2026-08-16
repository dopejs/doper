import {
  Fragment,
  DoperFont,
  createElement,
  isDoperElement,
  normalizeChildren,
  type AnyDoperElement,
  type Color,
  type CommonProps,
  type DoperNode,
  type DoperEvent,
  type DoperEventHandler,
  type EditableTextProps,
  type FunctionComponent,
  type HostType,
  type Key,
  type NodeHandle,
  type Ref,
  type VirtualListProps,
} from "@dopejs/doper-jsx";
import { ComponentScope } from "@dopejs/doper-runtime/internal";
import type { EditTransaction, EventTransaction, InputEventKind } from "@dopejs/doper-editing";

import { MAX_VIRTUAL_ITEMS, NodeKind, Prop, ResourceKind } from "./generated";
import { encodeMutationBatch, NULL_NODE_ID, type Mutation } from "./mutation-stream";
import { NodeIdAllocator } from "./node-id";
import {
  ResourcePool,
  encodeAffine,
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
}

/** Public lifecycle for a localized component/host tree. */
export interface DoperRoot {
  render(node: DoperNode): void;
  flushSync(): void;
  invokeCallback(callbackId: number): void;
  unmount(): void;
  readonly failed: boolean;
}

/** Internal Host contract for applying asynchronous Core virtual windows. */
export interface CoreDrivenDoperRoot extends DoperRoot {
  refillVirtualRanges(requests: readonly VirtualRangeRequest[]): void;
  applyEditTransaction(transaction: EditTransaction): void;
  applyEventTransaction(transaction: EventTransaction): void;
  editableState(nodeId: number): EditableStateSnapshot | undefined;
  submitEditable(nodeId: number): void;
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
  onTapId: number | undefined;
  ref: Ref<NodeHandle> | undefined;
  scrollPosition: readonly [number, number] | undefined;
  virtualItemIndex: number | undefined;
  virtualItems: Map<number, DoperNode>;
  virtualList: NormalizedVirtualList | undefined;
  virtualRange: readonly [number, number] | undefined;
  editable: NormalizedEditable | undefined;
  editableSelection: { anchor: number; focus: number } | undefined;
  onEditTransaction: ((transaction: EditTransaction) => void) | undefined;
  onSubmit: (() => void) | undefined;
  eventHandlers: Map<EventHandlerKey, DoperEventHandler>;
}

interface ComponentInstance extends BaseInstance {
  readonly kind: "component";
  readonly type: FunctionComponent<never>;
  props: Readonly<Record<string, unknown>>;
  children: Instance[];
  readonly scope: ComponentScope;
}

type Instance = HostInstance | ComponentInstance;
type Owner = RootOwner | HostInstance | ComponentInstance;
type ChildDescriptor = AnyDoperElement | string;

interface NormalizedHostProps {
  readonly children: DoperNode;
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
      }
    | undefined;
  readonly scrollPosition: readonly [number, number] | undefined;
  readonly virtualItemIndex: number | undefined;
  readonly virtualList: NormalizedVirtualList | undefined;
  readonly editable: NormalizedEditable | undefined;
  readonly eventHandlers: Map<EventHandlerKey, DoperEventHandler>;
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
  readonly itemCount: number;
  readonly estimatedItemHeight: number;
  readonly baseOverscanViewports: number;
  readonly velocityHorizonSeconds: number;
  readonly maximumAheadViewports: number;
  readonly renderItem: (index: number) => DoperNode;
}

interface CallbackEntry {
  readonly id: number;
  readonly callback: () => void;
  references: number;
}

const COMMON_KEYS = new Set([
  "backgroundColor",
  "children",
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
  "onClickCapture",
  "onClick",
  "onWheelCapture",
  "onWheel",
  "opacity",
  "padding",
  "ref",
  "semanticLabel",
  "semanticRole",
  "semanticValue",
  "transform",
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
  "maxGraphemes",
  "multiline",
  "onSubmit",
  "onTransaction",
  "password",
  "readOnly",
  "revision",
]);
const SCROLL_KEYS = new Set([...COMMON_KEYS, "scrollX", "scrollY"]);
const VIRTUAL_LIST_KEYS = new Set([
  ...[...SCROLL_KEYS].filter((key) => key !== "children"),
  "baseOverscanViewports",
  "estimatedItemHeight",
  "itemCount",
  "maximumAheadViewports",
  "renderItem",
  "velocityHorizonSeconds",
]);
const VIRTUAL_ITEM_INDEX = Symbol("doper.virtualItemIndex");

/** Creates one deterministic component tree and Mutation Stream producer. */
export function createRoot(sink: MutationSink, options: RootOptions = {}): CoreDrivenDoperRoot {
  return new ReconcilerRoot(sink, options);
}

class ReconcilerRoot implements CoreDrivenDoperRoot {
  readonly #sink: MutationSink;
  readonly #schedule: (task: () => void) => void;
  readonly #onFatalError: ((error: Error) => void) | undefined;
  readonly #onPostCommitError: ((error: Error) => void) | undefined;
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
  #performing = false;
  #unmounted = false;
  #failed = false;

  public constructor(sink: MutationSink, options: RootOptions) {
    this.#sink = sink;
    this.#schedule = options.schedule ?? ((task) => queueMicrotask(task));
    this.#onFatalError = options.onFatalError;
    this.#onPostCommitError = options.onPostCommitError;
  }

  public get failed(): boolean {
    return this.#failed;
  }

  public render(node: DoperNode): void {
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
    if (this.#performing || this.#dirtyComponents.size === 0) return;
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
        return instance?.mounted === true && instance.type === "virtualList";
      })
      .sort((left, right) => left.nodeId - right.nodeId);
    if (applicable.length === 0) return;
    this.perform(() => {
      for (const request of applicable) {
        const instance = this.#hostsByNodeId.get(request.nodeId);
        if (instance === undefined || instance.type !== "virtualList") continue;
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

    const state = new PropagationState(transaction);
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
    if (!state.propagationStopped) {
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
    node: DoperNode,
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
        next.push(this.updateInstance(candidate, descriptor, coreParent));
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
      scope: new ComponentScope(() => this.enqueueComponent(instance)),
      mounted: true,
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
    const normalized = normalizeHostProps(type, props);
    const nodeId = this.#allocator.allocate();
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
      onTapId: undefined,
      ref: undefined,
      scrollPosition: undefined,
      virtualItemIndex: undefined,
      virtualItems: new Map(),
      virtualList: undefined,
      virtualRange: undefined,
      editable: undefined,
      editableSelection: undefined,
      onEditTransaction: undefined,
      onSubmit: undefined,
      eventHandlers: new Map(),
      mounted: true,
    };
    this.mutations().push({
      type: "createNode",
      nodeId,
      kind: hostNodeKind(type),
      parent: coreParent,
      beforeSibling: NULL_NODE_ID,
    });
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
    if (instance.kind === "component") {
      if (typeof descriptor === "string" || !isDoperElement(descriptor)) {
        throw new Error("component descriptor changed unexpectedly");
      }
      instance.props = descriptor.props;
      this.renderComponent(instance, coreParent);
      return instance;
    }
    const props =
      typeof descriptor === "string" ? ({ value: descriptor } as const) : descriptor.props;
    const normalized = normalizeHostProps(instance.type, props);
    const previousVirtualList = instance.virtualList;
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
      instance.type === "virtualList" &&
      instance.virtualRange !== undefined &&
      (previousVirtualList?.renderItem !== instance.virtualList?.renderItem ||
        previousVirtualList?.itemCount !== instance.virtualList?.itemCount)
    ) {
      const [start, end] = instance.virtualRange;
      const itemCount = instance.virtualList?.itemCount ?? 0;
      if (previousVirtualList?.renderItem !== instance.virtualList?.renderItem) {
        instance.virtualItems.clear();
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
      const component = instance.type as FunctionComponent<Record<string, unknown>>;
      return component(instance.props);
    });
    instance.children = this.reconcileChildren(instance, coreParent, instance.children, output);
    this.#renderedScopes.add(instance.scope);
  }

  private applyHostProps(instance: HostInstance, next: NormalizedHostProps): void {
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
          estimatedItemHeight: next.virtualList.estimatedItemHeight,
          baseOverscanViewports: next.virtualList.baseOverscanViewports,
          velocityHorizonSeconds: next.virtualList.velocityHorizonSeconds,
          maximumAheadViewports: next.virtualList.maximumAheadViewports,
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
  }

  private materializeVirtualWindow(instance: HostInstance, start: number, end: number): void {
    if (instance.virtualRange?.[0] === start && instance.virtualRange[1] === end) return;
    const config = instance.virtualList;
    if (config === undefined) throw new Error("virtual list instance has no configuration");
    const children: DoperNode[] = [];
    for (let index = start; index < end; index += 1) {
      let child = instance.virtualItems.get(index);
      if (!instance.virtualItems.has(index)) {
        child = config.renderItem(index);
        instance.virtualItems.set(index, child);
      }
      const props = {
        children: child,
        [VIRTUAL_ITEM_INDEX]: index,
      } as Record<string | symbol, unknown>;
      children.push(
        createElement(
          "container",
          props as unknown as Record<string, unknown>,
          `doper:virtual:${String(index)}`,
        ),
      );
    }
    instance.children = this.reconcileChildren(
      instance,
      instance.nodeId,
      instance.children,
      children,
    );
    for (const index of instance.virtualItems.keys()) {
      if (index < start || index >= end) instance.virtualItems.delete(index);
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
      encodeTextStyle(paintId, text.fontSize, text.lineHeight, text.fontWeight, text.fontFamily),
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
      const handle: NodeHandle = Object.freeze({ nodeId: instance.nodeId });
      this.#postCommitAttachments.push(() => assignRef(next, handle));
    }
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
    for (const child of instance.children) this.disposeInstance(child, false);
    instance.children = [];
    instance.virtualItems.clear();
    for (const resourceId of instance.resources.values()) {
      this.#resources.release(resourceId, this.mutations());
    }
    instance.resources.clear();
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
): NormalizedHostProps {
  assertAllowedProps(type, props);
  const common = props as CommonProps;
  const propertyBag = props as Readonly<Record<PropertyKey, unknown>>;
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
    if (font !== undefined && !(font instanceof DoperFont)) {
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
    };
  }

  let scrollPosition: readonly [number, number] | undefined;
  if (type === "scroll" || type === "virtualList") {
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
  if (type === "virtualList") {
    const virtualProps = props as unknown as VirtualListProps;
    const itemCount = requireBoundedInteger(
      virtualProps.itemCount,
      0,
      MAX_VIRTUAL_ITEMS,
      "itemCount",
    );
    const estimatedItemHeight = requireBoundedFinite(
      virtualProps.estimatedItemHeight,
      Number.EPSILON,
      1_000_000_000,
      "estimatedItemHeight",
    );
    if (typeof virtualProps.renderItem !== "function") {
      throw new TypeError("renderItem must be a function");
    }
    virtualList = {
      itemCount,
      estimatedItemHeight,
      baseOverscanViewports: optionalBoundedFinite(
        virtualProps.baseOverscanViewports,
        1,
        0,
        64,
        "baseOverscanViewports",
      ),
      velocityHorizonSeconds: optionalBoundedFinite(
        virtualProps.velocityHorizonSeconds,
        0.25,
        0,
        10,
        "velocityHorizonSeconds",
      ),
      maximumAheadViewports: optionalBoundedFinite(
        virtualProps.maximumAheadViewports,
        4,
        0,
        64,
        "maximumAheadViewports",
      ),
      renderItem: virtualProps.renderItem,
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
  return {
    children: allowsHostChildren(type) ? (props.children as DoperNode) : undefined,
    ref,
    scalars,
    vectors,
    background:
      common.backgroundColor === undefined ? undefined : encodeSolidPaint(common.backgroundColor),
    transform: common.transform === undefined ? undefined : encodeAffine(common.transform),
    semantics,
    onTap,
    text,
    scrollPosition,
    virtualItemIndex,
    virtualList,
    editable,
    eventHandlers,
  };
}

function hostNodeKind(type: HostType): NodeKind {
  switch (type) {
    case "container":
      return NodeKind.Container;
    case "text":
      return NodeKind.Text;
    case "editableText":
      return NodeKind.EditableText;
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
): Map<EventHandlerKey, DoperEventHandler> {
  const bindings = [
    ["pointerdown:capture", "onPointerDownCapture"],
    ["pointerdown:bubble", "onPointerDown"],
    ["pointerup:capture", "onPointerUpCapture"],
    ["pointerup:bubble", "onPointerUp"],
    ["pointermove:capture", "onPointerMoveCapture"],
    ["pointermove:bubble", "onPointerMove"],
    ["pointercancel:capture", "onPointerCancelCapture"],
    ["pointercancel:bubble", "onPointerCancel"],
    ["click:capture", "onClickCapture"],
    ["click:bubble", "onClick"],
    ["wheel:capture", "onWheelCapture"],
    ["wheel:bubble", "onWheel"],
  ] as const satisfies readonly (readonly [EventHandlerKey, string])[];
  const result = new Map<EventHandlerKey, DoperEventHandler>();
  for (const [key, property] of bindings) {
    const value = props[property];
    if (value === undefined) continue;
    if (typeof value !== "function") throw new TypeError(`${property} must be a function`);
    result.set(key, value as DoperEventHandler);
  }
  return result;
}

class PropagationState {
  public defaultPrevented = false;
  public propagationStopped = false;
  public immediatePropagationStopped = false;
  readonly #transaction: EventTransaction;

  public constructor(transaction: EventTransaction) {
    this.#transaction = transaction;
  }

  public eventFor(nodeId: number, phase: "bubble" | "capture"): DoperEvent {
    const transaction = this.#transaction;
    const isDefaultPrevented = (): boolean => this.defaultPrevented;
    const target = Object.freeze({ nodeId: transaction.target });
    const currentTarget = Object.freeze({ nodeId });
    return Object.freeze({
      type: transaction.kind,
      eventId: transaction.eventId,
      target,
      currentTarget,
      eventPhase: nodeId === transaction.target ? 2 : phase === "capture" ? 1 : 3,
      x: transaction.x,
      y: transaction.y,
      deltaX: transaction.deltaX,
      deltaY: transaction.deltaY,
      buttons: transaction.buttons,
      pointerId: transaction.pointerId,
      elapsedMicros: transaction.elapsedMicros,
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
            : COMMON_KEYS;
  for (const key of Object.keys(props)) {
    if (!allowed.has(key)) throw new TypeError(`unknown ${type} prop ${key}`);
  }
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
    left.estimatedItemHeight === right.estimatedItemHeight &&
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

function nextU32Sequence(value: number): number {
  const next = (value + 1) >>> 0;
  return next === 0 ? 1 : next;
}

function toError(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}
