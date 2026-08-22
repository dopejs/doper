import { memo, Text, View, type PingoEvent, type PingoNode } from "@dopejs/pingo-jsx";
import { useSignal } from "@dopejs/pingo-runtime";

import { classes } from "../overlay";
import { useTheme } from "../theme";

export type CarouselProps = {
  readonly items: readonly PingoNode[];
  readonly index?: number;
  readonly defaultIndex?: number;
  readonly onIndexChange?: (index: number) => void;
  /** Wraps from the last slide to the first and back. */
  readonly loop?: boolean;
  readonly transitionMs?: number;
  readonly previousLabel?: string;
  readonly nextLabel?: string;
  readonly className?: string;
};

/** Index reached by moving `delta` slides, honouring `loop`. */
export function carouselStep(index: number, delta: number, count: number, loop: boolean): number {
  if (count <= 0) return 0;
  const raw = index + delta;
  if (!loop) return Math.min(Math.max(raw, 0), count - 1);
  // Modulo twice so a negative delta wraps to the end rather than to a
  // negative index, which would translate the track off-screen.
  return ((raw % count) + count) % count;
}

/** Pure builder: safe to call without a component scope (tests use this). */
export function carouselDescriptor(props: CarouselProps, index: number): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const count = props.items.length;
  const loop = props.loop === true;
  const go = (delta: number): void => {
    const next = carouselStep(index, delta, count, loop);
    if (next !== index) props.onIndexChange?.(next);
  };
  const control = (label: string, delta: number, name: string): PingoNode => {
    const enabled = count > 0 && (loop || carouselStep(index, delta, count, loop) !== index);
    return Text({
      className: classes(
        "pui-carousel__control",
        enabled ? undefined : "pui-carousel__control--disabled",
        dark,
      ),
      value: label,
      semanticRole: "button",
      semanticLabel: name,
      ...(enabled
        ? {
            onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
            onTap: () => go(delta),
            onClick: () => go(delta),
          }
        : {}),
    });
  };
  return View({
    className: classes("pui-carousel", props.className),
    semanticRole: "group",
    onKeyDown: (event: PingoEvent): void => {
      const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      go(delta);
    },
    children: [
      View({
        className: "pui-carousel__viewport",
        children: View({
          className: "pui-carousel__track",
          direction: "row",
          // transform, not `left`: the engine can animate transform and opacity
          // and nothing else, so this is the only property that can move
          // smoothly rather than jumping.
          style: { transform: `translateX(${-index * 100}%)` },
          transition: { property: "transform", durationMs: props.transitionMs ?? 300 },
          children: props.items.map((item, slide) =>
            View({
              className: "pui-carousel__slide",
              key: String(slide),
              ...(slide === index ? { semanticValue: "current" } : {}),
              children: item,
            }),
          ),
        }),
      }),
      View({
        className: "pui-carousel__controls",
        direction: "row",
        children: [
          control(props.previousLabel ?? "‹", -1, "previous slide"),
          control(props.nextLabel ?? "›", 1, "next slide"),
        ],
      }),
    ],
  });
}

/** shadcn-style carousel. JSX-only: uses hooks. */
export const Carousel = memo(function CarouselImpl(props: CarouselProps): PingoNode {
  const internal = useSignal(props.defaultIndex ?? 0);
  // .get() (not .peek()): advancing must re-render this component.
  const index = props.index ?? internal.get();
  return carouselDescriptor(
    {
      ...props,
      onIndexChange: (next) => {
        internal.set(next);
        props.onIndexChange?.(next);
      },
    },
    index,
  );
});
