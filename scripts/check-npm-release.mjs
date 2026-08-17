import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Publish set: the facade, the migration shim, and their dependency closure. */
export const RELEASE_PACKAGES = [
  "runtime",
  "editing",
  "jsx",
  "backend-canvas2d",
  "a11y",
  "reconciler",
  "host",
  "widgets",
  "facade",
  "compat",
];

/**
 * Packs every publishable package and validates the actual tarballs: required
 * artifacts present, no sources or tests leaked, workspace ranges rewritten,
 * versions aligned with ENGINE_VERSION, and the dependency closure closed.
 */
export async function checkNpmRelease() {
  const problems = [];
  const manifests = new Map();
  for (const directory of RELEASE_PACKAGES) {
    const manifest = JSON.parse(
      await readFile(path.join(repositoryRoot, "packages", directory, "package.json"), "utf8"),
    );
    manifests.set(manifest.name, { directory, manifest });
  }

  const engineVersion = /ENGINE_VERSION = "([^"]+)"/u.exec(
    await readFile(path.join(repositoryRoot, "packages/facade/src/version.ts"), "utf8"),
  )?.[1];
  for (const [name, { manifest }] of manifests) {
    if (manifest.private === true) problems.push(`${name} is still private`);
    if (manifest.version !== engineVersion) {
      problems.push(
        `${name} version ${manifest.version} differs from ENGINE_VERSION ${engineVersion}`,
      );
    }
    if (manifest.publishConfig?.access !== "public") {
      problems.push(`${name} must declare publishConfig.access public`);
    }
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@dopejs/") && !manifests.has(dependency)) {
        problems.push(`${name} depends on ${dependency} which is outside the publish set`);
      }
      if (!dependency.startsWith("@dopejs/") && range.startsWith("workspace:")) {
        problems.push(`${name} external dependency ${dependency} uses a workspace range`);
      }
    }
  }

  const staging = await mkdtemp(path.join(tmpdir(), "doper-release-"));
  try {
    for (const [name, { directory }] of manifests) {
      problems.push(...(await checkTarball(name, directory, staging)));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return problems;
}

async function checkTarball(name, directory, staging) {
  const problems = [];
  const packageRoot = path.join(repositoryRoot, "packages", directory);
  let tarball;
  try {
    const { stdout } = await run("pnpm", ["pack", "--pack-destination", staging], {
      cwd: packageRoot,
    });
    tarball = stdout.trim().split("\n").at(-1);
  } catch (cause) {
    return [`${name}: pnpm pack failed: ${String(cause)}`];
  }
  const { stdout: listing } = await run("tar", ["-tf", tarball]);
  const files = listing.trim().split("\n");
  const required = ["package/package.json", "package/dist/index.js", "package/dist/index.d.ts"];
  if (directory === "host") {
    required.push("package/wasm/doper_core_bg.wasm", "package/wasm/manifest.json");
  }
  if (directory === "jsx") {
    required.push("package/dist/jsx-runtime.js", "package/dist/jsx-dev-runtime.js");
  }
  if (directory === "facade") {
    required.push("package/dist/backend-canvas2d.js", "package/dist/jsx-runtime.js");
  }
  for (const file of required) {
    if (!files.includes(file)) problems.push(`${name}: tarball is missing ${file}`);
  }
  for (const file of files) {
    if (/\.test\.|\.browser\.|^package\/src\//u.test(file)) {
      problems.push(`${name}: tarball leaks non-release file ${file}`);
    }
  }
  const { stdout: packed } = await run("tar", ["-xOf", tarball, "package/package.json"]);
  const manifest = JSON.parse(packed);
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (String(range).startsWith("workspace:")) {
      problems.push(`${name}: packed dependency ${dependency} still uses ${range}`);
    }
  }
  return problems;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const problems = await checkNpmRelease();
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`npm release check: ${problem}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `npm release: ${String(RELEASE_PACKAGES.length)} packable packages verified\n`,
    );
  }
}
