import { memo, Text, View, type PingoNode } from "@dopejs/pingo-jsx";

import { cva } from "../cva";
import { useTheme } from "../theme";

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type BadgeProps = {
  readonly children: string;
  readonly variant?: BadgeVariant;
  readonly className?: string;
  readonly semanticLabel?: string;
};

const badgeClass = cva({
  base: "pui-badge",
  variants: {
    variant: {
      default: "pui-badge--default",
      secondary: "pui-badge--secondary",
      destructive: "pui-badge--destructive",
      outline: "pui-badge--outline",
    },
    theme: { light: "", dark: "pui-dark" },
  },
  defaultVariants: { variant: "default" },
});

function BadgeImpl(props: BadgeProps): PingoNode {
  const theme = useTheme();
  const className = [badgeClass({ variant: props.variant, theme }), props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return View({
    className,
    ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
    children: Text({ value: props.children }),
  });
}

/** shadcn-style badge: non-interactive status label. Memoized: re-renders only when props change. */
export const Badge = memo(BadgeImpl);
