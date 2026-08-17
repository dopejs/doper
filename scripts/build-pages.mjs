import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repositoryRoot, "dist-pages");

// GitHub Pages is static hosting and cannot send COOP/COEP headers, so the
// deployed site runs the postMessage/main-thread fallback. The playground and
// the Storybook demos report which transport capability detection selected.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// The VitePress site is the root of the deployment and already contains the
// playground page. Storybook keeps its own build and is copied in beside it.
await run("pnpm", ["exec", "vitepress", "build", "docs"], { cwd: repositoryRoot });
await run("pnpm", ["--filter", "@dopejs/storybook", "build"], { cwd: repositoryRoot });

await cp(path.join(repositoryRoot, "docs/.vitepress/dist"), output, { recursive: true });
await cp(path.join(repositoryRoot, "apps/storybook/dist"), path.join(output, "storybook"), {
  recursive: true,
});

const version = JSON.parse(
  await readFile(path.join(repositoryRoot, "packages/facade/package.json"), "utf8"),
).version;

// Jekyll would otherwise drop files and directories starting with an underscore.
await writeFile(path.join(output, ".nojekyll"), "");

process.stdout.write(`Pages site built at dist-pages (doper v${version})\n`);
