import type {
  PingoStyle,
  PingoStyleNodeType,
  StyleInvalidationDomain,
  StylePropertyName,
  StylePropertyMetadata,
} from "./generated";

/** Stable machine-readable diagnostic codes emitted by the M6 style resolver. */
export type StyleDiagnosticCode =
  | "important-not-supported"
  | "invalid-class-name"
  | "invalid-css"
  | "property-not-applicable"
  | "unsupported-selector"
  | "unsupported-value"
  | "unknown-property";

/** Source location in the original stylesheet, using one-based line and column. */
export interface StyleSourceLocation {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly sourceName?: string;
}

/** A deterministic style compilation or resolution diagnostic. */
export interface StyleDiagnostic {
  readonly code: StyleDiagnosticCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly property?: string;
  readonly location?: StyleSourceLocation;
}

/** Canonical values ready for a future typed Shell-to-Core style resource. */
export type ComputedStyleValue = number | string;

/** Complete computed longhand map for the selected node type. */
export type ComputedStyle = Readonly<Partial<Record<StylePropertyName, ComputedStyleValue>>>;

/** Immutable compiled stylesheet. It intentionally exposes no CSSOM mutation surface. */
export interface PingoStyleSheet {
  readonly cssSubsetVersion: string;
  readonly contentHash: string;
  readonly featureBits: number;
  readonly ruleCount: number;
}

/** Type-safe stylesheet object. Keys are class selectors with or without the leading dot. */
export type PingoStyleSheetObject = Readonly<Record<string, PingoStyle>>;

/** Optional source identity included in stylesheet diagnostics. */
export interface CompileStyleSheetOptions {
  readonly sourceName?: string;
}

/** Result of non-throwing stylesheet compilation. */
export interface StyleSheetCompilation {
  readonly styleSheet: PingoStyleSheet | null;
  readonly diagnostics: readonly StyleDiagnostic[];
}

/** Inputs to deterministic cascade and computed-value resolution. */
export interface ResolveStyleOptions {
  readonly nodeType: PingoStyleNodeType;
  readonly className?: string;
  readonly styleSheets?: readonly PingoStyleSheet[];
  readonly inlineStyle?: PingoStyle;
  readonly parentStyle?: ComputedStyle;
  /** Published 0.x direct props. They outrank inline style during migration. */
  readonly legacyStyle?: Readonly<Partial<Record<StylePropertyName, unknown>>>;
}

/** Computed result plus all recoverable diagnostics. */
export interface ResolveStyleResult {
  readonly style: ComputedStyle;
  readonly diagnostics: readonly StyleDiagnostic[];
}

/** One resolution from the memoizing Shell-side computed-style resolver. */
export interface IncrementalStyleResolution {
  readonly result: ResolveStyleResult;
  readonly cacheHit: boolean;
  readonly changedProperties: readonly StylePropertyName[];
  readonly invalidation: readonly StyleInvalidationDomain[];
  readonly recomputedProperties: number;
}

/** Cumulative, deterministic resolver counters suitable for diagnostics. */
export interface IncrementalStyleResolverMetrics {
  readonly resolutions: number;
  readonly fullResolutions: number;
  readonly cacheHits: number;
  readonly cacheClears: number;
  readonly recomputedProperties: number;
}

/** Public capability description; engine support remains explicit during M6-A. */
export interface StyleCapability {
  readonly id: number;
  readonly cssName: string;
  readonly jsName: StylePropertyName;
  readonly grammar: string;
  readonly canonical: string;
  readonly inherited: boolean;
  readonly invalidation: readonly string[];
  readonly animation: string;
  readonly appliesTo: readonly PingoStyleNodeType[];
  readonly feature: string;
  readonly affects: readonly string[];
  readonly percentageReference: string;
  readonly engineSupport: "planned-m6-b";
}

/** Snapshot returned by styleCapabilities(). */
export interface StyleCapabilities {
  readonly cssSubsetVersion: string;
  readonly featureBits: number;
  readonly resolverReady: true;
  readonly engineReady: false;
  readonly properties: readonly StyleCapability[];
}

export type { PingoStyle, PingoStyleNodeType, StyleInvalidationDomain, StylePropertyMetadata };
