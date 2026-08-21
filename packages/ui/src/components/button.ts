import { memo, Text, type PingoNode } from "@dopejs/pingo-jsx";
import { Pressable } from "@dopejs/pingo-widgets";

import { cva } from "../cva";
import { useTheme } from "../theme";

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "default" | "sm" | "lg" | "icon";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type ButtonProps = {
  readonly children: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly className?: string;
  readonly semanticLabel?: string;
};

const buttonClass = cva({
  base: "pui-button",
  variants: {
    variant: {
      default: "pui-button--default",
      secondary: "pui-button--secondary",
      outline: "pui-button--outline",
      ghost: "pui-button--ghost",
      destructive: "pui-button--destructive",
    },
    size: {
      default: "",
      sm: "pui-button--sm",
      lg: "pui-button--lg",
      icon: "pui-button--icon",
    },
    theme: { light: "", dark: "pui-dark" },
    disabled: { true: "pui-button--disabled" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

function ButtonImpl(props: ButtonProps): PingoNode {
  const theme = useTheme();
  const disabled = props.disabled === true;
  const className = [
    buttonClass({ variant: props.variant, size: props.size, theme, disabled }),
    props.className,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return Pressable({
    className,
    disabled,
    ...(props.onPress === undefined ? {} : { onPress: props.onPress }),
    semanticLabel: props.semanticLabel ?? props.children,
    children: Text({ value: props.children }),
  });
}

/**
 * shadcn-style button. Visuals come entirely from the skin classes; text
 * color and font inherit from the View into the inner Text node. Memoized:
 * re-renders only when props change.
 */
export const Button = memo(ButtonImpl);
