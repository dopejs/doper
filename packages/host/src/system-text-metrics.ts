import {
  ABI_VERSION,
  MAX_SYSTEM_TEXT_ADVANCES,
  MAX_SYSTEM_TEXT_LINES,
  MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS,
  MAX_SYSTEM_TEXT_METRICS_BYTES,
  PROTOCOL_ALIGNMENT,
  STREAM_HEADER_BYTES,
  SYSTEM_TEXT_METRIC_LAYOUTS,
  SYSTEM_TEXT_METRICS_MAGIC,
  SystemTextMetricOpcode,
  INSTRUCTION_FLAG_MASK,
  INSTRUCTION_FLAG_OPTIONAL,
  INSTRUCTION_LENGTH_ESCAPE,
  INSTRUCTION_HEADER_BYTES,
  MINIMUM_READABLE_ABI_VERSION,
} from "./generated";

/** One measured code point and its advance in logical CSS pixels. */
export type CodePointAdvance = readonly [codePoint: number, advance: number];

/** Browser-measured dimensions for one immutable fallback string/style pair. */
export interface SystemTextMetric {
  readonly stringId: number;
  readonly styleId: number;
  readonly maxLineWidth: number;
  readonly lineCount: number;
  /**
   * Advance per measured code point in logical CSS pixels, ascending by code
   * point and without duplicates, or empty when this pair was not measured.
   *
   * Core places the caret, resolves a pointer to a text offset, and lays out the
   * IME candidate-window rectangles from these. A table rather than a positional
   * array because the caret follows the live editing value, which during
   * composition holds preedit text that is in no Scene string; the Host measures
   * that text into the same table. Only pairs a Scene node makes editable are
   * measured, since each distinct code point costs a `measureText` call.
   */
  readonly advances: readonly CodePointAdvance[];
  /**
   * Advance of each code point of the string in order, measured in context
   * from prefix differences, or empty when the pair was not measured.
   *
   * Exact for the string it was measured from — including the contextual
   * contraction of consecutive full-width punctuation, which the table above
   * cannot express — and applied by Core only while the editing value still
   * equals that string.
   */
  readonly positionalAdvances: readonly number[];
}

/** One transactional system-font metric cache delta. */
export type SystemTextMetricDelta =
  | { readonly type: "upsert"; readonly metric: SystemTextMetric }
  | { readonly type: "release"; readonly stringId: number; readonly styleId: number };

/** Deterministic system-font metric contract violation. */
export class SystemTextMetricError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SystemTextMetricError";
  }
}

/** Encodes a canonical Host-to-Core system-font measurement batch. */
export function encodeSystemTextMetricBatch(deltas: readonly SystemTextMetricDelta[]): Uint8Array {
  if (deltas.length > MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS) fail("too many text metric deltas");
  const bytes =
    STREAM_HEADER_BYTES +
    deltas.reduce((total, delta) => {
      const opcode =
        delta.type === "upsert"
          ? SystemTextMetricOpcode.UpsertSystemTextMetric
          : SystemTextMetricOpcode.ReleaseSystemTextMetric;
      const advances = delta.type === "upsert" ? delta.metric.advances.length : 0;
      const positional = delta.type === "upsert" ? delta.metric.positionalAdvances.length : 0;
      return checkedAdd(
        total,
        checkedAdd(instructionBytes(opcode), checkedAdd(advances * 8, positional * 4)),
      );
    }, 0);
  if (bytes > MAX_SYSTEM_TEXT_METRICS_BYTES) fail("text metric batch exceeds maximum size");
  const output = new Uint8Array(bytes);
  const writer = new Writer(output);
  writer.u32(SYSTEM_TEXT_METRICS_MAGIC);
  writer.u16(ABI_VERSION);
  writer.u16(STREAM_HEADER_BYTES);
  writer.u32(bytes);
  writer.u32(deltas.length);
  const seen = new Set<string>();
  for (const delta of deltas) {
    const metric =
      delta.type === "upsert" ? delta.metric : { stringId: delta.stringId, styleId: delta.styleId };
    validateId(metric.stringId, "stringId");
    validateId(metric.styleId, "styleId");
    const key = pairKey(metric.stringId, metric.styleId);
    if (seen.has(key)) fail("text metric resource pair occurs more than once in a batch");
    seen.add(key);
    if (delta.type === "upsert") {
      validateMetric(delta.metric);
      writer.instruction(SystemTextMetricOpcode.UpsertSystemTextMetric);
      writer.u32(delta.metric.stringId);
      writer.u32(delta.metric.styleId);
      writer.f32(delta.metric.maxLineWidth);
      writer.u32(delta.metric.lineCount);
      writer.u32(delta.metric.advances.length);
      for (const [codePoint, advance] of delta.metric.advances) {
        writer.u32(codePoint);
        writer.f32(advance);
      }
      writer.u32(delta.metric.positionalAdvances.length);
      for (const advance of delta.metric.positionalAdvances) writer.f32(advance);
    } else {
      writer.instruction(SystemTextMetricOpcode.ReleaseSystemTextMetric);
      writer.u32(delta.stringId);
      writer.u32(delta.styleId);
    }
  }
  writer.closeInstruction();
  if (writer.offset !== output.byteLength) fail("text metric encoder length mismatch");
  return output;
}

