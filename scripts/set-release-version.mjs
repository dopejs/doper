import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { RELEASE_PACKAGES } from "./check-npm-release.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error("usage: node scripts/set-release-version.mjs <semver>");
}

// One command keeps the ten package manifests and ENGINE_VERSION aligned; the
// release check fails on any drift.
for (const directory of RELEASE_PACKAGES) {
  const manifestPath = path.join(repositoryRoot, "packages", directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
const versionPath = path.join(repositoryRoot, "packages/facade/src/version.ts");
const source = await readFile(versionPath, "utf8");
await writeFile(
  versionPath,
  source.replace(/ENGINE_VERSION = "[^"]+"/u, `ENGINE_VERSION = "${version}"`),
);
process.stdout.write(
  `release version set to ${version} across ${String(RELEASE_PACKAGES.length)} packages\n`,
);
