import { TextEditingController, type EditTransaction } from "@dopejs/pingo-editing";
import { Input as EngineInput, View, type EditableInputMode, type PingoNode } from "@dopejs/pingo-jsx";
import { useMemo } from "@dopejs/pingo-runtime";

import { useTheme } from "../theme";

export interface InputProps {
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
  readonly password?: boolean;
  readonly inputMode?: EditableInputMode;
  readonly className?: string;
  readonly width?: number;
  readonly semanticLabel?: string;
}

/** Builds the Input descriptor tree. Pure: safe to call without a component scope. */
export function inputDescriptor(props: InputProps, controller: TextEditingController): PingoNode {
  const theme = useTheme();
  const disabled = props.disabled === true;
  const readOnly = disabled || props.readOnly === true;
  return View({
    className: [
      "pui-input",
      disabled ? "pui-input--disabled" : undefined,
      theme === "dark" ? "pui-dark" : undefined,
      props.className,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join(" "),
    ...(props.width === undefined ? {} : { width: props.width }),
    children: EngineInput({
      className: "pui-input__field",
      controller,
      readOnly,
      ...(props.password === undefined ? {} : { password: props.password }),
      ...(props.inputMode === undefined ? {} : { inputMode: props.inputMode }),
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
 * shadcn-style decorated input. MUST be used as a JSX component
 * (createElement(Input, props) / <Input />) — it uses hooks to keep the
 * editing controller stable across renders; calling it as a plain function
 * throws outside a component scope. Known gaps (tracked in the capability
 * plan): no placeholder, no focus ring, no prefix/suffix slots.
 */
export function Input(props: InputProps): PingoNode {
  // Deps [] intentionally capture the initial controller/value: a later
  // `controller` prop change is ignored — callers owning a controller should
  // keep passing the same instance for the component's lifetime.
  const controller = useMemo(
    () => props.controller ?? new TextEditingController({ value: props.value ?? "" }),
    [],
  );
  return inputDescriptor(props, controller);
}
