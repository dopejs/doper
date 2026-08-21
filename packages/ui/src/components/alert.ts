import { memo, Text, View, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

export type AlertVariant = "default" | "destructive";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type AlertProps = {
  readonly title: string;
  readonly children: string;
  readonly variant?: AlertVariant;
  readonly className?: string;
};

function join(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== "").join(" ");
}

function AlertImpl(props: AlertProps): PingoNode {
  const theme = useTheme();
  const dark = theme === "dark" ? "pui-dark" : undefined;
  const destructive = props.variant === "destructive";
  return View({
    className: join(
      "pui-alert",
      destructive ? "pui-alert--destructive" : undefined,
      dark,
      props.className,
    ),
    children: [
      Text({
        className: join(
          "pui-alert__title",
          destructive ? "pui-alert__title--destructive" : undefined,
          dark,
        ),
        value: props.title,
      }),
      Text({ className: join("pui-alert__description", dark), value: props.children }),
    ],
  });
}

/** shadcn-style alert callout. Memoized: re-renders only when props change. */
export const Alert = memo(AlertImpl);
