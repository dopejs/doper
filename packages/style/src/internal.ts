import type { StylePropertyName } from "./generated";
import type { PingoStyleSheet, StyleDiagnostic, StyleSourceLocation } from "./types";

export type GlobalStyleKeyword = "inherit" | "initial" | "unset";
export type SpecifiedStyleValue = number | string | { readonly global: GlobalStyleKeyword };

export interface CompiledDeclaration {
  readonly property: StylePropertyName;
  readonly value: SpecifiedStyleValue;
  readonly location?: StyleSourceLocation;
}

export interface CompiledRule {
  readonly classes: readonly string[];
  readonly stateMask: number;
  readonly specificity: number;
  readonly declarations: readonly CompiledDeclaration[];
}

export const INTERNAL_STYLE_SHEET = Symbol("pingo.internalStyleSheet");

export interface InternalStyleSheet extends PingoStyleSheet {
  readonly [INTERNAL_STYLE_SHEET]: true;
  readonly rules: readonly CompiledRule[];
  readonly diagnostics: readonly StyleDiagnostic[];
}

export function isInternalStyleSheet(value: PingoStyleSheet): value is InternalStyleSheet {
  return (value as Partial<InternalStyleSheet>)[INTERNAL_STYLE_SHEET] === true;
}
