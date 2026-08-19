import type { DoperFont } from "./font";
import type { DoperImage } from "./image";
import type { EditTransaction, TextEditingController } from "@dopejs/pingo-editing";

/** Stable list identity used by localized reconciliation. */
export type Key = string | number;

/** Engine-native host element names. */
export type HostType = "container" | "editableText" | "image" | "scroll" | "text" | "virtualList";

/** Mounted host handle exposed through refs without leaking internal instances. */
export interface NodeHandle {
  /** Generation-bearing Core node identifier. */
  readonly nodeId: number;
}

/** Object or callback ref. */
export type Ref<T> = { current: T | null } | ((value: T | null) => void);

/** DOM-style event phase after Core world-space hit testing. */
export type DoperEventPhase = 1 | 2 | 3;

/** Stable Shell event object; coordinates are canvas-local logical pixels. */
export interface DoperEvent {
  readonly type: "click" | "pointercancel" | "pointerdown" | "pointermove" | "pointerup" | "wheel";
  readonly eventId: number;
  readonly target: NodeHandle;
  readonly currentTarget: NodeHandle;
  readonly eventPhase: DoperEventPhase;
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly buttons: number;
  readonly pointerId: number;
  readonly elapsedMicros: number;
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
export type DoperEventHandler = (event: DoperEvent) => void;

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

/** Shared host properties mapped to generated Scene props. */
export interface CommonProps {
  readonly key?: Key;
  readonly ref?: Ref<NodeHandle>;
  readonly children?: DoperNode;
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
  readonly onTap?: () => void;
  readonly onPointerDownCapture?: DoperEventHandler;
  readonly onPointerDown?: DoperEventHandler;
  readonly onPointerUpCapture?: DoperEventHandler;
  readonly onPointerUp?: DoperEventHandler;
  readonly onPointerMoveCapture?: DoperEventHandler;
  readonly onPointerMove?: DoperEventHandler;
  readonly onPointerCancelCapture?: DoperEventHandler;
  readonly onPointerCancel?: DoperEventHandler;
  readonly onClickCapture?: DoperEventHandler;
  readonly onClick?: DoperEventHandler;
  readonly onWheelCapture?: DoperEventHandler;
  readonly onWheel?: DoperEventHandler;
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
  readonly source: DoperImage;
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
  readonly renderItem: (index: number) => DoperNode;
  readonly baseOverscanViewports?: number;
  readonly velocityHorizonSeconds?: number;
  readonly maximumAheadViewports?: number;
  readonly scrollX?: number;
  readonly scrollY?: number;
}

/** Minimal M1 text fallback properties. */
export interface TextProps extends Omit<CommonProps, "children"> {
  readonly value?: string;
  readonly children?: string | number;
  readonly color?: Color;
  readonly fontFamily?: string;
  /** Explicit immutable SFNT font; unsupported input falls back as a whole run. */
  readonly font?: DoperFont;
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
export type FunctionComponent<Props = Record<string, never>> = (props: Props) => DoperNode;

/** Fragment marker accepted as an element type. */
export const Fragment: unique symbol = Symbol.for("dopejs.doper.fragment");

/** Host, component, or Fragment element type. */
export type ElementType<Props = Record<string, unknown>> =
  HostType | FunctionComponent<Props> | typeof Fragment;

/** Erased immutable descriptor used in heterogeneous child collections. */
export interface AnyDoperElement {
  readonly $$typeof: symbol;
  readonly type: HostType | FunctionComponent<never> | typeof Fragment;
  readonly key: Key | null;
  readonly props: Readonly<Record<string, unknown>>;
}

/** Immutable JSX descriptor preserving component prop inference. */
export interface DoperElement<
  Props extends Record<string, unknown> = Record<string, unknown>,
> extends AnyDoperElement {
  readonly type: ElementType<Props>;
  readonly props: Readonly<Props>;
}

/** Values accepted in component and host children. */
export type DoperNode =
  AnyDoperElement | string | number | bigint | boolean | null | undefined | readonly DoperNode[];

/** TypeScript automatic-JSX namespace. */
// eslint-disable-next-line @typescript-eslint/no-namespace -- TypeScript's JSX import-source contract requires this namespace name.
export declare namespace JSX {
  export type Element = AnyDoperElement;
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
    virtualList: VirtualListProps;
  }
}
