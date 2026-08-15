import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import prettier from "prettier";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  ["packages/facade/dist/index.d.ts", "benchmarks/api/facade.v1.d.ts"],
  ["packages/facade/dist/jsx-runtime.d.ts", "benchmarks/api/jsx-runtime.v1.d.ts"],
  ["packages/facade/dist/jsx-dev-runtime.d.ts", "benchmarks/api/jsx-dev-runtime.v1.d.ts"],
  ["packages/facade/dist/backend-canvas2d.d.ts", "benchmarks/api/backend-canvas2d.v1.d.ts"],
];

for (const [actualName, expectedName] of pairs) {
  const [actual, expected] = await Promise.all([
    readFile(path.join(repositoryRoot, actualName), "utf8"),
    readFile(path.join(repositoryRoot, expectedName), "utf8"),
  ]);
  const [normalizedActual, normalizedExpected] = await Promise.all([
    prettier.format(actual, { parser: "typescript" }),
    prettier.format(expected, { parser: "typescript" }),
  ]);
  if (normalizedActual !== normalizedExpected) {
    throw new Error(
      `public API changed: ${actualName} no longer matches reviewed snapshot ${expectedName}`,
    );
  }
}

const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "packages/facade/package.json"), "utf8"),
);
const expectedSubpaths = [".", "./backend-canvas2d", "./jsx-dev-runtime", "./jsx-runtime"];
const actualSubpaths = Object.keys(packageJson.exports).sort();
if (JSON.stringify(actualSubpaths) !== JSON.stringify(expectedSubpaths)) {
  throw new Error(`facade export subpaths changed: ${JSON.stringify(actualSubpaths)}`);
}

process.stdout.write(`Public API snapshots: ${String(pairs.length)} matched\n`);
