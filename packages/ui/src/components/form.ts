import { memo, Text, View, type PingoNode } from "@dopejs/pingo-jsx";

import { classes } from "../overlay";
import { useTheme } from "../theme";

export type FormFieldProps = {
  readonly label: string;
  readonly children: PingoNode;
  /** Shown in place of the description; presence is what marks the field invalid. */
  readonly error?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly className?: string;
};

/**
 * Builds one labelled form field. Pure: safe to call without a component scope.
 *
 * No validation lives here. A validator is a product decision — when it runs,
 * what it reports, how it composes — and a component that guesses is harder to
 * work around than one that asks. The caller owns the rule and passes `error`;
 * this owns the layout, the semantics and the message slot.
 */
export function formFieldDescriptor(props: FormFieldProps): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const invalid = props.error !== undefined && props.error !== "";
  return View({
    className: classes("pui-form-field", props.className),
    semanticRole: "group",
    semanticLabel: props.label,
    // Announced on the group rather than on the control: the control is the
    // caller's, so this is the only element guaranteed to exist.
    ...(invalid ? { semanticValue: "invalid" } : {}),
    children: [
      Text({
        className: classes("pui-form-field__label", dark),
        value: props.required === true ? `${props.label} *` : props.label,
      }),
      props.children,
      // Error replaces description rather than stacking under it: two lines of
      // guidance where one is a failure buries the one that matters.
      invalid
        ? Text({ className: classes("pui-form-field__error", dark), value: props.error ?? "" })
        : props.description === undefined
          ? null
          : Text({
              className: classes("pui-form-field__description", dark),
              value: props.description,
            }),
    ],
  });
}

/** shadcn-style form field wrapper. Validation is the caller's. */
export const FormField = memo(formFieldDescriptor);

export type FormProps = {
  readonly children: PingoNode;
  readonly className?: string;
};

/** Pure builder: safe to call without a component scope (tests use this). */
export function formDescriptor(props: FormProps): PingoNode {
  return View({
    className: classes("pui-form", props.className),
    semanticRole: "form",
    children: props.children,
  });
}

/** shadcn-style form container. */
export const Form = memo(formDescriptor);
