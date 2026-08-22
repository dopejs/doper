import {
  Svg,
  Text,
  View,
  memo,
  type PingoEvent,
  type PingoNode,
  type PingoSvg,
} from "@dopejs/pingo-jsx";

import { ChevronLeftIcon, ChevronRightIcon } from "../icons";
import { classes } from "../overlay";
import { useTheme } from "../theme";

export type PaginationProps = {
  /** One-based current page. */
  readonly page: number;
  readonly pageCount: number;
  readonly onPageChange?: (page: number) => void;
  /** Page buttons shown around the current one, excluding the edges. */
  readonly siblingCount?: number;
  readonly previousLabel?: string;
  readonly nextLabel?: string;
  readonly className?: string;
};

/**
 * Page numbers to render, with `null` marking an elided run.
 *
 * Exported because the elision rule is the part most likely to be wrong at a
 * boundary, and it is far easier to pin down as a pure function than through
 * a rendered tree.
 */
export function paginationRange(
  page: number,
  pageCount: number,
  siblingCount = 1,
): readonly (number | null)[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) return [];
  const clamped = Math.min(Math.max(page, 1), pageCount);
  const pages = new Set<number>([1, pageCount]);
  for (let offset = -siblingCount; offset <= siblingCount; offset += 1) {
    const candidate = clamped + offset;
    if (candidate >= 1 && candidate <= pageCount) pages.add(candidate);
  }
  const sorted = [...pages].sort((left, right) => left - right);
  const result: (number | null)[] = [];
  let previous: number | undefined;
  for (const value of sorted) {
    // A gap of exactly one is filled rather than elided: an ellipsis standing
    // in for a single page is wider than the page it replaces.
    if (previous !== undefined && value - previous === 2) result.push(previous + 1);
    else if (previous !== undefined && value - previous > 2) result.push(null);
    result.push(value);
    previous = value;
  }
  return result;
}

/** Pure builder: safe to call without a component scope (tests use this). */
export function paginationDescriptor(props: PaginationProps): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const go = (page: number): void => {
    if (page < 1 || page > props.pageCount || page === props.page) return;
    props.onPageChange?.(page);
  };
  const control = (label: PingoSvg, target: number, name: string): PingoNode => {
    const enabled = target >= 1 && target <= props.pageCount;
    return Svg({
      className: classes(
        "pui-pagination__control",
        enabled ? undefined : "pui-pagination__control--disabled",
        dark,
      ),
      source: label,
      semanticRole: "button",
      semanticLabel: name,
      ...(enabled
        ? {
            onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
            onTap: () => go(target),
            onClick: () => go(target),
          }
        : {}),
    });
  };
  const entries = paginationRange(props.page, props.pageCount, props.siblingCount).map(
    (value, index) =>
      value === null
        ? Text({
            className: classes("pui-pagination__ellipsis", dark),
            value: "…",
            key: `gap-${String(index)}`,
          })
        : Text({
            className: classes(
              "pui-pagination__page",
              value === props.page ? "pui-pagination__page--active" : undefined,
              dark,
            ),
            value: String(value),
            key: String(value),
            semanticRole: "button",
            ...(value === props.page ? { semanticValue: "current" } : {}),
            onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
            onTap: () => go(value),
            onClick: () => go(value),
          }),
  );
  return View({
    className: classes("pui-pagination", props.className),
    direction: "row",
    semanticRole: "navigation",
    semanticLabel: "pagination",
    // One handler on the container: a key routes to whichever entry has focus
    // and bubbles here, so this stays correct as the elision changes shape.
    onKeyDown: (event: PingoEvent): void => {
      const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      go(props.page + delta);
    },
    children: [
      control(ChevronLeftIcon, props.page - 1, "previous page"),
      ...entries,
      control(ChevronRightIcon, props.page + 1, "next page"),
    ],
  });
}

/** shadcn-style pagination control. */
export const Pagination = memo(paginationDescriptor);
