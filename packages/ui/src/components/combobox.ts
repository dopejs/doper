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

import { classes, OverlayFocusContext, useOverlayFocus } from "../overlay";
import { useTheme } from "../theme";

import { commandDescriptor, type CommandItem } from "./command";
import { anchorDescriptor } from "./popover";

export type ComboboxProps = {
  readonly items: readonly CommandItem[];
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly placeholder?: string;
  readonly emptyLabel?: string;
  readonly className?: string;
};

/**
 * Builds the Combobox tree. Pure: safe to call without a component scope.
 *
 * A trigger that shows the chosen label, and a Command list anchored under it.
 * Both halves already existed; what this adds is the value binding between
 * them, which is the whole of what a combobox is.
 */
export function comboboxDescriptor(
  props: ComboboxProps,
  state: {
    readonly open: boolean;
    readonly value: string | undefined;
    readonly query: string;
    readonly active: string | undefined;
    readonly setOpen: (open: boolean) => void;
    readonly setQuery: (query: string) => void;
    readonly setActive: (value: string | undefined) => void;
    readonly focusItem: (value: string) => void;
    readonly registerItem: (value: string, handle: NodeHandle | null) => void;
    readonly commit: (value: string) => void;
  },
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const selected = props.items.find((item) => item.value === state.value);
  const toggle = (): void => state.setOpen(!state.open);
  return anchorDescriptor({
    className: classes("pui-combobox", props.className),
    children: [
      View({
        className: classes("pui-combobox__trigger", dark),
        direction: "row",
        semanticRole: "button",
        semanticValue: state.open ? "expanded" : "collapsed",
        onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
        onTap: toggle,
        onClick: toggle,
        children: [
          Text({
            className: classes(
              "pui-combobox__value",
              selected === undefined ? "pui-combobox__value--placeholder" : undefined,
              dark,
            ),
            // The placeholder is the trigger's own, not the search field's:
            // one says what to pick, the other says how to search.
            value: selected?.label ?? props.placeholder ?? "请选择",
          }),
          Text({ className: classes("pui-combobox__indicator", dark), value: "▾" }),
        ],
      }),
      state.open
        ? View({
            className: classes("pui-combobox__content", dark),
            children: commandDescriptor(
              {
                items: props.items,
                onSelect: state.commit,
                onDismiss: () => state.setOpen(false),
                ...(props.emptyLabel === undefined ? {} : { emptyLabel: props.emptyLabel }),
              },
              state.query,
              state.active,
              {
                setQuery: state.setQuery,
                setActive: state.setActive,
                focusItem: state.focusItem,
                registerItem: state.registerItem,
              },
            ),
          })
        : null,
    ],
  });
}

/** shadcn-style combobox: a Command list bound to a trigger's value. */
export const Combobox = memo(function ComboboxImpl(props: ComboboxProps): PingoNode {
  const openSignal = useSignal(props.defaultOpen === true);
  const valueSignal = useSignal<string | undefined>(props.defaultValue);
  const querySignal = useSignal("");
  const activeSignal = useSignal<string | undefined>(undefined);
  const focus = useOverlayFocus();
  const handles = useMemo(() => new Map<string, NodeHandle>(), []);
  // .get() (not .peek()): uncontrolled changes must re-render this component.
  const open = props.open ?? openSignal.get();
  const value = props.value ?? valueSignal.get();
  const setOpen = (next: boolean): void => {
    openSignal.set(next);
    // The query resets on close rather than on open: leaving it would show a
    // filtered list for a search the user has forgotten making.
    if (!next) {
      querySignal.set("");
      activeSignal.set(undefined);
    }
    props.onOpenChange?.(next);
  };
  return createElement(OverlayFocusContext.Provider, {
    value: focus,
    children: comboboxDescriptor(props, {
      open,
      value,
      query: querySignal.get(),
      active: activeSignal.get(),
      setOpen,
      setQuery: (query) => querySignal.set(query),
      setActive: (next) => activeSignal.set(next),
      focusItem: (next) => handles.get(next)?.focus(),
      registerItem: (next, handle) => {
        if (handle === null) handles.delete(next);
        else handles.set(next, handle);
      },
      commit: (next) => {
        valueSignal.set(next);
        props.onValueChange?.(next);
        setOpen(false);
      },
    }),
  });
});
