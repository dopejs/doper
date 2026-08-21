import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { StyleSourceLocation } from "@dopejs/pingo-style";

export function mapGeneratedLocation(
  rawMap: string | object | undefined,
  location: StyleSourceLocation | undefined,
  entrySourceName?: string,
): StyleSourceLocation | undefined {
  if (rawMap === undefined || location === undefined) return undefined;
  try {
    type TraceMapInput = ConstructorParameters<typeof TraceMap>[0];
    const input =
      typeof rawMap === "string"
        ? (JSON.parse(rawMap) as TraceMapInput)
        : (rawMap as TraceMapInput);
    const map = new TraceMap(input);
    const original = originalPositionFor(map, {
      line: location.line,
      column: Math.max(0, location.column - 1),
    });
    if (original.line === null || original.column === null || original.source === null) {
      return undefined;
    }
    return {
      offset: 0,
      line: original.line,
      column: original.column + 1,
      sourceName: normalizeSourceName(original.source, entrySourceName),
    };
  } catch {
    return undefined;
  }
}

function normalizeSourceName(source: string, entrySourceName: string | undefined): string {
  if (source.startsWith("file:")) {
    try {
      return fileURLToPath(source);
    } catch {
      return source;
    }
  }
  if (path.isAbsolute(source)) return source;
  if (entrySourceName !== undefined && path.isAbsolute(entrySourceName)) {
    return path.resolve(path.dirname(entrySourceName), source);
  }
  return source;
}
