import { createElement, memo, Text, View, type PingoEvent, type PingoNode } from "@dopejs/pingo-jsx";
import { createContext, useContext, useSignal } from "@dopejs/pingo-runtime";

import { useTheme } from "../theme";

export type TabsContextValue = {
  readonly value: string | undefined;
  readonly onSelect: (value: string) => void;
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
  const contextValue: TabsContextValue = {
    value: current,
    onSelect: (value) => {
      internal.set(value);
      props.onValueChange?.(value);
    },
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

function TabsListImpl(props: TabsListProps): PingoNode {
  const theme = useTheme();
  return View({
    className: ["pui-tabs__list", theme === "dark" ? "pui-dark" : undefined, props.className]
      .filter((part) => part !== undefined && part !== "")
      .join(" "),
    direction: "row",
    children: props.children,
  });
}

/** shadcn-style tab list row. Uses no hooks: `TabsList.component(props)` is safe to call directly. */
export const TabsList = memo(TabsListImpl);

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
