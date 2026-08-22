import { memo, Text, View, type PingoEvent, type PingoNode } from "@dopejs/pingo-jsx";

import { classes } from "../overlay";
import { useTheme } from "../theme";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type ListRowProps = {
  readonly title: string;
  readonly description?: string;
  /** Leading slot, for an avatar or an icon. */
  readonly leading?: PingoNode;
  /** Trailing slot, for a badge, a switch or a chevron. */
  readonly trailing?: PingoNode;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function listRowDescriptor(props: ListRowProps): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const disabled = props.disabled === true;
  const interactive = !disabled && props.onPress !== undefined;
  const press = (): void => props.onPress?.();
  return View({
    className: classes(
      "pui-list-row",
      interactive ? "pui-list-row--interactive" : undefined,
      props.selected === true ? "pui-list-row--selected" : undefined,
      disabled ? "pui-list-row--disabled" : undefined,
      dark,
      props.className,
    ),
    semanticRole: interactive ? "button" : "listitem",
    semanticLabel: props.title,
    ...(props.selected === undefined
      ? {}
      : { semanticValue: props.selected ? "selected" : "unselected" }),
    // A disabled row carries no handlers at all rather than guarding inside
    // them, matching RadioGroupItem: nothing to fire is stronger than a
    // handler that decides not to.
    ...(interactive
      ? {
          onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
          onTap: press,
          onClick: press,
        }
      : {}),
    children: [
      ...(props.leading === undefined ? [] : [props.leading]),
      // The text column takes whatever the slots leave, so the trailing slot
      // sits on the far edge whatever the title's length.
      View({
        className: "pui-list-row__text",
        children: [
          Text({ className: "pui-list-row__title", value: props.title }),
          ...(props.description === undefined
            ? []
            : [
                Text({
                  className: classes("pui-list-row__description", dark),
                  value: props.description,
                }),
              ]),
        ],
      }),
      ...(props.trailing === undefined ? [] : [props.trailing]),
    ],
  });
}

/** One row of a list. Memoized: re-renders only when props change. */
export const ListRow = memo(listRowDescriptor);
