import {
  Input,
  Text,
  View,
  TextArea as UnstyledTextArea,
  createElement,
  type Color,
  type CommonProps,
  type PingoNode,
  type EditableInputMode,
  type EditableTextProps,
  type PingoEvent,
} from "@dopejs/pingo-jsx";
import type { EditTransaction, TextEditingController } from "@dopejs/pingo-editing";

/** Shared decorated-field configuration for TextField and TextArea. */
export interface TextFieldProps {
  readonly controller?: TextEditingController;
  readonly value?: string;
  readonly revision?: number | bigint;
  readonly readOnly?: boolean;
  readonly password?: boolean;
  readonly maxGraphemes?: number;
  readonly inputMode?: EditableInputMode;
  readonly width?: number;
  readonly height?: number;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly color?: Color;
  readonly backgroundColor?: Color;
  readonly borderColor?: Color;
  readonly errorColor?: Color;
  /** Renders the error border color and an error caption below the field. */
  readonly error?: string;
  readonly onTransaction?: (transaction: EditTransaction) => void;
  readonly onSubmit?: () => void;
  readonly semanticLabel?: string;
}

/** Multiline variant; submit stays with the host form, not Enter. */
export interface TextAreaProps extends TextFieldProps {
  readonly rows?: number;
}

/** Native-event foundation primitive; it never introduces a Core control kind. */
export interface PressableProps {
  readonly children?: PingoNode;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly className?: string;
  readonly style?: CommonProps["style"];
  readonly width?: number;
  readonly height?: number;
  readonly semanticLabel?: string;
}

/** Text-button convenience composed from Pressable + Text. */
export interface ButtonProps extends Omit<PressableProps, "children"> {
  readonly children: string | number;
  readonly color?: Color;
  readonly fontSize?: number;
}

const DEFAULT_BORDER: Color = "#c0c4ccff";
const DEFAULT_ERROR: Color = "#d03050ff";
const DEFAULT_BACKGROUND: Color = "#ffffffff";
const DEFAULT_TEXT: Color = "#1f2329ff";
const BORDER_WIDTH = 1;
const FIELD_PADDING = 8;

function decoratedField(props: TextFieldProps, multiline: boolean, rows: number): PingoNode {
  const fontSize = props.fontSize ?? 14;
  const lineHeight = props.lineHeight ?? Math.round(fontSize * 1.5);
  const width = props.width ?? 240;
  const innerHeight = props.height ?? lineHeight * rows + FIELD_PADDING * 2;
  const borderColor =
    props.error === undefined
      ? (props.borderColor ?? DEFAULT_BORDER)
      : (props.errorColor ?? DEFAULT_ERROR);
  const editable: EditableTextProps = {
    width: width - (BORDER_WIDTH + FIELD_PADDING) * 2,
    height: innerHeight - FIELD_PADDING * 2,
    fontSize,
    lineHeight,
    color: props.color ?? DEFAULT_TEXT,
    multiline,
    ...(props.controller === undefined
      ? { value: props.value ?? "", revision: props.revision ?? 0n }
      : { controller: props.controller }),
    ...(props.readOnly === undefined ? {} : { readOnly: props.readOnly }),
    ...(props.password === undefined ? {} : { password: props.password }),
    ...(props.maxGraphemes === undefined ? {} : { maxGraphemes: props.maxGraphemes }),
    ...(props.inputMode === undefined ? {} : { inputMode: props.inputMode }),
    ...(props.onTransaction === undefined ? {} : { onTransaction: props.onTransaction }),
    ...(props.onSubmit === undefined ? {} : { onSubmit: props.onSubmit }),
    ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
    semanticRole: "textbox",
  };
  const field = createElement("container", {
    width,
    backgroundColor: borderColor,
    padding: BORDER_WIDTH,
    children: createElement("container", {
      width: width - BORDER_WIDTH * 2,
      height: innerHeight,
      backgroundColor: props.backgroundColor ?? DEFAULT_BACKGROUND,
      padding: FIELD_PADDING,
      children: multiline ? UnstyledTextArea(editable) : Input(editable),
    }),
  });
  if (props.error === undefined) return field;
  return createElement("container", {
    width,
    children: [
      field as PingoNode,
      createElement("text", {
        value: props.error,
        color: props.errorColor ?? DEFAULT_ERROR,
        fontSize: Math.max(10, fontSize - 2),
        lineHeight: Math.max(12, lineHeight - 4),
        semanticRole: "alert",
      }) as PingoNode,
    ],
  });
}

/** Single-line decorated input composing only the engine editable primitive. */
export function TextField(props: TextFieldProps): PingoNode {
  return decoratedField(props, false, 1);
}

/** Multiline decorated input composing only the engine editable primitive. */
export function TextArea(props: TextAreaProps): PingoNode {
  return decoratedField(props, true, props.rows ?? 3);
}

/** Focusable activation surface composed from View, focus, and native click state. */
export function Pressable(props: PressableProps): PingoNode {
  const disabled = props.disabled === true;
  const focus = (event: PingoEvent): void => event.currentTarget.focus();
  return View({
    children: props.children,
    semanticRole: "button",
    ...(disabled ? { semanticValue: "disabled" } : {}),
    ...(props.semanticLabel === undefined ? {} : { semanticLabel: props.semanticLabel }),
    ...(props.className === undefined ? {} : { className: props.className }),
    ...(props.style === undefined ? {} : { style: props.style }),
    ...(props.width === undefined ? {} : { width: props.width }),
    ...(props.height === undefined ? {} : { height: props.height }),
    opacity: disabled ? 0.5 : 1,
    ...(disabled ? {} : { onPointerDown: focus, onClick: props.onPress, onTap: props.onPress }),
  });
}

/** Accessible text button without a dedicated Scene node kind. */
export function Button(props: ButtonProps): PingoNode {
  return Pressable({
    ...props,
    children: Text({
      value: String(props.children),
      ...(props.color === undefined ? {} : { color: props.color }),
      ...(props.fontSize === undefined ? {} : { fontSize: props.fontSize }),
    }),
    semanticLabel: props.semanticLabel ?? String(props.children),
  });
}
