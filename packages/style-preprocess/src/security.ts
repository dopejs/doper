import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  BasePreprocessOptions,
  StylePreprocessDiagnostic,
  StylePreprocessLanguage,
} from "./types.js";

export const DEFAULT_MAXIMUM_ENTRY_CODE_UNITS = 1_048_576;
export const DEFAULT_MAXIMUM_DEPENDENCIES = 256;
export const DEFAULT_MAXIMUM_DEPENDENCY_BYTES = 8 * 1024 * 1024;

export function entryBudgetDiagnostic(
  language: StylePreprocessLanguage,
  source: string,
  options: BasePreprocessOptions,
): StylePreprocessDiagnostic | null {
  const maximum = options.maximumEntryCodeUnits ?? DEFAULT_MAXIMUM_ENTRY_CODE_UNITS;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new RangeError("maximumEntryCodeUnits must be a positive safe integer");
  }
  return source.length <= maximum
    ? null
    : diagnostic(language, "entry-too-large", `Stylesheet exceeds ${String(maximum)} code units`);
}

export function importPolicyDiagnostic(
  language: StylePreprocessLanguage,
  source: string,
  sourceName: string | undefined,
): StylePreprocessDiagnostic | null {
  if (language === "less" && /@plugin\b/iu.test(source)) {
    return diagnostic("less", "plugin-not-allowed", "Less @plugin is not allowed");
  }
  if (
    /@(import|use|forward)\s+(?:\([^)]*\)\s*)?(?:url\(\s*)?["']?(?:https?:)?\/\//iu.test(source)
  ) {
    return diagnostic(
      language,
      "remote-import-not-allowed",
      "Remote stylesheet imports are not allowed",
    );
  }
  if (
    /@(import|use|forward)\b/iu.test(source) &&
    (sourceName === undefined || !path.isAbsolute(sourceName))
  ) {
    return diagnostic(
      language,
      "relative-import-needs-source",
      "Relative imports require an absolute sourceName",
    );
  }
  return null;
}

export async function validateDependencies(
  language: StylePreprocessLanguage,
  dependencies: readonly string[],
  allowRoots: readonly string[],
  options: BasePreprocessOptions,
): Promise<readonly StylePreprocessDiagnostic[]> {
  const maximumDependencies = options.maximumDependencies ?? DEFAULT_MAXIMUM_DEPENDENCIES;
  const maximumBytes = options.maximumDependencyBytes ?? DEFAULT_MAXIMUM_DEPENDENCY_BYTES;
  if (!Number.isSafeInteger(maximumDependencies) || maximumDependencies < 0) {
    throw new RangeError("maximumDependencies must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("maximumDependencyBytes must be a non-negative safe integer");
  }
  if (dependencies.length > maximumDependencies) {
    return [
      diagnostic(
        language,
        "dependency-count-exceeded",
        `Stylesheet loaded ${String(dependencies.length)} dependencies; maximum is ${String(maximumDependencies)}`,
      ),
    ];
  }

  const canonicalRoots = await Promise.all(allowRoots.map((root) => realpath(root)));
  let bytes = 0;
  for (const dependency of dependencies) {
    let canonical: string;
    try {
      canonical = await realpath(dependency);
    } catch {
      return [
        diagnostic(language, "dependency-unreadable", `Dependency is not readable: ${dependency}`),
      ];
    }
    if (!canonicalRoots.some((root) => isWithin(root, canonical))) {
      return [
        diagnostic(
          language,
          "dependency-outside-allow-root",
          `Dependency is outside allow roots: ${canonical}`,
        ),
      ];
    }
    const metadata = await stat(canonical);
    if (!metadata.isFile()) {
      return [
        diagnostic(language, "dependency-not-file", `Dependency is not a file: ${canonical}`),
      ];
    }
    bytes += metadata.size;
    if (bytes > maximumBytes) {
      return [
        diagnostic(
          language,
          "dependency-bytes-exceeded",
          `Stylesheet dependencies exceed ${String(maximumBytes)} bytes`,
        ),
      ];
    }
  }
  return [];
}

export function normalizedAllowRoots(
  sourceName: string | undefined,
  configured: readonly string[] | undefined,
  loadPaths: readonly string[],
): readonly string[] {
  const roots = new Set<string>();
  if (sourceName !== undefined && path.isAbsolute(sourceName)) roots.add(path.dirname(sourceName));
  for (const root of configured ?? []) roots.add(path.resolve(root));
  for (const root of loadPaths) roots.add(path.resolve(root));
  return [...roots].sort();
}

export function sortedUniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((entry) => path.resolve(entry)))].sort();
}

export function diagnostic(
  stage: StylePreprocessDiagnostic["stage"],
  code: string,
  message: string,
): StylePreprocessDiagnostic {
  return { stage, code, severity: "error", message };
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
