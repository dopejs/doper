import { ReactiveObserver, signal, type Signal, type Unsubscribe } from "./signal";
import type { ContextLookup, PingoContext } from "./context";

/** Axis-aligned rectangle in world (root) coordinates. */
export interface LayoutRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** One node's laid-out geometry, as reported by Core for a committed frame. */
export interface LayoutGeometry {
  /** World box before any ancestor clipping. */
  readonly bounds: LayoutRect;
  /**
   * Intersection of every clipping ancestor. Unbounded when nothing clips the
   * node, zero-sized when it lies entirely outside its clipping ancestors.
   */
  readonly clip: LayoutRect;
}

/**
 * Host-provided access to Core geometry, injected by the reconciler.
 *
 * The runtime defines the shape it consumes rather than importing it, because
 * the reconciler depends on the runtime and not the other way round.
 */
export interface LayoutGeometryAccess {
  /** Starts reporting for a node and re-runs `notify` when its geometry moves. */
  readonly observe: (nodeId: number, notify: () => void) => Unsubscribe;
  /** Latest geometry, or undefined when the node has not been measured yet. */
  readonly read: (nodeId: number) => LayoutGeometry | undefined;
  /**
   * Visible surface in world coordinates, or undefined before the first frame.
   *
   * Carried here rather than through the geometry ABI because the Shell already
   * owns the canvas size — it is the side that drives resize — so asking Core
   * for it would add a wire field to answer a question the asker can answer.
   */
  readonly viewport: () => LayoutRect | undefined;
  /** Subscribes to viewport changes; returns an unsubscribe. */
  readonly observeViewport: (notify: () => void) => Unsubscribe;
}

/** Mutable stable reference returned by `useRef`. */
export interface RefObject<T> {
  current: T;
}

type DependencyList = readonly unknown[];
type StateUpdate<T> = T | ((previous: T) => T);

interface StateSlot<T> {
  readonly kind: "state";
  value: T;
  readonly set: (update: StateUpdate<T>) => void;
}

interface SignalSlot<T> {
  readonly kind: "signal";
  readonly value: Signal<T>;
}

interface MemoSlot<T> {
  readonly kind: "memo";
  readonly value: T;
  readonly dependencies: DependencyList;
}

interface RefSlot<T> {
  readonly kind: "ref";
  readonly value: RefObject<T>;
}

interface EffectSlot {
  readonly kind: "effect";
  readonly dependencies: DependencyList | undefined;
  readonly create: () => void | Unsubscribe;
  cleanup: void | Unsubscribe;
  committed: boolean;
}

type HookSlot =
  | { readonly kind: "state" }
  | { readonly kind: "signal" }
  | { readonly kind: "memo" }
  | { readonly kind: "ref" }
  | EffectSlot;

let activeScope: ComponentScope | undefined;

/** Reconciler-owned hook and reactive lifetime for one function component. */
export class ComponentScope {
  #slots: HookSlot[] = [];
  #pendingEffects = new Set<number>();
  #cursor = 0;
  #expectedHooks: number | undefined;
  #rendering = false;
  #disposed = false;
  readonly #observer: ReactiveObserver;
  readonly #invalidate: () => void;
  readonly #lookupContext: ContextLookup | undefined;
  readonly #layoutGeometry: LayoutGeometryAccess | undefined;

  public constructor(
    invalidate: () => void,
    lookupContext?: ContextLookup,
    layoutGeometry?: LayoutGeometryAccess,
  ) {
    this.#invalidate = invalidate;
    this.#observer = new ReactiveObserver(invalidate);
    this.#lookupContext = lookupContext;
    this.#layoutGeometry = layoutGeometry;
  }

  /** Core geometry access, or undefined outside a host that provides it. */
  public layoutGeometryAccess(): LayoutGeometryAccess | undefined {
    return this.#layoutGeometry;
  }

  /** Finds the nearest provider signal for one context along the owner chain. */
  public lookupContext(context: PingoContext<unknown>): Signal<unknown> | undefined {
    return this.#lookupContext?.(context);
  }

