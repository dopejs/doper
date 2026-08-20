import { beforeEach, describe, expect, it, vi } from "vitest";

const bindings = vi.hoisted(() => {
  const initialize = vi.fn<() => Promise<unknown>>();
  const construct = vi.fn();
  class WasmCore {
    public constructor(width: number, height: number, iosPhysics: boolean) {
      construct(width, height, iosPhysics);
    }
  }
  return { construct, initialize, WasmCore };
});

vi.mock("../wasm/pingo_core", () => ({
  default: bindings.initialize,
  WasmCore: bindings.WasmCore,
}));

beforeEach(() => {
  vi.resetModules();
  bindings.construct.mockReset();
  bindings.initialize.mockReset();
});

describe("initializeWasm", () => {
  it("shares one in-flight initialization with callers and Core creation", async () => {
    let complete: (() => void) | undefined;
    bindings.initialize.mockReturnValue(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    const { createWasmCore, initializeWasm } = await import("./wasm");

    const first = initializeWasm();
    const second = initializeWasm();
    const core = createWasmCore(320, 200);

    expect(bindings.initialize).toHaveBeenCalledOnce();
    expect(bindings.construct).not.toHaveBeenCalled();
    complete?.();
    await expect(Promise.all([first, second, core])).resolves.toHaveLength(3);
    expect(bindings.construct).toHaveBeenCalledWith(320, 200, false);
  });

  it("does not cache a failed initialization", async () => {
    bindings.initialize
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({});
    const { initializeWasm } = await import("./wasm");

    await expect(initializeWasm()).rejects.toThrow("network unavailable");
    await expect(initializeWasm()).resolves.toBeUndefined();
    expect(bindings.initialize).toHaveBeenCalledTimes(2);
  });

  it("passes a custom wasm-bindgen input through the first initialization", async () => {
    bindings.initialize.mockResolvedValue({});
    const { initializeWasm } = await import("./wasm");
    const module = {} as WebAssembly.Module;

    await initializeWasm(module);

    expect(bindings.initialize).toHaveBeenCalledWith({ module_or_path: module });
  });
});
