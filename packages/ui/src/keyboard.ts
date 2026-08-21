import { isPingoElement, type PingoNode } from "@dopejs/pingo-jsx";

/**
 * Values of the caller's own children, in document order.
 *
 * Reading the declared `value` off each child avoids a registration pass:
 * children register during render, but a memoized child that does not re-render
 * never registers again, so a registry drifts from what is actually on screen.
 * The children array cannot drift — it is the render.
 */
export function orderedValues(children: PingoNode): readonly string[] {
  const values: string[] = [];
  collect(children, values);
  return values;
}

function collect(node: PingoNode, values: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child as PingoNode, values);
    return;
  }
  if (!isPingoElement(node)) return;
  const value = (node.props as { readonly value?: unknown }).value;
  if (typeof value === "string") values.push(value);
}

/** Which arrow keys move along a group's axis. */
export type NavigationAxis = "horizontal" | "vertical" | "both";

/**
 * The value an arrow, Home or End press should move to, or `undefined`.
 *
 * Movement wraps, which is what WAI-ARIA specifies for tabs, radio groups and
 * menus. Returning `undefined` means the press was not navigation and must be
 * left alone, so a handler never swallows a key it did not act on.
 */
export function step(
  values: readonly string[],
  current: string | undefined,
  key: string,
  axis: NavigationAxis,
): string | undefined {
  if (values.length === 0) return undefined;
  if (key === "Home") return values[0];
  if (key === "End") return values.at(-1);
  const forward =
    (axis !== "vertical" && key === "ArrowRight") || (axis !== "horizontal" && key === "ArrowDown");
  const backward =
    (axis !== "vertical" && key === "ArrowLeft") || (axis !== "horizontal" && key === "ArrowUp");
  if (!forward && !backward) return undefined;
  const index = current === undefined ? -1 : values.indexOf(current);
  // An unknown current value starts navigation at whichever end the press
  // implies, so a group with nothing selected still responds to the first key.
  if (index < 0) return forward ? values[0] : values.at(-1);
  const length = values.length;
  return values[(index + (forward ? 1 : length - 1)) % length];
}
