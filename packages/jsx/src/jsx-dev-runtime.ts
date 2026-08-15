import { createElement } from "./element.js";
import { Fragment, type DoperElement, type ElementType, type JSX, type Key } from "./types.js";

/** Development JSX transform with source arguments intentionally excluded from runtime state. */
export function jsxDEV<Props extends Record<string, unknown>>(
  type: ElementType<Props>,
  props: Props,
  key: Key | undefined,
  _isStaticChildren: boolean,
  _source: unknown,
  _self: unknown,
): DoperElement<Props> {
  return createElement(type, props, key);
}

export { Fragment, type JSX };
