import type { Color, DoperFont, DoperImage } from "@dopejs/pingo-jsx";

import {
  AFFINE_A_OFFSET,
  AFFINE_B_OFFSET,
  AFFINE_C_OFFSET,
  AFFINE_D_OFFSET,
  AFFINE_E_OFFSET,
  AFFINE_F_OFFSET,
  AFFINE_RESOURCE_MINIMUM_BYTES,
  AFFINE_RESOURCE_VARIANT,
  AFFINE_VARIANT_OFFSET,
  AFFINE_VERSION_OFFSET,
  MAX_RESOURCE_BYTES,
  RESOURCE_ENCODING_VERSION,
  SFNT_FONT_DATA_BYTES_OFFSET,
  SFNT_FONT_DATA_OFFSET,
  SFNT_FONT_FACE_INDEX_OFFSET,
  SFNT_FONT_RESOURCE_MINIMUM_BYTES,
  SFNT_FONT_RESOURCE_VARIANT,
  SFNT_FONT_VARIANT_OFFSET,
  SFNT_FONT_VERSION_OFFSET,
  SOLID_PAINT_ALPHA_OFFSET,
  SOLID_PAINT_BLUE_OFFSET,
  SOLID_PAINT_GREEN_OFFSET,
  SOLID_PAINT_RED_OFFSET,
  SOLID_PAINT_RESOURCE_MINIMUM_BYTES,
  SOLID_PAINT_RESOURCE_VARIANT,
  SOLID_PAINT_VARIANT_OFFSET,
  SOLID_PAINT_VERSION_OFFSET,
  TEXT_STYLE_FAMILY_BYTES_OFFSET,
  TEXT_STYLE_FAMILY_OFFSET,
  TEXT_STYLE_FONT_SIZE_OFFSET,
  TEXT_STYLE_LINE_HEIGHT_OFFSET,
  TEXT_STYLE_PAINT_ID_OFFSET,
  TEXT_STYLE_RESOURCE_VARIANT,
  TEXT_STYLE_VARIANT_OFFSET,
  TEXT_STYLE_VERSION_OFFSET,
  TEXT_STYLE_WEIGHT_OFFSET,
  IMAGE_BITMAP_HEIGHT_OFFSET,
  IMAGE_BITMAP_PIXEL_BYTES_OFFSET,
  IMAGE_BITMAP_PIXELS_OFFSET,
  IMAGE_BITMAP_RESOURCE_MINIMUM_BYTES,
  IMAGE_BITMAP_RESOURCE_VARIANT,
  IMAGE_BITMAP_VARIANT_OFFSET,
  IMAGE_BITMAP_VERSION_OFFSET,
  IMAGE_BITMAP_WIDTH_OFFSET,
} from "./generated";
import type { ResourceKind } from "./generated";
import type { Mutation } from "./mutation-stream";

interface ResourceEntry {
  readonly id: number;
  readonly kind: ResourceKind;
  readonly bytes: Uint8Array;
  readonly bucketKey: string;
  references: number;
}

/** Content-interned immutable resources with explicit Core lifetime mutations. */
export class ResourcePool {
  readonly #buckets = new Map<string, ResourceEntry[]>();
  readonly #byId = new Map<number, ResourceEntry>();
  #nextId = 1;

  public replace(
    previousId: number | undefined,
    kind: ResourceKind,
    bytes: Uint8Array,
    mutations: Mutation[],
  ): number {
    const previous = previousId === undefined ? undefined : this.#byId.get(previousId);
    if (previousId !== undefined && previous === undefined) {
      throw new Error(`cannot replace unknown resource ${String(previousId)}`);
    }
    if (previous !== undefined && previous.kind === kind && equalBytes(previous.bytes, bytes)) {
      return previous.id;
    }
    const next = this.acquire(kind, bytes, mutations);
    if (previousId !== undefined) this.release(previousId, mutations);
    return next;
  }

  public acquire(kind: ResourceKind, bytes: Uint8Array, mutations: Mutation[]): number {
    if (bytes.byteLength > MAX_RESOURCE_BYTES) {
      throw new RangeError(`resource exceeds ${String(MAX_RESOURCE_BYTES)} bytes`);
    }
    const bucketKey = `${String(kind)}:${String(bytes.byteLength)}:${String(fnv1a32(bytes))}`;
    const bucket = this.#buckets.get(bucketKey);
    const existing = bucket?.find((entry) => entry.kind === kind && equalBytes(entry.bytes, bytes));
    if (existing !== undefined) {
      existing.references += 1;
      return existing.id;
    }
    const id = this.allocateId();
    const stored = bytes.slice();
    const entry: ResourceEntry = {
      id,
      kind,
      bytes: stored,
      bucketKey,
      references: 1,
    };
    if (bucket === undefined) this.#buckets.set(bucketKey, [entry]);
    else bucket.push(entry);
    this.#byId.set(id, entry);
    mutations.push({ type: "defineResource", resourceId: id, kind, bytes: stored });
    return id;
  }

