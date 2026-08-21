import { TextEditingController, type EditTransaction } from "@dopejs/pingo-editing";
import { memo, TextArea as EngineTextArea, View, type PingoNode } from "@dopejs/pingo-jsx";
import { useMemo } from "@dopejs/pingo-runtime";

import { useTheme } from "../theme";

// Type alias (not interface) so the implicit index signature satisfies
// memo's Props extends Record<string, unknown> constraint.
export type TextAreaProps = {
  /** Initial value for uncontrolled usage; ignored when `controller` is set. */
  readonly value?: string;
  /** Called after each edit transaction with the controller-applied value. */
  readonly onValueChange?: (value: string) => void;
  /** Advanced escape hatch: caller-owned durable controller. */
  readonly controller?: TextEditingController;
  readonly onTransaction?: (transaction: EditTransaction) => void;
  readonly onSubmit?: () => void;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  /** Visible line count; sets the shell min-height. */
  readonly rows?: number;
  readonly className?: string;
  readonly width?: number;
  readonly semanticLabel?: string;
};

/** Builds the TextArea descriptor tree. Pure: safe to call without a component scope. */
export function textAreaDescriptor(
  props: TextAreaProps,
  controller: TextEditingController,
): PingoNode {
  const theme = useTheme();
  const disabled = props.disabled === true;
  const readOnly = disabled || props.readOnly === true;
  return View({
    className: [
      "pui-input",
      "pui-textarea",
      disabled ? "pui-input--disabled" : undefined,
      theme === "dark" ? "pui-dark" : undefined,
      props.className,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" "),
    ...(props.width === undefined ? {} : { width: props.width }),
    // Lockstep: rows * line-height-sm (20) + 2 * input-padding-y (6).
    ...(props.rows === undefined ? {} : { style: { minHeight: props.rows * 20 + 12 } }),
    children: EngineTextArea({
      className: "pui-input__field",
      controller,
      readOnly,
      ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
      onTransaction: (transaction) => {
        // The reconciler applies the transaction to the controller BEFORE
        // invoking this callback (reconciler.ts controller wiring), so
        // controller.value is already current here.
        props.onValueChange?.(controller.value);
        props.onTransaction?.(transaction);
      },
      ...(props.onSubmit === undefined ? {} : { onSubmit: props.onSubmit }),
    }),
  });
}

/**
 * shadcn-style decorated multiline input. MUST be used as a JSX component
 * (createElement(TextArea, props) / <TextArea />) — it uses hooks to keep the
 * editing controller stable across renders; calling `.component(props)` as a
 * plain function throws outside a component scope. Memoized: re-renders only
 * when props change. Known gaps (shared with Input, tracked in the capability
 * plan): no placeholder, no focus ring, no prefix/suffix slots.
 */
export const TextArea = memo(function TextAreaImpl(props: TextAreaProps): PingoNode {
  // Deps [] intentionally capture the initial controller/value: a later
  // `controller` prop change is ignored — callers owning a controller should
  // keep passing the same instance for the component's lifetime.
  const controller = useMemo(
    () => props.controller ?? new TextEditingController({ value: props.value ?? "" }),
    [],
  );
  return textAreaDescriptor(props, controller);
});
