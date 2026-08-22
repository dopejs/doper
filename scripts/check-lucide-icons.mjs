/**
 * Diffs the vendored Lucide glyphs against the upstream package.
 *
 * The path data in packages/ui/src/icons.ts was transcribed rather than
 * generated, which makes it exactly the kind of thing that is wrong in a way
 * nobody notices: a mistyped coordinate still renders, just slightly off. This
 * turns "please verify" into something that can fail.
 *
 * Requires `pnpm add -Dw lucide-static`. Without it the check reports that it
 * verified nothing and exits non-zero, because a verification that quietly
 * passes when it did not run is worse than no verification.
 */

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

let iconDirectory;
try {
  iconDirectory = path.join(path.dirname(require.resolve("lucide-static/package.json")), "icons");
} catch {
  process.stderr.write(
    "lucide-static is not installed, so the vendored glyphs were not verified.\n" +
      "Install it with `pnpm add -Dw lucide-static` and run this again.\n",
  );
  process.exit(1);
}

const module = await import(path.join(root, "packages/ui/dist/icons.js")).catch(() => undefined);
if (module?.LUCIDE_SOURCES === undefined) {
  throw new Error("build packages/ui first: LUCIDE_SOURCES was not found in its output");
}

const mismatches = [];
for (const [name, vendored] of Object.entries(module.LUCIDE_SOURCES)) {
  const file = path.join(iconDirectory, `${name}.svg`);
  const upstream = await readFile(file, "utf8").catch(() => undefined);
  if (upstream === undefined) {
    mismatches.push(`${name}: no such icon upstream`);
    continue;
  }
  // Compare the body only: the wrapper attributes are supplied by this
  // repository, so a change to them is ours to make and not a drift from
  // upstream.
  const body = normalize(
    upstream.replace(/^[\s\S]*?<svg[^>]*>/u, "").replace(/<\/svg>[\s\S]*$/u, ""),
  );
  if (body !== normalize(vendored)) {
    mismatches.push(`${name}:\n  vendored: ${normalize(vendored)}\n  upstream: ${body}`);
  }
}

if (mismatches.length > 0) {
  process.stderr.write(`vendored Lucide glyphs differ from upstream:\n${mismatches.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `Lucide glyphs: ${String(Object.keys(module.LUCIDE_SOURCES).length)} matched upstream\n`,
);

/** Collapses the formatting differences that carry no geometry. */
function normalize(markup) {
  return markup
    .replace(/\s+/gu, " ")
    .replace(/\s*\/>/gu, "/>")
    .replace(/>\s+</gu, "><")
    .trim();
}
