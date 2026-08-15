import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const pnpmStore = path.join(repositoryRoot, "node_modules", ".pnpm");
const packages = await readdir(pnpmStore, { withFileTypes: true });
const playwright = packages
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("playwright-core@"))
  .sort((left, right) => left.name.localeCompare(right.name))
  .at(-1);
if (playwright === undefined) {
  throw new Error("playwright-core is required for the dependency-provided SFNT fixture");
}
const traceViewer = path.join(
  pnpmStore,
  playwright.name,
  "node_modules",
  "playwright-core",
  "lib",
  "vite",
  "traceViewer",
);
const assets = await readdir(traceViewer);
const fontName = assets.find((name) => /^codicon\..+\.ttf$/u.test(name));
if (fontName === undefined) throw new Error("Playwright trace-viewer SFNT fixture is missing");
await run("cargo", [
  "run",
  "--locked",
  "--quiet",
  "-p",
  "doper-text",
  "--example",
  "m3_text_conformance",
  "--",
  path.join(traceViewer, fontName),
]);

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}
