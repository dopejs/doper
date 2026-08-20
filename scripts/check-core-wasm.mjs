import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createServer } from "vite";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wasmDirectory = path.join(repositoryRoot, "packages/host/wasm");
const wasmModule = await import(pathToFileURL(path.join(wasmDirectory, "pingo_core.js")));
const wasmBytes = await readFile(path.join(wasmDirectory, "pingo_core_bg.wasm"));
await wasmModule.default({ module_or_path: wasmBytes });

const bundler = await createServer({
  root: repositoryRoot,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});
const calls = [];
const state = { fillStyle: "", font: "", globalAlpha: 1 };
const context = {
  get fillStyle() {
    return state.fillStyle;
  },
  set fillStyle(value) {
    state.fillStyle = String(value);
  },
  get font() {
    return state.font;
  },
  set font(value) {
    state.font = value;
  },
  get globalAlpha() {
    return state.globalAlpha;
  },
  set globalAlpha(value) {
    state.globalAlpha = value;
  },
  save() {},
  restore() {},
  transform(...values) {
    calls.push(["transform", ...values]);
  },
  fillRect(...values) {
    calls.push(["fillRect", ...values, state.fillStyle]);
  },
  fillText(...values) {
    calls.push(["fillText", ...values, state.font, state.fillStyle]);
  },
  measureText(value) {
    return { width: String(value).length * 8 };
  },
};

try {
  const { createElement, createRoot } = await bundler.ssrLoadModule(
    "/packages/facade/src/index.ts",
  );
  const core = new wasmModule.WasmCore(320, 240);
  try {
    const root = createRoot(context, core);
    root.render(
      createElement("container", {
        width: 120,
        height: 60,
        backgroundColor: "#123456",
        children: createElement("text", { value: "WASM frame", color: "#abcdef" }),
      }),
    );
    if (!calls.some(([name]) => name === "fillRect")) {
      throw new Error("WASM vertical slice did not replay a rectangle");
    }
    if (!calls.some(([name, value]) => name === "fillText" && value === "WASM frame")) {
      throw new Error("WASM vertical slice did not replay fallback text");
    }
    if (core.is_poisoned()) throw new Error("WASM Core was poisoned by a valid facade frame");
    root.unmount();
  } finally {
    core.free();
  }
} finally {
  await bundler.close();
}

process.stdout.write(`WASM vertical slice: ${String(calls.length)} Canvas calls\n`);
