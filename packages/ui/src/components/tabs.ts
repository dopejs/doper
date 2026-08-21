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

import { useTheme } from "../theme";

export type TabsContextValue = {
  readonly value: string | undefined;
  readonly onSelect: (value: string) => void;
  /**
   * Records a trigger's mounted node so keyboard navigation can move focus.
   *
   * Core delivers a key event only to the focused node, so moving the
   * selection without moving focus would leave the next arrow press going to
   * the old trigger. The list needs a handle to the node it is selecting.
   */
  readonly registerTrigger: (value: string, handle: NodeHandle | null) => void;
  /** Focuses a registered trigger, if it is still mounted. */
  readonly focusTrigger: (value: string) => void;
};

const TabsContext = createContext<TabsContextValue | undefined>(undefined);

// Type aliases (not interfaces) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type TabsProps = {
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly children: PingoNode;
  readonly className?: string;
};

function TabsImpl(props: TabsProps): PingoNode {
  const theme = useTheme();
  const internal = useSignal<string | undefined>(props.defaultValue);
  // .get() (not .peek()): the root must subscribe to its own signal so an
  // uncontrolled selection re-renders it and republishes the context value.
  const current = props.value !== undefined ? props.value : internal.get();
  // One map for the tab set's lifetime: triggers register on mount and clear
  // on unmount, so a stale handle can never be focused.
  const handles = useMemo(() => new Map<string, NodeHandle>(), []);
  const contextValue: TabsContextValue = {
    value: current,
    onSelect: (value) => {
      internal.set(value);
      props.onValueChange?.(value);
    },
    registerTrigger: (value, handle) => {
      if (handle === null) handles.delete(value);
      else handles.set(value, handle);
    },
    focusTrigger: (value) => handles.get(value)?.focus(),
  };
  const className = ["pui-tabs", theme === "dark" ? "pui-dark" : undefined, props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return createElement(TabsContext.Provider, {
    value: contextValue,
    children: View({ className, children: props.children }),
  });
}

/**
 * shadcn-style tabs root (compositional). JSX-only: uses hooks.
 * The provider value object changes identity per render by design — consumers
 * are few and re-render cheaply.
 */
export const Tabs = memo(TabsImpl);

export type TabsListProps = {
  readonly children: PingoNode;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function tabsListDescriptor(
  props: TabsListProps,
  context: TabsContextValue | undefined,
): PingoNode {
  const theme = useTheme();
  // Document order comes from the caller's own children, so it needs no
  // registration pass and cannot drift from what is rendered.
  const values = orderedValues(props.children);
  return View({
    className: ["pui-tabs__list", theme === "dark" ? "pui-dark" : undefined, props.className]
      .filter((part) => part !== undefined && part !== "")
      .join(" "),
    direction: "row",
    semanticRole: "tablist",
    // The handler sits on the list rather than on each trigger: a key event
    // routes to the focused trigger and bubbles through here, so one handler
    // covers every trigger and stays correct as they come and go.
    onKeyDown: (event: PingoEvent): void => {
      const next = step(values, context?.value, event.key, "horizontal");
      if (next === undefined) return;
      event.preventDefault();
      context?.onSelect(next);
      context?.focusTrigger(next);
    },
    children: props.children,
  });
}

/** shadcn-style tab list row. JSX-only: reads the root via context. */
export const TabsList = memo(function TabsListImpl(props: TabsListProps): PingoNode {
  return tabsListDescriptor(props, useContext(TabsContext));
});

export type TabsTriggerProps = {
  readonly value: string;
  readonly children: string;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function tabsTriggerDescriptor(
  props: TabsTriggerProps,
  context: TabsContextValue | undefined,
): PingoNode {
  const theme = useTheme();
  const active = context?.value === props.value;
  const select = (): void => context?.onSelect(props.value);
  return View({
    className: [
      "pui-tabs__trigger",
      active ? "pui-tabs__trigger--active" : undefined,
      theme === "dark" ? "pui-dark" : undefined,
      props.className,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" "),
    semanticRole: "tab",
    semanticValue: active ? "active" : "inactive",
    ref: (handle: NodeHandle | null) => context?.registerTrigger(props.value, handle),
    onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
    onTap: select,
    onClick: select,
    children: Text({ value: props.children }),
  });
}

/** shadcn-style tab trigger. JSX-only: reads the root via context. */
export const TabsTrigger = memo(function TabsTriggerImpl(props: TabsTriggerProps): PingoNode {
  return tabsTriggerDescriptor(props, useContext(TabsContext));
});

export type TabsContentProps = {
  readonly value: string;
  readonly children: PingoNode;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function tabsContentDescriptor(
  props: TabsContentProps,
  context: TabsContextValue | undefined,
): PingoNode {
  const theme = useTheme();
  const active = context?.value === props.value;
  return View({
    className: ["pui-tabs__content", theme === "dark" ? "pui-dark" : undefined, props.className]
      .filter((part) => part !== undefined && part !== "")
      .join(" "),
    // display:none preserves panel state instead of unmounting it.
    style: { display: active ? "flex" : "none" },
    children: props.children,
  });
}

/** shadcn-style tab panel. JSX-only: reads the root via context. */
export const TabsContent = memo(function TabsContentImpl(props: TabsContentProps): PingoNode {
  return tabsContentDescriptor(props, useContext(TabsContext));
});
