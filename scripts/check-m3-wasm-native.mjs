import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const native = JSON.parse(
  await capture("cargo", [
    "run",
    "--locked",
    "--quiet",
    "--package",
    "doper-core",
    "--example",
    "m3_virtual_differential",
  ]),
);
if (native.version !== 1) throw new Error("native M3 differential report version mismatch");

const wasmModule = await import(
  pathToFileURL(path.join(root, "packages/host/wasm/doper_core.js")).href
);
const wasmBytes = await readFile(path.join(root, "packages/host/wasm/doper_core_bg.wasm"));
await wasmModule.default({ module_or_path: wasmBytes });
const core = new wasmModule.WasmCore(160, 80);
try {
  const initialDisplay = core.commit(decodeHex(native.initialMutation));
  assertHex(initialDisplay, native.initialDisplay, "initial DisplayList");
  assertRefills(core.take_virtual_refills(), native.initialRefills, "initial refill window");

  const materializedDisplay = core.commit(decodeHex(native.materializationMutation));
  assertHex(materializedDisplay, native.materializedDisplay, "materialized DisplayList");
  assertRefills(
    core.take_virtual_refills(),
    native.materializedRefills,
    "measurement-corrected refill window",
  );

  const inputDisplay = core.input(decodeHex(native.input));
  if (!(inputDisplay instanceof Uint8Array)) throw new Error("WASM scroll produced no frame");
  assertHex(inputDisplay, native.inputDisplay, "scroll DisplayList");
  assertRefills(core.take_virtual_refills(), native.inputRefills, "scrolled refill window");
} finally {
  core.free();
}

process.stdout.write("M3 native/wasm virtual scrolling is byte-exact\n");

function assertHex(bytes, expected, label) {
  const actual = Buffer.from(bytes).toString("hex");
  if (actual !== expected) throw new Error(`${label} differs between native and wasm32`);
}

function assertRefills(words, expected, label) {
  if (!(words instanceof Uint32Array) || words.length < 2 || words[0] !== 1) {
    throw new Error(`${label} returned malformed WASM words`);
  }
  const count = words[1];
  if (words.length !== 2 + count * 3) throw new Error(`${label} length mismatch`);
  const actual = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 2 + index * 3;
    actual.push([words[offset], words[offset + 1], words[offset + 2]]);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} differs between native and wasm32`);
  }
}

function decodeHex(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/u.test(hex)) {
    throw new Error("native differential report contains invalid hex");
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function capture(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output.trim());
      else
        reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}
