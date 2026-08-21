import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { RELEASE_PACKAGES } from "./check-npm-release.mjs";
import { assertQualifiedEvidenceBuild, auditM9Evidence } from "./audit-m9-evidence.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const [{ stdout: commitOutput }, { stdout: statusOutput }, wasm, qualification] = await Promise.all(
  [
    run("git", ["rev-parse", "HEAD"], { cwd: root }),
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }),
    readJson(path.join(root, "packages/host/wasm/manifest.json")),
    auditM9Evidence({
      archiveRoot: root,
      manifestPath: path.join(root, "docs/evidence/m9-evidence-manifest.v2.json"),
      now: new Date(process.env.PINGO_QUALIFICATION_NOW ?? Date.now()),
    }),
  ],
);
const commit = commitOutput.trim();
const dirty = statusOutput.trim().split(/\r?\n/u).filter(Boolean);
if (dirty.length > 0) throw new Error(`candidate checkout is dirty: ${dirty.join(", ")}`);
if (wasm.version !== 2 || wasm.reproducibleCleanBuilds !== 2) {
  throw new Error("candidate WASM was not produced by two clean reproducible builds");
}
if (wasm.gzipBytes > 384 * 1024 || wasm.gzipBytes >= wasm.productMaximumGzipBytes) {
  throw new Error("candidate WASM violates its engineering or product budget");
}
if (qualification.status !== "pass") throw new Error("candidate qualification audit failed");
assertQualifiedEvidenceBuild(qualification, { commit, digest: wasm.sha256 });

const packages = {};
for (const directory of RELEASE_PACKAGES) {
  const packageRoot = path.join(root, "packages", directory);
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  packages[manifest.name] = {
    version: manifest.version,
    digest: await treeDigest(packageRoot, ["package.json", "dist"]),
  };
}
const engineVersion = /ENGINE_VERSION = "([^"]+)"/u.exec(
  await readFile(path.join(root, "packages/facade/src/version.ts"), "utf8"),
)?.[1];
if (typeof engineVersion !== "string") throw new Error("ENGINE_VERSION is missing");
const protocol = await readJson(path.join(root, "schemas/protocol.v1.json"));
const workerProtocolVersion = Number(
  /WORKER_PROTOCOL_VERSION = ([0-9]+) as const/u.exec(
    await readFile(path.join(root, "packages/host/src/worker-protocol.ts"), "utf8"),
  )?.[1],
);
if (!Number.isSafeInteger(workerProtocolVersion))
  throw new Error("Worker protocol version is missing");
const report = {
  version: 1,
  commit,
  engineVersion,
  abiVersion: protocol.abiVersion,
  workerProtocolVersion,
  wasm: {
    gzipBytes: wasm.gzipBytes,
    rawBytes: wasm.rawBytes,
    sha256: wasm.sha256,
    reproducibleCleanBuilds: wasm.reproducibleCleanBuilds,
    attribution: wasm.attribution,
  },
  packages,
  gateContext: process.argv.includes("--gates-passed")
    ? "passed-in-current-m9-check"
    : "standalone-report-only",
  requiredGates: [
    "m8:check",
    "picture-contracts",
    "optimized-inline-browser-differential",
    "main-postMessage-SAB-lifecycle",
    "native-wasm-differential",
    "rich-scroll-performance",
    "accelerated-30-minute-soak",
    "wasm-reproducibility-and-budget",
    "qualification-v2",
    "api-abi-snapshots",
    "release-tarballs",
  ],
  supportMatrix: qualification.matrix,
  knownLimitations: qualification.matrix
    .filter((entry) => entry.status !== "qualified")
    .map((entry) => `${entry.roleId}: ${entry.status}`),
  rollback: {
    page: "application page-level kill switch",
    pictures: "incrementalPicturesEnabled=false",
    video: "videoEnabled=false",
    transport: "sab -> post-message -> main-thread",
    recovery: "destroy Worker/Core session and rebuild from durable Shell state",
  },
  sideEffects: Object.freeze({
    gitTag: false,
    githubRelease: false,
    npmPublish: false,
    productionConfig: false,
  }),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function treeDigest(directory, entries) {
  const hash = createHash("sha256");
  for (const entry of entries) await add(path.join(directory, entry), directory, hash);
  return hash.digest("hex");
}

async function add(candidate, rootDirectory, hash) {
  const metadata = await stat(candidate);
  if (metadata.isDirectory()) {
    const entries = await readdir(candidate);
    for (const entry of entries.sort()) await add(path.join(candidate, entry), rootDirectory, hash);
    return;
  }
  const relative = path.relative(rootDirectory, candidate);
  hash.update(relative);
  hash.update("\0");
  hash.update(await readFile(candidate));
  hash.update("\0");
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}