/** Decodes and fully validates a Host-to-Core system-font measurement batch. */
export function decodeSystemTextMetricBatch(input: Uint8Array): SystemTextMetricDelta[] {
  if (!(input instanceof Uint8Array)) fail("text metric batch must be Uint8Array bytes");
  if (input.byteLength > MAX_SYSTEM_TEXT_METRICS_BYTES)
    fail("text metric batch exceeds maximum size");
  if (input.byteLength % PROTOCOL_ALIGNMENT !== 0) fail("text metric batch is not aligned");
  const reader = new Reader(input);
  if (reader.u32() !== SYSTEM_TEXT_METRICS_MAGIC) fail("wrong text metric magic");
  // Newer producers stay readable through the self-describing instruction
  // framing; anything older than it cannot be stepped through safely.
  if (reader.u16() < MINIMUM_READABLE_ABI_VERSION) fail("unsupported text metric ABI version");
  if (reader.u16() !== STREAM_HEADER_BYTES) fail("invalid text metric header length");
  if (reader.u32() !== input.byteLength) fail("text metric length does not match input");
  const declaredCount = reader.u32();
  if (declaredCount > MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS) fail("too many text metric deltas");
  if (declaredCount > Math.floor(reader.remaining / 12)) {
    fail("text metric count cannot fit in the remaining bytes");
  }
  const deltas: SystemTextMetricDelta[] = [];
  const seen = new Set<string>();
  while (reader.remaining !== 0) {
    const start = reader.offset;
    const header = reader.instruction();
    if (!isKnownOpcode(SystemTextMetricOpcode, header.opcode)) {
      if (!header.optional) fail(`unknown text metric opcode ${String(header.opcode)}`);
      reader.seekTo(header.end);
      continue;
    }
    const opcode = systemTextMetricOpcode(header.opcode);
    const stringId = reader.u32();
    const styleId = reader.u32();
    validateId(stringId, "stringId");
    validateId(styleId, "styleId");
    const key = pairKey(stringId, styleId);
    if (seen.has(key)) fail("text metric resource pair occurs more than once in a batch");
    seen.add(key);
    if (opcode === SystemTextMetricOpcode.UpsertSystemTextMetric) {
      const maxLineWidth = reader.f32();
      const lineCount = reader.u32();
      const advanceCount = reader.u32();
      if (advanceCount > MAX_SYSTEM_TEXT_ADVANCES) {
        fail("text metric advance count is outside the supported limit");
      }
      // Bound against the bytes that remain before allocating: a declared count
      // must never size an array ahead of the payload backing it.
      if (advanceCount > Math.floor(reader.remaining / 8)) fail("truncated text metric batch");
      const advances: CodePointAdvance[] = [];
      for (let index = 0; index < advanceCount; index += 1) {
        advances.push(Object.freeze([reader.codePoint(), reader.f32()] as const));
      }
      const positionalCount = reader.u32();
      if (positionalCount > MAX_SYSTEM_TEXT_ADVANCES) {
        fail("text metric advance count is outside the supported limit");
      }
      if (positionalCount > Math.floor(reader.remaining / 4)) fail("truncated text metric batch");
      const positionalAdvances: number[] = [];
      for (let index = 0; index < positionalCount; index += 1) {
        positionalAdvances.push(reader.f32());
      }
      const metric = {
        stringId,
        styleId,
        maxLineWidth,
        lineCount,
        advances: Object.freeze(advances),
        positionalAdvances: Object.freeze(positionalAdvances),
      };
      validateMetric(metric);
      deltas.push({ type: "upsert", metric: Object.freeze(metric) });
    } else if (opcode === SystemTextMetricOpcode.ReleaseSystemTextMetric) {
      deltas.push({ type: "release", stringId, styleId });
    } else {
      fail(`unknown text metric opcode ${String(opcode)}`);
    }
    const actual = reader.offset - start;
    if (actual < instructionBytes(opcode)) fail("text metric instruction length mismatch");
    // A declared length that disagrees with what was consumed would let a
    // skipping reader and this one disagree about where the next one starts.
    if (reader.offset !== header.end) fail("instruction length does not match its payload");
  }
  if (deltas.length !== declaredCount) fail("text metric instruction count does not match");
  return deltas;
}

