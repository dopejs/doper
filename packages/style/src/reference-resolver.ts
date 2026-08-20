import {
  CSS_SUBSET_VERSION,
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
  StyleDiagnostic,
} from "./types";

const classNamePattern = /^[_a-zA-Z][_a-zA-Z0-9-]*$/u;
const properties = Object.values(STYLE_PROPERTIES);

interface ReferenceCandidate {
  readonly property: StylePropertyName;
  readonly specificity: number;
  readonly order: number;
  readonly value: SpecifiedStyleValue;
}

/**
 * Deliberately straightforward differential oracle for tests.
 *
 * Unlike the production resolver's one-pass winning-candidate map, this
 * implementation retains every applicable candidate and independently scans
 * the list once per property. Keep it out of runtime entry points.
 */
export function resolveStyleReference(options: ResolveStyleOptions): ResolveStyleResult {
  const diagnostics: StyleDiagnostic[] = [];
  const classes = referenceClassSet(options.className, diagnostics);
  const candidates: ReferenceCandidate[] = [];
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
      if (rule.classes.some((className) => !classes.has(className))) continue;
      for (const declaration of rule.declarations) {
        order += 1;
        appendReferenceCandidate(
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

  order = appendObjectCandidates(
    options.inlineStyle,
    1_000_000,
    order,
    options,
    candidates,
    diagnostics,
    false,
  );
  appendObjectCandidates(
    options.legacyStyle,
    2_000_000,
    order,
    options,
    candidates,
    diagnostics,
    true,
  );

  const computed: Partial<Record<StylePropertyName, ComputedStyleValue>> = {};
  for (const metadata of properties) {
    if (!(metadata.appliesTo as readonly string[]).includes(options.nodeType)) continue;
    let winner: ReferenceCandidate | undefined;
    for (const candidate of candidates) {
      if (candidate.property !== metadata.jsName) continue;
      if (
        winner === undefined ||
        candidate.specificity > winner.specificity ||
        (candidate.specificity === winner.specificity && candidate.order > winner.order)
      ) {
        winner = candidate;
      }
    }
    const inherited = metadata.inherited ? options.parentStyle?.[metadata.jsName] : undefined;
    computed[metadata.jsName] = referenceComputedValue(
      winner?.value,
      metadata.initial,
      inherited,
      metadata.inherited,
    );
  }

  referenceOverflowCoupling(computed);
  referenceCurrentColor(computed);
  return Object.freeze({
    style: Object.freeze(computed),
    diagnostics: Object.freeze(diagnostics),
  });
}

function appendObjectCandidates(
  style: Readonly<Record<string, unknown>> | PingoStyle | undefined,
  specificity: number,
  startOrder: number,
  options: ResolveStyleOptions,
  candidates: ReferenceCandidate[],
  diagnostics: StyleDiagnostic[],
  legacy: boolean,
): number {
  let order = startOrder;
  if (style === undefined) return order;
  for (const [name, value] of Object.entries(style)) {
    const expanded = expandDeclaration(name, value, "js");
    diagnostics.push(...expanded.diagnostics);
    for (const declaration of expanded.declarations) {
      order += 1;
      if (legacy && candidates.some((candidate) => candidate.property === declaration.property)) {
        const metadata = metadataForProperty(declaration.property);
        diagnostics.push({
          code: "legacy-direct-prop-conflict",
          severity: "warning",
          message: `Legacy direct prop ${metadata.jsName} overrides a CSS declaration`,
          property: metadata.cssName,
        });
      }
      appendReferenceCandidate(
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

function appendReferenceCandidate(
  property: StylePropertyName,
  value: SpecifiedStyleValue,
  specificity: number,
  order: number,
  options: ResolveStyleOptions,
  candidates: ReferenceCandidate[],
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
  candidates.push({ property, specificity, order, value });
}

function referenceComputedValue(
  value: SpecifiedStyleValue | undefined,
  initial: ComputedStyleValue,
  inherited: ComputedStyleValue | undefined,
  propertyInherits: boolean,
): ComputedStyleValue {
  if (value === undefined) return inherited === undefined ? initial : inherited;
  if (typeof value === "number" || typeof value === "string") return value;
  if (value.global === "initial") return initial;
  if (value.global === "inherit") return inherited === undefined ? initial : inherited;
  return propertyInherits && inherited !== undefined ? inherited : initial;
}

function referenceClassSet(
  className: string | undefined,
  diagnostics: StyleDiagnostic[],
): Set<string> {
  const classes = new Set<string>();
  if (className === undefined || className.trim() === "") return classes;
  for (const token of className.trim().split(/\s+/u)) {
    if (classNamePattern.test(token)) {
      classes.add(token);
    } else {
      diagnostics.push({
        code: "invalid-class-name",
        severity: "error",
        message: `Invalid class token ${JSON.stringify(token)}`,
      });
    }
  }
  return classes;
}

function referenceOverflowCoupling(
  computed: Partial<Record<StylePropertyName, ComputedStyleValue>>,
): void {
  const x = computed.overflowX;
  const y = computed.overflowY;
  if (typeof x !== "string" || typeof y !== "string") return;
  if ((x === "visible" || x === "clip") && y !== "visible" && y !== "clip") {
    computed.overflowX = x === "visible" ? "auto" : "hidden";
  }
  if ((y === "visible" || y === "clip") && x !== "visible" && x !== "clip") {
    computed.overflowY = y === "visible" ? "auto" : "hidden";
  }
}

function referenceCurrentColor(
  computed: Partial<Record<StylePropertyName, ComputedStyleValue>>,
): void {
  const color = computed.color === undefined ? "#000000ff" : computed.color;
  const borderColors: readonly StylePropertyName[] = [
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
  ];
  for (const property of borderColors) {
    if (computed[property] === "currentColor") computed[property] = color;
  }
}
