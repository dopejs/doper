import type { StylePreprocessDiagnostic } from "./types.js";

export class StylePreprocessError extends Error {
  readonly diagnostics: readonly StylePreprocessDiagnostic[];

  constructor(diagnostics: readonly StylePreprocessDiagnostic[]) {
    super(diagnostics[0]?.message ?? "stylesheet preprocessing failed");
    this.name = "StylePreprocessError";
    this.diagnostics = diagnostics;
  }
}
