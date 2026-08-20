import { MAX_RESOURCE_BYTES, SFNT_FONT_DATA_OFFSET } from "./generated";
import { createFont, type PingoFont, type PingoFontOptions } from "./font";

const MAX_FONT_BYTES = MAX_RESOURCE_BYTES - SFNT_FONT_DATA_OFFSET;
const WOFF_HEADER_BYTES = 44;
const WOFF_TABLE_BYTES = 20;
const SFNT_HEADER_BYTES = 12;
const SFNT_TABLE_BYTES = 16;
const MAX_FONT_TABLES = 4096;
const CHECKSUM_MAGIC = 0xb1b0_afba;

/** Input accepted by {@link loadFont}. Response bodies are consumed exactly once. */
export type PingoFontSource = string | URL | Request | Response | ArrayBuffer | ArrayBufferView;

/** Optional network and WOFF2-decoder controls for an explicit font load. */
export interface PingoFontLoadOptions extends PingoFontOptions {
  /** Cancels fetch and streamed body reads. */
  readonly signal?: AbortSignal;
  /** Overrides the ambient fetch implementation, primarily for controlled hosts and tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Replaces the lazily imported default WOFF2 decoder. */
  readonly woff2Decoder?: Woff2Decoder;
}

/** Asynchronous WOFF2-to-SFNT decoder contract. */
export type Woff2Decoder = (
  input: Uint8Array,
) => Promise<ArrayBuffer | ArrayBufferView> | ArrayBuffer | ArrayBufferView;

/** Stable failure categories exposed by {@link PingoFontLoadError}. */
export type PingoFontLoadErrorCode =
  | "aborted"
  | "decode-failed"
  | "fetch-failed"
  | "invalid-data"
  | "response-too-large"
  | "unsupported-environment"
  | "unsupported-format";

/** Operator-facing font loading error with a machine-readable category. */
export class PingoFontLoadError extends Error {
  public override readonly name = "PingoFontLoadError";

  public constructor(
    public readonly code: PingoFontLoadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Fetches or decodes an explicit font into immutable SFNT bytes owned by Core.
 * SFNT inputs stay synchronous internally; WOFF1 and WOFF2 are decoded in the
 * host before the font can enter a Scene transaction.
 */
export async function loadFont(
  source: PingoFontSource,
  options: PingoFontLoadOptions = {},
): Promise<PingoFont> {
  checkAbort(options.signal);
  const bytes = await readFontSource(source, options);
  const format = fontFormat(bytes);
  const fontOptions: PingoFontOptions = {
    ...(options.faceIndex === undefined ? {} : { faceIndex: options.faceIndex }),
    ...(options.fallbackFamily === undefined ? {} : { fallbackFamily: options.fallbackFamily }),
  };
  if (format === "sfnt") return createFont(bytes, fontOptions);
  if (format === "woff") {
    return createFont(await decodeWoff(bytes, options.signal), fontOptions);
  }
  if (format === "woff2") {
    preflightWoff2(bytes);
    const decoder = options.woff2Decoder ?? defaultWoff2Decoder;
    try {
      return createFont(copyBytes(await decoder(bytes.slice())), fontOptions);
    } catch (error) {
      if (error instanceof PingoFontLoadError) throw error;
      throw new PingoFontLoadError("decode-failed", "failed to decode WOFF2 font", {
        cause: error,
      });
    }
  }
  throw new PingoFontLoadError(
    "unsupported-format",
    "font source must contain SFNT, WOFF, or WOFF2 bytes",
  );
}

async function readFontSource(
  source: PingoFontSource,
  options: PingoFontLoadOptions,
): Promise<Uint8Array> {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const bytes = copyBytes(source);
    enforceSourceLimit(bytes.byteLength);
    return bytes;
  }
  if (typeof Response !== "undefined" && source instanceof Response) {
    return readResponse(source, options.signal);
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new PingoFontLoadError(
      "unsupported-environment",
      "loadFont requires fetch for URL and Request sources",
    );
  }
  try {
    const response = await fetcher(source as string | URL | Request, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return await readResponse(response, options.signal);
  } catch (error) {
    if (error instanceof PingoFontLoadError) throw error;
    if (options.signal?.aborted === true) {
      throw new PingoFontLoadError("aborted", "font load was aborted", { cause: error });
    }
    throw new PingoFontLoadError("fetch-failed", "failed to fetch font source", { cause: error });
  }
}

async function readResponse(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  if (!response.ok) {
    throw new PingoFontLoadError(
      "fetch-failed",
      `font response failed with HTTP ${String(response.status)}`,
    );
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_FONT_BYTES) {
      throw new PingoFontLoadError(
        "response-too-large",
        `font response exceeds the ${String(MAX_FONT_BYTES)} byte limit`,
      );
    }
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    enforceSourceLimit(bytes.byteLength);
    return bytes;
  }
  return readStream(response.body, MAX_FONT_BYTES, signal, "font response");
}

async function decodeWoff(input: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  const header = preflightWoff(input);
  const tableData = new Map<number, Uint8Array>();
  for (const table of header.byOffset) {
    checkAbort(signal);
    const encoded = input.subarray(table.offset, table.offset + table.compressedLength);
    const decoded =
      table.compressedLength === table.originalLength
        ? encoded.slice()
        : await inflateWoffTable(encoded, table.originalLength, signal);
    if (decoded.byteLength !== table.originalLength) {
      throw invalidData("WOFF table decompressed to an unexpected length");
    }
    tableData.set(table.tag, decoded);
  }

  const output = new Uint8Array(header.totalSfntSize);
  const view = new DataView(output.buffer);
  view.setUint32(0, header.flavor);
  view.setUint16(4, header.tables.length);
  const entrySelector = Math.floor(Math.log2(header.tables.length));
  const searchRange = 16 * 2 ** entrySelector;
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, header.tables.length * 16 - searchRange);

