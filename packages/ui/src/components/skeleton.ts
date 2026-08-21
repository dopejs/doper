import { memo, View, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type SkeletonProps = {
  readonly width?: number;
  readonly height?: number;
  readonly className?: string;
};

function SkeletonImpl(props: SkeletonProps): PingoNode {
  const theme = useTheme();
  const className = ["pui-skeleton", theme === "dark" ? "pui-dark" : undefined, props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return View({
    className,
    ...(props.width === undefined ? {} : { width: props.width }),
    ...(props.height === undefined ? {} : { height: props.height }),
  });
}

/**
 * shadcn-style skeleton placeholder (static; no pulse animation yet).
 * Memoized: re-renders only when props change.
 */
export const Skeleton = memo(SkeletonImpl);
