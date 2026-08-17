import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Validates the publishable facade artifact: every export subpath must resolve
 * to built types and code, every module must ship a source map, and the WASM
 * asset must match its integrity manifest byte for byte.
 */
export async function checkReleasePackage() {
  const problems = [];
  const facadeRoot = path.join(repositoryRoot, "packages/facade");
  const manifest = JSON.parse(await readFile(path.join(facadeRoot, "package.json"), "utf8"));
  if (!Array.isArray(manifest.files) || !manifest.files.includes("dist")) {
    problems.push("facade package.json files must publish dist");
  }
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    for (const [condition, relative] of Object.entries(entry)) {
      const target = path.join(facadeRoot, relative);
      if (!(await exists(target))) {
        problems.push(`export ${subpath} ${condition} points at missing file ${relative}`);
        continue;
      }
      if (condition === "import") {
        const source = await readFile(target, "utf8");
        const mapReference = /\/\/# sourceMappingURL=(.+)$/mu.exec(source)?.[1];
        if (mapReference === undefined) {
          problems.push(`export ${subpath} module ${relative} has no source map reference`);
        } else if (!(await exists(path.join(path.dirname(target), mapReference)))) {
          problems.push(`export ${subpath} source map ${mapReference} is missing`);
        }
      }
    }
  }
  problems.push(...(await checkWasmManifest()));
  return problems;
}

/** The shipped WASM must be exactly the bytes the manifest was built from. */
export async function checkWasmManifest() {
  const problems = [];
  const wasmRoot = path.join(repositoryRoot, "packages/host/wasm");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(wasmRoot, "manifest.json"), "utf8"));
  } catch {
    return ["packages/host/wasm/manifest.json is missing; run pnpm core:wasm"];
  }
  const bytes = await readFile(path.join(wasmRoot, "doper_core_bg.wasm"));
  if (bytes.byteLength !== manifest.rawBytes) {
    problems.push(
      `WASM asset is ${String(bytes.byteLength)} bytes; manifest built ${String(manifest.rawBytes)}`,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== manifest.sha256) {
    problems.push(`WASM digest ${digest} does not match manifest ${manifest.sha256}`);
  }
  if (typeof manifest.gzipBytes !== "number" || manifest.gzipBytes > manifest.maximumGzipBytes) {
    problems.push("WASM gzip size exceeds the release budget recorded in the manifest");
  }
  return problems;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const problems = await checkReleasePackage();
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`release check: ${problem}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Release package: facade exports, source maps, and WASM integrity OK\n");
  }
}
