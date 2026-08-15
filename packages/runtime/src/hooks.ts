import { ReactiveObserver, signal, type Signal, type Unsubscribe } from "./signal.js";

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

  public constructor(invalidate: () => void) {
    this.#invalidate = invalidate;
    this.#observer = new ReactiveObserver(invalidate);
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
