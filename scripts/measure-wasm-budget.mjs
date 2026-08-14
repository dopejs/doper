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
const evidencePath = path.join(repositoryRoot, "docs/evidence/wasm-budget.v2.json");

const rustcInformation = await runCapture("rustc", ["-Vv"]);
const rustcVersion = /^release: (.+)$/mu.exec(rustcInformation)?.[1];
const rustcHost = /^host: (.+)$/mu.exec(rustcInformation)?.[1];
if (rustcVersion !== "1.96.0" || rustcHost === undefined) {
  throw new Error(
    `WASM budget evidence requires a recognized Rust 1.96.0 host; received ${rustcInformation.trim()}`,
  );
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

const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
const expectedBaseline = evidence.baselines[rustcHost];
const expectedEnvelope = {
  crate: report.crate,
  maximumGzipBytes: report.maximumGzipBytes,
  productBudgetBytes: report.productBudgetBytes,
  profile: report.profile,
  rustToolchain: report.rustToolchain,
  target: report.target,
  version: 2,
};
const actualEnvelope = {
  crate: evidence.crate,
  maximumGzipBytes: evidence.maximumGzipBytes,
  productBudgetBytes: evidence.productBudgetBytes,
  profile: evidence.profile,
  rustToolchain: evidence.rustToolchain,
  target: evidence.target,
  version: evidence.version,
};
if (JSON.stringify(actualEnvelope) !== JSON.stringify(expectedEnvelope)) {
  throw new Error(`WASM budget evidence envelope is inconsistent: ${JSON.stringify(evidence)}`);
}
if (expectedBaseline === undefined) {
  throw new Error(`WASM budget evidence has no reviewed baseline for host ${rustcHost}`);
}
if (
  expectedBaseline.gzipBytes !== report.gzipBytes ||
  expectedBaseline.rawBytes !== report.rawBytes
) {
  throw new Error(
    `WASM budget evidence changed for ${rustcHost}. Review the size/toolchain impact and update ${path.relative(repositoryRoot, evidencePath)} explicitly.\nExpected: ${JSON.stringify(expectedBaseline)}\nActual:   ${JSON.stringify({ gzipBytes: report.gzipBytes, rawBytes: report.rawBytes })}`,
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
