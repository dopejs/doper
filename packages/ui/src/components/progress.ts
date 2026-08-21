import { memo, View, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type ProgressProps = {
  readonly value: number;
  readonly max?: number;
  readonly className?: string;
};

function ProgressImpl(props: ProgressProps): PingoNode {
  const theme = useTheme();
  const dark = theme === "dark" ? "pui-dark" : undefined;
  const max = props.max ?? 100;
  const pct = Math.min(100, Math.max(0, (props.value / max) * 100));
  const className = ["pui-progress", dark, props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return View({
    className,
    children: View({
      className: ["pui-progress__indicator", dark].filter((part) => part !== undefined).join(" "),
      style: { width: `${pct}%` },
    }),
  });
}

/** shadcn-style progress bar. Memoized: re-renders only when props change. */
export const Progress = memo(ProgressImpl);
