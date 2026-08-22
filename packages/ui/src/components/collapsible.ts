import { memo, Text, View, type PingoEvent, type PingoNode } from "@dopejs/pingo-jsx";
import { useSignal } from "@dopejs/pingo-runtime";

import { classes } from "../overlay";
import { useTheme } from "../theme";

// Type aliases (not interfaces) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type CollapsibleProps = {
  readonly trigger: string;
  readonly children: PingoNode;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly disabled?: boolean;
  readonly className?: string;
};

/**
 * Builds the Collapsible tree. Pure: safe to call without a component scope.
 *
 * The content stays mounted and is hidden with `display: none`, matching
 * Accordion: unmounting would discard scroll position and any editing state
 * inside, and re-mounting is the more expensive of the two.
 */
export function collapsibleDescriptor(props: CollapsibleProps, open: boolean): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const disabled = props.disabled === true;
  const toggle = (): void => props.onOpenChange?.(!open);
  return View({
    className: classes("pui-collapsible", props.className),
    children: [
      View({
        className: classes(
          "pui-collapsible__trigger",
          disabled ? "pui-collapsible__trigger--disabled" : undefined,
          dark,
        ),
        direction: "row",
        semanticRole: "button",
        semanticValue: open ? "expanded" : "collapsed",
        // A disabled trigger carries no handlers at all rather than handlers
        // that return early, so nothing can observe a press that does nothing.
        ...(disabled
          ? {}
          : {
              onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
              onTap: toggle,
              onClick: toggle,
              onKeyDown: (event: PingoEvent): void => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                toggle();
              },
            }),
        children: [
          Text({ className: classes("pui-collapsible__label", dark), value: props.trigger }),
          Text({
            className: classes("pui-collapsible__indicator", dark),
            value: open ? "▾" : "▸",
          }),
        ],
      }),
      View({
        className: classes("pui-collapsible__content", dark),
        style: { display: open ? "flex" : "none" },
        children: props.children,
      }),
    ],
  });
}

/**
 * shadcn-style collapsible section. JSX-only: uses hooks.
 *
 * This is Accordion's single-item primitive, extracted so a caller that needs
 * one disclosure does not have to stand up a single-item Accordion and inherit
 * its exclusive-selection semantics.
 */
export const Collapsible = memo(function CollapsibleImpl(props: CollapsibleProps): PingoNode {
  const internal = useSignal(props.defaultOpen === true);
  // .get() (not .peek()): an uncontrolled toggle must re-render this component.
  const open = props.open ?? internal.get();
  return collapsibleDescriptor(
    {
      ...props,
      onOpenChange: (next) => {
        internal.set(next);
        props.onOpenChange?.(next);
      },
    },
    open,
  );
});
