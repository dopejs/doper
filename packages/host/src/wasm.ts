import initialize, { WasmCore } from "../wasm/doper_core";

import type { CoreClient } from "./main-thread";

/** Inputs supported by wasm-bindgen's web-target loader. */
export type WasmCoreInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

/** Initializes the packaged product WASM and creates one disposable Core. */
export async function createWasmCore(
  width: number,
  height: number,
  input?: WasmCoreInput | Promise<WasmCoreInput>,
): Promise<CoreClient> {
  if (input === undefined) await initialize();
  else await initialize({ module_or_path: input });
  return new WasmCore(width, height);
}
