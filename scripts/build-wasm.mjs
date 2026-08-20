import { createGzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(
  repositoryRoot,
  "target/wasm32-unknown-unknown/release/pingo_probe_wasm.wasm",
);
const outputDirectory = path.join(repositoryRoot, "apps/platform-probe/public/wasm");
const output = path.join(outputDirectory, "pingo_probe.wasm");

await run("cargo", [
  "build",
  "--locked",
  "--package",
  "pingo-probe-wasm",
  "--release",
  "--target",
  "wasm32-unknown-unknown",
]);

await mkdir(outputDirectory, { recursive: true });
await copyFile(source, output);

const [{ size }, gzipBytes] = await Promise.all([stat(output), gzipSize(output)]);
const manifest = {
  generatedAt: new Date().toISOString(),
  gzipBytes,
  rawBytes: size,
  target: "wasm32-unknown-unknown",
};

await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`WASM probe: ${size} bytes raw, ${gzipBytes} bytes gzip\n`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}

function gzipSize(file) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const input = createReadStream(file);
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
