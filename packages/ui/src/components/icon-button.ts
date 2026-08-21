import { memo, type PingoNode } from "@dopejs/pingo-jsx";
import { Pressable } from "@dopejs/pingo-widgets";

import { cva } from "../cva";
import { useTheme } from "../theme";
import type { ButtonVariant } from "./button";

export type IconButtonSize = "default" | "sm" | "lg";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type IconButtonProps = {
  /** Icon slot: passed through untouched (slot identity contract). */
  readonly icon: PingoNode;
  /** Icon-only buttons must carry an accessible label. */
  readonly semanticLabel: string;
  readonly variant?: ButtonVariant;
  readonly size?: IconButtonSize;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly className?: string;
};

const iconButtonClass = cva({
  base: "pui-button pui-button--icon",
  variants: {
    variant: {
      default: "pui-button--default",
      secondary: "pui-button--secondary",
      outline: "pui-button--outline",
      ghost: "pui-button--ghost",
      destructive: "pui-button--destructive",
    },
    size: { default: "", sm: "pui-button--sm", lg: "pui-button--lg" },
    theme: { light: "", dark: "pui-dark" },
    disabled: { true: "pui-button--disabled" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

function IconButtonImpl(props: IconButtonProps): PingoNode {
  const theme = useTheme();
  const disabled = props.disabled === true;
  const className = [
    iconButtonClass({ variant: props.variant, size: props.size, theme, disabled }),
    props.className,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return Pressable({
    className,
    disabled,
    semanticLabel: props.semanticLabel,
    ...(props.onPress === undefined ? {} : { onPress: props.onPress }),
    children: props.icon,
  });
}

/**
 * shadcn-style icon button. Memoized: re-renders only when props change.
 *
 * Known limitation: the button skin has no `.pui-button--icon.pui-button--sm`
 * compound rule, so for `size: "sm"`/`"lg"` the icon sizing wins (it comes
 * later in source order) and the size modifier has no visual effect.
 */
export const IconButton = memo(IconButtonImpl);
