import { MAX_RESOURCE_BYTES, SFNT_FONT_DATA_OFFSET } from "./generated";

const MAX_SFNT_DATA_BYTES = MAX_RESOURCE_BYTES - SFNT_FONT_DATA_OFFSET;

/** Options for one immutable, explicitly loaded SFNT font face. */
export interface PingoFontOptions {
  /** Face index for a TrueType/OpenType collection. */
  readonly faceIndex?: number;
  /** CSS family used only when the explicit Core font path falls back. */
  readonly fallbackFamily?: string;
}

/** Immutable explicit font handle accepted by text and editable-text nodes. */
export class PingoFont {
  readonly #bytes: Uint8Array;

  /** Collection face index consumed by Core shaping. */
  public readonly faceIndex: number;

  /** CSS family used by the all-or-nothing system-font fallback. */
  public readonly fallbackFamily: string;

  /** @internal Use {@link createFont} so input is copied and validated. */
  public constructor(bytes: Uint8Array, faceIndex: number, fallbackFamily: string) {
    this.#bytes = bytes.slice();
    this.faceIndex = faceIndex;
    this.fallbackFamily = fallbackFamily;
    Object.freeze(this);
  }

  /** Returns an isolated copy for one encoded immutable Scene resource. */
  public copyBytes(): Uint8Array {
    return this.#bytes.slice();
  }
}

/**
 * Copies and validates an SFNT OpenType/TrueType font for deterministic Core
 * shaping. WOFF/WOFF2 must be decoded before this boundary.
 */
export function createFont(
  input: ArrayBuffer | ArrayBufferView,
  options: PingoFontOptions = {},
): PingoFont {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input.slice(0))
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SFNT_DATA_BYTES) {
    throw new RangeError(`font bytes must contain 1 through ${String(MAX_SFNT_DATA_BYTES)} bytes`);
  }
  if (!hasSfntSignature(bytes)) {
    throw new TypeError("font must be decoded TTF, OTF, or TTC SFNT bytes");
  }
  const faceIndex = options.faceIndex ?? 0;
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex > 0xffff_ffff) {
    throw new RangeError("font faceIndex must be an unsigned 32-bit integer");
  }
  const fallbackFamily = options.fallbackFamily ?? "sans-serif";
  if (fallbackFamily.length === 0) throw new RangeError("fallbackFamily must not be empty");
  return new PingoFont(bytes, faceIndex, fallbackFamily);
}

function hasSfntSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const signature = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  return (
    signature === "\u0000\u0001\u0000\u0000" ||
    signature === "OTTO" ||
    signature === "true" ||
    signature === "typ1" ||
    signature === "ttcf"
  );
}
