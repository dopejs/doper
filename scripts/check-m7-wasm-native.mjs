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
    "pingo-core",
    "--example",
    "m7_animation_differential",
  ]),
);
if (
  native.version !== 1 ||
  !Array.isArray(native.displays) ||
  native.displays.length !== 7 ||
  !Array.isArray(native.diagnostics) ||
  native.diagnostics.length !== 7
) {
  throw new Error("native M7 animation differential report is malformed");
}

const wasmModule = await import(
  pathToFileURL(path.join(root, "packages/host/wasm/pingo_core.js")).href
);
const wasmBytes = await readFile(path.join(root, "packages/host/wasm/pingo_core_bg.wasm"));
await wasmModule.default({ module_or_path: wasmBytes });
const core = new wasmModule.WasmCore(160, 80);
try {
  const displays = [];
  const diagnostics = [];
  displays.push(hex(core.commit(decodeHex(native.initialMutation))));
  diagnostics.push([...core.frame_diagnostics()]);
  displays.push(hex(core.commit(decodeHex(native.targetMutation))));
  diagnostics.push([...core.frame_diagnostics()]);
  for (const delta of [0.25, 0.25]) {
    const display = core.advance(delta);
    if (!(display instanceof Uint8Array)) throw new Error("WASM animation tick produced no frame");
    displays.push(hex(display));
    diagnostics.push([...core.frame_diagnostics()]);
  }
  displays.push(hex(core.commit(decodeHex(native.retargetMutation))));
  diagnostics.push([...core.frame_diagnostics()]);
  const retargeted = core.advance(0.25);
  if (!(retargeted instanceof Uint8Array)) throw new Error("WASM retarget tick produced no frame");
  displays.push(hex(retargeted));
  diagnostics.push([...core.frame_diagnostics()]);
  const reduced = core.set_reduced_motion(true);
  if (!(reduced instanceof Uint8Array)) throw new Error("WASM reduced motion produced no frame");
  displays.push(hex(reduced));
  diagnostics.push([...core.frame_diagnostics()]);

  assertEqual(displays, native.displays, "DisplayList bytes");
  assertEqual(diagnostics, native.diagnostics, "frame diagnostics");
  if (core.advance(1) !== undefined)
    throw new Error("completed WASM animation repainted while idle");
} finally {
  core.free();
}

process.stdout.write("M7 native/wasm animation timeline is byte-exact\n");

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} differ between native and wasm32`);
  }
}

function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function decodeHex(value) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/u.test(value)) {
    throw new Error("native animation report contains invalid hex");
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
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
