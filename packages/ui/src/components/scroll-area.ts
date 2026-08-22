import {
  memo,
  Scroll,
  View,
  type NodeHandle,
  type PingoNode,
  type ViewHandle,
} from "@dopejs/pingo-jsx";
import { useLayoutValue, type LayoutGeometry } from "@dopejs/pingo-runtime";

import { classes } from "../overlay";
import { useTheme } from "../theme";

export type ScrollAreaProps = {
  readonly children: PingoNode;
  /** Hides the drawn scrollbar; Core still scrolls. */
  readonly hideScrollbar?: boolean;
  readonly className?: string;
};

/** Thumb geometry as fractions of the track, or `undefined` when unneeded. */
export function scrollbarThumb(
  viewportTop: number,
  viewportHeight: number,
  contentTop: number,
  contentHeight: number,
): { readonly offset: number; readonly length: number } | undefined {
  if (!(viewportHeight > 0) || !(contentHeight > viewportHeight)) return undefined;
  const length = Math.min(viewportHeight / contentHeight, 1);
  // The content is translated upwards as it scrolls, so the offset is how far
  // its top has moved above the viewport's — there is no scroll position to
  // read, only the two boxes.
  const scrolled = viewportTop - contentTop;
  const range = contentHeight - viewportHeight;
  const offset = Math.min(Math.max(scrolled / range, 0), 1) * (1 - length);
  return { offset, length };
}

/** Pure builder: safe to call without a component scope (tests use this). */
export function scrollAreaDescriptor(
  props: ScrollAreaProps,
  refs: {
    readonly viewport: (handle: NodeHandle | null) => void;
    readonly content: (handle: ViewHandle | null) => void;
  },
  thumb: { readonly offset: number; readonly length: number } | undefined,
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  return View({
    className: classes("pui-scroll-area", props.className),
    children: [
      Scroll({
        className: "pui-scroll-area__viewport",
        ref: refs.viewport,
        children: View({
          className: "pui-scroll-area__content",
          ref: refs.content,
          children: props.children,
        }),
      }),
      thumb === undefined || props.hideScrollbar === true
        ? null
        : View({
            className: classes("pui-scroll-area__bar", dark),
            children: View({
              className: classes("pui-scroll-area__thumb", dark),
              style: {
                height: `${thumb.length * 100}%`,
                marginTop: `${thumb.offset * 100}%`,
              },
            }),
          }),
    ],
  });
}

/**
 * shadcn-style scroll area with a drawn scrollbar. JSX-only: uses hooks.
 *
 * Core owns the scrolling; the bar is derived from the measured boxes of the
 * viewport and its content, because the engine exposes no scroll position.
 *
 * **The thumb lags by one frame.** Measurement arrives a frame after the layout
 * it describes, which is visible during a fling. Fixing it properly means
 * Core-rendered scrollbars; see docs/pingo-ui-shadcn-parity-plan.md D2.
 */
export const ScrollArea = memo(function ScrollAreaImpl(props: ScrollAreaProps): PingoNode {
  const [viewport, viewportBounds] = useLayoutValue((measured: LayoutGeometry) => measured.bounds);
  const [content, contentBounds] = useLayoutValue((measured: LayoutGeometry) => measured.bounds);
  const thumb =
    viewportBounds === undefined || contentBounds === undefined
      ? undefined
      : scrollbarThumb(
          viewportBounds.top,
          viewportBounds.height,
          contentBounds.top,
          contentBounds.height,
        );
  return scrollAreaDescriptor(props, { viewport, content }, thumb);
});
