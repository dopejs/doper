import type { Signal } from "./signal";

/** Stable context brand shared across package copies and realms. */
export const PINGO_CONTEXT_TYPE: symbol = Symbol.for("dopejs.pingo.context");
/** Stable provider brand shared across package copies and realms. */
export const PINGO_PROVIDER_TYPE: symbol = Symbol.for("dopejs.pingo.context.provider");

/** A context object created by `createContext`. */
export interface PingoContext<T> {
  readonly $$typeof: typeof PINGO_CONTEXT_TYPE;
  readonly defaultValue: T;
  readonly Provider: ContextProvider<T>;
}

/** Element type wrapper: `<context.Provider value={...}>children</...>`. */
export interface ContextProvider<T> {
  readonly $$typeof: typeof PINGO_PROVIDER_TYPE;
  readonly context: PingoContext<T>;
}

/** Props accepted by a context Provider element. */
export interface ContextProviderProps<T> {
  readonly value: T;
  readonly children?: unknown;
}

export function createContext<T>(defaultValue: T): PingoContext<T> {
  // Two-phase init for the context↔provider self-reference; the object is
  // complete before createContext returns.
  const context = {} as PingoContext<T>;
  const provider: ContextProvider<T> = { $$typeof: PINGO_PROVIDER_TYPE, context };
  Object.assign(context, {
    $$typeof: PINGO_CONTEXT_TYPE,
    defaultValue,
    Provider: provider,
  } satisfies PingoContext<T>);
  return context;
}

export function isContextProvider(value: unknown): value is ContextProvider<never> {
  return (
    typeof value === "object" &&
    value !== null &&
    "$$typeof" in value &&
    value.$$typeof === PINGO_PROVIDER_TYPE
  );
}

/** Lookup bridge result: the nearest provider's signal for one context. */
export type ContextLookup = (context: PingoContext<unknown>) => Signal<unknown> | undefined;