function validateMetric(metric: SystemTextMetric): void {
  validateId(metric.stringId, "stringId");
  validateId(metric.styleId, "styleId");
  if (
    !Number.isFinite(metric.maxLineWidth) ||
    !Number.isFinite(Math.fround(metric.maxLineWidth)) ||
    metric.maxLineWidth < 0
  ) {
    fail("text metric width must be finite, non-negative, and representable as f32");
  }
  if (
    !Number.isInteger(metric.lineCount) ||
    metric.lineCount < 1 ||
    metric.lineCount > MAX_SYSTEM_TEXT_LINES
  ) {
    fail("text metric line count is outside the supported limit");
  }
  if (metric.advances.length > MAX_SYSTEM_TEXT_ADVANCES) {
    fail("text metric advance count is outside the supported limit");
  }
  if (metric.positionalAdvances.length > MAX_SYSTEM_TEXT_ADVANCES) {
    fail("text metric advance count is outside the supported limit");
  }
  for (const advance of metric.positionalAdvances) {
    if (!Number.isFinite(advance) || !Number.isFinite(Math.fround(advance)) || advance < 0) {
      fail("text metric advance must be finite, non-negative, and representable as f32");
    }
  }
  let previous = -1;
  for (const [codePoint, advance] of metric.advances) {
    if (!Number.isFinite(advance) || !Number.isFinite(Math.fround(advance)) || advance < 0) {
      fail("text metric advance must be finite, non-negative, and representable as f32");
    }
    validateCodePoint(codePoint);
    // Ascending and unique keeps one table one byte sequence, so a golden
    // fixture and a cross-language round trip still pin the encoding.
    if (codePoint <= previous) {
      fail("text metric advances must ascend by code point without duplicates");
    }
    previous = codePoint;
  }
}

function validateCodePoint(value: number): void {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0x10ffff ||
    (value >= 0xd800 && value <= 0xdfff)
  ) {
    fail("text metric advance code point is not a Unicode scalar value");
  }
}

function validateId(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    fail(`${label} must be a non-zero unsigned 32-bit integer`);
  }
}

function pairKey(stringId: number, styleId: number): string {
  return `${String(stringId)}:${String(styleId)}`;
}

function systemTextMetricOpcode(value: number): SystemTextMetricOpcode {
  if (value === Number(SystemTextMetricOpcode.UpsertSystemTextMetric)) {
    return SystemTextMetricOpcode.UpsertSystemTextMetric;
  }
  if (value === Number(SystemTextMetricOpcode.ReleaseSystemTextMetric)) {
    return SystemTextMetricOpcode.ReleaseSystemTextMetric;
  }
  return fail(`unknown text metric opcode ${String(value)}`);
}

/** Bytes an instruction occupies before any variable-size payload. */
function instructionBytes(opcode: SystemTextMetricOpcode): number {
  const layout = SYSTEM_TEXT_METRIC_LAYOUTS[opcode];
  if (layout === undefined) fail("unknown text metric opcode");
  return layout.minimumBytes;
}

class Reader {
  #offset = 0;

  public constructor(private readonly bytes: Uint8Array) {}

  public get offset(): number {
    return this.#offset;
  }

  public get remaining(): number {
    return this.bytes.byteLength - this.#offset;
  }

