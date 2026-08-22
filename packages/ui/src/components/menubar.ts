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

export type MenubarContextValue = {
  /** Value of the open menu, or undefined when the bar is idle. */
  readonly open: string | undefined;
  readonly setOpen: (value: string | undefined) => void;
  readonly registerMenu: (value: string, handle: NodeHandle | null) => void;
  readonly focusMenu: (value: string) => void;
};

const MenubarContext = createContext<MenubarContextValue | undefined>(undefined);

export type MenubarProps = {
  readonly value?: string;
  readonly onValueChange?: (value: string | undefined) => void;
  readonly children: PingoNode;
  readonly className?: string;
  /** Navigation semantics instead of menubar semantics. */
  readonly navigation?: boolean;
};

function MenubarImpl(props: MenubarProps): PingoNode {
  const theme = useTheme();
  const openSignal = useSignal<string | undefined>(undefined);
  const handles = useMemo(() => new Map<string, NodeHandle>(), []);
  // .get() (not .peek()): opening a menu must re-render and republish context.
  const open = props.value ?? openSignal.get();
  const context: MenubarContextValue = {
    open,
    setOpen: (value) => {
      openSignal.set(value);
      props.onValueChange?.(value);
    },
    registerMenu: (value, handle) => {
      if (handle === null) handles.delete(value);
      else handles.set(value, handle);
    },
    focusMenu: (value) => handles.get(value)?.focus(),
  };
  return createElement(MenubarContext.Provider, {
    value: context,
    children: View({
      className: classes(
        props.navigation === true ? "pui-navigation-menu" : "pui-menubar",
        theme === "dark" ? "pui-dark" : undefined,
        props.className,
      ),
      direction: "row",
      semanticRole: props.navigation === true ? "navigation" : "menubar",
      // Left/Right walks the bar. Once a menu is open the same keys move
      // between menus rather than closing one and opening nothing, which is
      // what makes a menubar feel like one control instead of several.
      onKeyDown: (event: PingoEvent): void => {
        const values = orderedValues(props.children);
        if (event.key === "Escape" && open !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          context.setOpen(undefined);
          context.focusMenu(open);
          return;
        }
        const next = step(values, open ?? values[0], event.key, "horizontal");
        if (next === undefined) return;
        event.preventDefault();
        context.focusMenu(next);
        if (open !== undefined) context.setOpen(next);
      },
      children: props.children,
    }),
  });
}

/** shadcn-style menubar: a row of menus that share one open slot. */
export const Menubar = memo(MenubarImpl);

/** shadcn-style navigation menu: a Menubar with navigation semantics. */
export const NavigationMenu = memo(function NavigationMenuImpl(
  props: Omit<MenubarProps, "navigation">,
): PingoNode {
  return MenubarImpl({ ...props, navigation: true });
});

export type MenubarMenuProps = {
  readonly value: string;
  readonly label: string;
  readonly children: PingoNode;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function menubarMenuDescriptor(
  props: MenubarMenuProps,
  context: MenubarContextValue | undefined,
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const open = context?.open === props.value;
  const toggle = (): void => context?.setOpen(open ? undefined : props.value);
  return View({
    className: classes("pui-menubar__menu", props.className),
    children: [
      Text({
        className: classes(
          "pui-menubar__trigger",
          open ? "pui-menubar__trigger--open" : undefined,
          dark,
        ),
        value: props.label,
        semanticRole: "menuitem",
        semanticValue: open ? "expanded" : "collapsed",
        ref: (handle: NodeHandle | null) => context?.registerMenu(props.value, handle),
        onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
        onTap: toggle,
        onClick: toggle,
        // Enter, Space and Down all open — Down because a menubar user reaching
        // for the list expects the same key that moves into it.
        onKeyDown: (event: PingoEvent): void => {
          if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
          event.preventDefault();
          context?.setOpen(props.value);
        },
      }),
      open
        ? View({
            className: classes("pui-menubar__content", dark),
            semanticRole: "menu",
            children: props.children,
          })
        : null,
    ],
  });
}

/** shadcn-style menubar entry. JSX-only: reads the bar via context. */
export const MenubarMenu = memo(function MenubarMenuImpl(props: MenubarMenuProps): PingoNode {
  return menubarMenuDescriptor(props, useContext(MenubarContext));
});
