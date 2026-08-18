import { decodeInputBatch } from "@dopejs/doper-editing";
import { decodeMutationBatch } from "@dopejs/doper-reconciler";

import { decodeSystemTextMetricBatch } from "./system-text-metrics";

import {
  ABI_VERSION,
  MAX_RECORDING_BYTES,
  MAX_RECORDING_RECORDS,
  PROTOCOL_ALIGNMENT,
  RECORD_HEADER_BYTES,
  RECORDING_MAGIC,
  RecordingRecordKind,
  STREAM_HEADER_BYTES,
  INSTRUCTION_FLAG_MASK,
  INSTRUCTION_FLAG_OPTIONAL,
  INSTRUCTION_LENGTH_ESCAPE,
  MINIMUM_READABLE_ABI_VERSION,
} from "./generated";

const MUTATION_RECORD_KIND = Number(RecordingRecordKind.Mutation);
const INPUT_RECORD_KIND = Number(RecordingRecordKind.Input);
const SYSTEM_TEXT_METRICS_RECORD_KIND = Number(RecordingRecordKind.SystemTextMetrics);

/** Explicit privacy classification required before binary data may be retained. */
export type ReplayDataClassification = "recordable" | "sensitive";

/** One exact nested stream in observed order. */
export type ReplayRecord =
  | { readonly type: "mutation"; readonly bytes: Uint8Array }
  | { readonly type: "input"; readonly bytes: Uint8Array }
  | { readonly type: "systemTextMetrics"; readonly bytes: Uint8Array };

/** A recursively validated deterministic replay recording. */
export interface ReplayRecording {
  readonly records: readonly ReplayRecord[];
}

/** Malformed, oversized, unsupported, or privacy-unsafe recording operation. */
export class ReplayRecordingError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReplayRecordingError";
  }
}

/** Encodes a canonical recording after validating every nested transaction. */
export function encodeReplayRecording(recording: ReplayRecording): Uint8Array {
  if (recording.records.length > MAX_RECORDING_RECORDS) fail("record count exceeds limit");
  let length: number = STREAM_HEADER_BYTES;
  for (const record of recording.records) {
    validateRecord(record);
    length = checkedAdd(length, RECORD_HEADER_BYTES);
    length = checkedAdd(length, record.bytes.byteLength);
    if (length > MAX_RECORDING_BYTES) fail("recording exceeds maximum size");
  }

  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  view.setUint32(0, RECORDING_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, STREAM_HEADER_BYTES, true);
  view.setUint32(8, length, true);
  view.setUint32(12, recording.records.length, true);
  let offset = STREAM_HEADER_BYTES;
  for (const record of recording.records) {
    output[offset] = kindFor(record);
    // Records carry their length like every other instruction, so a reader that
    // does not know the kind can step over one instead of refusing the file.
    const total = RECORD_HEADER_BYTES + record.bytes.byteLength;
    const words = total / PROTOCOL_ALIGNMENT;
    if (words >= INSTRUCTION_LENGTH_ESCAPE) fail("recording record is too large to frame");
    view.setUint16(offset + 2, words, true);
    view.setUint32(offset + 4, record.bytes.byteLength, true);
    offset += RECORD_HEADER_BYTES;
    output.set(record.bytes, offset);
    offset += record.bytes.byteLength;
  }
  return output;
}

/** Decodes all records and nested streams before returning any replayable data. */
export function decodeReplayRecording(input: Uint8Array): ReplayRecording {
  if (input.byteLength > MAX_RECORDING_BYTES) fail("recording exceeds maximum size");
  if (input.byteLength % PROTOCOL_ALIGNMENT !== 0) fail("recording is not aligned");
  const reader = new RecordingReader(input);
  if (reader.u32() !== RECORDING_MAGIC) fail("wrong recording magic");
  // Newer producers stay readable through the self-describing instruction
  // framing; anything older than it cannot be stepped through safely.
  if (reader.u16() < MINIMUM_READABLE_ABI_VERSION) fail("unsupported recording ABI version");
  if (reader.u16() !== STREAM_HEADER_BYTES) fail("invalid recording header length");
  if (reader.u32() !== input.byteLength) fail("declared recording length does not match input");
  const declaredCount = reader.u32();
  if (declaredCount > MAX_RECORDING_RECORDS) fail("record count exceeds limit");
  if (declaredCount > Math.floor(reader.remaining / RECORD_HEADER_BYTES)) {
    fail("record count cannot fit in remaining bytes");
  }

  const records: ReplayRecord[] = [];
  while (reader.remaining > 0) {
    const start = reader.offset;
    const kind = reader.u8();
    const flags = reader.u8();
    if ((flags & ~INSTRUCTION_FLAG_MASK) !== 0) fail("unsupported recording flags");
    // A record header now carries the instruction length like every other
    // stream, so a reader that does not know the record kind can step over it.
    const words = reader.u16();
    const total = words === INSTRUCTION_LENGTH_ESCAPE ? reader.u32() : words * PROTOCOL_ALIGNMENT;
    const length = reader.u32();
    if (length % PROTOCOL_ALIGNMENT !== 0) fail("nested stream is not aligned");
    const bytes = reader.bytes(length);
    if (reader.offset !== start + total) fail("record length does not match its payload");
    if (!(kind in RecordingRecordKind)) {
      if ((flags & INSTRUCTION_FLAG_OPTIONAL) === 0) fail("unknown recording record kind");
      continue;
    }
    const record = recordFor(kind, bytes);
    validateRecord(record);
    records.push(record);
  }
  if (records.length !== declaredCount) fail("record count does not match input");
  return { records };
}

