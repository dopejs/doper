import { createElement } from "./element";
import type {
  AnyPingoElement,
  ContainerProps,
  EditableTextProps,
  ImageProps,
  TextProps,
} from "./types";

/** Public general-purpose box, currently mapped to the compatible container intrinsic. */
export type ViewProps = ContainerProps;

/** Public single-line editor backed by the shared Core EditableText subsystem. */
export type InputProps = Omit<EditableTextProps, "multiline">;

/** Public multiline editor backed by the shared Core EditableText subsystem. */
export type TextAreaProps = Omit<EditableTextProps, "multiline">;

/** Creates a general-purpose box without introducing a new Core node kind. */
export function View(props: ViewProps): AnyPingoElement {
  return compatibleHostElement("container", props);
}

/** Creates engine-native text through the compatible text intrinsic. */
export function Text(props: TextProps): AnyPingoElement {
  return compatibleHostElement("text", props);
}

/** Creates an engine-drawn image through the compatible image intrinsic. */
export function Image(props: ImageProps): AnyPingoElement {
  return compatibleHostElement("image", props);
}

/** Creates a single-line editor; callers cannot change its multiline invariant. */
export function Input(props: InputProps): AnyPingoElement {
  return compatibleHostElement("editableText", { ...props, multiline: false });
}

/** Creates an unstyled multiline editor sharing the same primitive as Input. */
export function TextArea(props: TextAreaProps): AnyPingoElement {
  return compatibleHostElement("editableText", { ...props, multiline: true });
}

function compatibleHostElement(type: "container", props: ContainerProps): AnyPingoElement;
function compatibleHostElement(type: "text", props: TextProps): AnyPingoElement;
function compatibleHostElement(type: "image", props: ImageProps): AnyPingoElement;
function compatibleHostElement(type: "editableText", props: EditableTextProps): AnyPingoElement;
function compatibleHostElement(
  type: "container" | "editableText" | "image" | "text",
  props: ContainerProps | EditableTextProps | ImageProps | TextProps,
): AnyPingoElement {
  return createElement(type, props as unknown as Record<string, unknown>);
}
