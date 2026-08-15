import {
  Fragment,
  type AnyDoperElement,
  type DoperElement,
  type DoperNode,
  type ElementType,
  type Key,
} from "./types.js";

/** Stable element brand shared across package copies and realms. */
export const DOPER_ELEMENT_TYPE: symbol = Symbol.for("dopejs.doper.element");

/** Creates an immutable-shape element descriptor for the automatic JSX transform. */
export function createElement<Props extends Record<string, unknown>>(
  type: ElementType<Props>,
  inputProps: Props | null,
  explicitKey?: Key,
): DoperElement<Props> {
  const source = (inputProps ?? ({} as Props)) as Props & { readonly key?: Key };
  const key = explicitKey ?? source.key ?? null;
  const props =
    source.key === undefined
      ? source
      : Object.fromEntries(Object.entries(source).filter(([name]) => name !== "key"));
  return {
    $$typeof: DOPER_ELEMENT_TYPE,
    type,
    key,
    props: props as Readonly<Props>,
  };
}

/** Returns whether an unknown value is a doper element descriptor. */
export function isDoperElement(value: unknown): value is AnyDoperElement {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly $$typeof?: unknown }).$$typeof === DOPER_ELEMENT_TYPE
  );
}

/** Flattens fragments/arrays and drops boolean/null placeholders deterministically. */
export function normalizeChildren(node: DoperNode): Array<AnyDoperElement | string> {
  const result: Array<AnyDoperElement | string> = [];
  const stack: DoperNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined || typeof current === "boolean") continue;
    if (Array.isArray(current)) {
      const children = current as readonly DoperNode[];
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    } else if (isDoperElement(current) && current.type === Fragment) {
      const children = (current.props as { readonly children?: DoperNode }).children;
      stack.push(children);
    } else if (isDoperElement(current)) {
      result.push(current);
    } else if (
      typeof current === "string" ||
      typeof current === "number" ||
      typeof current === "bigint"
    ) {
      result.push(String(current));
    } else {
      throw new TypeError("invalid doper child value");
    }
  }
  return result;
}
