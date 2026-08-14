import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { spawn } from "node:child_process";

const maximumGzipBytes = 300 * 1024;
const productBudgetBytes = 400 * 1024;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = path.join(
  repositoryRoot,
  "target/wasm32-unknown-unknown/release/doper_probe_wasm_budget.wasm",
);
const outputDirectory = path.join(repositoryRoot, "target/probe-artifacts");
const publicDirectory = path.join(repositoryRoot, "apps/platform-probe/public/wasm");
const evidencePath = path.join(repositoryRoot, "docs/evidence/wasm-budget.v1.json");

const rustcVersion = (await runCapture("rustc", ["--version"])).trim();
if (!rustcVersion.startsWith("rustc 1.96.0 ")) {
  throw new Error(`WASM budget evidence requires rustc 1.96.0; received ${rustcVersion}`);
}

await run("cargo", [
  "build",
  "--locked",
  "--package",
  "doper-probe-wasm-budget",
  "--release",
  "--target",
  "wasm32-unknown-unknown",
]);

const [{ size: rawBytes }, gzipBytes] = await Promise.all([stat(wasmPath), gzipSize(wasmPath)]);
const report = {
  crate: "doper-probe-wasm-budget",
  gzipBytes,
  headroomBytes: productBudgetBytes - gzipBytes,
  maximumGzipBytes,
  productBudgetBytes,
  profile: "release-opt-z-lto",
  rawBytes,
  rustToolchain: "1.96.0",
  target: "wasm32-unknown-unknown",
  version: 1,
};

const expected = JSON.parse(await readFile(evidencePath, "utf8"));
if (JSON.stringify(report) !== JSON.stringify(expected)) {
  throw new Error(
    `WASM budget evidence changed. Review the size/toolchain impact and update ${path.relative(repositoryRoot, evidencePath)} explicitly.\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(report)}`,
  );
}

await mkdir(outputDirectory, { recursive: true });
await mkdir(publicDirectory, { recursive: true });
const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
await Promise.all([
  copyFile(wasmPath, path.join(publicDirectory, "doper_budget.wasm")),
  writeFile(path.join(outputDirectory, "wasm-budget.v1.json"), serializedReport, "utf8"),
  writeFile(path.join(publicDirectory, "budget-manifest.json"), serializedReport, "utf8"),
]);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (gzipBytes > maximumGzipBytes) {
  throw new Error(
    `Representative WASM envelope is ${String(gzipBytes)} bytes gzip; limit is ${String(maximumGzipBytes)}`,
  );
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else
        reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}

function gzipSize(filename) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const input = createReadStream(filename);
    const gzip = createGzip({ level: 9 });
    input.once("error", reject);
    gzip.once("error", reject);
    gzip.on("data", (chunk) => {
      bytes += chunk.length;
    });
    gzip.once("end", () => resolve(bytes));
    input.pipe(gzip);
  });
}
