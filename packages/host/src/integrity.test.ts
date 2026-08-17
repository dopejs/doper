import { describe, expect, it } from "vitest";

import { verifyWasmIntegrity, WasmIntegrityError } from "./integrity";

const bytes = new TextEncoder().encode("doper wasm bytes");
// SHA-256 of the fixture above, computed once and pinned.
const digestOf = async (input: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", input.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

describe("verifyWasmIntegrity", () => {
  it("accepts matching bytes and rejects any size or digest drift", async () => {
    const sha256 = await digestOf(bytes);
    await expect(
      verifyWasmIntegrity(bytes, { sha256, rawBytes: bytes.byteLength }),
    ).resolves.toBeUndefined();

    await expect(
      verifyWasmIntegrity(bytes.slice(1), { sha256, rawBytes: bytes.byteLength }),
    ).rejects.toBeInstanceOf(WasmIntegrityError);

    const flipped = bytes.slice();
    const first = flipped[0] ?? 0;
    flipped[0] = first ^ 0xff;
    await expect(
      verifyWasmIntegrity(flipped, { sha256, rawBytes: flipped.byteLength }),
    ).rejects.toThrow(/does not match/u);

    await expect(
      verifyWasmIntegrity(bytes, { sha256: "not-hex", rawBytes: bytes.byteLength }),
    ).rejects.toThrow(/lowercase hex/u);
  });
});