  public release(id: number, mutations: Mutation[]): void {
    const entry = this.#byId.get(id);
    if (entry === undefined) throw new Error(`cannot release unknown resource ${String(id)}`);
    if (entry.references <= 0)
      throw new Error(`resource ${String(id)} has an invalid reference count`);
    entry.references -= 1;
    if (entry.references !== 0) return;
    this.#byId.delete(id);
    const bucket = this.#buckets.get(entry.bucketKey);
    if (bucket === undefined) throw new Error("resource bucket disappeared before final release");
    const index = bucket.indexOf(entry);
    if (index < 0) throw new Error("resource entry disappeared before final release");
    bucket.splice(index, 1);
    if (bucket.length === 0) this.#buckets.delete(entry.bucketKey);
    mutations.push({ type: "releaseResource", resourceId: id });
  }

  public get size(): number {
    return this.#byId.size;
  }

  /** Drops Shell-side resource ownership after a fatal root failure. */
  public discard(): void {
    this.#buckets.clear();
    this.#byId.clear();
  }

  private allocateId(): number {
    if (this.#nextId > 0xffff_ffff) throw new RangeError("resource identifier space exhausted");
    const result = this.#nextId;
    this.#nextId += 1;
    return result;
  }
}

/** Encodes a schema-versioned portable solid paint. */
export function encodeSolidPaint(color: Color): Uint8Array {
  const [red, green, blue, alpha] = normalizeColor(color);
  const bytes = new Uint8Array(SOLID_PAINT_RESOURCE_MINIMUM_BYTES);
  bytes[SOLID_PAINT_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
  bytes[SOLID_PAINT_VARIANT_OFFSET] = SOLID_PAINT_RESOURCE_VARIANT;
  bytes[SOLID_PAINT_RED_OFFSET] = red;
  bytes[SOLID_PAINT_GREEN_OFFSET] = green;
  bytes[SOLID_PAINT_BLUE_OFFSET] = blue;
  bytes[SOLID_PAINT_ALPHA_OFFSET] = alpha;
  return bytes;
}

/** Encodes a schema-versioned affine matrix. */
export function encodeAffine(
  matrix: readonly [number, number, number, number, number, number],
): Uint8Array {
  if (matrix.some((value) => !Number.isFinite(value))) {
    throw new TypeError("transform components must be finite");
  }
  const bytes = new Uint8Array(AFFINE_RESOURCE_MINIMUM_BYTES);
  bytes[AFFINE_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
  bytes[AFFINE_VARIANT_OFFSET] = AFFINE_RESOURCE_VARIANT;
  const view = new DataView(bytes.buffer);
  const offsets = [
    AFFINE_A_OFFSET,
    AFFINE_B_OFFSET,
    AFFINE_C_OFFSET,
    AFFINE_D_OFFSET,
    AFFINE_E_OFFSET,
    AFFINE_F_OFFSET,
  ];
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index];
    const value = matrix[index];
    if (offset === undefined || value === undefined) throw new Error("affine schema is incomplete");
    view.setFloat32(offset, value, true);
  }
  return bytes;
}

/** Encodes the minimal schema-versioned Canvas text fallback style. */
export function encodeTextStyle(
  paintId: number,
  fontSize: number,
  lineHeight: number,
  weight: number,
  family: string,
): Uint8Array {
  assertU32(paintId, "paintId");
  assertPositiveFinite(fontSize, "fontSize");
  assertPositiveFinite(lineHeight, "lineHeight");
  if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
    throw new RangeError("fontWeight must be an integer from 1 through 1000");
  }
  const encodedFamily = new TextEncoder().encode(family);
  if (encodedFamily.length === 0) throw new RangeError("fontFamily must not be empty");
  const unalignedLength = TEXT_STYLE_FAMILY_OFFSET + encodedFamily.length;
  if (unalignedLength > MAX_RESOURCE_BYTES) {
    throw new RangeError("text style resource is too large");
  }
  const byteLength = align4(unalignedLength);
  if (byteLength > MAX_RESOURCE_BYTES) throw new RangeError("text style resource is too large");
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  bytes[TEXT_STYLE_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
  bytes[TEXT_STYLE_VARIANT_OFFSET] = TEXT_STYLE_RESOURCE_VARIANT;
  view.setUint32(TEXT_STYLE_PAINT_ID_OFFSET, paintId, true);
  view.setFloat32(TEXT_STYLE_FONT_SIZE_OFFSET, fontSize, true);
  view.setFloat32(TEXT_STYLE_LINE_HEIGHT_OFFSET, lineHeight, true);
  view.setUint16(TEXT_STYLE_WEIGHT_OFFSET, weight, true);
  view.setUint32(TEXT_STYLE_FAMILY_BYTES_OFFSET, encodedFamily.length, true);
  bytes.set(encodedFamily, TEXT_STYLE_FAMILY_OFFSET);
  return bytes;
}

/** Encodes one copied, decoded SFNT font face for Core-owned shaping. */
export function encodeSfntFont(font: DoperFont): Uint8Array {
  const data = font.copyBytes();
  if (data.byteLength === 0 || data.byteLength > MAX_RESOURCE_BYTES) {
    throw new RangeError("font resource is empty or exceeds the resource byte budget");
  }
  const byteLength = align4(SFNT_FONT_DATA_OFFSET + data.byteLength);
  if (byteLength > MAX_RESOURCE_BYTES) throw new RangeError("font resource is too large");
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  bytes[SFNT_FONT_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
  bytes[SFNT_FONT_VARIANT_OFFSET] = SFNT_FONT_RESOURCE_VARIANT;
  view.setUint32(SFNT_FONT_FACE_INDEX_OFFSET, font.faceIndex, true);
  view.setUint32(SFNT_FONT_DATA_BYTES_OFFSET, data.byteLength, true);
  bytes.set(data, SFNT_FONT_DATA_OFFSET);
  if (bytes.byteLength < SFNT_FONT_RESOURCE_MINIMUM_BYTES) {
    throw new Error("generated SFNT font layout is inconsistent");
  }
  return bytes;
}

/** Encodes one copied RGBA8 bitmap for Core-owned image drawing. */
export function encodeImageBitmap(image: DoperImage): Uint8Array {
  const pixels = image.copyPixels();
  const expected = image.width * image.height * 4;
  if (pixels.byteLength !== expected) {
    throw new RangeError("image pixels do not match the declared dimensions");
  }
  const byteLength = align4(IMAGE_BITMAP_PIXELS_OFFSET + pixels.byteLength);
  if (byteLength > MAX_RESOURCE_BYTES) {
    throw new RangeError(
      `image resource is ${String(byteLength)} bytes, over the ${String(
        MAX_RESOURCE_BYTES,
      )} byte budget: downsample the bitmap before handing it to the engine`,
    );
  }
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  bytes[IMAGE_BITMAP_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
  bytes[IMAGE_BITMAP_VARIANT_OFFSET] = IMAGE_BITMAP_RESOURCE_VARIANT;
  view.setUint32(IMAGE_BITMAP_WIDTH_OFFSET, image.width, true);
  view.setUint32(IMAGE_BITMAP_HEIGHT_OFFSET, image.height, true);
  view.setUint32(IMAGE_BITMAP_PIXEL_BYTES_OFFSET, pixels.byteLength, true);
  bytes.set(pixels, IMAGE_BITMAP_PIXELS_OFFSET);
  if (bytes.byteLength < IMAGE_BITMAP_RESOURCE_MINIMUM_BYTES) {
    throw new Error("generated image bitmap layout is inconsistent");
  }
  return bytes;
}

export function encodeUtf8(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_RESOURCE_BYTES) throw new RangeError("UTF-8 resource is too large");
  return bytes;
}

function normalizeColor(color: Color): [number, number, number, number] {
  if (typeof color === "string") {
    const match = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.exec(color);
    if (match?.[1] === undefined) throw new TypeError(`unsupported color ${color}`);
    const hex = match[1];
    if (hex.length === 3 || hex.length === 4) {
      return [
        parseHex(hex[0], hex[0]),
        parseHex(hex[1], hex[1]),
        parseHex(hex[2], hex[2]),
        hex.length === 4 ? parseHex(hex[3], hex[3]) : 255,
      ];
    }
    return [
      parseHex(hex[0], hex[1]),
      parseHex(hex[2], hex[3]),
      parseHex(hex[4], hex[5]),
      hex.length === 8 ? parseHex(hex[6], hex[7]) : 255,
    ];
  }
  return [
    colorChannel(color.red, "red"),
    colorChannel(color.green, "green"),
    colorChannel(color.blue, "blue"),
    colorChannel(color.alpha ?? 255, "alpha"),
  ];
}

function parseHex(first: string | undefined, second: string | undefined): number {
  if (first === undefined || second === undefined) throw new TypeError("color is truncated");
  return Number.parseInt(first + second, 16);
}

function colorChannel(value: number, channel: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${channel} color channel must be an integer from 0 through 255`);
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c_9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash;
}

function align4(value: number): number {
  return value + ((4 - (value % 4)) % 4);
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
}

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer`);
  }
}
