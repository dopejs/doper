import { TextEditingController, type EditTransaction } from "@dopejs/pingo-editing";
import { Input as EngineInput, View, type EditableInputMode, type PingoNode } from "@dopejs/pingo-jsx";

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

/**
 * shadcn-style decorated input. Known gaps (no hacks, tracked in the
 * capability plan): no placeholder (engine capability), no focus ring
 * (needs :focus-within or E4), no prefix/suffix slots (needs E5/E6).
 */
export function Input(props: InputProps): PingoNode {
  const theme = useTheme();
  const disabled = props.disabled === true;
  const controller = props.controller ?? new TextEditingController({ value: props.value ?? "" });
  const readOnly = disabled || props.readOnly === true;
  const className = [
    "pui-input",
    disabled ? "pui-input--disabled" : undefined,
    theme === "dark" ? "pui-dark" : undefined,
    props.className,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return View({
    className,
    ...(props.width === undefined ? {} : { width: props.width }),
    children: EngineInput({
      className: "pui-input__field",
      controller,
      readOnly,
      ...(props.password === undefined ? {} : { password: props.password }),
      ...(props.inputMode === undefined ? {} : { inputMode: props.inputMode }),
      ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
      onTransaction: (transaction) => {
        // The reconciler applies the transaction to the controller before
        // invoking this callback, so controller.value is already current.
        props.onValueChange?.(controller.value);
        props.onTransaction?.(transaction);
      },
      ...(props.onSubmit === undefined ? {} : { onSubmit: props.onSubmit }),
    }),
  });
}
