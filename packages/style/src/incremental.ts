import {
  STYLE_INVALIDATION_DOMAINS,
  STYLE_PROPERTIES,
  type StyleInvalidationDomain,
  type StylePropertyName,
} from "./generated";
import { sha256 } from "./hash";
import { resolveStyle } from "./resolver";
import type {
  ComputedStyle,
  IncrementalStyleResolution,
  IncrementalStyleResolverMetrics,
  ResolveStyleOptions,
  ResolveStyleResult,
} from "./types";

const properties = Object.values(STYLE_PROPERTIES);

/**
 * Memoizes the no-change path and reports exact computed-style differences.
 *
 * Changed inputs deliberately use the full resolver in M6-A. This keeps the
 * reference path intact until property-level incremental cascade is justified
 * by profiles and can be checked against the same result contract.
 */
export class IncrementalStyleResolver {
  private inputSignature: string | null = null;
  private lastResult: ResolveStyleResult | null = null;
  private resolutions = 0;
  private fullResolutions = 0;
  private cacheHits = 0;
  private cacheClears = 0;
  private recomputedProperties = 0;

  resolve(options: ResolveStyleOptions): IncrementalStyleResolution {
    this.resolutions += 1;
    const signature = signatureForOptions(options);
    if (signature === this.inputSignature && this.lastResult !== null) {
      this.cacheHits += 1;
      return freezeResolution(this.lastResult, true, [], [], 0);
    }

    const previousStyle = this.lastResult?.style;
    const result = resolveStyle(options);
    const changedProperties = diffComputedStyles(previousStyle, result.style);
    const invalidation = invalidationForProperties(changedProperties);
    const applicablePropertyCount = properties.filter((metadata) =>
      (metadata.appliesTo as readonly string[]).includes(options.nodeType),
    ).length;

    this.inputSignature = signature;
    this.lastResult = result;
    this.fullResolutions += 1;
    this.recomputedProperties += applicablePropertyCount;
    return freezeResolution(
      result,
      false,
      changedProperties,
      invalidation,
      applicablePropertyCount,
    );
  }

  /** Drops the memoized input/result pair without discarding cumulative counters. */
  clear(): void {
    this.inputSignature = null;
    this.lastResult = null;
    this.cacheClears += 1;
  }

  metrics(): IncrementalStyleResolverMetrics {
    return Object.freeze({
      resolutions: this.resolutions,
      fullResolutions: this.fullResolutions,
      cacheHits: this.cacheHits,
      cacheClears: this.cacheClears,
      recomputedProperties: this.recomputedProperties,
    });
  }
}

function signatureForOptions(options: ResolveStyleOptions): string {
  const fields = [
    atom(options.nodeType),
    atom(options.className),
    atom(options.interactionState),
    recordSignature(options.inlineStyle),
    recordSignature(options.parentStyle),
    recordSignature(options.legacyStyle),
    (options.styleSheets ?? [])
      .map((styleSheet) =>
        [
          atom(styleSheet.cssSubsetVersion),
          atom(styleSheet.contentHash),
          atom(styleSheet.featureBits),
          atom(styleSheet.ruleCount),
        ].join("|"),
      )
      .join(","),
  ];
  return sha256(fields.join("\u001f"));
}

function recordSignature(value: object | undefined): string {
  if (value === undefined) return "undefined";
  const record = value as Readonly<Record<string, unknown>>;
  return Object.keys(value)
    .map((key) => `${atom(key)}:${atom(record[key])}`)
    .join("|");
}

function atom(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null) return "l";
  if (typeof value === "string") return `s${value.length}:${value}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "n:NaN";
    if (Object.is(value, -0)) return "n:-0";
    return `n:${String(value)}`;
  }
  if (typeof value === "boolean") return value ? "b:1" : "b:0";
  if (typeof value === "bigint") return `i:${String(value)}`;
  if (typeof value === "symbol" || typeof value === "function")
    return `${typeof value}:${String(value)}`;
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return `j${serialized.length}:${serialized}`;
  } catch {
    // The full resolver reports cyclic unsupported values by their object tag.
  }
  return `o:${Object.prototype.toString.call(value)}`;
}

function diffComputedStyles(
  previous: ComputedStyle | undefined,
  current: ComputedStyle,
): readonly StylePropertyName[] {
  return Object.freeze(
    properties
      .filter((metadata) => !Object.is(previous?.[metadata.jsName], current[metadata.jsName]))
      .map((metadata) => metadata.jsName),
  );
}

function invalidationForProperties(
  changedProperties: readonly StylePropertyName[],
): readonly StyleInvalidationDomain[] {
  const domains = new Set<StyleInvalidationDomain>();
  for (const property of changedProperties) {
    for (const domain of STYLE_PROPERTIES[property].invalidation) {
      domains.add(domain);
    }
  }
  return Object.freeze(STYLE_INVALIDATION_DOMAINS.filter((domain) => domains.has(domain)));
}

function freezeResolution(
  result: ResolveStyleResult,
  cacheHit: boolean,
  changedProperties: readonly StylePropertyName[],
  invalidation: readonly StyleInvalidationDomain[],
  recomputedProperties: number,
): IncrementalStyleResolution {
  return Object.freeze({
    result,
    cacheHit,
    changedProperties: Object.freeze([...changedProperties]),
    invalidation: Object.freeze([...invalidation]),
    recomputedProperties,
  });
}
