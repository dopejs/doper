import {
  ABI_VERSION,
  MAX_SYSTEM_TEXT_LINES,
  MAX_SYSTEM_TEXT_METRIC_INSTRUCTIONS,
  MAX_SYSTEM_TEXT_METRICS_BYTES,
  PROTOCOL_ALIGNMENT,
  STREAM_HEADER_BYTES,
  SYSTEM_TEXT_METRIC_LAYOUTS,
  SYSTEM_TEXT_METRICS_MAGIC,
  SystemTextMetricOpcode,
} from "./generated";

/** Browser-measured dimensions for one immutable fallback string/style pair. */
export interface SystemTextMetric {
  readonly stringId: number;
  readonly styleId: number;
  readonly maxLineWidth: number;
  readonly lineCount: number;
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
      return checkedAdd(total, requiredFixedBytes(opcode));
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
    } else {
      writer.instruction(SystemTextMetricOpcode.ReleaseSystemTextMetric);
      writer.u32(delta.stringId);
      writer.u32(delta.styleId);
    }
  }
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
  if (reader.u16() !== ABI_VERSION) fail("unsupported text metric ABI version");
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
    const opcode = systemTextMetricOpcode(reader.instruction());
    const stringId = reader.u32();
    const styleId = reader.u32();
    validateId(stringId, "stringId");
    validateId(styleId, "styleId");
    const key = pairKey(stringId, styleId);
    if (seen.has(key)) fail("text metric resource pair occurs more than once in a batch");
    seen.add(key);
    if (opcode === SystemTextMetricOpcode.UpsertSystemTextMetric) {
      const metric = {
        stringId,
        styleId,
        maxLineWidth: reader.f32(),
        lineCount: reader.u32(),
      };
      validateMetric(metric);
      deltas.push({ type: "upsert", metric: Object.freeze(metric) });
    } else if (opcode === SystemTextMetricOpcode.ReleaseSystemTextMetric) {
      deltas.push({ type: "release", stringId, styleId });
    } else {
      fail(`unknown text metric opcode ${String(opcode)}`);
    }
    const actual = reader.offset - start;
    const expected = requiredFixedBytes(opcode);
    if (actual !== expected) fail("text metric instruction length mismatch");
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

function requiredFixedBytes(opcode: SystemTextMetricOpcode): number {
  const layout = SYSTEM_TEXT_METRIC_LAYOUTS[opcode];
  if (layout === undefined || layout.fixedBytes === null) fail("unknown text metric opcode");
  return layout.fixedBytes;
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

  public instruction(): number {
    if (this.#offset % PROTOCOL_ALIGNMENT !== 0) fail("text metric instruction is not aligned");
    const opcode = this.u8();
    if (this.u8() !== 0) fail("text metric flags are unsupported");
    if (this.u16() !== 0) fail("text metric reserved bytes must be zero");
    return opcode;
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

  public constructor(private readonly bytes: Uint8Array) {}

  public get offset(): number {
    return this.#offset;
  }

  public instruction(opcode: SystemTextMetricOpcode): void {
    this.u8(opcode);
    this.u8(0);
    this.u16(0);
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
