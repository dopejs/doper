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

export type ToggleProps = {
  readonly children: string;
  readonly pressed?: boolean;
  readonly defaultPressed?: boolean;
  readonly onPressedChange?: (pressed: boolean) => void;
  readonly disabled?: boolean;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function toggleDescriptor(
  props: Omit<ToggleProps, "pressed" | "defaultPressed">,
  pressed: boolean,
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const disabled = props.disabled === true;
  const press = (): void => props.onPressedChange?.(!pressed);
  return View({
    className: classes(
      "pui-toggle",
      pressed ? "pui-toggle--on" : undefined,
      disabled ? "pui-toggle--disabled" : undefined,
      dark,
      props.className,
    ),
    semanticRole: "button",
    semanticValue: pressed ? "on" : "off",
    ...(disabled
      ? {}
      : {
          onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
          onTap: press,
          onClick: press,
          onKeyDown: (event: PingoEvent): void => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            press();
          },
        }),
    children: Text({ className: "pui-toggle__label", value: props.children }),
  });
}

/** shadcn-style two-state toggle button. JSX-only: uses hooks. */
export const Toggle = memo(function ToggleImpl(props: ToggleProps): PingoNode {
  const internal = useSignal(props.defaultPressed === true);
  // .get() (not .peek()): an uncontrolled press must re-render this component.
  const pressed = props.pressed ?? internal.get();
  return toggleDescriptor(
    {
      ...props,
      onPressedChange: (next) => {
        internal.set(next);
        props.onPressedChange?.(next);
      },
    },
    pressed,
  );
});

export type ToggleGroupContextValue = {
  readonly value: readonly string[];
  readonly onToggle: (value: string) => void;
  readonly registerItem: (value: string, handle: NodeHandle | null) => void;
  readonly focusItem: (value: string) => void;
};

const ToggleGroupContext = createContext<ToggleGroupContextValue | undefined>(undefined);

export type ToggleGroupProps = {
  /** `single` clears the previous choice; `multiple` accumulates. */
  readonly type?: "single" | "multiple";
  readonly value?: readonly string[];
  readonly defaultValue?: readonly string[];
  readonly onValueChange?: (value: readonly string[]) => void;
  readonly children: PingoNode;
  readonly className?: string;
};

function ToggleGroupImpl(props: ToggleGroupProps): PingoNode {
  const theme = useTheme();
  const internal = useSignal<readonly string[]>(props.defaultValue ?? []);
  // .get() (not .peek()): the root subscribes to its own signal so an
  // uncontrolled change re-renders it and republishes the context value.
  const current = props.value ?? internal.get();
  const handles = useMemo(() => new Map<string, NodeHandle>(), []);
  const single = (props.type ?? "single") === "single";
  const context: ToggleGroupContextValue = {
    value: current,
    onToggle: (value) => {
      const next = current.includes(value)
        ? current.filter((entry) => entry !== value)
        : single
          ? [value]
          : [...current, value];
      internal.set(next);
      props.onValueChange?.(next);
    },
    registerItem: (value, handle) => {
      if (handle === null) handles.delete(value);
      else handles.set(value, handle);
    },
    focusItem: (value) => handles.get(value)?.focus(),
  };
  return createElement(ToggleGroupContext.Provider, {
    value: context,
    children: View({
      className: classes(
        "pui-toggle-group",
        theme === "dark" ? "pui-dark" : undefined,
        props.className,
      ),
      direction: "row",
      semanticRole: "group",
      // One handler on the group rather than per item: a key event routes to
      // the focused item and bubbles through here, so this stays correct as
      // items come and go.
      onKeyDown: (event: PingoEvent): void => {
        const values = orderedValues(props.children);
        const next = step(values, current[current.length - 1], event.key, "horizontal");
        if (next === undefined) return;
        event.preventDefault();
        context.focusItem(next);
      },
      children: props.children,
    }),
  });
}

/** shadcn-style toggle group. JSX-only: uses hooks. */
export const ToggleGroup = memo(ToggleGroupImpl);

export type ToggleGroupItemProps = {
  readonly value: string;
  readonly children: string;
  readonly disabled?: boolean;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function toggleGroupItemDescriptor(
  props: ToggleGroupItemProps,
  context: ToggleGroupContextValue | undefined,
): PingoNode {
  const pressed = context?.value.includes(props.value) === true;
  return toggleDescriptor(
    {
      children: props.children,
      className: classes("pui-toggle-group__item", props.className),
      ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
      onPressedChange: () => context?.onToggle(props.value),
    },
    pressed,
  );
}

/** shadcn-style toggle group item. JSX-only: reads the group via context. */
export const ToggleGroupItem = memo(function ToggleGroupItemImpl(
  props: ToggleGroupItemProps,
): PingoNode {
  const context = useContext(ToggleGroupContext);
  const node = toggleGroupItemDescriptor(props, context);
  return node === null
    ? null
    : createElement(ToggleGroupContext.Provider, { value: context, children: node });
});
