import { memo, Text, View, type PingoNode } from "@dopejs/pingo-jsx";

import { classes } from "../overlay";
import { useTheme } from "../theme";

export type ToastVariant = "default" | "destructive";

export type ToastProps = {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly variant?: ToastVariant;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function toastDescriptor(props: ToastProps): PingoNode {
  if (!props.open) return null;
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const destructive = props.variant === "destructive";
  return View({
    className: classes(
      "pui-toast",
      destructive ? "pui-toast--destructive" : undefined,
      dark,
      props.className,
    ),
    semanticRole: "status",
    children: [
      Text({ className: "pui-toast__title", value: props.title }),
      ...(props.description === undefined
        ? []
        : [
            Text({
              // A destructive toast already inverts its foreground; muting it
              // again would put grey on red.
              className: classes(
                destructive ? undefined : "pui-toast__description",
                destructive ? undefined : dark,
              ),
              value: props.description,
            }),
          ]),
    ],
  });
}

/** shadcn-style toast. Uses no hooks: `Toast.component(props)` is safe directly. */
export const Toast = memo(toastDescriptor);

export type ToastViewportProps = { readonly children: PingoNode; readonly className?: string };

/**
 * Corner stack for toasts.
 *
 * Absolutely positioned against *its own parent*, because the containing block
 * in this engine is the parent rather than the nearest positioned ancestor.
 * Mount it near the root; see docs/style-support.md.
 */
export const ToastViewport = memo(function ToastViewportImpl(props: ToastViewportProps): PingoNode {
  return View({
    className: classes("pui-toast__viewport", props.className),
    children: props.children,
  });
});
