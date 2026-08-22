import {
  Svg,
  Text,
  View,
  createElement,
  memo,
  type NodeHandle,
  type PingoEvent,
  type PingoNode,
} from "@dopejs/pingo-jsx";
import { createContext, useContext, useMemo, useSignal } from "@dopejs/pingo-runtime";

import { ChevronDownIcon } from "../icons";
import { orderedValues, step } from "../keyboard";
import { useTheme } from "../theme";

export type AccordionContextValue = {
  readonly openValue: string | undefined;
  readonly onToggle: (value: string) => void;
  /** Records an item trigger's mounted node so arrow keys can move focus. */
  readonly registerTrigger: (value: string, handle: NodeHandle | null) => void;
  /** Focuses a registered item trigger, if it is still mounted. */
  readonly focusTrigger: (value: string) => void;
};

const AccordionContext = createContext<AccordionContextValue | undefined>(undefined);

// Type aliases (not interfaces) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type AccordionProps = {
  readonly openValue?: string;
  readonly defaultOpenValue?: string;
  readonly onValueChange?: (value: string | undefined) => void;
  readonly children: PingoNode;
  readonly className?: string;
};

function AccordionImpl(props: AccordionProps): PingoNode {
  const theme = useTheme();
  const internal = useSignal<string | undefined>(props.defaultOpenValue);
  // .get() (not .peek()): the root must subscribe to its own signal so an
  // uncontrolled toggle re-renders it and republishes the context value.
  const current = props.openValue !== undefined ? props.openValue : internal.get();
  const handles = useMemo(() => new Map<string, NodeHandle>(), []);
  const contextValue: AccordionContextValue = {
    openValue: current,
    onToggle: (value) => {
      const next = current === value ? undefined : value;
      internal.set(next);
      props.onValueChange?.(next);
    },
    registerTrigger: (value, handle) => {
      if (handle === null) handles.delete(value);
      else handles.set(value, handle);
    },
    focusTrigger: (value) => handles.get(value)?.focus(),
  };
  const className = ["pui-accordion", theme === "dark" ? "pui-dark" : undefined, props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  const focused = useSignal<string | undefined>(undefined);
  return createElement(AccordionContext.Provider, {
    value: contextValue,
    children: accordionDescriptor(props, contextValue, className, focused),
  });
}

/** A cursor the arrow keys move without opening anything. */
export interface AccordionFocusCursor {
  peek: () => string | undefined;
  set: (value: string | undefined) => void;
}

/**
 * Builds the accordion container. Pure: safe to call without a component scope.
 *
 * Arrows move focus between headers without opening anything; Enter and Space
 * on a header toggle it. That split is what WAI-ARIA specifies, and it is why
 * the cursor is separate from the open value.
 */
export function accordionDescriptor(
  props: Pick<AccordionProps, "children">,
  context: AccordionContextValue,
  className: string,
  focused: AccordionFocusCursor,
): PingoNode {
  const values = orderedValues(props.children);
  return View({
    className,
    onKeyDown: (event: PingoEvent): void => {
      const next = step(values, focused.peek() ?? context.openValue, event.key, "vertical");
      if (next === undefined) return;
      event.preventDefault();
      focused.set(next);
      context.focusTrigger(next);
    },
    children: props.children,
  });
}

/**
 * shadcn-style single-open accordion root (compositional). JSX-only: uses
 * hooks. The provider value object changes identity per render by design —
 * consumers are few and re-render cheaply.
 */
export const Accordion = memo(AccordionImpl);

export type AccordionItemProps = {
  readonly value: string;
  readonly title: string;
  readonly children: PingoNode;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function accordionItemDescriptor(
  props: AccordionItemProps,
  context: AccordionContextValue | undefined,
): PingoNode {
  const theme = useTheme();
  const dark = theme === "dark";
  const open = context?.openValue === props.value;
  const toggle = (): void => context?.onToggle(props.value);
  return View({
    className: ["pui-accordion__item", dark ? "pui-dark" : undefined, props.className]
      .filter((part) => part !== undefined && part !== "")
      .join(" "),
    children: [
      View({
        className: ["pui-accordion__trigger", dark ? "pui-dark" : undefined]
          .filter((part) => part !== undefined)
          .join(" "),
        direction: "row",
        semanticRole: "button",
        semanticValue: open ? "open" : "closed",
        ref: (handle: NodeHandle | null) => context?.registerTrigger(props.value, handle),
        onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
        onKeyDown: (event: PingoEvent): void => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggle();
        },
        onTap: toggle,
        onClick: toggle,
        children: [
          Text({ value: props.title }),
          // Rotated rather than swapped for a second glyph, so the chevron
          // turns rather than jumping once transitions exist.
          Svg({
            source: ChevronDownIcon,
            ...(open ? { style: { transform: "rotate(180deg)" } } : {}),
          }),
        ],
      }),
      View({
        className: ["pui-accordion__content", dark ? "pui-dark" : undefined]
          .filter((part) => part !== undefined)
          .join(" "),
        // display:none preserves content state instead of unmounting it.
        style: { display: open ? "flex" : "none" },
        children: props.children,
      }),
    ],
  });
}

/** shadcn-style accordion item. JSX-only: reads the root via context. */
export const AccordionItem = memo(function AccordionItemImpl(props: AccordionItemProps): PingoNode {
  return accordionItemDescriptor(props, useContext(AccordionContext));
});