  let outputOffset = SFNT_HEADER_BYTES + SFNT_TABLE_BYTES * header.tables.length;
  const outputOffsets = new Map<number, number>();
  for (const table of header.byOffset) {
    const data = required(tableData.get(table.tag), "decoded WOFF table");
    output.set(data, outputOffset);
    outputOffsets.set(table.tag, outputOffset);
    outputOffset = align4(outputOffset + data.byteLength);
  }
  if (outputOffset !== output.byteLength) throw invalidData("WOFF totalSfntSize is inconsistent");

  for (const [index, table] of header.tables.entries()) {
    const record = SFNT_HEADER_BYTES + index * SFNT_TABLE_BYTES;
    view.setUint32(record, table.tag);
    view.setUint32(record + 4, table.checksum);
    view.setUint32(record + 8, required(outputOffsets.get(table.tag), "WOFF table offset"));
    view.setUint32(record + 12, table.originalLength);
  }
  repairChecksumAdjustment(output, header.tables, outputOffsets);
  return output;
}

async function inflateWoffTable(
  input: Uint8Array,
  expectedBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new PingoFontLoadError(
      "unsupported-environment",
      "WOFF decoding requires DecompressionStream support",
    );
  }
  try {
    const source = new Blob([input.slice().buffer]).stream();
    const stream = source.pipeThrough(new DecompressionStream("deflate"));
    return await readStream(stream, expectedBytes, signal, "WOFF table");
  } catch (error) {
    if (error instanceof PingoFontLoadError) {
      if (error.code === "response-too-large") {
        throw invalidData("WOFF table decompressed beyond its declared length");
      }
      throw error;
    }
    if (signal?.aborted === true) {
      throw new PingoFontLoadError("aborted", "font load was aborted", { cause: error });
    }
    throw new PingoFontLoadError("decode-failed", "failed to inflate WOFF table", {
      cause: error,
    });
  }
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: ((error: PingoFontLoadError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject: (error: PingoFontLoadError) => void) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort?.(
      new PingoFontLoadError("aborted", "font load was aborted", { cause: signal?.reason }),
    );
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      checkAbort(signal);
      const { done, value } = await (signal === undefined
        ? reader.read()
        : Promise.race([reader.read(), aborted]));
      if (done) break;
      if (!(value instanceof Uint8Array)) throw invalidData(`${label} emitted non-byte data`);
      total = checkedAdd(total, value.byteLength, `${label} length overflow`);
      if (total > limit) {
        throw new PingoFontLoadError(
          "response-too-large",
          `${label} exceeds the ${String(limit)} byte limit`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

interface WoffTable {
  readonly tag: number;
  readonly offset: number;
  readonly compressedLength: number;
  readonly originalLength: number;
  readonly checksum: number;
}

interface WoffHeader {
  readonly flavor: number;
  readonly totalSfntSize: number;
  readonly tables: readonly WoffTable[];
  readonly byOffset: readonly WoffTable[];
}

function preflightWoff(input: Uint8Array): WoffHeader {
  if (input.byteLength < WOFF_HEADER_BYTES) throw invalidData("truncated WOFF header");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint32(0) !== tag("wOFF")) throw invalidData("invalid WOFF signature");
  const flavor = view.getUint32(4);
  if (!isSfntFlavor(flavor)) throw invalidData("WOFF flavor is not a supported SFNT");
  if (view.getUint32(8) !== input.byteLength) throw invalidData("WOFF length does not match input");
  const tableCount = view.getUint16(12);
  if (tableCount === 0 || tableCount > MAX_FONT_TABLES) {
    throw invalidData("WOFF table count is outside the supported limit");
  }
  if (view.getUint16(14) !== 0) throw invalidData("WOFF reserved field must be zero");
  const directoryEnd = checkedAdd(
    WOFF_HEADER_BYTES,
    checkedMultiply(tableCount, WOFF_TABLE_BYTES, "WOFF directory length overflow"),
    "WOFF directory length overflow",
  );
  if (directoryEnd > input.byteLength) throw invalidData("truncated WOFF table directory");
  const totalSfntSize = view.getUint32(16);
  if (totalSfntSize > MAX_FONT_BYTES || totalSfntSize % 4 !== 0) {
    throw invalidData("WOFF decoded size exceeds the aligned font limit");
  }

  const tables: WoffTable[] = [];
  const tags = new Set<number>();
  let expectedSfntSize = SFNT_HEADER_BYTES + SFNT_TABLE_BYTES * tableCount;
  let previousTag = -1;
  for (let index = 0; index < tableCount; index += 1) {
    const record = WOFF_HEADER_BYTES + index * WOFF_TABLE_BYTES;
    const table: WoffTable = {
      tag: view.getUint32(record),
      offset: view.getUint32(record + 4),
      compressedLength: view.getUint32(record + 8),
      originalLength: view.getUint32(record + 12),
      checksum: view.getUint32(record + 16),
    };
    if (table.tag <= previousTag || tags.has(table.tag)) {
      throw invalidData("WOFF table directory must contain unique ascending tags");
    }
    if (
      table.offset % 4 !== 0 ||
      table.offset < directoryEnd ||
      table.originalLength === 0 ||
      table.compressedLength === 0 ||
      table.compressedLength > table.originalLength
    ) {
      throw invalidData("WOFF table has invalid offset or length");
    }
    const dataEnd = checkedAdd(table.offset, table.compressedLength, "WOFF table range overflow");
    if (dataEnd > input.byteLength) throw invalidData("WOFF table extends beyond input");
    expectedSfntSize = checkedAdd(
      expectedSfntSize,
      align4(table.originalLength),
      "WOFF decoded size overflow",
    );
    previousTag = table.tag;
    tags.add(table.tag);
    tables.push(table);
  }
  if (expectedSfntSize !== totalSfntSize) throw invalidData("WOFF totalSfntSize is incorrect");

  const byOffset = [...tables].sort((left, right) => left.offset - right.offset);
  let cursor = directoryEnd;
  for (const table of byOffset) {
    if (table.offset !== cursor) throw invalidData("WOFF tables contain a gap or overlap");
    const dataEnd = table.offset + table.compressedLength;
    const paddedEnd = align4(dataEnd);
    if (paddedEnd > input.byteLength || input.subarray(dataEnd, paddedEnd).some(Boolean)) {
      throw invalidData("WOFF table padding must be zero");
    }
    cursor = paddedEnd;
  }
  validateOptionalBlocks(input, view, cursor);
  return { flavor, totalSfntSize, tables, byOffset };
}

function validateOptionalBlocks(input: Uint8Array, view: DataView, firstOffset: number): void {
  const metadataOffset = view.getUint32(24);
  const metadataLength = view.getUint32(28);
  const metadataOriginalLength = view.getUint32(32);
  const privateOffset = view.getUint32(36);
  const privateLength = view.getUint32(40);
  const hasMetadata = metadataOffset !== 0 || metadataLength !== 0 || metadataOriginalLength !== 0;
  const hasPrivate = privateOffset !== 0 || privateLength !== 0;
  let cursor = firstOffset;
  if (hasMetadata) {
    if (
      metadataOffset !== cursor ||
      metadataOffset % 4 !== 0 ||
      metadataLength === 0 ||
      metadataOriginalLength === 0
    ) {
      throw invalidData("WOFF metadata fields are inconsistent");
    }
    const end = checkedAdd(metadataOffset, metadataLength, "WOFF metadata range overflow");
    const paddedEnd = align4(end);
    if (paddedEnd > input.byteLength || input.subarray(end, paddedEnd).some(Boolean)) {
      throw invalidData("WOFF metadata range or padding is invalid");
    }
    cursor = paddedEnd;
  }
  if (hasPrivate) {
    if (privateOffset !== cursor || privateOffset % 4 !== 0 || privateLength === 0) {
      throw invalidData("WOFF private-data fields are inconsistent");
    }
    cursor = checkedAdd(privateOffset, privateLength, "WOFF private-data range overflow");
  }
  if (cursor !== input.byteLength) throw invalidData("WOFF contains unreferenced trailing data");
}

function preflightWoff2(input: Uint8Array): void {
  if (input.byteLength < 20) throw invalidData("truncated WOFF2 header");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint32(0) !== tag("wOF2")) throw invalidData("invalid WOFF2 signature");
  if (!isSfntFlavor(view.getUint32(4)) && view.getUint32(4) !== tag("ttcf")) {
    throw invalidData("WOFF2 flavor is not a supported SFNT");
  }
  if (view.getUint32(8) !== input.byteLength)
    throw invalidData("WOFF2 length does not match input");
  const tableCount = view.getUint16(12);
  if (tableCount === 0 || tableCount > MAX_FONT_TABLES) {
    throw invalidData("WOFF2 table count is outside the supported limit");
  }
  const totalSfntSize = view.getUint32(16);
  if (totalSfntSize === 0 || totalSfntSize > MAX_FONT_BYTES) {
    throw invalidData("WOFF2 decoded size exceeds the font limit");
  }
}

async function defaultWoff2Decoder(input: Uint8Array): Promise<Uint8Array> {
  const { default: decompress } = await import("woff2-encoder/decompress");
  return decompress(input);
}

function repairChecksumAdjustment(
  output: Uint8Array,
  tables: readonly WoffTable[],
  offsets: ReadonlyMap<number, number>,
): void {
  const head = tables.find((table) => table.tag === tag("head"));
  if (head === undefined || head.originalLength < 12) return;
  const offset = required(offsets.get(head.tag), "head table offset");
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint32(offset + 8, 0);
  view.setUint32(offset + 8, (CHECKSUM_MAGIC - sfntChecksum(output)) >>> 0);
}

function sfntChecksum(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let checksum = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    checksum = (checksum + view.getUint32(offset)) >>> 0;
  }
  return checksum;
}

