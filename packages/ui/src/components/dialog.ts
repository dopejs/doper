import {
  createElement,
  memo,
  Text,
  View,
  type NodeHandle,
  type PingoNode,
} from "@dopejs/pingo-jsx";

import {
  classes,
  OverlayFocusContext,
  overlayKeyHandler,
  useOverlayFocus,
  type OverlayFocus,
} from "../overlay";
import { useTheme } from "../theme";

// Type aliases (not interfaces) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type DialogProps = {
  readonly open: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: PingoNode;
  readonly className?: string;
};

export type DialogSection = {
  readonly children: PingoNode;
  readonly className?: string;
};

/**
 * Builds the Dialog tree. Pure: safe to call without a component scope.
 *
 * The backdrop precedes the panel so the panel draws over it, and both sit
 * inside one absolutely positioned layer. That layer fills *its own parent*:
 * the containing block in this engine is the parent, not the nearest
 * positioned ancestor, so mount a Dialog near the root.
 */
export function dialogDescriptor(
  props: DialogProps,
  focus: OverlayFocus,
  variant: "dialog" | "sheet" = "dialog",
  side: "left" | "right" = "right",
): PingoNode {
  if (!props.open) return null;
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const close = (): void => props.onOpenChange?.(false);
  return View({
    className: classes(
      "pui-overlay",
      variant === "sheet" ? "pui-overlay--sheet" : undefined,
      props.className,
    ),
    semanticRole: variant === "sheet" ? "complementary" : "dialog",
    children: [
      View({
        className: "pui-overlay__backdrop",
        semanticLabel: "关闭",
        onTap: close,
        onClick: close,
      }),
      View({
        className: classes(
          "pui-overlay__panel",
          variant === "sheet" ? "pui-sheet__panel" : undefined,
          variant === "sheet" && side === "right" ? "pui-sheet__panel--right" : undefined,
          dark,
        ),
        // Core delivers keys to the focused node, so the panel takes focus as
        // it mounts and gives it back when it goes.
        ref: focus.panel,
        onKeyDown: overlayKeyHandler(focus, close),
        children: props.children,
      }),
    ],
  });
}

/**
 * shadcn-style modal dialog. JSX-only: uses hooks.
 *
 * Mount it near the root — it fills its own parent, not the viewport.
 */
export const Dialog = memo(function DialogImpl(props: DialogProps): PingoNode {
  return provideFocus(useOverlayFocus(), (focus) => dialogDescriptor(props, focus));
});

/**
 * Wraps a panel so its content can register itself in the Tab cycle.
 *
 * The provider sits outside the descriptor rather than inside it so the
 * descriptor stays a pure builder that tests can call without a scope.
 */
function provideFocus(focus: OverlayFocus, build: (focus: OverlayFocus) => PingoNode): PingoNode {
  return createElement(OverlayFocusContext.Provider, { value: focus, children: build(focus) });
}

export type SheetProps = DialogProps & { readonly side?: "left" | "right" };

/** shadcn-style edge sheet. JSX-only: uses hooks. Mount it near the root. */
export const Sheet = memo(function SheetImpl(props: SheetProps): PingoNode {
  return provideFocus(useOverlayFocus(), (focus) =>
    dialogDescriptor(props, focus, "sheet", props.side ?? "right"),
  );
});

/** Ref for whatever opens a Dialog, so focus returns to it on close. */
export function dialogTriggerRef(focus: OverlayFocus): (handle: NodeHandle | null) => void {
  return focus.trigger;
}

function section(name: string, props: DialogSection, themed: boolean): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  return View({
    className: classes(name, themed ? dark : undefined, props.className),
    children: props.children,
  });
}

/** Dialog heading row. */
export const DialogHeader = memo(function DialogHeaderImpl(props: DialogSection): PingoNode {
  return section("pui-overlay__header", props, false);
});

/** Dialog action row. */
export const DialogFooter = memo(function DialogFooterImpl(props: DialogSection): PingoNode {
  return section("pui-overlay__footer", props, false);
});

export type DialogTextProps = { readonly children: string; readonly className?: string };

/** Dialog title. */
export const DialogTitle = memo(function DialogTitleImpl(props: DialogTextProps): PingoNode {
  return Text({
    className: classes("pui-overlay__title", props.className),
    value: props.children,
    semanticRole: "heading",
  });
});

/** Dialog supporting copy. */
export const DialogDescription = memo(function DialogDescriptionImpl(
  props: DialogTextProps,
): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  return Text({
    className: classes("pui-overlay__description", dark, props.className),
    value: props.children,
  });
});
