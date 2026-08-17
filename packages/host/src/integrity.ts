/** Build-time manifest fields shipped beside the product WASM asset. */
export interface WasmIntegrityManifest {
  readonly sha256: string;
  readonly rawBytes: number;
}

/** Raised when a self-hosted WASM asset does not match its build manifest. */
export class WasmIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WasmIntegrityError";
  }
}

/**
 * Verifies a fetched WASM asset against the build manifest before
 * instantiation. Incident diagnostics can then trust that a failing page ran
 * the bytes the release shipped.
 *
 * Throws {@link WasmIntegrityError} on any size or digest mismatch.
 */
export async function verifyWasmIntegrity(
  bytes: ArrayBuffer | Uint8Array,
  manifest: WasmIntegrityManifest,
): Promise<void> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!/^[0-9a-f]{64}$/u.test(manifest.sha256)) {
    throw new WasmIntegrityError("manifest sha256 must be a lowercase hex SHA-256 digest");
  }
  if (view.byteLength !== manifest.rawBytes) {
    throw new WasmIntegrityError(
      `WASM asset is ${String(view.byteLength)} bytes but the manifest built ${String(manifest.rawBytes)}`,
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", view.slice().buffer);
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (actual !== manifest.sha256) {
    throw new WasmIntegrityError(
      `WASM asset digest ${actual} does not match the manifest ${manifest.sha256}`,
    );
  }
}
