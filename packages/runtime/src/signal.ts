/** Unsubscribe callback returned by reactive subscriptions. */
export type Unsubscribe = () => void;

/** Read-only reactive value. Reads through `get` participate in dependency tracking. */
export interface ReadonlySignal<T> {
  get(): T;
  peek(): T;
  subscribe(listener: (value: T) => void): Unsubscribe;
}

/** Writable reactive value. */
export interface Signal<T> extends ReadonlySignal<T> {
  set(value: T): void;
  update(update: (previous: T) => T): void;
}

interface ReactiveSource {
  addObserver(observer: ReactiveObserver): void;
  removeObserver(observer: ReactiveObserver): void;
}

let activeObserver: ReactiveObserver | undefined;
let batchDepth = 0;
let flushing = false;
const pendingObservers = new Set<ReactiveObserver>();
const MAX_FLUSH_ITERATIONS = 100_000;

/** Internal dependency observer used by component scopes and computed values. */
export class ReactiveObserver {
  #dependencies = new Set<ReactiveSource>();
  #nextDependencies = new Set<ReactiveSource>();
  #collecting = false;
  #disposed = false;
  readonly #onInvalidate: () => void;

  public constructor(onInvalidate: () => void) {
    this.#onInvalidate = onInvalidate;
  }

  public track<T>(read: () => T): T {
    if (this.#disposed) throw new Error("cannot track with a disposed reactive observer");
    if (this.#collecting) throw new Error("reactive observer cannot recursively track itself");
    const previousObserver = activeObserver;
    this.#collecting = true;
    this.#nextDependencies.clear();
    setActiveObserver(this);
    try {
      const result = read();
      for (const source of this.#dependencies) {
        if (!this.#nextDependencies.has(source)) source.removeObserver(this);
      }
      const previous = this.#dependencies;
      this.#dependencies = this.#nextDependencies;
      this.#nextDependencies = previous;
      return result;
    } catch (error) {
      for (const source of this.#nextDependencies) {
        if (!this.#dependencies.has(source)) source.removeObserver(this);
      }
      throw error;
    } finally {
      setActiveObserver(previousObserver);
      this.#nextDependencies.clear();
      this.#collecting = false;
    }
  }

  public dependOn(source: ReactiveSource): void {
    if (!this.#collecting || this.#nextDependencies.has(source)) return;
    this.#nextDependencies.add(source);
    if (!this.#dependencies.has(source)) source.addObserver(this);
  }

  public invalidate(): void {
    if (this.#disposed) return;
    pendingObservers.add(this);
    if (batchDepth === 0) flushPendingObservers();
  }

  public runInvalidation(): void {
    if (!this.#disposed) this.#onInvalidate();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    pendingObservers.delete(this);
    for (const source of this.#dependencies) source.removeObserver(this);
    for (const source of this.#nextDependencies) source.removeObserver(this);
    this.#dependencies.clear();
    this.#nextDependencies.clear();
  }
}

class SignalValue<T> implements Signal<T>, ReactiveSource {
  #value: T;
  readonly #observers = new Set<ReactiveObserver>();
  readonly #listeners = new Set<(value: T) => void>();

  public constructor(value: T) {
    this.#value = value;
  }

  public get(): T {
    activeObserver?.dependOn(this);
    return this.#value;
  }

  public peek(): T {
    return this.#value;
  }

  public set(value: T): void {
    if (Object.is(this.#value, value)) return;
    this.#value = value;
    batch(() => {
      for (const observer of this.#observers) observer.invalidate();
      for (const listener of this.#listeners) listener(value);
    });
  }

  public update(update: (previous: T) => T): void {
    this.set(update(this.#value));
  }

  public subscribe(listener: (value: T) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public addObserver(observer: ReactiveObserver): void {
    this.#observers.add(observer);
  }

  public removeObserver(observer: ReactiveObserver): void {
    this.#observers.delete(observer);
  }
}

class ComputedValue<T> implements ReadonlySignal<T>, ReactiveSource {
  readonly #compute: () => T;
  readonly #observer: ReactiveObserver;
  readonly #observers = new Set<ReactiveObserver>();
  readonly #listeners = new Set<(value: T) => void>();
  #value: T | undefined;
  #hasValue = false;
  #dirty = true;
  #computing = false;

  public constructor(compute: () => T) {
    this.#compute = compute;
    this.#observer = new ReactiveObserver(() => {
      if (this.#dirty) return;
      this.#dirty = true;
      batch(() => {
        for (const observer of this.#observers) observer.invalidate();
        if (this.#listeners.size > 0) {
          const value = this.get();
          for (const listener of this.#listeners) listener(value);
        }
      });
    });
  }

  public get(): T {
    activeObserver?.dependOn(this);
    if (!this.#dirty && this.#hasValue) return this.#value as T;
    if (this.#computing) throw new Error("computed signal cycle detected");
    this.#computing = true;
    try {
      const value = this.#observer.track(this.#compute);
      this.#value = value;
      this.#hasValue = true;
      this.#dirty = false;
      return value;
    } finally {
      this.#computing = false;
    }
  }

  public peek(): T {
    return untracked(() => this.get());
  }

  public subscribe(listener: (value: T) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public addObserver(observer: ReactiveObserver): void {
    this.#observers.add(observer);
  }

  public removeObserver(observer: ReactiveObserver): void {
    this.#observers.delete(observer);
  }
}

/** Creates a writable signal. */
export function signal<T>(value: T): Signal<T> {
  return new SignalValue(value);
}

/** Creates a lazy memoized derived signal. */
export function computed<T>(compute: () => T): ReadonlySignal<T> {
  return new ComputedValue(compute);
}

/** Coalesces observer invalidations until the outermost batch returns. */
export function batch<T>(operation: () => T): T {
  batchDepth += 1;
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  batchDepth -= 1;

  let flushError: unknown;
  let flushFailed = false;
  if (batchDepth === 0) {
    try {
      flushPendingObservers();
    } catch (error) {
      flushFailed = true;
      flushError = error;
    }
  }
  if (operationFailed && flushFailed) {
    throw new AggregateError(
      [operationError, flushError],
      "reactive batch operation and observer flush both failed",
    );
  }
  if (operationFailed) throw operationError;
  if (flushFailed) throw flushError;
  return result as T;
}

/** Executes a read without registering reactive dependencies. */
export function untracked<T>(read: () => T): T {
  const previousObserver = activeObserver;
  activeObserver = undefined;
  try {
    return read();
  } finally {
    activeObserver = previousObserver;
  }
}

/** Runs a tracked side effect immediately and after each dependency change. */
export function effect(run: () => void | Unsubscribe): Unsubscribe {
  let cleanup: void | Unsubscribe;
  let disposed = false;
  const execute = (): void => {
    if (disposed) return;
    const previousCleanup = cleanup;
    cleanup = undefined;
    const errors: unknown[] = [];
    try {
      previousCleanup?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      cleanup = observer.track(run);
    } catch (error) {
      errors.push(error);
    }
    throwCollectedErrors(errors, "effect cleanup and rerun both failed");
  };
  const observer = new ReactiveObserver(execute);
  try {
    execute();
  } catch (error) {
    observer.dispose();
    throw error;
  }
  return () => {
    if (disposed) return;
    disposed = true;
    observer.dispose();
    const previousCleanup = cleanup;
    cleanup = undefined;
    previousCleanup?.();
  };
}

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function flushPendingObservers(): void {
  if (flushing || batchDepth !== 0) return;
  flushing = true;
  let iterations = 0;
  let firstError: unknown;
  let hasError = false;
  try {
    while (pendingObservers.size > 0) {
      if (iterations >= MAX_FLUSH_ITERATIONS) {
        pendingObservers.clear();
        throw new Error("reactive invalidation cycle exceeded the flush budget");
      }
      iterations += 1;
      const observer = pendingObservers.values().next().value;
      if (observer === undefined) break;
      pendingObservers.delete(observer);
      try {
        observer.runInvalidation();
      } catch (error) {
        if (!hasError) firstError = error;
        hasError = true;
      }
    }
  } finally {
    flushing = false;
  }
  if (!hasError) return;
  if (firstError instanceof Error) throw firstError;
  throw new Error("reactive observer threw a non-Error value", { cause: firstError });
}

function setActiveObserver(observer: ReactiveObserver | undefined): void {
  activeObserver = observer;
}
