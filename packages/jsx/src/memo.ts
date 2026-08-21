import type { FunctionComponent } from "./types";

/** Stable memo brand shared across package copies and realms. */
export const PINGO_MEMO_TYPE: symbol = Symbol.for("dopejs.pingo.memo");

export type PropsAreEqual<Props> = (previous: Readonly<Props>, next: Readonly<Props>) => boolean;

/**
 * Component wrapper produced by `memo`. The wrapper is a singleton object:
 * element identity (`instance.type === descriptor.type`) is preserved, so the
 * reconciler's compatibility check works unchanged.
 */
export interface MemoComponent<Props = Record<string, never>> {
  readonly $$typeof: typeof PINGO_MEMO_TYPE;
  readonly component: FunctionComponent<Props>;
  readonly compare: PropsAreEqual<Props> | undefined;
}

/**
 * Skips re-rendering a component when its props are shallowly equal to the
 * last render's props. Function props compare by reference — inline handlers
 * defeat memo, exactly as in React. Signal-driven re-renders bypass memo:
 * a component subscribed to a signal always re-renders when it writes.
 */
export function memo<Props extends Record<string, unknown>>(
  component: FunctionComponent<Props>,
  compare?: PropsAreEqual<Props>,
): MemoComponent<Props> {
  return { $$typeof: PINGO_MEMO_TYPE, component, compare };
}

export function isMemoComponent(value: unknown): value is MemoComponent<never> {
  return (
    typeof value === "object" &&
    value !== null &&
    "$$typeof" in value &&
    value.$$typeof === PINGO_MEMO_TYPE
  );
}

/** Default memo comparison: Object.is per value plus key-count equality. */
export function shallowEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !Object.is(left[key], right[key])) return false;
  }
  return true;
}
