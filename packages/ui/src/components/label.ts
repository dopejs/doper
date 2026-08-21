import { memo, Text, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type LabelProps = {
  readonly children: string;
  readonly className?: string;
  readonly semanticLabel?: string;
};

function LabelImpl(props: LabelProps): PingoNode {
  const theme = useTheme();
  const className = ["pui-label", theme === "dark" ? "pui-dark" : undefined, props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return Text({
    className,
    value: props.children,
    ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
  });
}

/**
 * shadcn-style form label. No control association exists in pingo yet.
 * Memoized: re-renders only when props change.
 */
export const Label = memo(LabelImpl);
