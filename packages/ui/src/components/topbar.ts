import { memo, Text, View, type PingoNode } from "@dopejs/pingo-jsx";

import { classes } from "../overlay";
import { useTheme } from "../theme";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type TopBarProps = {
  readonly title?: string;
  /** Leading slot, for a logo or a back affordance. */
  readonly leading?: PingoNode;
  /** Trailing slot; pushed to the far edge by the title column. */
  readonly actions?: PingoNode;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function topBarDescriptor(props: TopBarProps): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  return View({
    className: classes("pui-topbar", dark, props.className),
    semanticRole: "banner",
    children: [
      ...(props.leading === undefined ? [] : [props.leading]),
      // The title column grows, which is what puts the actions on the far
      // edge without anyone measuring anything. It is rendered even with no
      // title so the actions still end up there.
      props.title === undefined
        ? View({ className: "pui-topbar__title" })
        : Text({ className: "pui-topbar__title", value: props.title, semanticRole: "heading" }),
      ...(props.actions === undefined
        ? []
        : [View({ className: "pui-topbar__actions", children: props.actions })]),
    ],
  });
}

/** Application header row. Memoized: re-renders only when props change. */
export const TopBar = memo(topBarDescriptor);
