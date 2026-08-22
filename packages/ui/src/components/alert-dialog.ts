import { memo, Text, View, type PingoNode } from "@dopejs/pingo-jsx";

import { classes, useOverlayFocus } from "../overlay";
import { useTheme } from "../theme";

import { dialogDescriptor, type DialogProps } from "./dialog";

export type AlertDialogProps = DialogProps & {
  readonly title: string;
  readonly description?: string;
  readonly cancelLabel?: string;
  readonly actionLabel?: string;
  readonly onCancel?: () => void;
  readonly onAction?: () => void;
  /** Colours the confirm action as destructive. */
  readonly destructive?: boolean;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function alertDialogDescriptor(
  props: AlertDialogProps,
  focus: ReturnType<typeof useOverlayFocus>,
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const close = (): void => props.onOpenChange?.(false);
  const cancel = (): void => {
    props.onCancel?.();
    close();
  };
  const act = (): void => {
    props.onAction?.();
    close();
  };
  const button = (
    label: string,
    press: () => void,
    variant: "cancel" | "action",
    order: number,
  ): PingoNode =>
    View({
      className: classes(
        "pui-alert-dialog__button",
        `pui-alert-dialog__button--${variant}`,
        variant === "action" && props.destructive === true
          ? "pui-alert-dialog__button--destructive"
          : undefined,
        dark,
      ),
      semanticRole: "button",
      ref: focus.focusable(order),
      onTap: press,
      onClick: press,
      children: Text({ className: "pui-alert-dialog__label", value: label }),
    });
  return dialogDescriptor(
    {
      ...props,
      children: [
        Text({ className: classes("pui-overlay__title", dark), value: props.title }),
        props.description === undefined
          ? null
          : Text({
              className: classes("pui-overlay__description", dark),
              value: props.description,
            }),
        View({
          className: "pui-alert-dialog__actions",
          direction: "row",
          children: [
            button(props.cancelLabel ?? "取消", cancel, "cancel", 0),
            button(props.actionLabel ?? "确定", act, "action", 1),
          ],
        }),
      ],
    },
    focus,
  );
}

/**
 * shadcn-style confirmation dialog. JSX-only: uses hooks.
 *
 * A Dialog with the confirm/cancel pair built in, and both buttons registered
 * in the Tab cycle — a keyboard user reaching neither of them is the failure
 * mode this shape exists to prevent. Mount it near the root, like Dialog.
 *
 * The backdrop still closes it. shadcn's AlertDialog is modal in the stronger
 * sense of refusing dismissal, but that would need a distinct backdrop
 * behaviour rather than a prop, and no caller has asked for it yet.
 */
export const AlertDialog = memo(function AlertDialogImpl(props: AlertDialogProps): PingoNode {
  return alertDialogDescriptor(props, useOverlayFocus());
});
