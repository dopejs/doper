import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const native = JSON.parse(
  (
    await run("cargo", [
      "run",
      "--locked",
      "--quiet",
      "--package",
      "pingo-core",
      "--example",
      "m9_picture_differential",
    ])
  )
    .trim()
    .split(/\r?\n/u)
    .at(-1) ?? "null",
);
if (native?.version !== 1) throw new Error("native M9 Picture fixture is invalid");
const wasmModule = await import(
  pathToFileURL(path.join(root, "packages/host/wasm/pingo_core.js")).href
);
const wasmBytes = await readFile(path.join(root, "packages/host/wasm/pingo_core_bg.wasm"));
await wasmModule.default({ module_or_path: wasmBytes });
const core = new wasmModule.WasmCore(160, 80);
try {
  core.set_incremental_pictures_enabled(true);
  const initial = core.commit(fromHex(native.mutation));
  const initialResources = core.take_picture_resources();
  const initialDiagnostics = Array.from(core.frame_diagnostics());
  core.acknowledge_picture_resources(1);
  const scrolled = core.input(fromHex(native.input));
  if (!(scrolled instanceof Uint8Array)) throw new Error("WASM scroll produced no frame");
  const scrollResources = core.take_picture_resources();
  const scrollDiagnostics = Array.from(core.frame_diagnostics());
  core.acknowledge_picture_resources(1);
  core.set_incremental_pictures_enabled(false);
  const rollback = core.commit(fromHex(native.rollbackMutation));
  const rollbackResources = core.take_picture_resources();
  const rollbackDiagnostics = Array.from(core.frame_diagnostics());
  core.acknowledge_picture_resources(2);
  const actual = {
    displays: [hex(initial), hex(scrolled), hex(rollback)],
    resources: [hex(initialResources), hex(scrollResources), hex(rollbackResources)],
    diagnostics: [initialDiagnostics, scrollDiagnostics, rollbackDiagnostics],
  };
  for (const field of ["displays", "resources", "diagnostics"]) {
    if (JSON.stringify(actual[field]) !== JSON.stringify(native[field])) {
      throw new Error(`M9 native/WASM ${field} differ`);
    }
  }
  if (core.is_poisoned()) throw new Error("valid M9 lifecycle poisoned WASM Core");
} finally {
  core.free();
}
process.stdout.write("M9 Picture lifecycle is byte-exact between native and wasm32\n");

function fromHex(value) {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) {
    throw new Error("native fixture emitted invalid hex");
  }
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function run(command, arguments_) {
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
      if (code === 0) resolve(output);
      else
        reject(new Error(`${command} failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}
