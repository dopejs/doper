import { decodeDisplayList } from "./display-list";
import {
  ABI_VERSION,
  INSTRUCTION_FLAG_MASK,
  INSTRUCTION_FLAG_OPTIONAL,
  INSTRUCTION_HEADER_BYTES,
  INSTRUCTION_LENGTH_ESCAPE,
  MAX_PICTURE_RESOURCE_INSTRUCTIONS,
  MAX_PICTURE_RESIDENT_BYTES,
  MAX_PICTURE_RESOURCES_BYTES,
  MAX_RESOURCE_BYTES,
  MINIMUM_READABLE_ABI_VERSION,
  PICTURE_RESOURCE_LAYOUTS,
  PICTURE_RESOURCES_MAGIC,
  PROTOCOL_ALIGNMENT,
  PictureResourceOpcode,
  STREAM_HEADER_BYTES,
} from "./generated";

/** Fully validated immutable Picture lifecycle delta. */
export type PictureResourceDelta =
  | { readonly type: "define"; readonly pictureId: number; readonly bytes: Uint8Array }
  | { readonly type: "release"; readonly pictureId: number };

/** Deterministic failure raised before backend registry state changes. */
export class PictureResourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PictureResourceError";
  }
}

/** Decodes a complete batch and recursively validates every nested DisplayList. */
export function decodePictureResourceBatch(input: Uint8Array): readonly PictureResourceDelta[] {
  if (input.byteLength > MAX_PICTURE_RESOURCES_BYTES) fail("picture batch exceeds maximum size");
  if (input.byteLength % PROTOCOL_ALIGNMENT !== 0) fail("picture batch is not aligned");
  const reader = new Reader(input);
  if (reader.u32() !== PICTURE_RESOURCES_MAGIC) fail("wrong picture-resource magic");
  if (reader.u16() < MINIMUM_READABLE_ABI_VERSION) fail("unsupported picture-resource ABI version");
  if (reader.u16() !== STREAM_HEADER_BYTES) fail("invalid picture-resource header length");
  if (reader.u32() !== input.byteLength) fail("picture-resource length does not match input");
  const declaredCount = reader.u32();
  if (declaredCount > MAX_PICTURE_RESOURCE_INSTRUCTIONS)
    fail("picture-resource instruction count exceeds limit");
  if (declaredCount > Math.floor(reader.remaining / 8))
    fail("picture-resource count cannot fit in the remaining bytes");

  const deltas: PictureResourceDelta[] = [];
  const seen = new Set<number>();
  let payloadTotal = 0;
  let actualCount = 0;
  while (reader.remaining > 0) {
    const start = reader.offset;
    const header = reader.instruction();
    actualCount += 1;
    if (!isKnownOpcode(PictureResourceOpcode, header.opcode)) {
      if (!header.optional) fail(`unknown picture-resource opcode ${String(header.opcode)}`);
      reader.seekTo(header.end);
      continue;
    }
    const opcode = header.opcode;
    const pictureId = nonzeroId(reader.u32());
    if (seen.has(pictureId)) fail("picture id occurs more than once in a batch");
    seen.add(pictureId);
    let delta: PictureResourceDelta;
    if (opcode === PictureResourceOpcode.DefinePicture) {
      const payloadBytes = reader.u32();
      if (payloadBytes > MAX_RESOURCE_BYTES) fail("picture payload exceeds resource limit");
      payloadTotal = checkedAdd(payloadTotal, payloadBytes);
      if (payloadTotal > MAX_PICTURE_RESIDENT_BYTES)
        fail("picture payloads exceed transaction budget");
      const bytes = reader.bytes(payloadBytes).slice();
      decodeDisplayList(bytes);
      const padding =
        (PROTOCOL_ALIGNMENT - (payloadBytes % PROTOCOL_ALIGNMENT)) % PROTOCOL_ALIGNMENT;
      for (const byte of reader.bytes(padding)) {
        if (byte !== 0) fail("picture payload padding must be zero");
      }
      delta = Object.freeze({ type: "define", pictureId, bytes });
    } else {
      delta = Object.freeze({ type: "release", pictureId });
    }
    const layout = PICTURE_RESOURCE_LAYOUTS[opcode];
    const consumed = reader.offset - start;
    if (
      consumed < layout.minimumBytes ||
      (layout.fixedBytes !== null && consumed !== layout.fixedBytes)
    ) {
      fail("picture-resource instruction length does not match schema");
    }
    if (reader.offset !== header.end) fail("instruction length does not match its payload");
    deltas.push(delta);
  }
  if (actualCount !== declaredCount) fail("picture-resource instruction count does not match");
  return Object.freeze(deltas);
}

