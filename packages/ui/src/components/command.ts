import {
  createElement,
  memo,
  Text,
  View,
  type NodeHandle,
  type PingoEvent,
  type PingoNode,
} from "@dopejs/pingo-jsx";
import { useMemo, useSignal } from "@dopejs/pingo-runtime";

import { step } from "../keyboard";
import { classes, escapeHandler } from "../overlay";
import { useTheme } from "../theme";
import { Input } from "./input";

export type CommandItem = {
  readonly value: string;
  readonly label: string;
};

export type CommandProps = {
  readonly items: readonly CommandItem[];
  readonly onSelect?: (value: string) => void;
  readonly onDismiss?: () => void;
  readonly placeholder?: string;
  readonly emptyLabel?: string;
  readonly className?: string;
};

/**
 * Case-insensitive substring match on the label.
 *
 * Deliberately not fuzzy: a fuzzy ranker is a product decision the component
 * cannot make for its caller, and a wrong one is worse than none.
 */
export function filterCommandItems(
  items: readonly CommandItem[],
  query: string,
): readonly CommandItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter((item) => item.label.toLowerCase().includes(needle));
}

/** Pure builder: safe to call without a component scope (tests use this). */
export function commandDescriptor(
  props: CommandProps,
  query: string,
  active: string | undefined,
  actions: {
    readonly setQuery: (query: string) => void;
    readonly setActive: (value: string | undefined) => void;
    readonly focusItem: (value: string) => void;
    readonly registerItem: (value: string, handle: NodeHandle | null) => void;
  },
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const visible = filterCommandItems(props.items, query);
  const values = visible.map((item) => item.value);
  const commit = (value: string): void => props.onSelect?.(value);
  return View({
    className: classes("pui-command", dark, props.className),
    semanticRole: "search",
    onKeyDown: (event: PingoEvent): void => {
      if (event.key === "Enter") {
        if (active === undefined) return;
        event.preventDefault();
        commit(active);
        return;
      }
      const next = step(values, active, event.key, "vertical");
      if (next === undefined) {
        if (props.onDismiss !== undefined) escapeHandler(props.onDismiss)(event);
        return;
      }
      event.preventDefault();
      actions.setActive(next);
      actions.focusItem(next);
    },
    children: [
      createElement(Input, {
        semanticLabel: props.placeholder ?? "搜索",
        onValueChange: (value: string) => {
          actions.setQuery(value);
          // The old cursor may have been filtered away; clearing it beats
          // leaving Enter pointing at something that is no longer listed.
          actions.setActive(undefined);
        },
      }),
      ...(visible.length === 0
        ? [
            Text({
              className: classes("pui-command__empty", dark),
              value: props.emptyLabel ?? "无结果",
            }),
          ]
        : visible.map((item) =>
            View({
              className: classes(
                "pui-menu__item",
                active === item.value ? "pui-menu__item--active" : undefined,
                dark,
              ),
              semanticRole: "option",
              semanticValue: active === item.value ? "selected" : "unselected",
              ref: (handle: NodeHandle | null) => actions.registerItem(item.value, handle),
              onPointerDown: (event: PingoEvent): void => {
                actions.setActive(item.value);
                event.currentTarget.focus();
              },
              onTap: () => commit(item.value),
              onClick: () => commit(item.value),
              children: Text({ value: item.label }),
            }),
          )),
    ],
  });
}

/** shadcn-style command palette. JSX-only: uses hooks. */
export const Command = memo(function CommandImpl(props: CommandProps): PingoNode {
  const query = useSignal("");
  const active = useSignal<string | undefined>(undefined);
  const handles = useMemo(() => new Map<string, NodeHandle>(), []);
  return commandDescriptor(props, query.get(), active.get(), {
    setQuery: (value) => query.set(value),
    setActive: (value) => active.set(value),
    focusItem: (value) => handles.get(value)?.focus(),
    registerItem: (value, handle) => {
      if (handle === null) handles.delete(value);
      else handles.set(value, handle);
    },
  });
});
