import { memo, View, type PingoEvent, type PingoNode, type ViewHandle } from "@dopejs/pingo-jsx";
import { useLayoutValue, useSignal, type LayoutGeometry } from "@dopejs/pingo-runtime";

import { createDrag, type DragHandlers } from "../drag";
import { classes } from "../overlay";
import { useTheme } from "../theme";

export type ResizableProps = {
  readonly first: PingoNode;
  readonly second: PingoNode;
  /** Fraction of the container the first pane takes, in `[0, 1]`. */
  readonly split?: number;
  readonly defaultSplit?: number;
  readonly onSplitChange?: (split: number) => void;
  readonly direction?: "row" | "column";
  readonly minSplit?: number;
  readonly maxSplit?: number;
  readonly disabled?: boolean;
  readonly className?: string;
};

/**
 * Clamps a split and rejects a nonsensical one.
 *
 * A caller can pass anything, and a split outside `[0, 1]` collapses a pane
 * to a negative basis, which reads as a layout bug far from its cause.
 */
export function clampSplit(split: number, minimum = 0.1, maximum = 0.9): number {
  const low = Math.max(0, Math.min(minimum, maximum));
  const high = Math.min(1, Math.max(minimum, maximum));
  // Only NaN needs special handling: it has no side to clamp towards, whereas
  // an infinity clamps to the bound it is heading for like any other number.
  if (Number.isNaN(split)) return low;
  return Math.min(Math.max(split, low), high);
}

/** Pure builder: safe to call without a component scope (tests use this). */
export function resizableDescriptor(
  props: ResizableProps,
  split: number,
  handlers: DragHandlers | undefined,
  attach?: (handle: ViewHandle | null) => void,
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const column = props.direction === "column";
  const disabled = props.disabled === true;
  const clamped = clampSplit(split, props.minSplit, props.maxSplit);
  const basis = (fraction: number): `${number}%` => `${fraction * 100}%`;
  const nudge = (delta: number): void => {
    const next = clampSplit(clamped + delta, props.minSplit, props.maxSplit);
    if (next !== clamped) props.onSplitChange?.(next);
  };
  return View({
    className: classes("pui-resizable", props.className),
    direction: column ? "column" : "row",
    ...(attach === undefined ? {} : { ref: attach }),
    children: [
      View({
        className: "pui-resizable__pane",
        style: column ? { height: basis(clamped) } : { width: basis(clamped) },
        children: props.first,
      }),
      View({
        className: classes(
          "pui-resizable__handle",
          column ? "pui-resizable__handle--column" : "pui-resizable__handle--row",
          disabled ? "pui-resizable__handle--disabled" : undefined,
          dark,
        ),
        semanticRole: "separator",
        semanticValue: String(Math.round(clamped * 100)),
        ...(disabled || handlers === undefined ? {} : handlers),
        ...(disabled
          ? {}
          : {
              onKeyDown: (event: PingoEvent): void => {
                const back = column ? "ArrowUp" : "ArrowLeft";
                const forward = column ? "ArrowDown" : "ArrowRight";
                const delta = event.key === back ? -0.02 : event.key === forward ? 0.02 : 0;
                if (delta === 0) return;
                event.preventDefault();
                nudge(delta);
              },
            }),
      }),
      View({
        className: "pui-resizable__pane",
        // The second pane takes the remainder rather than a computed
        // percentage, so the two can never disagree about the total.
        style: { flex: "1 1 0px" },
        children: props.second,
      }),
    ],
  });
}

/** shadcn-style resizable pair. JSX-only: uses hooks. */
export const Resizable = memo(function ResizableImpl(props: ResizableProps): PingoNode {
  const internal = useSignal(props.defaultSplit ?? 0.5);
  // .get() (not .peek()): dragging the handle must re-render this component.
  const split = props.split ?? internal.get();
  // The container's measured box turns a pointer delta in pixels into a
  // fraction of the split. Without it the handle would move and nothing else
  // would, which is the failure this measurement exists to prevent.
  const [attach, bounds] = useLayoutValue((measured: LayoutGeometry) => measured.bounds);
  const handlers = createDrag({
    onMove: (delta) => {
      const extent = props.direction === "column" ? bounds?.height : bounds?.width;
      if (extent === undefined || !(extent > 0)) return;
      const moved = (props.direction === "column" ? delta[1] : delta[0]) / extent;
      const next = clampSplit(split + moved, props.minSplit, props.maxSplit);
      if (next === split) return;
      internal.set(next);
      props.onSplitChange?.(next);
    },
  });
  return resizableDescriptor(
    {
      ...props,
      onSplitChange: (next) => {
        internal.set(next);
        props.onSplitChange?.(next);
      },
    },
    split,
    handlers,
    attach,
  );
});
