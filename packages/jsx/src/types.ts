import type { PingoFont } from "./font";
import type { PingoImage } from "./image";
import type { MemoComponent } from "./memo";
import type { EditTransaction, TextEditingController } from "@dopejs/pingo-editing";
import type { ContextProvider } from "@dopejs/pingo-runtime";
import type { PingoStyle } from "@dopejs/pingo-style";

/** Stable list identity used by localized reconciliation. */
export type Key = string | number;

/** Engine-native host element names. */
export type HostType =
  "container" | "editableText" | "image" | "scroll" | "text" | "video" | "virtualList";

/** Mounted host handle exposed through refs without leaking internal instances. */
export interface NodeHandle {
  /** Generation-bearing Core node identifier. */
  readonly nodeId: number;
  /** Requests explicit Core pointer capture for this mounted node. */
  setPointerCapture(pointerId: number): void;
  /** Releases explicit Core pointer capture when this node owns it. */
  releasePointerCapture(pointerId: number): void;
  /** Returns whether Core most recently reported this node as capture owner. */
  hasPointerCapture(pointerId: number): boolean;
  /** Requests Core focus without inferring keyboard focus visibility. */
  focus(): void;
  /** Clears Core focus when this node owns it. */
  blur(): void;
}

/** Mounted View handle for deterministic Core-owned scrolling. */
export interface ViewHandle extends NodeHandle {
  /** Immediately sets the logical content offset and cancels existing motion. */
  scrollTo(x: number, y: number): void;
  /** Immediately offsets the logical content position and cancels existing motion. */
  scrollBy(deltaX: number, deltaY: number): void;
  /** Starts constant-velocity Core scrolling; two zeros stop it. */
  setScrollVelocity(velocityX: number, velocityY: number): void;
}

/** Mounted Video handle. Commands are forwarded to the Host-owned media element. */
export interface VideoHandle extends NodeHandle {
  play(): void;
  pause(): void;
  seek(timeSeconds: number): void;
}

/** Object or callback ref. */
export type Ref<T> = { current: T | null } | ((value: T | null) => void);

/** DOM-style event phase after Core world-space hit testing. */
export type PingoEventPhase = 1 | 2 | 3;

