import { createElement } from "./element";
import { Fragment, type DoperElement, type ElementType, type JSX, type Key } from "./types";

/** Automatic JSX transform entry point for one child. */
export function jsx<Props extends Record<string, unknown>>(
  type: ElementType<Props>,
  props: Props,
  key?: Key,
): DoperElement<Props> {
  return createElement(type, props, key);
}

/** Automatic JSX transform entry point for static/multiple children. */
export const jsxs = jsx;

export { Fragment, type JSX };
