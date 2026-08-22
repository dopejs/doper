import { memo, View, type NodeHandle, type PingoNode } from "@dopejs/pingo-jsx";
import { useLayoutValue, type LayoutGeometry } from "@dopejs/pingo-runtime";

import { classes } from "../overlay";

export type AspectRatioProps = {
  /** Width divided by height; 16 / 9 for widescreen. */
  readonly ratio?: number;
  readonly children: PingoNode;
  readonly className?: string;
};

/** Height implied by a measured width, or `undefined` when either is unusable. */
export function ratioHeight(width: number | undefined, ratio: number): number | undefined {
  if (width === undefined || !(width > 0) || !(ratio > 0) || !Number.isFinite(ratio)) {
    return undefined;
  }
  return width / ratio;
}

/** Pure builder: safe to call without a component scope (tests use this). */
export function aspectRatioDescriptor(
  props: AspectRatioProps,
  height: number | undefined,
  attach: (handle: NodeHandle | null) => void,
): PingoNode {
  return View({
    className: classes("pui-aspect-ratio", props.className),
    ref: attach,
    // No height until the width is known. Guessing one would lay the subtree
    // out at the wrong size and then move it, which is worse than a frame of
    // zero height for a box whose whole job is to reserve space correctly.
    ...(height === undefined ? {} : { style: { height } }),
    children: props.children,
  });
}

/**
 * shadcn-style aspect-ratio box. JSX-only: uses hooks.
 *
 * `aspect-ratio` is not in the CSS subset, so this measures its own width and
 * sets a height from it. That costs one frame: the box has no height until the
 * measurement arrives. Putting the property in the subset would remove both
 * the lag and this component; that is a subset decision, recorded as follow-up
 * in docs/pingo-ui-shadcn-parity-plan.md.
 */
export const AspectRatio = memo(function AspectRatioImpl(props: AspectRatioProps): PingoNode {
  const [attach, bounds] = useLayoutValue((measured: LayoutGeometry) => measured.bounds);
  return aspectRatioDescriptor(props, ratioHeight(bounds?.width, props.ratio ?? 1), attach);
});
