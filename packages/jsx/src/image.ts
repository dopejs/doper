/** Options accepted when copying pixels into an immutable image. */
export interface PingoImageOptions {
  /** Human-readable label forwarded to accessibility. */
  readonly label?: string;
}

/**
 * An immutable RGBA8 bitmap owned by the Shell and interned as a Scene resource.
 *
 * Pixels rather than encoded bytes: resource transactions are applied
 * synchronously at a commit boundary, and every encoded format needs an
 * asynchronous decode. Handing over decoded pixels keeps Core deterministic and
 * keeps the worker transport free of a staging protocol, at the cost of sending
 * `width * height * 4` bytes. That is the right trade for the thumbnails a list
 * cell needs; large images want an encoded path with asynchronous staging, which
 * is a separate decision.
 */
export class PingoImage {
  readonly #pixels: Uint8Array;

  /** Bitmap width in pixels. */
  public readonly width: number;

  /** Bitmap height in pixels. */
  public readonly height: number;

  /** Accessibility label, empty when the image is decorative. */
  public readonly label: string;

  /** @internal Use {@link createImage} so input is copied and validated. */
  public constructor(pixels: Uint8Array, width: number, height: number, label: string) {
    this.#pixels = pixels.slice();
    this.width = width;
    this.height = height;
    this.label = label;
    Object.freeze(this);
  }

  /** Returns an isolated copy for one encoded immutable Scene resource. */
  public copyPixels(): Uint8Array {
    return this.#pixels.slice();
  }
}

/** Copies and validates RGBA8 pixels into an immutable engine image. */
export function createImage(
  pixels: ArrayBuffer | ArrayBufferView,
  width: number,
  height: number,
  options: PingoImageOptions = {},
): PingoImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("image dimensions must be positive integers");
  }
  const bytes =
    pixels instanceof ArrayBuffer
      ? new Uint8Array(pixels)
      : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  // Checked here rather than at the ABI boundary so the error names the caller's
  // mistake instead of surfacing as a malformed resource several layers down.
  if (bytes.byteLength !== width * height * 4) {
    throw new RangeError(
      `image pixels must be RGBA8: expected ${String(width * height * 4)} bytes, received ${String(
        bytes.byteLength,
      )}`,
    );
  }
  const label = options.label ?? "";
  if (typeof label !== "string") throw new TypeError("image label must be a string");
  return new PingoImage(bytes, width, height, label);
}
