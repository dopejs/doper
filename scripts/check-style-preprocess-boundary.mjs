import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repositoryRoot, "packages");
const packageName = "@dopejs/pingo-style-preprocess";
const forbiddenBrowserDependencies = new Set([packageName, "less", "sass", "sass-embedded"]);

await checkBrowserDependencyBoundary();
await buildPreprocessor();
const firstDigest = await digestTree(path.join(packagesRoot, "style-preprocess", "dist"));
await buildPreprocessor();
const secondDigest = await digestTree(path.join(packagesRoot, "style-preprocess", "dist"));

if (firstDigest !== secondDigest) {
  throw new Error(
    `style preprocessor build is not reproducible: ${firstDigest} != ${secondDigest}`,
  );
}

process.stdout.write(
  `Style preprocessor boundary: browser dependency graph clean; reproducible dist ${firstDigest}\n`,
);

async function checkBrowserDependencyBoundary() {
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "style-preprocess") continue;
    const manifestPath = path.join(packagesRoot, entry.name, "package.json");
    if (!(await exists(manifestPath))) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (forbiddenBrowserDependencies.has(dependency)) {
          throw new Error(`${manifest.name} must not list ${dependency} in ${field}`);
        }
      }
    }
  }
}

async function buildPreprocessor() {
  await run("pnpm", ["--filter", packageName, "build"], {
    cwd: repositoryRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function digestTree(root) {
  const files = await listFiles(root);
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(relative);
    hash.update("\0");
    hash.update(await readFile(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files.sort();
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
