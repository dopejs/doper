import { memo, Text, View, type PingoEvent, type PingoNode } from "@dopejs/pingo-jsx";

import { classes } from "../overlay";
import { useTheme } from "../theme";

export type BreadcrumbItem = {
  readonly label: string;
  readonly onNavigate?: () => void;
};

export type BreadcrumbProps = {
  readonly items: readonly BreadcrumbItem[];
  /** Rendered between entries; a text glyph until an icon set exists. */
  readonly separator?: string;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function breadcrumbDescriptor(props: BreadcrumbProps): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const separator = props.separator ?? "/";
  const children: PingoNode[] = [];
  props.items.forEach((item, index) => {
    // The last entry is the current page: not a link, and marked as current so
    // a screen reader does not offer to navigate to where the user already is.
    const current = index === props.items.length - 1;
    const navigate = item.onNavigate;
    children.push(
      Text({
        className: classes(
          "pui-breadcrumb__item",
          current ? "pui-breadcrumb__item--current" : undefined,
          dark,
        ),
        value: item.label,
        semanticRole: current ? "text" : "link",
        ...(current ? { semanticValue: "current" } : {}),
        ...(current || navigate === undefined
          ? {}
          : {
              onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
              onTap: navigate,
              onClick: navigate,
              onKeyDown: (event: PingoEvent): void => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                navigate();
              },
            }),
      }),
    );
    if (!current) {
      children.push(
        Text({ className: classes("pui-breadcrumb__separator", dark), value: separator }),
      );
    }
  });
  return View({
    className: classes("pui-breadcrumb", props.className),
    direction: "row",
    semanticRole: "navigation",
    semanticLabel: "breadcrumb",
    children,
  });
}

/** shadcn-style breadcrumb trail. */
export const Breadcrumb = memo(breadcrumbDescriptor);
