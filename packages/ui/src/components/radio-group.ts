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

export type RadioGroupContextValue = {
  readonly value: string | undefined;
  readonly disabled: boolean;
  readonly onSelect: (value: string) => void;
  /** Records an item's mounted node so arrow keys can move focus with selection. */
  readonly registerItem: (value: string, handle: NodeHandle | null) => void;
  /** Focuses a registered item, if it is still mounted. */
  readonly focusItem: (value: string) => void;
};

const RadioGroupContext = createContext<RadioGroupContextValue | undefined>(undefined);

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type RadioGroupProps = {
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly disabled?: boolean;
  readonly children: PingoNode;
  readonly className?: string;
};

function RadioGroupImpl(props: RadioGroupProps): PingoNode {
  const theme = useTheme();
  const internal = useSignal<string | undefined>(props.defaultValue);
  // .get() (not .peek()): the group must subscribe to its own signal so an
  // uncontrolled selection re-renders it and republishes the context value.
  const current = props.value !== undefined ? props.value : internal.get();
  const disabled = props.disabled === true;
  const handles = useMemo(() => new Map<string, NodeHandle>(), []);
  const contextValue: RadioGroupContextValue = {
    value: current,
    disabled,
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
  const className = ["pui-radiogroup", theme === "dark" ? "pui-dark" : undefined, props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return createElement(RadioGroupContext.Provider, {
    value: contextValue,
    children: radioGroupDescriptor(props, contextValue, className),
  });
}

/**
 * Builds the group container. Pure: safe to call without a component scope.
 *
 * Both axes navigate: a radio group is a single selection whichever way it is
 * laid out, and WAI-ARIA moves it with either arrow pair.
 */
export function radioGroupDescriptor(
  props: Pick<RadioGroupProps, "children">,
  context: RadioGroupContextValue,
  className: string,
): PingoNode {
  const values = orderedValues(props.children);
  return View({
    className,
    semanticRole: "radiogroup",
    ...(context.disabled
      ? {}
      : {
          onKeyDown: (event: PingoEvent): void => {
            const next = step(values, context.value, event.key, "both");
            if (next === undefined) return;
            event.preventDefault();
            context.onSelect(next);
            context.focusItem(next);
          },
        }),
    children: props.children,
  });
}

/**
 * shadcn-style radio group (compositional). JSX-only: uses hooks.
 * The provider value object changes identity per render by design — consumers
 * are few and re-render cheaply.
 */
export const RadioGroup = memo(RadioGroupImpl);

export type RadioGroupItemProps = {
  readonly value: string;
  readonly label?: string;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function radioGroupItemDescriptor(
  props: RadioGroupItemProps,
  context: RadioGroupContextValue | undefined,
): PingoNode {
  const theme = useTheme();
  const dark = theme === "dark";
  const checked = context?.value === props.value;
  const disabled = context?.disabled === true;
  const select = (): void => context?.onSelect(props.value);
  return View({
    className: [
      "pui-radio",
      disabled ? "pui-radio--disabled" : undefined,
      dark ? "pui-dark" : undefined,
      props.className,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" "),
    direction: "row",
    semanticRole: "radio",
    semanticValue: disabled ? "disabled" : checked ? "checked" : "unchecked",
    ref: (handle: NodeHandle | null) => context?.registerItem(props.value, handle),
    ...(disabled
      ? {}
      : {
          onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
          onTap: select,
          onClick: select,
        }),
    children: [
      View({
        className: ["pui-radio__circle", dark ? "pui-dark" : undefined]
          .filter((part) => part !== undefined)
          .join(" "),
        children: checked
          ? View({
              className: ["pui-radio__indicator", dark ? "pui-dark" : undefined]
                .filter((part) => part !== undefined)
                .join(" "),
            })
          : null,
      }),
      ...(props.label === undefined
        ? []
        : [
            Text({
              className: ["pui-label", "pui-radio__label", dark ? "pui-dark" : undefined]
                .filter((part) => part !== undefined)
                .join(" "),
              value: props.label,
            }),
          ]),
    ],
  });
}

/** shadcn-style radio item. JSX-only: reads the group via context. */
export const RadioGroupItem = memo(function RadioGroupItemImpl(
  props: RadioGroupItemProps,
): PingoNode {
  return radioGroupItemDescriptor(props, useContext(RadioGroupContext));
});
