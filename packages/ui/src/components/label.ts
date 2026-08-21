import { Text, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

export interface LabelProps {
  readonly children: string;
  readonly className?: string;
  readonly semanticLabel?: string;
}

/** shadcn-style form label. No control association exists in pingo yet. */
export function Label(props: LabelProps): PingoNode {
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
