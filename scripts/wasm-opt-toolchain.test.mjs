import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bootstrapAndLocatePinnedWasmOpt, locatePinnedWasmOpt } from "./wasm-opt-toolchain.mjs";

const expectedVersion = "wasm-opt version 117 (version_117)";

describe("product WASM Binaryen bootstrap", () => {
  it("lets the first wasm-pack build populate an empty cache before locating the pin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pingo-wasm-opt-empty-"));
    const events = [];
    try {
      const verified = await bootstrapAndLocatePinnedWasmOpt({
        build: async () => {
          events.push("build");
          const executable = path.join(root, "wasm-opt-cold", "bin", "wasm-opt");
          await mkdir(path.dirname(executable), { recursive: true });
          await writeFile(executable, "fixture", "utf8");
          return "artifact";
        },
        locate: async () => {
          events.push("locate");
          return locatePinnedWasmOpt({
            expectedVersion,
            readVersion: async () => expectedVersion,
            roots: [root],
          });
        },
      });
      expect(events).toEqual(["build", "locate"]);
      expect(verified.result).toBe("artifact");
      expect(verified.version).toBe(expectedVersion);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails closed when wasm-pack installs a different Binaryen version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pingo-wasm-opt-wrong-"));
    try {
      const executable = path.join(root, "wasm-opt-wrong", "bin", "wasm-opt");
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, "fixture", "utf8");
      await expect(
        locatePinnedWasmOpt({
          expectedVersion,
          readVersion: async () => "wasm-opt version 118 (version_118)",
          roots: [root],
        }),
      ).rejects.toThrow(/did not install required Binaryen/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not inspect the cache after a failed wasm-pack build", async () => {
    let located = false;
    await expect(
      bootstrapAndLocatePinnedWasmOpt({
        build: async () => {
          throw new Error("build failed");
        },
        locate: async () => {
          located = true;
          throw new Error("must not run");
        },
      }),
    ).rejects.toThrow(/build failed/u);
    expect(located).toBe(false);
  });
});