/** Encodes canonical bytes for cross-language fixtures and contract tests. */
export function encodePictureResourceBatch(deltas: readonly PictureResourceDelta[]): Uint8Array {
  if (deltas.length > MAX_PICTURE_RESOURCE_INSTRUCTIONS)
    fail("picture-resource instruction count exceeds limit");
  const writer = new Writer();
  writer.u32(PICTURE_RESOURCES_MAGIC);
  writer.u16(ABI_VERSION);
  writer.u16(STREAM_HEADER_BYTES);
  writer.u32(0);
  writer.u32(deltas.length);
  const seen = new Set<number>();
  let payloadTotal = 0;
  for (const delta of deltas) {
    const pictureId = nonzeroId(delta.pictureId);
    if (seen.has(pictureId)) fail("picture id occurs more than once in a batch");
    seen.add(pictureId);
    writer.instruction(
      delta.type === "define"
        ? PictureResourceOpcode.DefinePicture
        : PictureResourceOpcode.ReleasePicture,
    );
    writer.u32(pictureId);
    if (delta.type === "define") {
      decodeDisplayList(delta.bytes);
      if (delta.bytes.byteLength > MAX_RESOURCE_BYTES)
        fail("picture payload exceeds resource limit");
      payloadTotal = checkedAdd(payloadTotal, delta.bytes.byteLength);
      if (payloadTotal > MAX_PICTURE_RESIDENT_BYTES)
        fail("picture payloads exceed transaction budget");
      writer.u32(delta.bytes.byteLength);
      writer.bytes(delta.bytes);
      writer.pad();
    }
  }
  const output = writer.finish();
  if (output.byteLength > MAX_PICTURE_RESOURCES_BYTES) fail("picture batch exceeds maximum size");
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(
    8,
    output.byteLength,
    true,
  );
  return output;
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

  public instruction(): {
    readonly opcode: number;
    readonly optional: boolean;
    readonly end: number;
  } {
    const start = this.#offset;
    if (start % PROTOCOL_ALIGNMENT !== 0) fail("picture instruction is not aligned");
    this.require(INSTRUCTION_HEADER_BYTES);
    const opcode = this.u8();
    const flags = this.u8();
    if ((flags & ~INSTRUCTION_FLAG_MASK) !== 0) fail("unsupported picture instruction flags");
    const words = this.u16();
    const length = words === INSTRUCTION_LENGTH_ESCAPE ? this.u32() : words * PROTOCOL_ALIGNMENT;
    const end = checkedAdd(start, length);
    if (length < INSTRUCTION_HEADER_BYTES || length % PROTOCOL_ALIGNMENT !== 0)
      fail("picture instruction length is invalid");
    if (end > this.#input.byteLength) fail("picture instruction runs past the stream");
    return { opcode, optional: (flags & INSTRUCTION_FLAG_OPTIONAL) !== 0, end };
  }

  public seekTo(offset: number): void {
    if (offset < this.#offset || offset > this.#input.byteLength) fail("invalid picture skip");
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
  public bytes(length: number): Uint8Array {
    this.require(length);
    const value = this.#input.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }
  private require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining)
      fail("truncated picture-resource batch");
  }
}

class Writer {
  readonly #bytes: number[] = [];
  #instructionStart: number | undefined;

  public instruction(opcode: PictureResourceOpcode): void {
    this.closeInstruction();
    this.#instructionStart = this.#bytes.length;
    this.u8(opcode);
    this.u8(0);
    this.u16(0);
  }
  public closeInstruction(): void {
    const start = this.#instructionStart;
    if (start === undefined) return;
    this.#instructionStart = undefined;
    const length = this.#bytes.length - start;
    const words = length / PROTOCOL_ALIGNMENT;
    if (words < INSTRUCTION_LENGTH_ESCAPE) {
      this.#bytes[start + 2] = words & 0xff;
      this.#bytes[start + 3] = (words >>> 8) & 0xff;
      return;
    }
    this.#bytes[start + 2] = INSTRUCTION_LENGTH_ESCAPE & 0xff;
    this.#bytes[start + 3] = (INSTRUCTION_LENGTH_ESCAPE >>> 8) & 0xff;
    const total = checkedAdd(length, PROTOCOL_ALIGNMENT);
    this.#bytes.splice(
      start + INSTRUCTION_HEADER_BYTES,
      0,
      total & 0xff,
      (total >>> 8) & 0xff,
      (total >>> 16) & 0xff,
      (total >>> 24) & 0xff,
    );
  }
  public u8(value: number): void {
    this.#bytes.push(value & 0xff);
  }
  public u16(value: number): void {
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }
  public u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) fail("value is outside u32");
    this.#bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }
  public bytes(value: Uint8Array): void {
    this.#bytes.push(...value);
  }
  public pad(): void {
    while (this.#bytes.length % PROTOCOL_ALIGNMENT !== 0) this.#bytes.push(0);
  }
  public finish(): Uint8Array {
    this.closeInstruction();
    return Uint8Array.from(this.#bytes);
  }
}

function nonzeroId(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffff_ffff)
    fail("picture id must be a non-zero u32");
  return value;
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value > 0xffff_ffff) fail("picture byte arithmetic overflow");
  return value;
}

function isKnownOpcode<T extends number>(
  values: Record<string, string | T>,
  value: number,
): value is T {
  return Object.prototype.hasOwnProperty.call(values, value);
}

function fail(message: string): never {
  throw new PictureResourceError(message);
}