/** Exact-order callbacks used by browser-free and incident replay tools. */
export interface ReplayHandlers {
  readonly mutation: (bytes: Uint8Array) => void;
  readonly input: (bytes: Uint8Array) => void;
  readonly systemTextMetrics: (bytes: Uint8Array) => void;
}

/** Validates then replays a complete recording in exact observed order. */
export function replayRecording(input: Uint8Array, handlers: ReplayHandlers): void {
  const recording = decodeReplayRecording(input);
  for (const record of recording.records) handlers[record.type](record.bytes.slice());
}

/** Bounded in-memory recorder that never retains explicitly sensitive transactions. */
export class BinaryReplayRecorder {
  readonly #records: ReplayRecord[] = [];
  #encodedBytes: number = STREAM_HEADER_BYTES;

  /** Number of recordable transactions retained in memory. */
  public get size(): number {
    return this.#records.length;
  }

  /** Captures one exact Mutation Stream, or safely skips sensitive content. */
  public captureMutation(bytes: Uint8Array, classification: ReplayDataClassification): boolean {
    return this.capture({ type: "mutation", bytes }, classification);
  }

  /** Captures one exact Input Stream, or safely skips password/private content. */
  public captureInput(bytes: Uint8Array, classification: ReplayDataClassification): boolean {
    return this.capture({ type: "input", bytes }, classification);
  }

  /** Captures one exact browser system-font metric cache delta. */
  public captureSystemTextMetrics(
    bytes: Uint8Array,
    classification: ReplayDataClassification,
  ): boolean {
    return this.capture({ type: "systemTextMetrics", bytes }, classification);
  }

  /** Exports a detached versioned archive without exposing retained mutable buffers. */
  public export(): Uint8Array {
    return encodeReplayRecording({ records: this.#records });
  }

  /** Removes all retained diagnostic data from this recorder. */
  public clear(): void {
    this.#records.length = 0;
    this.#encodedBytes = STREAM_HEADER_BYTES;
  }

  private capture(record: ReplayRecord, classification: ReplayDataClassification): boolean {
    if (classification === "sensitive") return false;
    if (classification !== "recordable") fail("unknown replay data classification");
    validateRecord(record);
    if (this.#records.length >= MAX_RECORDING_RECORDS) fail("record count exceeds limit");
    const nextBytes = checkedAdd(
      this.#encodedBytes,
      checkedAdd(RECORD_HEADER_BYTES, record.bytes.byteLength),
    );
    if (nextBytes > MAX_RECORDING_BYTES) fail("recording exceeds maximum size");
    this.#records.push({ ...record, bytes: record.bytes.slice() });
    this.#encodedBytes = nextBytes;
    return true;
  }
}

class RecordingReader {
  readonly #input: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  public constructor(input: Uint8Array) {
    this.#input = input;
    this.#view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  }

  public get remaining(): number {
    return this.#input.byteLength - this.#offset;
  }

  public get offset(): number {
    return this.#offset;
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

  public zeroes(length: number): void {
    if (this.bytes(length).some((byte) => byte !== 0))
      fail("reserved recording bytes must be zero");
  }

  public bytes(length: number): Uint8Array {
    this.require(length);
    const result = this.#input.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  private require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      fail("truncated recording");
    }
  }
}

function validateRecord(record: ReplayRecord): void {
  try {
    if (record.type === "mutation") decodeMutationBatch(record.bytes);
    else if (record.type === "input") decodeInputBatch(record.bytes);
    else decodeSystemTextMetricBatch(record.bytes);
  } catch (cause) {
    throw new ReplayRecordingError(`invalid nested ${record.type} stream`, { cause });
  }
}

function kindFor(record: ReplayRecord): RecordingRecordKind {
  if (record.type === "mutation") return RecordingRecordKind.Mutation;
  if (record.type === "input") return RecordingRecordKind.Input;
  return RecordingRecordKind.SystemTextMetrics;
}

function recordFor(kind: number, bytes: Uint8Array): ReplayRecord {
  if (kind === MUTATION_RECORD_KIND) return { type: "mutation", bytes };
  if (kind === INPUT_RECORD_KIND) return { type: "input", bytes };
  if (kind === SYSTEM_TEXT_METRICS_RECORD_KIND) return { type: "systemTextMetrics", bytes };
  return fail(`unknown recording record kind ${String(kind)}`);
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail("recording size overflow");
  return result;
}

function fail(message: string): never {
  throw new ReplayRecordingError(message);
}
