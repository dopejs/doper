import {
  createElement,
  memo,
  Text,
  View,
  type PingoEvent,
  type PingoNode,
} from "@dopejs/pingo-jsx";
import { useSignal } from "@dopejs/pingo-runtime";

import { step } from "../keyboard";
import { classes, OverlayFocusContext, useOverlayFocus } from "../overlay";
import { useTheme } from "../theme";

export type ContextMenuEntry = {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
};

export type ContextMenuProps = {
  readonly children: PingoNode;
  readonly items: readonly ContextMenuEntry[];
  readonly onSelect?: (value: string) => void;
  readonly onOpenChange?: (open: boolean) => void;
  readonly className?: string;
};

/** Where the menu opens, in the trigger's own coordinates. */
export type ContextMenuOrigin = { readonly x: number; readonly y: number };

/** Pure builder: safe to call without a component scope (tests use this). */
export function contextMenuDescriptor(
  props: ContextMenuProps,
  state: {
    readonly origin: ContextMenuOrigin | undefined;
    readonly active: string | undefined;
    readonly open: (origin: ContextMenuOrigin) => void;
    readonly close: () => void;
    readonly setActive: (value: string | undefined) => void;
  },
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const origin = state.origin;
  const values = props.items.filter((item) => item.disabled !== true).map((item) => item.value);
  return View({
    className: classes("pui-context-menu", props.className),
    // The event only exists because E9 added it; before that a right-click
    // reached the platform menu and nothing else.
    onContextMenu: (event: PingoEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      state.open({ x: event.x, y: event.y });
    },
    children: [
      props.children,
      origin === undefined
        ? null
        : View({
            className: classes("pui-context-menu__content", dark),
            semanticRole: "menu",
            // Positioned at the press, not at the trigger's corner: a context
            // menu that ignores where the pointer was is a dropdown.
            style: { left: origin.x, top: origin.y },
            onKeyDown: (event: PingoEvent): void => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                state.close();
                return;
              }
              const next = step(values, state.active, event.key, "vertical");
              if (next === undefined) return;
              event.preventDefault();
              state.setActive(next);
            },
            children: props.items.map((item) => {
              const disabled = item.disabled === true;
              const choose = (): void => {
                props.onSelect?.(item.value);
                state.close();
              };
              return Text({
                key: item.value,
                className: classes(
                  "pui-context-menu__item",
                  state.active === item.value ? "pui-context-menu__item--active" : undefined,
                  disabled ? "pui-context-menu__item--disabled" : undefined,
                  dark,
                ),
                value: item.label,
                semanticRole: "menuitem",
                ...(disabled
                  ? {}
                  : {
                      onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
                      onTap: choose,
                      onClick: choose,
                    }),
              });
            }),
          }),
    ],
  });
}

/** shadcn-style context menu. JSX-only: uses hooks. */
export const ContextMenu = memo(function ContextMenuImpl(props: ContextMenuProps): PingoNode {
  const originSignal = useSignal<ContextMenuOrigin | undefined>(undefined);
  const activeSignal = useSignal<string | undefined>(undefined);
  const focus = useOverlayFocus();
  return createElement(OverlayFocusContext.Provider, {
    value: focus,
    children: contextMenuDescriptor(props, {
      // .get() (not .peek()): opening must re-render this component.
      origin: originSignal.get(),
      active: activeSignal.get(),
      open: (origin) => {
        originSignal.set(origin);
        activeSignal.set(undefined);
        props.onOpenChange?.(true);
      },
      close: () => {
        originSignal.set(undefined);
        activeSignal.set(undefined);
        props.onOpenChange?.(false);
      },
      setActive: (value) => activeSignal.set(value),
    }),
  });
});
