import type { StyleDiagnostic } from "./types";

/** Thrown by createStyleSheet when compilation produced one or more errors. */
export class StyleSheetCompileError extends Error {
  readonly diagnostics: readonly StyleDiagnostic[];

  constructor(diagnostics: readonly StyleDiagnostic[]) {
    super(diagnostics[0]?.message ?? "stylesheet compilation failed");
    this.name = "StyleSheetCompileError";
    this.diagnostics = diagnostics;
  }
}
