import {
  createElement,
  memo,
  Text,
  View,
  type PingoEvent,
  type PingoNode,
} from "@dopejs/pingo-jsx";
import { createContext, useContext, useSignal } from "@dopejs/pingo-runtime";

import { useTheme } from "../theme";

export type RadioGroupContextValue = {
  readonly value: string | undefined;
  readonly disabled: boolean;
  readonly onSelect: (value: string) => void;
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
  const contextValue: RadioGroupContextValue = {
    value: current,
    disabled,
    onSelect: (value) => {
      internal.set(value);
      props.onValueChange?.(value);
    },
  };
  const className = ["pui-radiogroup", theme === "dark" ? "pui-dark" : undefined, props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return createElement(RadioGroupContext.Provider, {
    value: contextValue,
    children: View({
      className,
      semanticRole: "radiogroup",
      children: props.children,
    }),
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
