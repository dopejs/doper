import { compileString, type Exception as SassException } from "sass";
import less from "less";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { compileStyleSheet, type StyleDiagnostic } from "@dopejs/pingo-style";

import { StylePreprocessError } from "./error.js";
import { mapGeneratedLocation } from "./source-map.js";
import {
  diagnostic,
  entryBudgetDiagnostic,
  importPolicyDiagnostic,
  normalizedAllowRoots,
  sortedUniquePaths,
  validateDependencies,
} from "./security.js";
import type {
  BasePreprocessOptions,
  LessPreprocessOptions,
  ScssPreprocessOptions,
  StylePreprocessDiagnostic,
  StylePreprocessLanguage,
  StylePreprocessResult,
} from "./types.js";

interface CompilerOutput {
  readonly cssText: string;
  readonly dependencies: readonly string[];
  readonly sourceMap?: string | object;
  readonly diagnostics: readonly StylePreprocessDiagnostic[];
}

type ScssCompilerResult =
  | { readonly output: CompilerOutput }
  | { readonly diagnostics: readonly StylePreprocessDiagnostic[] };

export function compileScssString(
  source: string,
  options: ScssPreprocessOptions = {},
): StylePreprocessResult {
  const rendered = renderScss(source, options);
  if ("diagnostics" in rendered) return failed("scss", rendered.diagnostics);
  return finalizeSync("scss", rendered.output, options, options.loadPaths ?? []);
}

export async function compileImportedScss(
  source: string,
  options: ScssPreprocessOptions,
): Promise<StylePreprocessResult> {
  const rendered = renderScss(source, options);
  if ("diagnostics" in rendered) return failed("scss", rendered.diagnostics);
  return finalize("scss", rendered.output, options, options.loadPaths ?? []);
}

function renderScss(source: string, options: ScssPreprocessOptions): ScssCompilerResult {
  const early = validateEntry("scss", source, options);
  if (early !== null) return { diagnostics: [early] };
  const warnings: StylePreprocessDiagnostic[] = [];
  let output;
  try {
    output = compileString(source, {
      charset: false,
      loadPaths: [...(options.loadPaths ?? [])],
      logger: {
        warn(message, details) {
          warnings.push({
            stage: "scss",
            code: details.deprecation ? "deprecation" : "compiler-warning",
            severity: "warning",
            message,
            ...(details.span === undefined
              ? {}
              : {
                  sourceLocation: {
                    offset: details.span.start.offset,
                    line: details.span.start.line + 1,
                    column: details.span.start.column + 1,
                    ...(details.span.url == null
                      ? {}
                      : { sourceName: sourceNameFromUrl(details.span.url) }),
                  },
                }),
          });
        },
      },
      sourceMap: true,
      sourceMapIncludeSources: false,
      style: "expanded",
      ...(options.sourceName === undefined || !path.isAbsolute(options.sourceName)
        ? {}
        : { url: pathToFileURL(options.sourceName) }),
    });
  } catch (cause) {
    return { diagnostics: [scssError(cause, options.sourceName)] };
  }
  const dependencies = sortedUniquePaths(
    output.loadedUrls
      .filter((url) => url.protocol === "file:")
      .map((url) => fileURLToPath(url))
      .filter((filename) => filename !== options.sourceName),
  );
  const compiled: CompilerOutput = {
    cssText: output.css,
    dependencies,
    ...(output.sourceMap === undefined ? {} : { sourceMap: output.sourceMap }),
    diagnostics: warnings,
  };
  return { output: compiled };
}