/** Stable Shell event object; coordinates are canvas-local logical pixels. */
export interface PingoEvent {
  readonly type:
    | "blur"
    | "click"
    | "focus"
    | "focusin"
    | "focusout"
    | "gotpointercapture"
    | "keydown"
    | "keyup"
    | "lostpointercapture"
    | "pointercancel"
    | "pointerdown"
    | "pointerenter"
    | "pointerleave"
    | "pointermove"
    | "pointerout"
    | "pointerover"
    | "pointerup"
    | "wheel";
  readonly eventId: number;
  readonly target: NodeHandle;
  readonly currentTarget: NodeHandle;
  readonly relatedTarget: NodeHandle | null;
  readonly eventPhase: PingoEventPhase;
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly buttons: number;
  readonly pointerId: number;
  readonly pointerType: "mouse" | "none" | "pen" | "touch";
  readonly isPrimary: boolean;
  readonly pressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly width: number;
  readonly height: number;
  readonly elapsedMicros: number;
  /**
   * `KeyboardEvent.key` on a key event, `""` otherwise.
   *
   * `preventDefault()` on a key event only stops Shell propagation. It never
   * suppresses editing: text insertion comes from the editing transaction path,
   * which does not read key events.
   */
  readonly key: string;
  /** `KeyboardEvent.code` on a key event, `""` otherwise or when unrecognized. */
  readonly code: string;
  /** Whether a key press is an auto-repeat. */
  readonly repeat: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

/** Handler invoked during Core-resolved capture or bubble propagation. */
export type PingoEventHandler = (event: PingoEvent) => void;

/** RGBA color accepted by portable solid-paint encoding. */
export type Color =
  | `#${string}`
  | {
      readonly red: number;
      readonly green: number;
      readonly blue: number;
      readonly alpha?: number;
    };

/** Four logical-pixel edges in top/right/bottom/left order. */
export type EdgeInsets = number | readonly [number, number, number, number];

/** Timing functions supported by the Core animation timeline. */
export type AnimationEasing =
  | "linear"
  | "ease"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | { readonly cubicBezier: readonly [number, number, number, number] }
  | { readonly steps: number; readonly position?: "start" | "end" };

/** Compositor-friendly property supported by M7. */
export type AnimatedProperty = "opacity" | "transform";

/** Transition declaration; a new durable target retargets from presentation. */
export interface TransitionSpec {
  readonly property: AnimatedProperty;
  readonly durationMs: number;
  readonly delayMs?: number;
  readonly easing?: AnimationEasing;
}

/** One immutable keyframe with a property-compatible value. */
export interface AnimationKeyframe {
  readonly offset: number;
  readonly value: number | readonly [number, number, number, number, number, number];
}

/** Core-owned immutable keyframe animation. */
export interface KeyframeAnimationSpec {
  readonly property: AnimatedProperty;
  readonly keyframes: readonly AnimationKeyframe[];
  readonly durationMs: number;
  readonly delayMs?: number;
  readonly easing?: AnimationEasing;
  readonly iterations?: number;
  readonly direction?: "normal" | "reverse" | "alternate" | "alternate-reverse";
  readonly fill?: "none" | "forwards" | "backwards" | "both";
  readonly playState?: "running" | "paused";
}

/** Shared host properties mapped to generated Scene props. */
export interface CommonProps {
  readonly key?: Key;
  readonly ref?: Ref<NodeHandle>;
  readonly children?: PingoNode;
  /** Registered same-node class selectors, separated by ASCII whitespace. */
  readonly className?: string;
  /** Typed inline declarations resolved by the Shell before entering Core. */
  readonly style?: PingoStyle;
  readonly width?: number;
  readonly height?: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly padding?: EdgeInsets;
  /**
   * Child flow axis. Defaults to `"column"`.
   *
   * Children are placed one after another along this axis and the container's
   * natural size is the run along it by the tallest/widest child across it.
   * There is no cross-axis alignment yet: children sit at the leading edge.
   */
  readonly direction?: "column" | "row";
  /** Space inserted between adjacent children, never before or after them. */
  readonly gap?: number;
  readonly backgroundColor?: Color;
  readonly opacity?: number;
  readonly transform?: readonly [number, number, number, number, number, number];
  readonly transition?: TransitionSpec | readonly TransitionSpec[];
  readonly animation?: KeyframeAnimationSpec | readonly KeyframeAnimationSpec[];
  readonly onTap?: () => void;
  readonly onPointerDownCapture?: PingoEventHandler;
  readonly onPointerDown?: PingoEventHandler;
  readonly onPointerUpCapture?: PingoEventHandler;
  readonly onPointerUp?: PingoEventHandler;
  readonly onPointerMoveCapture?: PingoEventHandler;
  readonly onPointerMove?: PingoEventHandler;
  readonly onPointerCancelCapture?: PingoEventHandler;
  readonly onPointerCancel?: PingoEventHandler;
  readonly onPointerOverCapture?: PingoEventHandler;
  readonly onPointerOver?: PingoEventHandler;
  readonly onPointerOutCapture?: PingoEventHandler;
  readonly onPointerOut?: PingoEventHandler;
  readonly onPointerEnterCapture?: PingoEventHandler;
  readonly onPointerEnter?: PingoEventHandler;
  readonly onPointerLeaveCapture?: PingoEventHandler;
  readonly onPointerLeave?: PingoEventHandler;
  readonly onGotPointerCaptureCapture?: PingoEventHandler;
  readonly onGotPointerCapture?: PingoEventHandler;
  readonly onLostPointerCaptureCapture?: PingoEventHandler;
  readonly onLostPointerCapture?: PingoEventHandler;
  readonly onFocusCapture?: PingoEventHandler;
  readonly onFocus?: PingoEventHandler;
  readonly onBlurCapture?: PingoEventHandler;
  readonly onBlur?: PingoEventHandler;
  readonly onFocusInCapture?: PingoEventHandler;
  readonly onFocusIn?: PingoEventHandler;
  readonly onFocusOutCapture?: PingoEventHandler;
  readonly onFocusOut?: PingoEventHandler;
  readonly onClickCapture?: PingoEventHandler;
  readonly onClick?: PingoEventHandler;
  readonly onWheelCapture?: PingoEventHandler;
  readonly onWheel?: PingoEventHandler;
  /**
   * Key press routed to the focused node.
   *
   * Core delivers key events only to whatever currently holds focus; a node
   * that is not focused never sees them.
   */
  readonly onKeyDownCapture?: PingoEventHandler;
  readonly onKeyDown?: PingoEventHandler;
  readonly onKeyUpCapture?: PingoEventHandler;
  readonly onKeyUp?: PingoEventHandler;
  readonly semanticRole?: string;
  readonly semanticLabel?: string;
  readonly semanticValue?: string;
}

/** Generic grouping element. */
export type ContainerProps = CommonProps;

/**
 * Engine-drawn bitmap.
 *
 * With no explicit `width`/`height` the node takes the image's pixel
 * dimensions; with one, the image is scaled into that box.
 */
export interface ImageProps extends Omit<CommonProps, "children"> {
  readonly source: PingoImage;
}

/** Stable media event emitted by the Host-owned playback pipeline. */
export interface PingoMediaEvent {
  readonly type: "ended" | "loadedmetadata" | "pause" | "play" | "timeupdate";
  readonly currentTime: number;
  readonly duration: number;
}

/** Bounded, diagnosable media failure without exposing a browser media object. */
export interface PingoMediaError {
  readonly code: "aborted" | "decode" | "network" | "not-supported" | "security" | "unknown";
  readonly message: string;
}

/** Engine-drawn video whose browser loading and decoding remain Host-owned. */
export interface VideoProps extends Omit<CommonProps, "children" | "ref"> {
  readonly src: string;
  readonly poster?: PingoImage;
  readonly ref?: Ref<VideoHandle>;
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  readonly muted?: boolean;
  readonly crossOrigin?: "anonymous" | "use-credentials";
  readonly preload?: "auto" | "metadata" | "none";
  readonly onPlay?: (event: PingoMediaEvent) => void;
  readonly onPause?: (event: PingoMediaEvent) => void;
  readonly onEnded?: (event: PingoMediaEvent) => void;
  readonly onLoadedMetadata?: (event: PingoMediaEvent) => void;
  readonly onTimeUpdate?: (event: PingoMediaEvent) => void;
  readonly onError?: (error: PingoMediaError) => void;
}

/** Clipped Core-owned scrolling element. */
export interface ScrollProps extends CommonProps {
  readonly scrollX?: number;
  readonly scrollY?: number;
}

/** Core-planned virtual list whose Shell materializes only the requested preheat window. */
export interface VirtualListProps extends Omit<CommonProps, "children"> {
  readonly itemCount: number;
  readonly estimatedItemHeight: number;
  readonly renderItem: (index: number) => PingoNode;
  readonly baseOverscanViewports?: number;
  readonly velocityHorizonSeconds?: number;
  readonly maximumAheadViewports?: number;
  readonly scrollX?: number;
  readonly scrollY?: number;
}

/** Explicit single-axis data window attached to a View. */
export interface VirtualViewProps {
  readonly axis?: "x" | "y";
  readonly itemCount: number;
  readonly estimatedItemSize: number;
  readonly getItemKey?: (index: number) => Key;
  readonly renderItem: (index: number) => PingoNode;
  readonly baseOverscanViewports?: number;
  readonly velocityHorizonSeconds?: number;
  readonly maximumAheadViewports?: number;
}

/** Minimal M1 text fallback properties. */
export interface TextProps extends Omit<CommonProps, "children"> {
  readonly value?: string;
  readonly children?: string | number;
  readonly color?: Color;
  readonly fontFamily?: string;
  /** Explicit immutable SFNT font; unsupported input falls back as a whole run. */
  readonly font?: PingoFont;
  readonly fontSize?: number;
  readonly fontWeight?: number;
  readonly lineHeight?: number;
}

/** Soft-keyboard hint forwarded to the host input surface. */
export type EditableInputMode =
  "decimal" | "email" | "none" | "numeric" | "search" | "tel" | "text" | "url";

/** Engine-native editable-text primitive; browser bridging is owned by the host. */
export interface EditableTextProps extends Omit<TextProps, "children"> {
  /** Stable local controller; mutually exclusive with value/revision. */
  readonly controller?: TextEditingController;
  readonly value?: string;
  /** Authoritative controlled-value revision; stale revisions never replace newer Core input. */
  readonly revision?: number | bigint;
  readonly multiline?: boolean;
  readonly readOnly?: boolean;
  readonly password?: boolean;
  readonly maxGraphemes?: number;
  /** Soft-keyboard layout hint; defaults to plain text. */
  readonly inputMode?: EditableInputMode;
  readonly onTransaction?: (transaction: EditTransaction) => void;
  readonly onSubmit?: () => void;
}

/** Function component evaluated inside a reconciler-owned hook scope. */
export type FunctionComponent<Props = Record<string, never>> = (props: Props) => PingoNode;

/** Fragment marker accepted as an element type. */
export const Fragment: unique symbol = Symbol.for("dopejs.pingo.fragment");

/** Host, component, memo component, context provider, or Fragment element type. */
export type ElementType<Props = Record<string, unknown>> =
  | HostType
  | FunctionComponent<Props>
  | MemoComponent<Props>
  | ContextProvider<unknown>
  | typeof Fragment;

/** Erased immutable descriptor used in heterogeneous child collections. */
export interface AnyPingoElement {
  readonly $$typeof: symbol;
  readonly type:
    | HostType
    | FunctionComponent<never>
    | MemoComponent<never>
    | ContextProvider<unknown>
    | typeof Fragment;
  readonly key: Key | null;
  readonly props: Readonly<Record<string, unknown>>;
}

/** Immutable JSX descriptor preserving component prop inference. */
export interface PingoElement<
  Props extends Record<string, unknown> = Record<string, unknown>,
> extends AnyPingoElement {
  readonly type: ElementType<Props>;
  readonly props: Readonly<Props>;
}

/** Values accepted in component and host children. */
export type PingoNode =
  AnyPingoElement | string | number | bigint | boolean | null | undefined | readonly PingoNode[];

/** TypeScript automatic-JSX namespace. */
// eslint-disable-next-line @typescript-eslint/no-namespace -- TypeScript's JSX import-source contract requires this namespace name.
export declare namespace JSX {
  export type Element = AnyPingoElement;
  export interface ElementChildrenAttribute {
    children: unknown;
  }
  export interface IntrinsicAttributes {
    key?: Key;
  }
  export interface IntrinsicElements {
    container: ContainerProps;
    editableText: EditableTextProps;
    image: ImageProps;
    scroll: ScrollProps;
    text: TextProps;
    video: VideoProps;
    virtualList: VirtualListProps;
  }
}
