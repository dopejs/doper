import {
  EVENT_TRANSACTIONS_MAGIC,
  EVENT_TRANSACTION_LAYOUTS,
  EventTransactionOpcode,
  INSTRUCTION_FLAG_MASK,
  INSTRUCTION_FLAG_OPTIONAL,
  INSTRUCTION_HEADER_BYTES,
  INSTRUCTION_LENGTH_ESCAPE,
  MINIMUM_READABLE_ABI_VERSION,
  MAX_EVENT_TRANSACTIONS_BYTES,
  MAX_EVENT_TRANSACTION_INSTRUCTIONS,
  MAX_RESOURCE_BYTES,
  PROTOCOL_ALIGNMENT,
  STREAM_HEADER_BYTES,
} from "./generated";
import type { InputEventKind, InputPointerType } from "./input-stream";

export type EventCursor =
  "auto" | "crosshair" | "default" | "grab" | "grabbing" | "not-allowed" | "pointer" | "text";

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
  readonly relatedTarget: number | null;
  readonly pointerType: InputPointerType;
  readonly isPrimary: boolean;
  readonly pressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly width: number;
  readonly height: number;
  readonly cursor: EventCursor;
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
  // Newer producers stay readable through the self-describing instruction
  // framing; anything older than it cannot be stepped through safely.
  if (reader.u16() < MINIMUM_READABLE_ABI_VERSION)
    fail("unsupported event transaction ABI version");
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
    const header = reader.instruction();
    if (header.opcode !== Number(EventTransactionOpcode.Event)) {
      // Skipping is the producer's call: an unmarked unknown instruction is
      // still fatal, because losing it could change what the stream means.
      if (!header.optional) fail("unknown event transaction opcode");
      reader.seekTo(header.end);
      continue;
    }
    events.push(decodeEvent(reader));
    const consumed = reader.offset - offset;
    if (
      consumed < EVENT_TRANSACTION_LAYOUTS[EventTransactionOpcode.Event].minimumBytes ||
      consumed % 4 !== 0
    ) {
      fail("event transaction instruction has invalid length");
    }
    if (reader.offset !== header.end) fail("instruction length does not match its payload");
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
  const relatedTargetRaw = reader.u32();
  const pointerType = pointerTypeName(reader.u8());
  const isPrimary = booleanByte(reader.u8(), "primary pointer flag");
  reader.zeroes(2);
  const pressure = reader.f32();
  const tiltX = reader.f32();
  const tiltY = reader.f32();
  const width = reader.f32();
  const height = reader.f32();
  const cursor = cursorName(reader.u16());
  reader.zeroes(2);
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
  const pointerEvent = isPointerEventKind(kind);
  if (pointerEvent !== (pointerId !== 0 && pointerType !== "none")) {
    fail("event transaction pointer identity and type are inconsistent");
  }
  if (pressure < 0 || pressure > 1) fail("event transaction pressure is outside 0..=1");
  if (tiltX < -90 || tiltX > 90 || tiltY < -90 || tiltY > 90) {
    fail("event transaction tilt is outside -90..=90");
  }
  if (width < 0 || width > 1_000_000 || height < 0 || height > 1_000_000) {
    fail("event transaction contact size is invalid");
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
    relatedTarget: relatedTargetRaw === 0xffff_ffff ? null : relatedTargetRaw,
    pointerType,
    isPrimary,
    pressure,
    tiltX,
    tiltY,
    width,
    height,
    cursor,
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
    case 7:
      return "pointerover";
    case 8:
      return "pointerout";
    case 9:
      return "pointerenter";
    case 10:
      return "pointerleave";
    case 11:
      return "gotpointercapture";
    case 12:
      return "lostpointercapture";
    case 13:
      return "focus";
    case 14:
      return "blur";
    case 15:
      return "focusin";
    case 16:
      return "focusout";
    default:
      return fail("unknown event transaction kind");
  }
}

function pointerTypeName(value: number): InputPointerType {
  switch (value) {
    case 0:
      return "none";
    case 1:
      return "mouse";
    case 2:
      return "pen";
    case 3:
      return "touch";
    default:
      return fail("unknown event transaction pointer type");
  }
}

function cursorName(value: number): EventCursor {
  switch (value) {
    case 2:
      return "auto";
    case 13:
      return "crosshair";
    case 14:
      return "default";
    case 21:
      return "grab";
    case 22:
      return "grabbing";
    case 30:
      return "not-allowed";
    case 34:
      return "pointer";
    case 49:
      return "text";
    default:
      return fail("unknown event transaction cursor");
  }
}

function booleanByte(value: number, label: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  return fail(`${label} is invalid`);
}

function isPointerEventKind(kind: InputEventKind): boolean {
  return (
    kind === "pointerdown" ||
    kind === "pointerup" ||
    kind === "pointermove" ||
    kind === "pointercancel" ||
    kind === "pointerover" ||
    kind === "pointerout" ||
    kind === "pointerenter" ||
    kind === "pointerleave" ||
    kind === "gotpointercapture" ||
    kind === "lostpointercapture"
  );
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
    if (end > this.#bytes.byteLength) fail("instruction length runs past the stream");
    return { opcode, optional: (flags & INSTRUCTION_FLAG_OPTIONAL) !== 0, end };
  }

  /** Moves the cursor forward to an instruction boundary. */
  public seekTo(offset: number): void {
    if (offset < this.#offset || offset > this.#bytes.byteLength) fail("invalid instruction skip");
    this.#offset = offset;
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
