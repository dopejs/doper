import { createElement, memo, Text, View, type PingoEvent, type PingoNode } from "@dopejs/pingo-jsx";
import { createContext, useContext, useSignal } from "@dopejs/pingo-runtime";

import { useTheme } from "../theme";

export type AccordionContextValue = {
  readonly openValue: string | undefined;
  readonly onToggle: (value: string) => void;
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
  const contextValue: AccordionContextValue = {
    openValue: current,
    onToggle: (value) => {
      const next = current === value ? undefined : value;
      internal.set(next);
      props.onValueChange?.(next);
    },
  };
  const className = ["pui-accordion", theme === "dark" ? "pui-dark" : undefined, props.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return createElement(AccordionContext.Provider, {
    value: contextValue,
    children: View({ className, children: props.children }),
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
        onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
        onTap: toggle,
        onClick: toggle,
        children: [
          Text({ value: props.title }),
          // ▾ glyph depends on font coverage — placeholder until icon assets.
          Text({ value: "▾", ...(open ? { style: { transform: "rotate(180deg)" } } : {}) }),
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
export const AccordionItem = memo(function AccordionItemImpl(
  props: AccordionItemProps,
): PingoNode {
  return accordionItemDescriptor(props, useContext(AccordionContext));
});
