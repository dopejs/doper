import {
  createElement,
  memo,
  Text,
  View,
  type NodeHandle,
  type PingoEvent,
  type PingoNode,
} from "@dopejs/pingo-jsx";
import { createContext, useContext, useMemo, useSignal } from "@dopejs/pingo-runtime";

import { orderedValues, step } from "../keyboard";
import { classes } from "../overlay";
import { useTheme } from "../theme";

export type SidebarContextValue = {
  readonly value: string | undefined;
  readonly onSelect: (value: string) => void;
  /** Records an item's mounted node so arrow keys can move focus with selection. */
  readonly registerItem: (value: string, handle: NodeHandle | null) => void;
  /** Focuses a registered item, if it is still mounted. */
  readonly focusItem: (value: string) => void;
};

const SidebarContext = createContext<SidebarContextValue | undefined>(undefined);

// Type aliases (not interfaces) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type SidebarProps = {
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly children: PingoNode;
  readonly className?: string;
};

/**
 * Builds the navigation column. Pure: safe to call without a component scope.
 *
 * The arrow handler sits here rather than on each item: a key routes to the
 * focused item and bubbles through, so one handler covers every item and stays
 * correct as sections come and go. Document order comes from the caller's own
 * children, which cannot drift from what is rendered.
 */
export function sidebarDescriptor(
  props: Pick<SidebarProps, "children">,
  context: SidebarContextValue,
  className: string,
): PingoNode {
  const values = orderedValues(props.children);
  return View({
    className,
    semanticRole: "navigation",
    onKeyDown: (event: PingoEvent): void => {
      const next = step(values, context.value, event.key, "vertical");
      if (next === undefined) return;
      event.preventDefault();
      context.onSelect(next);
      context.focusItem(next);
    },
    children: props.children,
  });
}

/** Product navigation column (compositional). JSX-only: uses hooks. */
export const Sidebar = memo(function SidebarImpl(props: SidebarProps): PingoNode {
  const theme = useTheme();
  const internal = useSignal<string | undefined>(props.defaultValue);
  // .get() (not .peek()): the root subscribes to its own signal so an
  // uncontrolled selection re-renders it and republishes the context value.
  const current = props.value ?? internal.get();
  const handles = useMemo(() => new Map<string, NodeHandle>(), []);
  const context: SidebarContextValue = {
    value: current,
    onSelect: (value) => {
      internal.set(value);
      props.onValueChange?.(value);
    },
    registerItem: (value, handle) => {
      if (handle === null) handles.delete(value);
      else handles.set(value, handle);
    },
    focusItem: (value) => handles.get(value)?.focus(),
  };
  return createElement(SidebarContext.Provider, {
    value: context,
    children: sidebarDescriptor(
      props,
      context,
      classes("pui-sidebar", theme === "dark" ? "pui-dark" : undefined, props.className),
    ),
  });
});

export type SidebarSectionProps = {
  readonly title?: string;
  readonly children: PingoNode;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function sidebarSectionDescriptor(props: SidebarSectionProps): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  return View({
    className: classes("pui-sidebar__section", props.className),
    children: [
      ...(props.title === undefined
        ? []
        : [
            Text({
              className: classes("pui-sidebar__section-title", dark),
              value: props.title,
            }),
          ]),
      props.children,
    ],
  });
}

/** Labelled group of navigation items. Uses no hooks beyond the theme. */
export const SidebarSection = memo(sidebarSectionDescriptor);

export type SidebarItemProps = {
  readonly value: string;
  readonly label: string;
  /** Leading slot, for an icon. */
  readonly icon?: PingoNode;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function sidebarItemDescriptor(
  props: SidebarItemProps,
  context: SidebarContextValue | undefined,
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const active = context?.value === props.value;
  const select = (): void => context?.onSelect(props.value);
  return View({
    className: classes(
      "pui-sidebar__item",
      active ? "pui-sidebar__item--active" : undefined,
      dark,
      props.className,
    ),
    semanticRole: "link",
    semanticLabel: props.label,
    semanticValue: active ? "selected" : "unselected",
    ...(context === undefined
      ? {}
      : {
          ref: (handle: NodeHandle | null) => context.registerItem(props.value, handle),
        }),
    onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
    onTap: select,
    onClick: select,
    children: [...(props.icon === undefined ? [] : [props.icon]), Text({ value: props.label })],
  });
}

/** One navigation entry. JSX-only: reads the column via context. */
export const SidebarItem = memo(function SidebarItemImpl(props: SidebarItemProps): PingoNode {
  return sidebarItemDescriptor(props, useContext(SidebarContext));
});
