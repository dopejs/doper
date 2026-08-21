import path from "node:path";

import type { Plugin, ResolvedConfig } from "vite";

import { StylePreprocessError } from "./error.js";
import { compilePingoStyleFile } from "./file.js";
import type { FilePreprocessOptions, StylePreprocessDiagnostic } from "./types.js";

const queryPattern = /\.(?:scss|less)\?pingo-style$/u;
const virtualPrefix = "\0pingo-style:";

export type PingoStylePreprocessPluginOptions = FilePreprocessOptions;

export function pingoStylePreprocess(options: PingoStylePreprocessPluginOptions = {}): Plugin {
  let config: ResolvedConfig | undefined;
  const resolvedFiles = new Map<string, string>();
  return {
    name: "pingo-style-preprocess",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
    },
    async resolveId(source, importer, resolveOptions) {
      if (!queryPattern.test(source)) return null;
      const request = source.slice(0, source.indexOf("?"));
      const resolved = await this.resolve(request, importer, {
        ...resolveOptions,
        skipSelf: true,
      });
      if (resolved === null || resolved.external === true) {
        this.error(`Unable to resolve pingo stylesheet ${JSON.stringify(request)}`);
      }
      // Keep the virtual module outside Vite's built-in CSS pipeline. A virtual
      // id ending in .scss/.less is otherwise parsed again after this plugin
      // has converted the source to JavaScript.
      const virtualId = `${virtualPrefix}${encodeURIComponent(resolved.id)}.js`;
      resolvedFiles.set(virtualId, resolved.id);
      return virtualId;
    },
    async load(id) {
      const filename = resolvedFiles.get(id);
      if (filename === undefined) return null;
      const result = await compilePingoStyleFile(filename, options);
      for (const dependency of [filename, ...result.dependencies]) this.addWatchFile(dependency);
      for (const warning of result.diagnostics.filter(({ severity }) => severity === "warning")) {
        this.warn(formatDiagnostic(warning));
      }
      const errors = result.diagnostics.filter(({ severity }) => severity === "error");
      if (result.cssText === null || result.styleSheet === null || errors.length > 0) {
        this.error(new StylePreprocessError(errors.length === 0 ? result.diagnostics : errors));
      }
      const root = config?.root ?? process.cwd();
      const sourceName = path.relative(root, filename).split(path.sep).join("/");
      const expectedVersion = result.styleSheet.cssSubsetVersion;
      return [
        'import { CSS_SUBSET_VERSION, createStyleSheet } from "@dopejs/pingo";',
        `const expectedVersion = ${JSON.stringify(expectedVersion)};`,
        "if (CSS_SUBSET_VERSION !== expectedVersion) {",
        "  throw new Error(`pingo stylesheet requires CSS subset ${expectedVersion}; runtime provides ${CSS_SUBSET_VERSION}`);",
        "}",
        `export default createStyleSheet(${JSON.stringify(result.cssText)}, { sourceName: ${JSON.stringify(sourceName)} });`,
      ].join("\n");
    },
  };
}

function formatDiagnostic(diagnostic: StylePreprocessDiagnostic): string {
  const location = diagnostic.sourceLocation ?? diagnostic.generatedLocation;
  const prefix =
    location === undefined
      ? ""
      : `${location.sourceName ?? "<style>"}:${String(location.line)}:${String(location.column)}: `;
  return `${prefix}[${diagnostic.stage}/${diagnostic.code}] ${diagnostic.message}`;
}
