/** Stable list identity used by localized reconciliation. */
export type Key = string | number;

/** Engine-native host element names. */
export type HostType = "container" | "editableText" | "scroll" | "text";

/** Mounted host handle exposed through refs without leaking internal instances. */
export interface NodeHandle {
  /** Generation-bearing Core node identifier. */
  readonly nodeId: number;
}

/** Object or callback ref. */
export type Ref<T> = { current: T | null } | ((value: T | null) => void);

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
  readonly backgroundColor?: Color;
  readonly opacity?: number;
  readonly transform?: readonly [number, number, number, number, number, number];
  readonly onTap?: () => void;
  readonly semanticRole?: string;
  readonly semanticLabel?: string;
  readonly semanticValue?: string;
}

/** Generic grouping element. */
export type ContainerProps = CommonProps;

/** Clipped Core-owned scrolling element. */
export interface ScrollProps extends CommonProps {
  readonly scrollX?: number;
  readonly scrollY?: number;
}

/** Minimal M1 text fallback properties. */
export interface TextProps extends Omit<CommonProps, "children"> {
  readonly value?: string;
  readonly children?: string | number;
  readonly color?: Color;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: number;
  readonly lineHeight?: number;
}

/** Engine-native editable-text primitive; browser bridging is owned by the host. */
export interface EditableTextProps extends Omit<TextProps, "children"> {
  readonly value: string;
  readonly multiline?: boolean;
  readonly readOnly?: boolean;
  readonly password?: boolean;
  readonly maxGraphemes?: number;
  readonly onTransaction?: (value: string, revision: number) => void;
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
    scroll: ScrollProps;
    text: TextProps;
  }
}
