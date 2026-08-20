import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createGzip } from "node:zlib";

const maximumGzipBytes = 400 * 1024;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = path.join(repositoryRoot, "target/core-wasm-package");
const packageDirectory = path.join(repositoryRoot, "packages/host/wasm");
const wasmPackVersion = (await runCapture("wasm-pack", ["--version"])).trim();
if (wasmPackVersion !== "wasm-pack 0.14.0") {
  throw new Error(`product Core requires wasm-pack 0.14.0; received ${wasmPackVersion}`);
}

await run("wasm-pack", [
  "build",
  "core/pingo-core",
  "--target",
  "web",
  "--release",
  "--out-dir",
  "../../target/core-wasm-package",
  "--out-name",
  "pingo_core",
]);

await mkdir(packageDirectory, { recursive: true });
const artifacts = ["pingo_core.js", "pingo_core.d.ts", "pingo_core_bg.wasm"];
await Promise.all(
  artifacts.map((artifact) =>
    copyFile(path.join(buildDirectory, artifact), path.join(packageDirectory, artifact)),
  ),
);

const wasmPath = path.join(packageDirectory, "pingo_core_bg.wasm");
const [{ size: rawBytes }, gzipBytes, wasmBytes] = await Promise.all([
  stat(wasmPath),
  gzipSize(wasmPath),
  readFile(wasmPath),
]);
const report = {
  gzipBytes,
  maximumGzipBytes,
  rawBytes,
  sha256: createHash("sha256").update(wasmBytes).digest("hex"),
  target: "web",
  tool: wasmPackVersion,
  version: 1,
};
await writeFile(
  path.join(packageDirectory, "manifest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`Product Core WASM: ${rawBytes} bytes raw, ${gzipBytes} bytes gzip\n`);
if (gzipBytes >= maximumGzipBytes) {
  throw new Error(
    `product Core WASM is ${String(gzipBytes)} gzip bytes; limit is below ${String(maximumGzipBytes)}`,
  );
}

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

function runCapture(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
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
