import {
  ABI_VERSION,
  EDIT_TRANSACTIONS_MAGIC,
  EDIT_TRANSACTION_LAYOUTS,
  EditTransactionOpcode,
  INSTRUCTION_HEADER_BYTES,
  MAX_EDIT_TRANSACTIONS_BYTES,
  MAX_EDIT_TRANSACTION_INSTRUCTIONS,
  MAX_RESOURCE_BYTES,
  PROTOCOL_ALIGNMENT,
  STREAM_HEADER_BYTES,
} from "./generated";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type EditAffinity = "downstream" | "upstream";
export type EditTransactionKind = "composition" | "edit" | "external" | "redo" | "undo";

export interface Utf16Range {
  readonly end: number;
  readonly start: number;
}

/** One fully validated Core-owned editing transition. */
export interface EditTransaction {
  readonly nodeId: number;
  readonly baseRevision: bigint;
  readonly revision: bigint;
  readonly delta?: { readonly range: Utf16Range; readonly text: string };
  readonly selection: {
    readonly anchor: number;
    readonly anchorAffinity: EditAffinity;
    readonly focus: number;
    readonly focusAffinity: EditAffinity;
  };
  readonly composition?: Utf16Range;
  readonly kind: EditTransactionKind;
}

export class EditTransactionDecodingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EditTransactionDecodingError";
  }
}

/** Validates an entire reverse batch before exposing any transaction. */
export function decodeEditTransactionBatch(input: Uint8Array): readonly EditTransaction[] {
  if (input.byteLength > MAX_EDIT_TRANSACTIONS_BYTES) fail("edit transaction stream is too large");
  if (input.byteLength % PROTOCOL_ALIGNMENT !== 0) fail("edit transaction stream is not aligned");
  const reader = new Reader(input);
  if (reader.u32() !== EDIT_TRANSACTIONS_MAGIC) fail("wrong edit transaction magic");
  if (reader.u16() !== ABI_VERSION) fail("unsupported edit transaction ABI version");
  if (reader.u16() !== STREAM_HEADER_BYTES) fail("invalid edit transaction header length");
  if (reader.u32() !== input.byteLength) fail("edit transaction length does not match input");
  const declared = reader.u32();
  if (declared > MAX_EDIT_TRANSACTION_INSTRUCTIONS) {
    fail("edit transaction instruction count exceeds limit");
  }
  if (declared > Math.floor(reader.remaining / EDIT_TRANSACTION_LAYOUTS[1].minimumBytes)) {
    fail("edit transaction instruction count cannot fit in input");
  }

  const transactions: EditTransaction[] = [];
  while (reader.remaining > 0) {
    const offset = reader.offset;
    const opcode = reader.instruction();
    if (opcode !== EditTransactionOpcode.Transaction) fail("unknown edit transaction opcode");
    transactions.push(decodeTransaction(reader));
    const consumed = reader.offset - offset;
    if (consumed < EDIT_TRANSACTION_LAYOUTS[opcode].minimumBytes || consumed % 4 !== 0) {
      fail("edit transaction instruction has invalid length");
    }
  }
  if (transactions.length !== declared) fail("edit transaction count does not match input");
  return transactions;
}

function decodeTransaction(reader: Reader): EditTransaction {
  const nodeId = reader.u32();
  const baseRevision = reader.u64();
  const revision = reader.u64();
  if (revision <= baseRevision) fail("edit transaction revision must increase");
  const deltaRange = range(reader.u32(), reader.u32(), "delta");
  const anchor = reader.u32();
  const focus = reader.u32();
  const compositionRange = range(reader.u32(), reader.u32(), "composition");
  const kind = transactionKind(reader.u8());
  const flags = reader.u8();
  if ((flags & ~3) !== 0) fail("edit transaction flags contain reserved bits");
  const anchorAffinity = affinity(reader.u8());
  const focusAffinity = affinity(reader.u8());
  const textLength = reader.u32();
  if (textLength > MAX_RESOURCE_BYTES) fail("edit transaction delta exceeds byte limit");
  const text = reader.utf8(textLength);
  const hasDelta = (flags & 1) !== 0;
  const hasComposition = (flags & 2) !== 0;
  if (!hasDelta && (text !== "" || deltaRange.start !== 0 || deltaRange.end !== 0)) {
    fail("absent edit delta has a payload");
  }
  if (!hasComposition && (compositionRange.start !== 0 || compositionRange.end !== 0)) {
    fail("absent composition has a range");
  }
  return {
    nodeId,
    baseRevision,
    revision,
    ...(hasDelta ? { delta: { range: deltaRange, text } } : {}),
    selection: { anchor, anchorAffinity, focus, focusAffinity },
    ...(hasComposition ? { composition: compositionRange } : {}),
    kind,
  };
}

function range(start: number, end: number, label: string): Utf16Range {
  if (start > end) fail(`${label} range is reversed`);
  return { start, end };
}

function affinity(value: number): EditAffinity {
  if (value === 0) return "upstream";
  if (value === 1) return "downstream";
  return fail("unknown edit affinity");
}

function transactionKind(value: number): EditTransactionKind {
  switch (value) {
    case 1:
      return "edit";
    case 2:
      return "composition";
    case 3:
      return "undo";
    case 4:
      return "redo";
    case 5:
      return "external";
    default:
      return fail("unknown edit transaction kind");
  }
}

class Reader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  public constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  public get offset(): number {
    return this.#offset;
  }

  public get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  public instruction(): EditTransactionOpcode {
    if (this.#offset % PROTOCOL_ALIGNMENT !== 0) fail("edit transaction instruction is unaligned");
    this.require(INSTRUCTION_HEADER_BYTES);
    const opcode = this.u8();
    if (this.u8() !== 0) fail("edit transaction instruction flags are unsupported");
    if (this.u16() !== 0) fail("edit transaction reserved bytes must be zero");
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

  public u64(): bigint {
    return BigInt(this.u32()) | (BigInt(this.u32()) << 32n);
  }

  public utf8(length: number): string {
    this.require(length);
    const start = this.#offset;
    this.#offset += length;
    let result: string;
    try {
      result = utf8Decoder.decode(this.#bytes.subarray(start, this.#offset));
    } catch {
      return fail("edit transaction delta is not UTF-8");
    }
    const padding = (PROTOCOL_ALIGNMENT - (length % PROTOCOL_ALIGNMENT)) % PROTOCOL_ALIGNMENT;
    this.require(padding);
    for (let index = 0; index < padding; index += 1) {
      if (this.#bytes[this.#offset++] !== 0) fail("edit transaction padding must be zero");
    }
    return result;
  }

  private require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      fail("truncated edit transaction stream");
    }
  }
}

function fail(message: string): never {
  throw new EditTransactionDecodingError(message);
}
