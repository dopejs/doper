import { readFile } from "node:fs/promises";
import path from "node:path";

import { compileImportedScss, compileLessString } from "./compiler.js";
import type { FilePreprocessOptions, StylePreprocessResult } from "./types.js";

export async function compilePingoStyleFile(
  filename: string,
  options: FilePreprocessOptions = {},
): Promise<StylePreprocessResult> {
  const absolute = path.resolve(filename);
  const source = await readFile(absolute, "utf8");
  const extension = path.extname(absolute).toLowerCase();
  if (extension === ".less") {
    return compileLessString(source, {
      ...options,
      sourceName: absolute,
      ...(options.lessPaths === undefined ? {} : { paths: options.lessPaths }),
    });
  }
  if (extension !== ".scss") {
    throw new TypeError(`Unsupported pingo stylesheet extension: ${extension}`);
  }
  return compileImportedScss(source, {
    ...options,
    sourceName: absolute,
    ...(options.scssLoadPaths === undefined ? {} : { loadPaths: options.scssLoadPaths }),
  });
}
