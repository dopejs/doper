import initialize, { WasmCore } from "../wasm/pingo_core";

import type { CoreClient } from "./main-thread";

/** Inputs supported by wasm-bindgen's web-target loader. */
export type WasmCoreInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

let initialization: Promise<void> | undefined;

/**
 * Loads and instantiates the packaged product WASM in the current JavaScript realm.
 *
 * The first call selects the module input. Concurrent and later calls share the
 * same initialization, so application startup code can own its loading UI
 * without causing `createWasmCore` to load the module again. A failed attempt is
 * not cached and may be retried.
 */
export function initializeWasm(input?: WasmCoreInput | Promise<WasmCoreInput>): Promise<void> {
  initialization ??= (input === undefined ? initialize() : initialize({ module_or_path: input }))
    .then(() => undefined)
    .catch((cause: unknown) => {
      initialization = undefined;
      throw cause;
    });
  return initialization;
}

/** Initializes the packaged product WASM and creates one disposable Core. */
export async function createWasmCore(
  width: number,
  height: number,
  input?: WasmCoreInput | Promise<WasmCoreInput>,
): Promise<CoreClient> {
  await initializeWasm(input);
  return new WasmCore(width, height, prefersIosScrollPhysics());
}

/**
 * Whether this device expects an iOS-family coast.
 *
 * The two families differ by roughly three times in how far a flick travels, so
 * guessing wrong is the difference between a list that glides and one that
 * stops almost immediately. Detection is deliberately conservative: anything
 * not recognisably Apple gets the shorter Android coast, which is the safer
 * error on a device whose platform cannot be read.
 */
function prefersIosScrollPhysics(): boolean {
  const navigatorLike = (globalThis as { navigator?: { platform?: string; userAgent?: string } })
    .navigator;
  if (navigatorLike === undefined) return false;
  const platform = `${navigatorLike.platform ?? ""} ${navigatorLike.userAgent ?? ""}`;
  // iPadOS reports a desktop platform string, so the touch-capable Mac case has
  // to be treated as iOS as well.
  if (/iPhone|iPad|iPod/u.test(platform)) return true;
  const touchPoints = (globalThis as { navigator?: { maxTouchPoints?: number } }).navigator
    ?.maxTouchPoints;
  return /Mac/u.test(platform) && typeof touchPoints === "number" && touchPoints > 1;
}
