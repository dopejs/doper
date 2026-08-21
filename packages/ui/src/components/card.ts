import { Text, View, type PingoNode } from "@dopejs/pingo-jsx";

import { useTheme } from "../theme";

export interface CardSectionProps {
  readonly children: PingoNode;
  readonly className?: string;
}

export interface CardTextProps {
  readonly children: string;
  readonly className?: string;
}

function join(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== "").join(" ");
}

function section(base: string, props: CardSectionProps, themed: boolean): PingoNode {
  const dark = themed && useTheme() === "dark";
  return View({
    className: join(base, dark ? "pui-dark" : undefined, props.className),
    children: props.children,
  });
}

function text(base: string, props: CardTextProps, themed: boolean): PingoNode {
  const dark = themed && useTheme() === "dark";
  return Text({
    className: join(base, dark ? "pui-dark" : undefined, props.className),
    value: props.children,
  });
}

/** shadcn-style Card composition family. Slots pass through untouched. */
export function Card(props: CardSectionProps): PingoNode {
  return section("pui-card", props, true);
}

export function CardHeader(props: CardSectionProps): PingoNode {
  return section("pui-card-header", props, false);
}

export function CardTitle(props: CardTextProps): PingoNode {
  return text("pui-card-title", props, false);
}

export function CardDescription(props: CardTextProps): PingoNode {
  return text("pui-card-description", props, true);
}

export function CardContent(props: CardSectionProps): PingoNode {
  return section("pui-card-content", props, false);
}

export function CardFooter(props: CardSectionProps): PingoNode {
  return section("pui-card-footer", props, false);
}
