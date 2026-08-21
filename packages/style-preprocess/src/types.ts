import type { PingoStyleSheet, StyleSourceLocation } from "@dopejs/pingo-style";

export type StylePreprocessLanguage = "scss" | "less";
export type StylePreprocessStage = StylePreprocessLanguage | "pingo-css";

export interface StylePreprocessDiagnostic {
  readonly stage: StylePreprocessStage;
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly generatedLocation?: StyleSourceLocation;
  readonly sourceLocation?: StyleSourceLocation;
}

export interface StylePreprocessResult {
  readonly language: StylePreprocessLanguage;
  readonly cssText: string | null;
  readonly styleSheet: PingoStyleSheet | null;
  readonly diagnostics: readonly StylePreprocessDiagnostic[];
  readonly dependencies: readonly string[];
}

export interface StylePreprocessBudgets {
  readonly maximumDependencies?: number;
  readonly maximumDependencyBytes?: number;
  readonly maximumEntryCodeUnits?: number;
}

export interface BasePreprocessOptions extends StylePreprocessBudgets {
  readonly allowRoots?: readonly string[];
  readonly sourceName?: string;
}

export interface ScssPreprocessOptions extends BasePreprocessOptions {
  readonly loadPaths?: readonly string[];
}

export interface LessPreprocessOptions extends BasePreprocessOptions {
  readonly paths?: readonly string[];
}

export interface FilePreprocessOptions extends StylePreprocessBudgets {
  readonly allowRoots?: readonly string[];
  readonly lessPaths?: readonly string[];
  readonly scssLoadPaths?: readonly string[];
}
