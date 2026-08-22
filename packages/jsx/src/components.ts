import { createElement } from "./element";
import type {
  AnyPingoElement,
  ContainerProps,
  EditableTextProps,
  ImageProps,
  VideoProps,
  TextProps,
  ViewHandle,
  VirtualListProps,
  VirtualViewProps,
  ScrollProps,
  Ref,
} from "./types";

const FOUNDATION_COMPONENT = Symbol.for("dopejs.pingo.foundation-component");

/** Public general-purpose box, currently mapped to the compatible container intrinsic. */
export type ViewProps = Omit<ContainerProps, "ref"> & {
  readonly ref?: Ref<ViewHandle>;
  /** Explicit single-axis virtualization contract; never inferred from overflow. */
  readonly virtual?: VirtualViewProps;
  readonly scrollX?: number;
  readonly scrollY?: number;
};

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

/** Creates a Host-decoded, Core-composited video without a browser object in Scene. */
export function Video(props: VideoProps): AnyPingoElement {
  return compatibleHostElement("video", props);
}

/** Creates a single-line editor; callers cannot change its multiline invariant. */
export function Input(props: InputProps): AnyPingoElement {
  return compatibleHostElement("editableText", { ...props, multiline: false });
}

/** Creates an unstyled multiline editor sharing the same primitive as Input. */
export function TextArea(props: TextAreaProps): AnyPingoElement {
  return compatibleHostElement("editableText", { ...props, multiline: true });
}

/**
 * Creates a Core-scrolled container through the compatible scroll intrinsic.
 *
 * Scrolling is owned by Core, so this is a real scroll port rather than a
 * styled overflow: the frame keeps moving while the Shell is busy.
 */
export function Scroll(props: ScrollProps): AnyPingoElement {
  return compatibleHostElement("scroll", props);
}

/**
 * Creates a Core-planned virtual list through the compatible intrinsic.
 *
 * The window is Core's decision and `renderItem` is called only for the range
 * it asks for, which is what keeps a million-row list bounded.
 */
export function VirtualList(props: VirtualListProps): AnyPingoElement {
  return compatibleHostElement("virtualList", props);
}

function compatibleHostElement(type: "container", props: ViewProps): AnyPingoElement;
function compatibleHostElement(type: "text", props: TextProps): AnyPingoElement;
function compatibleHostElement(type: "image", props: ImageProps): AnyPingoElement;
function compatibleHostElement(type: "video", props: VideoProps): AnyPingoElement;
function compatibleHostElement(type: "editableText", props: EditableTextProps): AnyPingoElement;
function compatibleHostElement(type: "scroll", props: ScrollProps): AnyPingoElement;
function compatibleHostElement(type: "virtualList", props: VirtualListProps): AnyPingoElement;
function compatibleHostElement(
  type: "container" | "editableText" | "image" | "scroll" | "text" | "video" | "virtualList",
  props:
    | ViewProps
    | EditableTextProps
    | ImageProps
    | ScrollProps
    | TextProps
    | VideoProps
    | VirtualListProps,
): AnyPingoElement {
  const compatibleProps: Record<string, unknown> = {
    ...props,
    [FOUNDATION_COMPONENT]: true,
  };
  return createElement(type, compatibleProps);
}
