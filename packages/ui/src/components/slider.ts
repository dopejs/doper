import { memo, View, type PingoEvent, type PingoNode, type ViewHandle } from "@dopejs/pingo-jsx";
import { useLayoutValue, useSignal, type LayoutGeometry } from "@dopejs/pingo-runtime";

import { createDrag, positionToValue, type DragHandlers } from "../drag";
import { classes } from "../overlay";
import { useTheme } from "../theme";

export type SliderProps = {
  readonly value?: number;
  readonly defaultValue?: number;
  readonly onValueChange?: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly disabled?: boolean;
  readonly semanticLabel?: string;
  readonly className?: string;
};

/** Fraction of the track the value sits at, clamped to `[0, 1]`. */
export function sliderRatio(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  return Math.min(Math.max((value - min) / (max - min), 0), 1);
}

/** Pure builder: safe to call without a component scope (tests use this). */
export function sliderDescriptor(
  props: SliderProps,
  value: number,
  handlers: DragHandlers | undefined,
  attach: (handle: ViewHandle | null) => void,
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const disabled = props.disabled === true;
  const percent: `${number}%` = `${sliderRatio(value, min, max) * 100}%`;
  const nudge = (delta: number): void => {
    const next = Math.min(Math.max(value + delta, min), max);
    if (next !== value) props.onValueChange?.(next);
  };
  return View({
    className: classes(
      "pui-slider",
      disabled ? "pui-slider--disabled" : undefined,
      dark,
      props.className,
    ),
    semanticRole: "slider",
    semanticValue: String(value),
    ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
    ref: attach,
    ...(disabled || handlers === undefined ? {} : handlers),
    ...(disabled
      ? {}
      : {
          onKeyDown: (event: PingoEvent): void => {
            const step = props.step ?? 1;
            const delta =
              event.key === "ArrowLeft" || event.key === "ArrowDown"
                ? -step
                : event.key === "ArrowRight" || event.key === "ArrowUp"
                  ? step
                  : event.key === "Home"
                    ? min - value
                    : event.key === "End"
                      ? max - value
                      : 0;
            if (delta === 0) return;
            event.preventDefault();
            nudge(delta);
          },
        }),
    children: [
      View({ className: classes("pui-slider__track", dark) }),
      // Width as a percentage of the track: the filled range follows the value
      // without the Shell needing to know the track's pixel width.
      View({ className: classes("pui-slider__range", dark), style: { width: percent } }),
      View({ className: classes("pui-slider__thumb", dark), style: { left: percent } }),
    ],
  });
}

/** shadcn-style slider. JSX-only: uses hooks. */
export const Slider = memo(function SliderImpl(props: SliderProps): PingoNode {
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const internal = useSignal(props.defaultValue ?? min);
  // .get() (not .peek()): an uncontrolled drag must re-render this component.
  const value = props.value ?? internal.get();
  const [attach, geometry] = useLayoutValue((measured: LayoutGeometry) => measured.bounds);
  const commit = (position: number): void => {
    // The track's own measured box is the mapping's basis. Without it the
    // pointer position is in world coordinates and means nothing here, which
    // is why Slider is the first component to need E8's readback.
    if (geometry === undefined) return;
    const next = positionToValue(
      position,
      { start: geometry.left, length: geometry.width },
      { min, max, ...(props.step === undefined ? {} : { step: props.step }) },
    );
    if (next === value) return;
    internal.set(next);
    props.onValueChange?.(next);
  };
  const handlers = createDrag({
    onStart: (position) => commit(position[0]),
    onMove: (_delta, position) => commit(position[0]),
  });
  return sliderDescriptor(
    {
      ...props,
      onValueChange: (next) => {
        internal.set(next);
        props.onValueChange?.(next);
      },
    },
    value,
    handlers,
    attach,
  );
});
