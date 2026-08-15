import {
  Fragment,
  isDoperElement,
  normalizeChildren,
  type AnyDoperElement,
  type Color,
  type CommonProps,
  type DoperNode,
  type FunctionComponent,
  type HostType,
  type Key,
  type NodeHandle,
  type Ref,
} from "@dopejs/doper-jsx";
import { ComponentScope } from "@dopejs/doper-runtime/internal";

import { NodeKind, Prop, ResourceKind } from "./generated";
import { encodeMutationBatch, NULL_NODE_ID, type Mutation } from "./mutation-stream";
import { NodeIdAllocator } from "./node-id";
import {
  ResourcePool,
  encodeAffine,
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
        readonly fontSize: number;
        readonly lineHeight: number;
        readonly fontWeight: number;
      }
    | undefined;
  readonly scrollPosition: readonly [number, number] | undefined;
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
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "value",
]);
const EDITABLE_KEYS = new Set([
  ...TEXT_KEYS,
  "maxGraphemes",
  "multiline",
  "onSubmit",
  "onTransaction",
  "password",
  "readOnly",
]);
const SCROLL_KEYS = new Set([...COMMON_KEYS, "scrollX", "scrollY"]);

/** Creates one deterministic component tree and Mutation Stream producer. */
export function createRoot(sink: MutationSink, options: RootOptions = {}): DoperRoot {
  return new ReconcilerRoot(sink, options);
}

class ReconcilerRoot implements DoperRoot {
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
    if (next.text !== undefined) this.replaceTextRun(instance, next.text);
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
    for (const resourceId of instance.resources.values()) {
      this.#resources.release(resourceId, this.mutations());
    }
    instance.resources.clear();
    if (instance.onTapId !== undefined) this.releaseCallback(instance.onTapId);
    if (instance.ref !== undefined) {
      const ref = instance.ref;
      this.#postCommitCleanups.push(() => assignRef(ref, null));
    }
    if (emitHostRemove) {
      this.mutations().push({ type: "removeNode", nodeId: instance.nodeId });
    }
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

  let text: NormalizedHostProps["text"];
  if (type === "text" || type === "editableText") {
    const value =
      type === "editableText"
        ? requireString(props.value, "EditableText value")
        : props.value === undefined
          ? primitiveText(props.children)
          : requireString(props.value, "Text value");
    const fontSize = optionalPositive(props.fontSize, 16, "fontSize");
    const lineHeight = optionalPositive(props.lineHeight, fontSize * 1.2, "lineHeight");
    const fontWeight = optionalWeight(props.fontWeight);
    const fontFamily =
      props.fontFamily === undefined
        ? "sans-serif"
        : requireNonEmptyString(props.fontFamily, "fontFamily");
    const color = (props.color ?? "#000000") as Color;
    scalars.set(Prop.FontSize, fontSize);
    text = {
      value,
      paint: encodeSolidPaint(color),
      fontFamily,
      fontSize,
      lineHeight,
      fontWeight,
    };
  }

  let scrollPosition: readonly [number, number] | undefined;
  if (type === "scroll") {
    const x = optionalFinite(props.scrollX, 0, "scrollX");
    const y = optionalFinite(props.scrollY, 0, "scrollY");
    scrollPosition = [x, y];
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