  /** Reads one instruction header, including where the instruction ends. */
  public instruction(): { opcode: number; optional: boolean; end: number } {
    const offset = this.#offset;
    if (offset % PROTOCOL_ALIGNMENT !== 0) fail("instruction is not aligned");
    this.require(INSTRUCTION_HEADER_BYTES);
    const opcode = this.u8();
    const flags = this.u8();
    if ((flags & ~INSTRUCTION_FLAG_MASK) !== 0) fail("unsupported instruction flags");
    const words = this.u16();
    const length = words === INSTRUCTION_LENGTH_ESCAPE ? this.u32() : words * PROTOCOL_ALIGNMENT;
    const end = offset + length;
    if (length < INSTRUCTION_HEADER_BYTES || length % PROTOCOL_ALIGNMENT !== 0) {
      fail("instruction length is invalid");
    }
    if (end > this.bytes.byteLength) fail("instruction length runs past the stream");
    return { opcode, optional: (flags & INSTRUCTION_FLAG_OPTIONAL) !== 0, end };
  }

  /** Moves the cursor forward to an instruction boundary. */
  public seekTo(offset: number): void {
    if (offset < this.#offset || offset > this.bytes.byteLength) fail("invalid instruction skip");
    this.#offset = offset;
  }

  public u8(): number {
    this.require(1);
    return this.bytes[this.#offset++] ?? 0;
  }

  public u16(): number {
    this.require(2);
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.#offset,
      2,
    ).getUint16(0, true);
    this.#offset += 2;
    return value;
  }

  public u32(): number {
    this.require(4);
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.#offset,
      4,
    ).getUint32(0, true);
    this.#offset += 4;
    return value;
  }

  /** Reads a Unicode scalar value; surrogates and out-of-range values fail. */
  public codePoint(): number {
    const value = this.u32();
    validateCodePoint(value);
    return value;
  }

  public f32(): number {
    this.require(4);
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.#offset,
      4,
    ).getFloat32(0, true);
    this.#offset += 4;
    if (!Number.isFinite(value)) fail("text metric float must be finite");
    return value;
  }

  private require(bytes: number): void {
    if (bytes > this.remaining) fail("truncated text metric batch");
  }
}

class Writer {
  #offset = 0;
  #instructionStart: number | undefined;

  public constructor(private readonly bytes: Uint8Array) {}

  public get offset(): number {
    return this.#offset;
  }

  public instruction(opcode: SystemTextMetricOpcode): void {
    this.closeInstruction();
    this.#instructionStart = this.#offset;
    this.u8(opcode);
    this.u8(0);
    this.u16(0);
  }

  /**
   * Writes the length of the instruction that just ended.
   *
   * These instructions are fixed-size and small, so the escape a variable-size
   * stream needs cannot arise here; it is still refused rather than truncated.
   */
  public closeInstruction(): void {
    const start = this.#instructionStart;
    if (start === undefined) return;
    this.#instructionStart = undefined;
    const words = (this.#offset - start) / PROTOCOL_ALIGNMENT;
    if (words >= INSTRUCTION_LENGTH_ESCAPE) fail("text metric instruction is too large");
    new DataView(this.bytes.buffer, this.bytes.byteOffset + start + 2, 2).setUint16(0, words, true);
  }

  public u8(value: number): void {
    this.bytes[this.#offset++] = value;
  }

  public u16(value: number): void {
    new DataView(this.bytes.buffer, this.bytes.byteOffset + this.#offset, 2).setUint16(
      0,
      value,
      true,
    );
    this.#offset += 2;
  }

  public u32(value: number): void {
    new DataView(this.bytes.buffer, this.bytes.byteOffset + this.#offset, 4).setUint32(
      0,
      value,
      true,
    );
    this.#offset += 4;
  }

  public f32(value: number): void {
    new DataView(this.bytes.buffer, this.bytes.byteOffset + this.#offset, 4).setFloat32(
      0,
      value,
      true,
    );
    this.#offset += 4;
  }
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail("text metric length overflow");
  return result;
}

function fail(message: string): never {
  throw new SystemTextMetricError(message);
}

/** Whether an opcode byte names a member this build knows. */
function isKnownOpcode<T extends Record<string, string | number>>(
  values: T,
  value: number,
): value is T[keyof T] & number {
  return typeof values[value] === "string";
}
