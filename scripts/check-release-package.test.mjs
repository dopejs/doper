import { describe, expect, it } from "vitest";

import { checkReleasePackage, checkWasmManifest } from "./check-release-package.mjs";

describe("release package check", () => {
  it("accepts the built facade artifact and WASM integrity manifest", async () => {
    expect(await checkWasmManifest()).toEqual([]);
    expect(await checkReleasePackage()).toEqual([]);
  });
});