function fontFormat(bytes: Uint8Array): "sfnt" | "woff" | "woff2" | "unknown" {
  if (bytes.byteLength < 4) return "unknown";
  const signature = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (isSfntFlavor(signature) || signature === tag("ttcf")) return "sfnt";
  if (signature === tag("wOFF")) return "woff";
  if (signature === tag("wOF2")) return "woff2";
  return "unknown";
}

function isSfntFlavor(value: number): boolean {
  return (
    value === 0x0001_0000 || value === tag("OTTO") || value === tag("true") || value === tag("typ1")
  );
}

function copyBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  return input instanceof ArrayBuffer
    ? new Uint8Array(input.slice(0))
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new PingoFontLoadError("aborted", "font load was aborted", { cause: signal.reason });
  }
}

function enforceSourceLimit(length: number): void {
  if (length === 0) throw invalidData("font source is empty");
  if (length > MAX_FONT_BYTES) {
    throw new PingoFontLoadError(
      "response-too-large",
      `font source exceeds the ${String(MAX_FONT_BYTES)} byte limit`,
    );
  }
}

function checkedAdd(left: number, right: number, message: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw invalidData(message);
  return result;
}

function checkedMultiply(left: number, right: number, message: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw invalidData(message);
  return result;
}

function align4(value: number): number {
  return checkedAdd(value, 3, "font alignment overflow") & ~3;
}

function tag(value: string): number {
  return (
    (((value.charCodeAt(0) << 24) >>> 0) |
      (value.charCodeAt(1) << 16) |
      (value.charCodeAt(2) << 8) |
      value.charCodeAt(3)) >>>
    0
  );
}

function invalidData(message: string): PingoFontLoadError {
  return new PingoFontLoadError("invalid-data", message);
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw invalidData(`missing ${label}`);
  return value;
}
