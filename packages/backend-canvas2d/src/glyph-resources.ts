import {
  ABI_VERSION,
  GLYPH_BITMAP_MINIMUM_BYTES,
  GLYPH_PLACEMENT_MINIMUM_BYTES,
  GLYPH_RESOURCE_LAYOUTS,
  GLYPH_RESOURCES_MAGIC,
  GlyphResourceOpcode,
  INSTRUCTION_HEADER_BYTES,
  MAX_GLYPH_BITMAP_PIXELS,
  MAX_GLYPH_RESOURCE_INSTRUCTIONS,
  MAX_GLYPH_RESOURCES_BYTES,
  PROTOCOL_ALIGNMENT,
  STREAM_HEADER_BYTES,
} from "./generated";

/** One immutable grayscale glyph bitmap produced by Core. */
export interface CanvasGlyphBitmap {
  readonly glyphId: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly data: Uint8Array;
}

/** One positioned bitmap use within a shaped span. */
export interface CanvasGlyphPlacement {
  readonly bitmapIndex: number;
  readonly x: number;
  readonly y: number;
}

/** Immutable shaped span installed transactionally before DisplayList replay. */
export interface CanvasGlyphSpan {
  readonly spanId: number;
  readonly paintId: number;
  readonly bitmaps: readonly CanvasGlyphBitmap[];
  readonly placements: readonly CanvasGlyphPlacement[];
}

/** Fully validated Core-to-backend glyph resource delta. */
export type GlyphResourceDelta =
  | { readonly type: "define"; readonly span: CanvasGlyphSpan }
  | { readonly type: "release"; readonly spanId: number };

/** Deterministic validation failure raised before backend state changes. */
export class GlyphResourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GlyphResourceError";
  }
}

/** Decodes a complete glyph-resource batch without mutating a registry. */
export function decodeGlyphResourceBatch(input: Uint8Array): readonly GlyphResourceDelta[] {
  if (input.byteLength > MAX_GLYPH_RESOURCES_BYTES) fail("glyph batch exceeds maximum size");
  if (input.byteLength % PROTOCOL_ALIGNMENT !== 0) fail("glyph batch is not aligned");
  const reader = new Reader(input);
  if (reader.u32() !== GLYPH_RESOURCES_MAGIC) fail("wrong glyph-resource magic");
  if (reader.u16() !== ABI_VERSION) fail("unsupported glyph-resource ABI version");
  if (reader.u16() !== STREAM_HEADER_BYTES) fail("invalid glyph-resource header length");
  if (reader.u32() !== input.byteLength) fail("glyph-resource length does not match input");
  const declaredCount = reader.u32();
  if (declaredCount > MAX_GLYPH_RESOURCE_INSTRUCTIONS)
    fail("glyph-resource instruction count exceeds limit");
  if (declaredCount > Math.floor(reader.remaining / 8))
    fail("glyph-resource count cannot fit in the remaining bytes");

  const deltas: GlyphResourceDelta[] = [];
  const seen = new Set<number>();
  while (reader.remaining > 0) {
    const start = reader.offset;
    const opcode = reader.instruction();
    const delta =
      opcode === GlyphResourceOpcode.DefineGlyphSpan
        ? { type: "define" as const, span: decodeSpan(reader) }
        : { type: "release" as const, spanId: nonzeroId(reader.u32(), "span") };
    const spanId = delta.type === "define" ? delta.span.spanId : delta.spanId;
    if (seen.has(spanId)) fail("glyph span id occurs more than once in a batch");
    seen.add(spanId);
    const layout = GLYPH_RESOURCE_LAYOUTS[opcode];
    const consumed = reader.offset - start;
    if (
      consumed < layout.minimumBytes ||
      (layout.fixedBytes !== null && consumed !== layout.fixedBytes)
    ) {
      fail("glyph-resource instruction length does not match schema");
    }
    deltas.push(delta);
  }
  if (deltas.length !== declaredCount) fail("glyph-resource instruction count does not match");
  return deltas;
}