  /** Runs one component render with transactional hook bookkeeping. */
  public render<T>(render: () => T): T {
    if (this.#disposed) throw new Error("cannot render a disposed component scope");
    if (this.#rendering) throw new Error("component scope cannot render recursively");
    const previousScope = activeScope;
    const previousSlots = this.#slots.slice();
    const previousPending = new Set(this.#pendingEffects);
    this.#cursor = 0;
    this.#rendering = true;
    setActiveScope(this);
    try {
      const result = this.#observer.track(render);
      if (this.#expectedHooks !== undefined && this.#expectedHooks !== this.#cursor) {
        throw new Error("hook count changed between component renders");
      }
      this.#expectedHooks ??= this.#cursor;
      return result;
    } catch (error) {
      this.#slots = previousSlots;
      this.#pendingEffects = previousPending;
      throw error;
    } finally {
      setActiveScope(previousScope);
      this.#rendering = false;
    }
  }

  /** Runs committed passive effects and their prior cleanup callbacks. */
  public flushEffects(): void {
    if (this.#disposed) return;
    const pending = [...this.#pendingEffects].sort((left, right) => left - right);
    this.#pendingEffects.clear();
    const errors: unknown[] = [];
    for (const index of pending) {
      const slot = this.#slots[index];
      if (slot?.kind !== "effect") continue;
      const previousCleanup = slot.cleanup;
      slot.cleanup = undefined;
      try {
        previousCleanup?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        slot.cleanup = slot.create();
        slot.committed = true;
      } catch (error) {
        slot.committed = false;
        errors.push(error);
      }
    }
    throwCollectedErrors(errors, "component effect flush failed");
  }

  /** Disposes reactive dependencies and effect lifetimes exactly once. */
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observer.dispose();
    this.#pendingEffects.clear();
    const errors: unknown[] = [];
    for (const slot of this.#slots) {
      if (slot.kind !== "effect") continue;
      const cleanup = slot.cleanup;
      slot.cleanup = undefined;
      try {
        cleanup?.();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#slots = [];
    throwCollectedErrors(errors, "component effect disposal failed");
  }

  public useSlot<T extends HookSlot>(kind: T["kind"], create: () => T): [T, number] {
    if (!this.#rendering)
      throw new Error("hooks may only run while rendering a function component");
    const index = this.#cursor;
    this.#cursor += 1;
    const existing = this.#slots[index];
    if (existing !== undefined && existing.kind !== kind) {
      throw new Error(`hook order changed at slot ${String(index)}`);
    }
    const slot = (existing ?? create()) as T;
    if (existing === undefined) this.#slots[index] = slot;
    return [slot, index];
  }

  public replaceSlot(index: number, slot: HookSlot): void {
    this.#slots[index] = slot;
  }

  public scheduleEffect(index: number): void {
    this.#pendingEffects.add(index);
  }

  public invalidate(): void {
    this.#invalidate();
  }
}

/** Stores component-local state and schedules the owning scope on change. */
export function useState<T>(initial: T | (() => T)): [T, (update: StateUpdate<T>) => void] {
  const scope = requireScope();
  let created: StateSlot<T> | undefined;
  const [slot] = scope.useSlot<StateSlot<T>>("state", () => {
    const state: StateSlot<T> = {
      kind: "state",
      value: typeof initial === "function" ? (initial as () => T)() : initial,
      set: (update) => {
        const next =
          typeof update === "function" ? (update as (value: T) => T)(state.value) : update;
        if (Object.is(state.value, next)) return;
        state.value = next;
        scope.invalidate();
      },
    };
    created = state;
    return state;
  });
  return [slot.value, (created ?? slot).set];
}

/** Creates one stable signal for a component lifetime. */
export function useSignal<T>(initial: T | (() => T)): Signal<T> {
  const scope = requireScope();
  const [slot] = scope.useSlot<SignalSlot<T>>("signal", () => ({
    kind: "signal",
    value: signal(typeof initial === "function" ? (initial as () => T)() : initial),
  }));
  return slot.value;
}

/** Memoizes a value until its dependency list changes by `Object.is`. */
export function useMemo<T>(compute: () => T, dependencies: DependencyList): T {
  const scope = requireScope();
  const [slot, index] = scope.useSlot<MemoSlot<T>>("memo", () => ({
    kind: "memo",
    value: compute(),
    dependencies: dependencies.slice(),
  }));
  if (sameDependencies(slot.dependencies, dependencies)) return slot.value;
  const next: MemoSlot<T> = {
    kind: "memo",
    value: compute(),
    dependencies: dependencies.slice(),
  };
  scope.replaceSlot(index, next);
  return next.value;
}

/** Returns a stable callback until its dependency list changes. */
export function useCallback<T extends (...arguments_: never[]) => unknown>(
  callback: T,
  dependencies: DependencyList,
): T {
  return useMemo(() => callback, dependencies);
}

/** Creates one stable mutable reference object. */
export function useRef<T>(initial: T): RefObject<T> {
  const scope = requireScope();
  const [slot] = scope.useSlot<RefSlot<T>>("ref", () => ({
    kind: "ref",
    value: { current: initial },
  }));
  return slot.value;
}

/** Schedules a passive effect after the reconciler commits host mutations. */
export function useEffect(create: () => void | Unsubscribe, dependencies?: DependencyList): void {
  const scope = requireScope();
  const [slot, index] = scope.useSlot<EffectSlot>("effect", () => ({
    kind: "effect",
    dependencies: dependencies?.slice(),
    create,
    cleanup: undefined,
    committed: false,
  }));
  if (slot.create === create && sameOptionalDependencies(slot.dependencies, dependencies)) {
    if (!slot.committed) scope.scheduleEffect(index);
    return;
  }
  if (!sameOptionalDependencies(slot.dependencies, dependencies)) {
    scope.replaceSlot(index, {
      kind: "effect",
      dependencies: dependencies?.slice(),
      create,
      cleanup: slot.cleanup,
      committed: false,
    });
    scope.scheduleEffect(index);
  }
}

function requireScope(): ComponentScope {
  if (activeScope === undefined) throw new Error("hooks may only run in a function component");
  return activeScope;
}

/**
 * Observes one mounted node's Core geometry, one frame behind.
 *
 * Returns a ref callback to attach and the projected value. The value is
 * `undefined` until Core has reported the node — the honest answer for "not
 * measured yet", since a zero rectangle is indistinguishable from a node that
 * really is empty.
 *
 * A ref **callback** rather than a `RefObject`, unlike the sketch in
 * `docs/design.md`: a ref object is populated after the render that would need
 * it, so the hook would have no node to observe and nothing would re-run it.
 * The callback fires on attach, which is when the node id becomes known.
 *
 * `enabled: false` observes nothing and consumes no slot in Core's bounded
 * observation set — bind it to whether an overlay is open, not to whether its
 * trigger is mounted.
 */
export function useLayoutValue<T>(
  selector: (geometry: LayoutGeometry) => T,
  options?: { readonly enabled?: boolean },
): readonly [(handle: { readonly nodeId: number } | null) => void, T | undefined] {
  const scope = requireScope();
  const access = scope.layoutGeometryAccess();
  const enabled = options?.enabled ?? true;
  const state = useRef<{
    nodeId: number | undefined;
    unsubscribe: Unsubscribe | undefined;
  }>({ nodeId: undefined, unsubscribe: undefined });
  const notify = useCallback(() => scope.invalidate(), [scope]);

  const attach = useCallback(
    (handle: { readonly nodeId: number } | null) => {
      const nodeId = handle?.nodeId;
      if (state.current.nodeId === nodeId) return;
      state.current.unsubscribe?.();
      state.current.unsubscribe = undefined;
      state.current.nodeId = nodeId;
      if (nodeId === undefined || access === undefined || !enabled) return;
      state.current.unsubscribe = access.observe(nodeId, notify);
      notify();
    },
    [access, enabled, notify, state],
  );

  // Toggling `enabled` on an already-attached node has to take effect without a
  // remount, and unmounting has to release the observation or Core's bounded
  // set leaks a slot per closed overlay.
  useEffect(() => {
    const nodeId = state.current.nodeId;
    if (nodeId !== undefined && access !== undefined && enabled) {
      state.current.unsubscribe ??= access.observe(nodeId, notify);
    } else {
      state.current.unsubscribe?.();
      state.current.unsubscribe = undefined;
    }
    return () => {
      state.current.unsubscribe?.();
      state.current.unsubscribe = undefined;
    };
  }, [access, enabled, notify, state]);

  const nodeId = state.current.nodeId;
  const geometry =
    nodeId === undefined || access === undefined || !enabled ? undefined : access.read(nodeId);
  return [attach, geometry === undefined ? undefined : selector(geometry)] as const;
}

/**
 * The visible surface in world coordinates, or `undefined` before the first
 * frame and whenever layout readback is off.
 *
 * Placement needs it as the outer bound; a node's clip box only describes what
 * its ancestors clip, which is unbounded for anything outside a scroller.
 */
export function useViewport(): LayoutRect | undefined {
  const scope = requireScope();
  const access = scope.layoutGeometryAccess();
  const notify = useCallback(() => scope.invalidate(), [scope]);
  useEffect(() => access?.observeViewport(notify), [access, notify]);
  return access?.viewport();
}

/**
 * Reads the nearest provider's value for `context`, subscribing the rendering
 * component to later changes. Without a provider on the owner chain, returns
 * the context default. Provider value changes re-render only subscribed
 * consumers and bypass memo (signal invalidation path).
 */
export function useContext<T>(context: PingoContext<T>): T {
  const scope = requireScope();
  const provided = scope.lookupContext(context);
  if (provided === undefined) return context.defaultValue;
  // The bridge is variance-erased; the provider for this context carries T.
  return provided.get() as T;
}

function setActiveScope(scope: ComponentScope | undefined): void {
  activeScope = scope;
}

function sameOptionalDependencies(
  previous: DependencyList | undefined,
  next: DependencyList | undefined,
): boolean {
  return previous !== undefined && next !== undefined && sameDependencies(previous, next);
}

function sameDependencies(previous: DependencyList, next: DependencyList): boolean {
  return (
    previous.length === next.length &&
    previous.every((value, index) => Object.is(value, next[index]))
  );
}

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}
