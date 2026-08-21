import { memo, View, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type DividerProps = {
  readonly orientation?: "horizontal" | "vertical";
  readonly className?: string;
};

function DividerImpl(props: DividerProps): PingoNode {
  const theme = useTheme();
  const className = [
    "pui-divider",
    props.orientation === "vertical" ? "pui-divider--vertical" : undefined,
    theme === "dark" ? "pui-dark" : undefined,
    props.className,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return View({ className });
}

/** shadcn-style separator. Memoized: re-renders only when props change. */
export const Divider = memo(DividerImpl);