export async function compileLessString(
  source: string,
  options: LessPreprocessOptions = {},
): Promise<StylePreprocessResult> {
  const early = validateEntry("less", source, options);
  if (early !== null) return failed("less", [early]);
  let output;
  try {
    output = await less.render(source, {
      filename: options.sourceName,
      javascriptEnabled: false,
      paths: [...(options.paths ?? [])],
      plugins: [],
      rewriteUrls: "off",
      sourceMap: { outputSourceFiles: false },
    });
  } catch (cause) {
    return failed("less", [lessError(cause, options.sourceName)]);
  }
  const compiled: CompilerOutput = {
    cssText: output.css.replace(/\/\*# sourceMappingURL=.*?\*\//gu, "").trimEnd(),
    dependencies: sortedUniquePaths(output.imports),
    ...(output.map === undefined ? {} : { sourceMap: output.map }),
    diagnostics: [],
  };
  return finalize("less", compiled, options, options.paths ?? []);
}

export function createStyleSheetFromScss(source: string, options: ScssPreprocessOptions = {}) {
  const result = compileScssString(source, options);
  if (result.styleSheet === null) throw new StylePreprocessError(result.diagnostics);
  return result.styleSheet;
}

export async function createStyleSheetFromLess(
  source: string,
  options: LessPreprocessOptions = {},
) {
  const result = await compileLessString(source, options);
  if (result.styleSheet === null) throw new StylePreprocessError(result.diagnostics);
  return result.styleSheet;
}

function validateEntry(
  language: StylePreprocessLanguage,
  source: string,
  options: BasePreprocessOptions,
): StylePreprocessDiagnostic | null {
  return (
    entryBudgetDiagnostic(language, source, options) ??
    importPolicyDiagnostic(language, source, options.sourceName)
  );
}

function finalizeSync(
  language: StylePreprocessLanguage,
  output: CompilerOutput,
  options: BasePreprocessOptions,
  loadPaths: readonly string[],
): StylePreprocessResult {
  const roots = normalizedAllowRoots(options.sourceName, options.allowRoots, loadPaths);
  if (output.dependencies.length > 0 && roots.length === 0) {
    return failed(language, [
      diagnostic(language, "allow-root-required", "Imports require an allow root"),
    ]);
  }
  // Sass exposes a synchronous API, but filesystem canonicalization is async. Imported files are
  // validated by compilePingoStyleFile before Vite consumes this result; the string API remains
  // import-free unless callers use the asynchronous file entrypoint.
  if (output.dependencies.length > 0) {
    return failed(language, [
      diagnostic(language, "file-api-required", "SCSS imports must use compilePingoStyleFile"),
    ]);
  }
  return validatePingoCss(language, output, options.sourceName);
}

async function finalize(
  language: StylePreprocessLanguage,
  output: CompilerOutput,
  options: BasePreprocessOptions,
  loadPaths: readonly string[],
): Promise<StylePreprocessResult> {
  const roots = normalizedAllowRoots(options.sourceName, options.allowRoots, loadPaths);
  if (output.dependencies.length > 0 && roots.length === 0) {
    return failed(language, [
      diagnostic(language, "allow-root-required", "Imports require an allow root"),
    ]);
  }
  const dependencyDiagnostics = await validateDependencies(
    language,
    output.dependencies,
    roots,
    options,
  );
  if (dependencyDiagnostics.length > 0) return failed(language, dependencyDiagnostics);
  return validatePingoCss(language, output, options.sourceName);
}

function validatePingoCss(
  language: StylePreprocessLanguage,
  output: CompilerOutput,
  sourceName: string | undefined,
): StylePreprocessResult {
  const compilation = compileStyleSheet(output.cssText, {
    ...(sourceName === undefined ? {} : { sourceName: `${sourceName} (generated CSS)` }),
  });
  const diagnostics = [
    ...output.diagnostics,
    ...compilation.diagnostics.map((item: StyleDiagnostic) =>
      pingoDiagnostic(item, output.sourceMap, sourceName),
    ),
  ].sort(compareDiagnostics);
  return Object.freeze({
    language,
    cssText: output.cssText,
    styleSheet: compilation.styleSheet,
    diagnostics: Object.freeze(diagnostics),
    dependencies: Object.freeze([...output.dependencies]),
  });
}

function pingoDiagnostic(
  item: StyleDiagnostic,
  sourceMap: string | object | undefined,
  entrySourceName: string | undefined,
): StylePreprocessDiagnostic {
  const sourceLocation = mapGeneratedLocation(sourceMap, item.location, entrySourceName);
  return {
    stage: "pingo-css",
    code: item.code,
    severity: item.severity,
    message: item.message,
    ...(item.location === undefined ? {} : { generatedLocation: item.location }),
    ...(sourceLocation === undefined ? {} : { sourceLocation }),
  };
}

function compareDiagnostics(
  left: StylePreprocessDiagnostic,
  right: StylePreprocessDiagnostic,
): number {
  const leftLocation = left.sourceLocation ?? left.generatedLocation;
  const rightLocation = right.sourceLocation ?? right.generatedLocation;
  return (
    (leftLocation?.sourceName ?? "").localeCompare(rightLocation?.sourceName ?? "") ||
    (leftLocation?.line ?? 0) - (rightLocation?.line ?? 0) ||
    (leftLocation?.column ?? 0) - (rightLocation?.column ?? 0) ||
    left.code.localeCompare(right.code)
  );
}

function scssError(cause: unknown, sourceName: string | undefined): StylePreprocessDiagnostic {
  const error = cause as Partial<SassException>;
  const span = error.span;
  return {
    stage: "scss",
    code: "compile-error",
    severity: "error",
    message: error.sassMessage ?? (cause instanceof Error ? cause.message : String(cause)),
    ...(span === undefined
      ? {}
      : {
          sourceLocation: {
            offset: span.start.offset,
            line: span.start.line + 1,
            column: span.start.column + 1,
            ...(span.url == null
              ? sourceName === undefined
                ? {}
                : { sourceName }
              : { sourceName: sourceNameFromUrl(span.url) }),
          },
        }),
  };
}

interface LessErrorLike {
  readonly message?: string;
  readonly filename?: string;
  readonly index?: number;
  readonly line?: number;
  readonly column?: number;
  readonly type?: string;
}

function lessError(cause: unknown, sourceName: string | undefined): StylePreprocessDiagnostic {
  const error = cause as LessErrorLike;
  return {
    stage: "less",
    code: error.type === undefined ? "compile-error" : `compile-${error.type.toLowerCase()}`,
    severity: "error",
    message: error.message ?? (cause instanceof Error ? cause.message : String(cause)),
    ...(error.line === undefined || error.column === undefined
      ? {}
      : {
          sourceLocation: {
            offset: error.index ?? 0,
            line: error.line,
            column: error.column + 1,
            sourceName: error.filename ?? sourceName ?? "<less>",
          },
        }),
  };
}

function sourceNameFromUrl(url: URL): string {
  return url.protocol === "file:" ? fileURLToPath(url) : url.href;
}

function failed(
  language: StylePreprocessLanguage,
  diagnostics: readonly StylePreprocessDiagnostic[],
): StylePreprocessResult {
  return Object.freeze({
    language,
    cssText: null,
    styleSheet: null,
    diagnostics: Object.freeze([...diagnostics].sort(compareDiagnostics)),
    dependencies: Object.freeze([]),
  });
}
