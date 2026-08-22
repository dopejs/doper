import {
  createElement,
  memo,
  Text,
  View,
  type PingoEvent,
  type PingoNode,
} from "@dopejs/pingo-jsx";
import { createContext, useContext, useSignal } from "@dopejs/pingo-runtime";

import {
  classes,
  OverlayFocusContext,
  overlayKeyHandler,
  useOverlayFocus,
  type OverlayFocus,
} from "../overlay";
import { useTheme } from "../theme";

export type AnchorContextValue = {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly focus: OverlayFocus;
};

const AnchorContext = createContext<AnchorContextValue | undefined>(undefined);

export type PopoverProps = {
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: PingoNode;
  readonly className?: string;
};

/**
 * Builds the anchor wrapper shared by every anchored overlay.
 *
 * The content is a child of this wrapper and positioned against it, which is
 * what keeps it pinned while the page scrolls: Core derives the geometry from
 * the parent, so nothing repositions per frame.
 */
export function anchorDescriptor(props: {
  readonly children: PingoNode;
  readonly className?: string;
}): PingoNode {
  return View({
    className: classes("pui-anchor", props.className),
    children: props.children,
  });
}

/** shadcn-style popover root. JSX-only: uses hooks. */
export const Popover = memo(function PopoverImpl(props: PopoverProps): PingoNode {
  const internal = useSignal(props.defaultOpen === true);
  const focus = useOverlayFocus();
  // .get() (not .peek()): the root subscribes to its own signal so an
  // uncontrolled toggle re-renders it and republishes the context value.
  const open = props.open ?? internal.get();
  const value: AnchorContextValue = {
    open,
    setOpen: (next) => {
      internal.set(next);
      props.onOpenChange?.(next);
    },
    focus,
  };
  return createElement(AnchorContext.Provider, {
    value,
    // Nested rather than folded into AnchorContext: useFocusableRef serves
    // every overlay kind, so it reads one context regardless of which built it.
    children: createElement(OverlayFocusContext.Provider, {
      value: focus,
      children: anchorDescriptor(props),
    }),
  });
});

export type AnchorTriggerProps = { readonly children: PingoNode; readonly className?: string };

/** Pure builder: safe to call without a component scope (tests use this). */
export function anchorTriggerDescriptor(
  props: AnchorTriggerProps,
  context: AnchorContextValue | undefined,
): PingoNode {
  const toggle = (): void => context?.setOpen(!(context.open ?? false));
  return View({
    className: classes("pui-anchor__trigger", props.className),
    semanticRole: "button",
    semanticValue: context?.open === true ? "expanded" : "collapsed",
    ...(context === undefined ? {} : { ref: context.focus.trigger }),
    onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
    onTap: toggle,
    onClick: toggle,
    children: props.children,
  });
}

/** shadcn-style popover trigger. JSX-only: reads the root via context. */
export const PopoverTrigger = memo(function PopoverTriggerImpl(
  props: AnchorTriggerProps,
): PingoNode {
  return anchorTriggerDescriptor(props, useContext(AnchorContext));
});

export type AnchorContentProps = {
  readonly children: PingoNode;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function anchorContentDescriptor(
  props: AnchorContentProps,
  context: AnchorContextValue | undefined,
  extra?: string,
): PingoNode {
  if (context?.open !== true) return null;
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  return View({
    className: classes("pui-anchor__content", extra, dark, props.className),
    ref: context.focus.panel,
    onKeyDown: overlayKeyHandler(context.focus, () => context.setOpen(false)),
    children: props.children,
  });
}

/** shadcn-style popover surface. JSX-only: reads the root via context. */
export const PopoverContent = memo(function PopoverContentImpl(
  props: AnchorContentProps,
): PingoNode {
  return anchorContentDescriptor(props, useContext(AnchorContext));
});

export type TooltipProps = {
  readonly content: string;
  readonly children: PingoNode;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function tooltipDescriptor(
  props: TooltipProps,
  visible: boolean,
  setVisible: (visible: boolean) => void,
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  return View({
    className: classes("pui-anchor", props.className),
    onPointerEnter: (): void => setVisible(true),
    onPointerLeave: (): void => setVisible(false),
    children: [
      props.children,
      visible
        ? View({
            className: classes("pui-anchor__content", "pui-tooltip__content", dark),
            semanticRole: "tooltip",
            children: Text({ value: props.content }),
          })
        : null,
    ],
  });
}

/**
 * shadcn-style tooltip. JSX-only: uses hooks.
 *
 * Shown on pointer enter rather than on focus: a focus-driven tooltip needs a
 * focus-visible signal the component cannot see from here.
 */
export const Tooltip = memo(function TooltipImpl(props: TooltipProps): PingoNode {
  const visible = useSignal(false);
  return tooltipDescriptor(props, visible.get(), (next) => visible.set(next));
});
