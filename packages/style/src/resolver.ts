import {
  CSS_SUBSET_VERSION,
  STYLE_FEATURE_BITS,
  STYLE_PROPERTIES,
  type PingoStyle,
  type StylePropertyName,
} from "./generated";
import { isInternalStyleSheet, type SpecifiedStyleValue } from "./internal";
import { expandDeclaration, metadataForProperty } from "./values";
import type {
  ComputedStyleValue,
  ResolveStyleOptions,
  ResolveStyleResult,
  StyleCapabilities,
  StyleCapability,
  StyleDiagnostic,
} from "./types";

const classNamePattern = /^[_a-zA-Z][_a-zA-Z0-9-]*$/u;
const properties = Object.values(STYLE_PROPERTIES);
const featureBits = Object.values(STYLE_FEATURE_BITS).reduce((bits, value) => bits | value, 0);
const capabilitySnapshot: StyleCapabilities = Object.freeze({
  cssSubsetVersion: CSS_SUBSET_VERSION,
  featureBits,
  resolverReady: true,
  engineReady: false,
  properties: Object.freeze(
    properties.map((property) =>
      Object.freeze({
        ...property,
        invalidation: Object.freeze([...property.invalidation]),
        appliesTo: Object.freeze([...property.appliesTo]),
        affects: Object.freeze([...property.affects]),
      }),
    ) as readonly StyleCapability[],
  ),
});

interface CascadeCandidate {
  readonly specificity: number;
  readonly order: number;
  readonly value: SpecifiedStyleValue;
}

/** Resolves initial/inherited values, registered class rules, inline style, and legacy props. */
export function resolveStyle(options: ResolveStyleOptions): ResolveStyleResult {
  const diagnostics: StyleDiagnostic[] = [];
  const classes = parseClassName(options.className, diagnostics);
  const candidates = new Map<StylePropertyName, CascadeCandidate>();
  let order = 0;

  for (const styleSheet of options.styleSheets ?? []) {
    if (!isInternalStyleSheet(styleSheet) || styleSheet.cssSubsetVersion !== CSS_SUBSET_VERSION) {
      diagnostics.push({
        code: "invalid-css",
        severity: "error",
        message: `Stylesheet is not compatible with CSS subset ${CSS_SUBSET_VERSION}`,
      });
      continue;
    }
    for (const rule of styleSheet.rules) {
      if (!rule.classes.every((className) => classes.has(className))) continue;
      for (const declaration of rule.declarations) {
        order += 1;
        considerCandidate(
          declaration.property,
          declaration.value,
          rule.specificity,
          order,
          options,
          candidates,
          diagnostics,
        );
      }
    }
  }

  order = addObjectDeclarations(
    options.inlineStyle,
    1_000_000,
    order,
    options,
    candidates,
    diagnostics,
  );
  addObjectDeclarations(options.legacyStyle, 2_000_000, order, options, candidates, diagnostics);

  const computed: Partial<Record<StylePropertyName, ComputedStyleValue>> = {};
  for (const metadata of properties) {
    if (!(metadata.appliesTo as readonly string[]).includes(options.nodeType)) continue;
    const inherited = metadata.inherited ? options.parentStyle?.[metadata.jsName] : undefined;
    const candidate = candidates.get(metadata.jsName);
    computed[metadata.jsName] = resolveSpecifiedValue(
      candidate?.value,
      metadata.initial,
      inherited,
      metadata.inherited,
    );
  }
  applyOverflowCoupling(computed);
  resolveCurrentColor(computed);
  return Object.freeze({
    style: Object.freeze(computed),
    diagnostics: Object.freeze(diagnostics),
  });
}

/** Returns whether the M6-A Shell resolver accepts a property/value pair. */
export function supportsStyle(property: string, value: unknown): boolean {
  const syntax = property.includes("-") ? "css" : "js";
  const result = expandDeclaration(property, value, syntax);
  return result.diagnostics.length === 0 && result.declarations.length > 0;
}

/** Returns an immutable capability snapshot without claiming M6-B Core support. */
export function styleCapabilities(): StyleCapabilities {
  return capabilitySnapshot;
}

function addObjectDeclarations(
  style: Readonly<Record<string, unknown>> | PingoStyle | undefined,
  specificity: number,
  startOrder: number,
  options: ResolveStyleOptions,
  candidates: Map<StylePropertyName, CascadeCandidate>,
  diagnostics: StyleDiagnostic[],
): number {
  let order = startOrder;
  if (style === undefined) return order;
  for (const [name, value] of Object.entries(style)) {
    const expanded = expandDeclaration(name, value, "js");
    diagnostics.push(...expanded.diagnostics);
    for (const declaration of expanded.declarations) {
      order += 1;
      considerCandidate(
        declaration.property,
        declaration.value,
        specificity,
        order,
        options,
        candidates,
        diagnostics,
      );
    }
  }
  return order;
}

function considerCandidate(
  property: StylePropertyName,
  value: SpecifiedStyleValue,
  specificity: number,
  order: number,
  options: ResolveStyleOptions,
  candidates: Map<StylePropertyName, CascadeCandidate>,
  diagnostics: StyleDiagnostic[],
): void {
  const metadata = metadataForProperty(property);
  if (!(metadata.appliesTo as readonly string[]).includes(options.nodeType)) {
    diagnostics.push({
      code: "property-not-applicable",
      severity: "error",
      message: `${metadata.cssName} does not apply to ${options.nodeType}`,
      property: metadata.cssName,
    });
    return;
  }
  const current = candidates.get(property);
  if (
    current === undefined ||
    specificity > current.specificity ||
    (specificity === current.specificity && order > current.order)
  ) {
    candidates.set(property, { specificity, order, value });
  }
}

function resolveSpecifiedValue(
  value: SpecifiedStyleValue | undefined,
  initial: ComputedStyleValue,
  inherited: ComputedStyleValue | undefined,
  propertyInherits: boolean,
): ComputedStyleValue {
  if (value === undefined) return inherited ?? initial;
  if (typeof value !== "object") return value;
  switch (value.global) {
    case "inherit":
      return inherited ?? initial;
    case "initial":
      return initial;
    case "unset":
      return propertyInherits ? (inherited ?? initial) : initial;
  }
}

function parseClassName(value: string | undefined, diagnostics: StyleDiagnostic[]): Set<string> {
  const result = new Set<string>();
  if (value === undefined || value.trim() === "") return result;
  for (const className of value.trim().split(/\s+/u)) {
    if (!classNamePattern.test(className)) {
      diagnostics.push({
        code: "invalid-class-name",
        severity: "error",
        message: `Invalid class token ${JSON.stringify(className)}`,
      });
    } else {
      result.add(className);
    }
  }
  return result;
}

function applyOverflowCoupling(
  computed: Partial<Record<StylePropertyName, ComputedStyleValue>>,
): void {
  const x = computed.overflowX;
  const y = computed.overflowY;
  if (typeof x !== "string" || typeof y !== "string") return;
  const xNonScrollable = x === "visible" || x === "clip";
  const yNonScrollable = y === "visible" || y === "clip";
  if (xNonScrollable && !yNonScrollable) computed.overflowX = x === "visible" ? "auto" : "hidden";
  if (yNonScrollable && !xNonScrollable) computed.overflowY = y === "visible" ? "auto" : "hidden";
}

function resolveCurrentColor(
  computed: Partial<Record<StylePropertyName, ComputedStyleValue>>,
): void {
  const color = computed.color ?? "#000000ff";
  for (const property of [
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
  ] as const) {
    if (computed[property] === "currentColor") computed[property] = color;
  }
}
