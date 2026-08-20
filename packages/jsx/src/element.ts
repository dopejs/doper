import {
  Fragment,
  type AnyPingoElement,
  type PingoElement,
  type PingoNode,
  type ElementType,
  type Key,
} from "./types";

/** Stable element brand shared across package copies and realms. */
export const PINGO_ELEMENT_TYPE: symbol = Symbol.for("dopejs.pingo.element");

/** Creates an immutable-shape element descriptor for the automatic JSX transform. */
export function createElement<Props extends Record<string, unknown>>(
  type: ElementType<Props>,
  inputProps: Props | null,
  explicitKey?: Key,
): PingoElement<Props> {
  const source = (inputProps ?? ({} as Props)) as Props & { readonly key?: Key };
  const key = explicitKey ?? source.key ?? null;
  const props =
    source.key === undefined
      ? source
      : Object.fromEntries(Object.entries(source).filter(([name]) => name !== "key"));
  return {
    $$typeof: PINGO_ELEMENT_TYPE,
    type,
    key,
    props: props as Readonly<Props>,
  };
}

/** Returns whether an unknown value is a pingo element descriptor. */
export function isPingoElement(value: unknown): value is AnyPingoElement {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly $$typeof?: unknown }).$$typeof === PINGO_ELEMENT_TYPE
  );
}

/** Flattens fragments/arrays and drops boolean/null placeholders deterministically. */
export function normalizeChildren(node: PingoNode): Array<AnyPingoElement | string> {
  const result: Array<AnyPingoElement | string> = [];
  const stack: PingoNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined || typeof current === "boolean") continue;
    if (Array.isArray(current)) {
      const children = current as readonly PingoNode[];
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    } else if (isPingoElement(current) && current.type === Fragment) {
      const children = (current.props as { readonly children?: PingoNode }).children;
      stack.push(children);
    } else if (isPingoElement(current)) {
      result.push(current);
    } else if (
      typeof current === "string" ||
      typeof current === "number" ||
      typeof current === "bigint"
    ) {
      result.push(String(current));
    } else {
      throw new TypeError("invalid pingo child value");
    }
  }
  return result;
}
