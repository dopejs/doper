import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";

const engineeringMaximumGzipBytes = 384 * 1024;
const productMaximumGzipBytes = 400 * 1024;
const expectedRustc = "rustc 1.96.0 (ac68faa20 2026-05-25)";
const expectedWasmOpt = "wasm-opt version 117 (version_117)";
const optimizationPasses = [
  "--duplicate-function-elimination",
  "--vacuum",
  "--dae-optimizing",
  "--optimize-instructions",
  "--enable-bulk-memory",
  "--enable-nontrapping-float-to-int",
];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = path.join(repositoryRoot, "target/core-wasm-package");
const packageDirectory = path.join(repositoryRoot, "packages/host/wasm");
const wasmPackVersion = (await runCapture("wasm-pack", ["--version"])).trim();
if (wasmPackVersion !== "wasm-pack 0.14.0") {
  throw new Error(`product Core requires wasm-pack 0.14.0; received ${wasmPackVersion}`);
}
const rustcVersion = (await runCapture("rustc", ["--version"])).trim();
if (rustcVersion !== expectedRustc) {
  throw new Error(`product Core requires ${expectedRustc}; received ${rustcVersion}`);
}
const wasmOpt = await locatePinnedWasmOpt();
const wasmOptVersion = (await runCapture(wasmOpt, ["--version"])).trim();
if (wasmOptVersion !== expectedWasmOpt) {
  throw new Error(`product Core requires ${expectedWasmOpt}; received ${wasmOptVersion}`);
}

const verifyReproducible = process.argv.includes("--verify-reproducible");
let cleanRoots = [];
let result;
try {
  if (verifyReproducible) {
    const firstRoot = await mkdtemp(path.join(tmpdir(), "pingo-m9-wasm-a-"));
    const secondRoot = await mkdtemp(path.join(tmpdir(), "pingo-m9-wasm-b-"));
    cleanRoots = [firstRoot, secondRoot];
    const first = await build(path.join(firstRoot, "package"), path.join(firstRoot, "target"));
    const second = await build(path.join(secondRoot, "package"), path.join(secondRoot, "target"));
    if (
      first.sha256 !== second.sha256 ||
      first.rawBytes !== second.rawBytes ||
      first.gzipBytes !== second.gzipBytes
    ) {
      throw new Error(
        `clean WASM builds differ: ${first.sha256}/${String(first.rawBytes)}/${String(first.gzipBytes)} vs ${second.sha256}/${String(second.rawBytes)}/${String(second.gzipBytes)}`,
      );
    }
    result = second;
  } else {
    result = await build(buildDirectory);
  }

  await mkdir(packageDirectory, { recursive: true });
  const artifacts = ["pingo_core.js", "pingo_core.d.ts", "pingo_core_bg.wasm"];
  await Promise.all(
    artifacts.map((artifact) =>
      copyFile(path.join(result.outputDirectory, artifact), path.join(packageDirectory, artifact)),
    ),
  );

  const report = {
    attribution: result.attribution,
    engineeringMaximumGzipBytes,
    gzipBytes: result.gzipBytes,
    maximumGzipBytes: engineeringMaximumGzipBytes,
    optimizationPasses,
    productMaximumGzipBytes,
    rawBytes: result.rawBytes,
    reproducibleCleanBuilds: verifyReproducible ? 2 : 0,
    rustc: rustcVersion,
    sha256: result.sha256,
    target: "web",
    tool: wasmPackVersion,
    version: 2,
    wasmOpt: wasmOptVersion,
  };
  await writeFile(
    path.join(packageDirectory, "manifest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `Product Core WASM: ${String(result.rawBytes)} bytes raw, ${String(result.gzipBytes)} bytes gzip${verifyReproducible ? ", two clean builds byte-identical" : ""}\n`,
  );
  if (result.gzipBytes > engineeringMaximumGzipBytes) {
    throw new Error(
      `product Core WASM is ${String(result.gzipBytes)} gzip bytes; M9 limit is ${String(engineeringMaximumGzipBytes)}`,
    );
  }
} finally {
  await Promise.all(cleanRoots.map((root) => rm(root, { force: true, recursive: true })));
}

async function build(outputDirectory, cargoTargetDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  await run(
    "wasm-pack",
    [
      "build",
      "core/pingo-core",
      "--target",
      "web",
      "--release",
      "--out-dir",
      outputDirectory,
      "--out-name",
      "pingo_core",
    ],
    cargoTargetDirectory === undefined ? undefined : { CARGO_TARGET_DIR: cargoTargetDirectory },
  );
  const wasmPath = path.join(outputDirectory, "pingo_core_bg.wasm");
  const [{ size: rawBytes }, gzipBytes, wasmBytes] = await Promise.all([
    stat(wasmPath),
    gzipSize(wasmPath),
    readFile(wasmPath),
  ]);
  return {
    attribution: attributeWasmSections(wasmBytes),
    gzipBytes,
    outputDirectory,
    rawBytes,
    sha256: createHash("sha256").update(wasmBytes).digest("hex"),
  };
}

function run(command, arguments_, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: environment === undefined ? process.env : { ...process.env, ...environment },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}

async function locatePinnedWasmOpt() {
  const roots = [
    path.join(homedir(), "Library/Caches/.wasm-pack"),
    path.join(homedir(), ".cache/.wasm-pack"),
  ];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !entry.name.startsWith("wasm-opt-")) continue;
      const candidate = path.join(root, entry.name, "bin", "wasm-opt");
      try {
        if (
          (await stat(candidate)).isFile() &&
          (await runCapture(candidate, ["--version"])).trim() === expectedWasmOpt
        ) {
          return candidate;
        }
      } catch {
        // Try the next wasm-pack cache entry.
      }
    }
  }
  throw new Error(
    `wasm-pack Binaryen cache does not contain ${expectedWasmOpt}; run wasm-pack once to install it`,
  );
}

function attributeWasmSections(bytes) {
  const names = [
    "custom",
    "type",
    "import",
    "function",
    "table",
    "memory",
    "global",
    "export",
    "start",
    "element",
    "code",
    "data",
    "dataCount",
    "tag",
  ];
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100 || bytes.readUInt32LE(4) !== 1) {
    throw new Error("generated artifact is not a canonical WebAssembly v1 module");
  }
  const sections = { header: 8 };
  let offset = 8;
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset];
    offset += 1;
    const length = readLebU32(bytes, offset);
    offset = length.offset;
    const end = offset + length.value;
    if (end > bytes.length) throw new Error("WASM section exceeds the module boundary");
    let name = names[id] ?? `unknown-${String(id)}`;
    if (id === 0) {
      const customLength = readLebU32(bytes, offset);
      const nameEnd = customLength.offset + customLength.value;
      if (nameEnd > end) throw new Error("WASM custom-section name exceeds its boundary");
      name = `custom:${bytes.subarray(customLength.offset, nameEnd).toString("utf8")}`;
    }
    sections[name] = (sections[name] ?? 0) + end - start;
    offset = end;
  }
  const attributed = Object.values(sections).reduce((sum, value) => sum + value, 0);
  if (attributed !== bytes.length) throw new Error("WASM section attribution is incomplete");
  return Object.fromEntries(Object.entries(sections).sort((left, right) => right[1] - left[1]));
}

function readLebU32(bytes, initialOffset) {
  let offset = initialOffset;
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 5; index += 1) {
    if (offset >= bytes.length) throw new Error("truncated WASM LEB128 value");
    const byte = bytes[offset];
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { offset, value: value >>> 0 };
    shift += 7;
  }
  throw new Error("WASM LEB128 value exceeds u32");
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
