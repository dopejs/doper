import {
  ABI_VERSION,
  EVENT_TRANSACTIONS_MAGIC,
  EVENT_TRANSACTION_LAYOUTS,
  EventTransactionOpcode,
  INSTRUCTION_HEADER_BYTES,
  MAX_EVENT_TRANSACTIONS_BYTES,
  MAX_EVENT_TRANSACTION_INSTRUCTIONS,
  MAX_RESOURCE_BYTES,
  PROTOCOL_ALIGNMENT,
  STREAM_HEADER_BYTES,
} from "./generated";
import type { InputEventKind } from "./input-stream";

export interface EventTransaction {
  readonly eventId: number;
  readonly kind: InputEventKind;
  readonly target: number;
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly buttons: number;
  readonly modifiers: number;
  readonly pointerId: number;
  readonly elapsedMicros: number;
  readonly path: readonly number[];
}

export class EventTransactionDecodingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EventTransactionDecodingError";
  }
}

/** Validates a complete Core hit-result batch before exposing any callback path. */
export function decodeEventTransactionBatch(input: Uint8Array): readonly EventTransaction[] {
  if (input.byteLength > MAX_EVENT_TRANSACTIONS_BYTES)
    fail("event transaction stream is too large");
  if (input.byteLength % PROTOCOL_ALIGNMENT !== 0) fail("event transaction stream is not aligned");
  const reader = new Reader(input);
  if (reader.u32() !== EVENT_TRANSACTIONS_MAGIC) fail("wrong event transaction magic");
  if (reader.u16() !== ABI_VERSION) fail("unsupported event transaction ABI version");
  if (reader.u16() !== STREAM_HEADER_BYTES) fail("invalid event transaction header length");
  if (reader.u32() !== input.byteLength) fail("event transaction length does not match input");
  const declared = reader.u32();
  if (declared > MAX_EVENT_TRANSACTION_INSTRUCTIONS) {
    fail("event transaction instruction count exceeds limit");
  }
  if (declared > Math.floor(reader.remaining / EVENT_TRANSACTION_LAYOUTS[1].minimumBytes)) {
    fail("event transaction instruction count cannot fit in input");
  }
  const events: EventTransaction[] = [];
  while (reader.remaining > 0) {
    const offset = reader.offset;
    const opcode = reader.instruction();
    if (opcode !== EventTransactionOpcode.Event) fail("unknown event transaction opcode");
    events.push(decodeEvent(reader));
    const consumed = reader.offset - offset;
    if (consumed < EVENT_TRANSACTION_LAYOUTS[opcode].minimumBytes || consumed % 4 !== 0) {
      fail("event transaction instruction has invalid length");
    }
  }
  if (events.length !== declared) fail("event transaction count does not match input");
  return events;
}

function decodeEvent(reader: Reader): EventTransaction {
  const eventId = reader.u32();
  const kind = eventKind(reader.u16());
  reader.zeroes(2);
  const target = reader.u32();
  const x = reader.f32();
  const y = reader.f32();
  const deltaX = reader.f32();
  const deltaY = reader.f32();
  const buttons = reader.u32();
  const modifiers = reader.u32();
  const pointerId = reader.u32();
  const elapsedMicros = reader.u32();
  const pathCount = reader.u32();
  if (
    pathCount > Math.floor(MAX_RESOURCE_BYTES / 4) ||
    pathCount > Math.floor(reader.remaining / 4)
  ) {
    fail("event transaction path exceeds its byte envelope");
  }
  const path = Array.from({ length: pathCount }, () => reader.u32());
  if (path.length === 0 || target === 0xffff_ffff || path.at(-1) !== target) {
    fail("event transaction path does not end at its target");
  }
  if (new Set(path).size !== path.length || path.includes(0xffff_ffff)) {
    fail("event transaction path contains a null or repeated node");
  }
  if (buttons > 0xffff || modifiers > 0x0f) fail("event transaction flag bits are reserved");
  if (elapsedMicros < 1 || elapsedMicros > 1_000_000) {
    fail("event transaction elapsed time is invalid");
  }
  return {
    eventId,
    kind,
    target,
    x,
    y,
    deltaX,
    deltaY,
    buttons,
    modifiers,
    pointerId,
    elapsedMicros,
    path,
  };
}

function eventKind(value: number): InputEventKind {
  switch (value) {
    case 1:
      return "pointerdown";
    case 2:
      return "pointerup";
    case 3:
      return "pointermove";
    case 4:
      return "pointercancel";
    case 5:
      return "click";
    case 6:
      return "wheel";
    default:
      return fail("unknown event transaction kind");
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

  public instruction(): EventTransactionOpcode {
    if (this.#offset % PROTOCOL_ALIGNMENT !== 0) fail("event transaction instruction is unaligned");
    this.require(INSTRUCTION_HEADER_BYTES);
    const opcode = this.u8();
    if (this.u8() !== 0) fail("event transaction instruction flags are unsupported");
    if (this.u16() !== 0) fail("event transaction reserved bytes must be zero");
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
    if (!Number.isFinite(value)) fail("event transaction float is not finite");
    return value;
  }

  public zeroes(length: number): void {
    this.require(length);
    for (let index = 0; index < length; index += 1) {
      if (this.#bytes[this.#offset++] !== 0) fail("event transaction reserved bytes must be zero");
    }
  }

  private require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      fail("truncated event transaction stream");
    }
  }
}

function fail(message: string): never {
  throw new EventTransactionDecodingError(message);
}