/** Encodes canonical bytes for cross-language fixtures and Core conformance tests. */
export function encodeGlyphResourceBatch(deltas: readonly GlyphResourceDelta[]): Uint8Array {
  if (deltas.length > MAX_GLYPH_RESOURCE_INSTRUCTIONS)
    fail("glyph-resource instruction count exceeds limit");
  const writer = new Writer();
  writer.u32(GLYPH_RESOURCES_MAGIC);
  writer.u16(ABI_VERSION);
  writer.u16(STREAM_HEADER_BYTES);
  writer.u32(0);
  writer.u32(deltas.length);
  const seen = new Set<number>();
  for (const delta of deltas) {
    const spanId = delta.type === "define" ? delta.span.spanId : delta.spanId;
    nonzeroId(spanId, "span");
    if (seen.has(spanId)) fail("glyph span id occurs more than once in a batch");
    seen.add(spanId);
    writer.u8(
      delta.type === "define"
        ? GlyphResourceOpcode.DefineGlyphSpan
        : GlyphResourceOpcode.ReleaseGlyphSpan,
    );
    writer.u8(0);
    writer.u16(0);
    if (delta.type === "release") {
      writer.u32(delta.spanId);
      continue;
    }
    const { span } = delta;
    nonzeroId(span.paintId, "paint");
    const payloadBytes = spanPayloadBytes(span);
    writer.u32(span.spanId);
    writer.u32(span.paintId);
    writer.u32(span.bitmaps.length);
    writer.u32(span.placements.length);
    writer.u32(payloadBytes);
    for (const bitmap of span.bitmaps) {
      validateBitmap(bitmap);
      writer.u16(bitmap.glyphId);
      writer.u16(0);
      writer.f32(bitmap.left);
      writer.f32(bitmap.top);
      writer.u32(bitmap.width);
      writer.u32(bitmap.height);
      writer.f32(bitmap.devicePixelRatio);
      writer.u32(bitmap.data.byteLength);
      writer.bytes(bitmap.data);
      writer.pad();
    }
    for (const placement of span.placements) {
      if (
        !Number.isInteger(placement.bitmapIndex) ||
        placement.bitmapIndex < 0 ||
        placement.bitmapIndex >= span.bitmaps.length
      )
        fail("glyph placement bitmap index is out of bounds");
      writer.u32(placement.bitmapIndex);
      writer.f32(placement.x);
      writer.f32(placement.y);
    }
  }
  const output = writer.finish();
  if (output.byteLength > MAX_GLYPH_RESOURCES_BYTES) fail("glyph batch exceeds maximum size");
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(
    8,
    output.byteLength,
    true,
  );
  return output;
}

function decodeSpan(reader: Reader): CanvasGlyphSpan {
  const spanId = nonzeroId(reader.u32(), "span");
  const paintId = nonzeroId(reader.u32(), "paint");
  const bitmapCount = reader.u32();
  const glyphCount = reader.u32();
  const payloadBytes = reader.u32();
  if (payloadBytes % PROTOCOL_ALIGNMENT !== 0) fail("glyph span payload is not aligned");
  const minimum = checkedAdd(
    checkedMultiply(bitmapCount, GLYPH_BITMAP_MINIMUM_BYTES),
    checkedMultiply(glyphCount, GLYPH_PLACEMENT_MINIMUM_BYTES),
  );
  if (minimum > payloadBytes) fail("glyph span counts cannot fit in the payload");
  const payload = new Reader(reader.bytes(payloadBytes));
  const bitmaps = Array.from({ length: bitmapCount }, () => decodeBitmap(payload));
  const placements = Array.from({ length: glyphCount }, (): CanvasGlyphPlacement => {
    const bitmapIndex = payload.u32();
    if (bitmapIndex >= bitmaps.length) fail("glyph placement bitmap index is out of bounds");
    return Object.freeze({ bitmapIndex, x: payload.f32(), y: payload.f32() });
  });
  if (payload.remaining !== 0) fail("glyph span payload has trailing bytes");
  return Object.freeze({
    spanId,
    paintId,
    bitmaps: Object.freeze(bitmaps),
    placements: Object.freeze(placements),
  });
}

function decodeBitmap(reader: Reader): CanvasGlyphBitmap {
  const glyphId = reader.u16();
  if (reader.u16() !== 0) fail("glyph bitmap reserved bytes must be zero");
  const left = reader.f32();
  const top = reader.f32();
  const width = reader.u32();
  const height = reader.u32();
  const devicePixelRatio = reader.f32();
  if (devicePixelRatio <= 0) fail("glyph bitmap DPR must be positive");
  const dataBytes = reader.u32();
  const pixels = checkedMultiply(width, height);
  if (pixels === 0 || pixels > MAX_GLYPH_BITMAP_PIXELS || dataBytes !== pixels) {
    fail("glyph bitmap must contain one bounded alpha byte per pixel");
  }
  const data = reader.bytes(dataBytes).slice();
  const padding = (PROTOCOL_ALIGNMENT - (dataBytes % PROTOCOL_ALIGNMENT)) % PROTOCOL_ALIGNMENT;
  for (const byte of reader.bytes(padding)) {
    if (byte !== 0) fail("glyph bitmap padding must be zero");
  }
  return Object.freeze({ glyphId, left, top, width, height, devicePixelRatio, data });
}

function spanPayloadBytes(span: CanvasGlyphSpan): number {
  let bytes = checkedMultiply(span.placements.length, GLYPH_PLACEMENT_MINIMUM_BYTES);
  for (const bitmap of span.bitmaps) {
    validateBitmap(bitmap);
    bytes = checkedAdd(bytes, GLYPH_BITMAP_MINIMUM_BYTES);
    bytes = checkedAdd(bytes, bitmap.data.byteLength);
    bytes = checkedAdd(
      bytes,
      (PROTOCOL_ALIGNMENT - (bitmap.data.byteLength % PROTOCOL_ALIGNMENT)) % PROTOCOL_ALIGNMENT,
    );
  }
  return bytes;
}

function validateBitmap(bitmap: CanvasGlyphBitmap): void {
  if (!Number.isInteger(bitmap.glyphId) || bitmap.glyphId < 0 || bitmap.glyphId > 0xffff)
    fail("glyph id is outside u16");
  if (
    !Number.isInteger(bitmap.width) ||
    bitmap.width < 0 ||
    bitmap.width > 0xffff_ffff ||
    !Number.isInteger(bitmap.height) ||
    bitmap.height < 0 ||
    bitmap.height > 0xffff_ffff ||
    !Number.isFinite(bitmap.left) ||
    !Number.isFinite(bitmap.top) ||
    !Number.isFinite(bitmap.devicePixelRatio) ||
    bitmap.devicePixelRatio <= 0
  ) {
    fail("glyph bitmap geometry and DPR must be finite and positive");
  }
  const pixels = checkedMultiply(bitmap.width, bitmap.height);
  if (pixels === 0 || pixels > MAX_GLYPH_BITMAP_PIXELS || pixels !== bitmap.data.byteLength)
    fail("glyph bitmap must contain one bounded alpha byte per pixel");
}

class Reader {
  readonly #input: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  public constructor(input: Uint8Array) {
    this.#input = input;
    this.#view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  }

  public get offset(): number {
    return this.#offset;
  }

  public get remaining(): number {
    return this.#input.byteLength - this.#offset;
  }

  public instruction(): GlyphResourceOpcode {
    if (this.#offset % PROTOCOL_ALIGNMENT !== 0) fail("glyph-resource instruction is not aligned");
    this.require(INSTRUCTION_HEADER_BYTES);
    const opcode = this.u8();
    if (this.u8() !== 0) fail("glyph-resource flags are unsupported");
    if (this.u16() !== 0) fail("glyph-resource reserved bytes must be zero");
    if (typeof GlyphResourceOpcode[opcode] !== "string") {
      fail(`unknown glyph-resource opcode ${String(opcode)}`);
    }
    return opcode;
  }

  public u8(): number {
    this.require(1);
    return this.#view.getUint8(this.#offset++);
  }

  public u16(): number {
    this.require(2);
    const value = this.#view.getUint16(this.#offset, true);
    this.#offset += 2;
    return value;
  }

  public u32(): number {
    this.require(4);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  public f32(): number {
    this.require(4);
    const value = this.#view.getFloat32(this.#offset, true);
    this.#offset += 4;
    if (!Number.isFinite(value)) fail("glyph-resource float must be finite");
    return value;
  }

  public bytes(length: number): Uint8Array {
    this.require(length);
    const value = this.#input.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  private require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining)
      fail("truncated glyph-resource batch");
  }
}

class Writer {
  readonly #bytes: number[] = [];

  public u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) fail("value is outside u8");
    this.#bytes.push(value);
  }

  public u16(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) fail("value is outside u16");
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }

  public u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) fail("value is outside u32");
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  }

  public f32(value: number): void {
    if (!Number.isFinite(value)) fail("glyph-resource float must be finite");
    const field = new Uint8Array(4);
    new DataView(field.buffer).setFloat32(0, value, true);
    this.bytes(field);
  }

  public bytes(value: Uint8Array): void {
    for (const byte of value) this.#bytes.push(byte);
  }

  public pad(): void {
    while (this.#bytes.length % PROTOCOL_ALIGNMENT !== 0) this.#bytes.push(0);
  }

  public finish(): Uint8Array {
    if (this.#bytes.length % PROTOCOL_ALIGNMENT !== 0) fail("encoded glyph batch is not aligned");
    return Uint8Array.from(this.#bytes);
  }
}

function nonzeroId(value: number, label: string): number {
  if (value === 0) fail(`glyph ${label} id must be non-zero`);
  return value;
}

function checkedMultiply(left: number, right: number): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) fail("glyph-resource arithmetic overflow");
  return value;
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) fail("glyph-resource arithmetic overflow");
  return value;
}

function fail(message: string): never {
  throw new GlyphResourceError(message);
}
