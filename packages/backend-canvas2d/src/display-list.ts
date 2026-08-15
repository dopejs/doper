import {
  ABI_VERSION,
  DISPLAY_LIST_MAGIC,
  DISPLAY_LAYOUTS,
  DisplayOpcode,
  INSTRUCTION_HEADER_BYTES,
  MAX_DISPLAY_INSTRUCTIONS,
  MAX_DISPLAY_LIST_BYTES,
  PROTOCOL_ALIGNMENT,
  STREAM_HEADER_BYTES,
} from "./generated";

/** A decoded drawing command used by diagnostics and contract tests. */
export type DisplayCommand =
  | { readonly type: "save" }
  | { readonly type: "restore" }
  | { readonly type: "transform"; readonly value: readonly number[] }
  | { readonly type: "clipRect"; readonly rect: readonly number[] }
  | { readonly type: "alpha"; readonly value: number }
  | { readonly type: "fillRect"; readonly rect: readonly number[]; readonly paintId: number }
  | {
      readonly type: "fillRRect";
      readonly rect: readonly number[];
      readonly radii: readonly number[];
      readonly paintId: number;
    }
  | { readonly type: "fillPath"; readonly pathId: number; readonly paintId: number }
  | {
      readonly type: "drawGlyphRun";
      readonly fontId: number;
      readonly size: number;
      readonly origin: readonly number[];
      readonly glyphSpanId: number;
    }
  | {
      readonly type: "drawTextFallback";
      readonly stringId: number;
      readonly fontDescriptionId: number;
      readonly origin: readonly number[];
    }
  | {
      readonly type: "drawImage";
      readonly imageId: number;
      readonly source: readonly number[];
      readonly destination: readonly number[];
    }
  | {
      readonly type: "drawPicture";
      readonly pictureId: number;
      readonly offset: readonly number[];
    };

/** A fully validated and graphics-state-balanced list. */
export interface DisplayList {
  readonly commands: readonly DisplayCommand[];
}

/** A deterministic validation failure for untrusted Core output. */
export class DisplayListError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DisplayListError";
  }
}

/** Validates the entire list before returning any backend-visible command. */
export function decodeDisplayList(input: Uint8Array): DisplayList {
  const { reader, declaredCount } = readDisplayListHeader(input);
  const commands: DisplayCommand[] = [];
  let saveDepth = 0;

  while (reader.remaining > 0) {
    const offset = reader.offset;
    const opcode = reader.instruction();
    if (opcode === DisplayOpcode.Save) saveDepth += 1;
    if (opcode === DisplayOpcode.Restore) {
      if (saveDepth === 0) fail("Restore underflows the graphics-state stack");
      saveDepth -= 1;
    }
    commands.push(decodeCommand(reader, opcode));
    validateInstructionSize(opcode, offset, reader.offset);
  }
  if (commands.length !== declaredCount) fail("instruction count does not match input");
  if (saveDepth !== 0) fail("display list has unmatched Save commands");
  return { commands };
}

/** @internal Reads and validates the fixed stream envelope. */
export function readDisplayListHeader(input: Uint8Array): {
  readonly reader: DisplayListReader;
  readonly declaredCount: number;
} {
  if (input.byteLength > MAX_DISPLAY_LIST_BYTES) fail("display list exceeds maximum size");
  if (input.byteLength % PROTOCOL_ALIGNMENT !== 0) fail("display list is not four-byte aligned");
  const reader = new DisplayListReader(input);
  if (reader.u32() !== DISPLAY_LIST_MAGIC) fail("wrong display-list magic");
  if (reader.u16() !== ABI_VERSION) fail("unsupported display-list ABI version");
  if (reader.u16() !== STREAM_HEADER_BYTES) fail("invalid display-list header length");
  if (reader.u32() !== input.byteLength) fail("declared display-list length does not match input");
  const declaredCount = reader.u32();
  if (declaredCount > MAX_DISPLAY_INSTRUCTIONS)
    fail("display-list instruction count exceeds limit");
  return { reader, declaredCount };
}

function decodeCommand(reader: DisplayListReader, opcode: DisplayOpcode): DisplayCommand {
  switch (opcode) {
    case DisplayOpcode.Save:
      return { type: "save" };
    case DisplayOpcode.Restore:
      return { type: "restore" };
    case DisplayOpcode.Transform:
      return { type: "transform", value: reader.f32s(6) };
    case DisplayOpcode.ClipRect:
      return { type: "clipRect", rect: reader.f32s(4) };
    case DisplayOpcode.Alpha: {
      const value = reader.f32();
      if (value < 0 || value > 1) fail("alpha is outside the zero-to-one range");
      return { type: "alpha", value };
    }
    case DisplayOpcode.FillRect:
      return { type: "fillRect", rect: reader.f32s(4), paintId: reader.u32() };
    case DisplayOpcode.FillRRect:
      return {
        type: "fillRRect",
        rect: reader.f32s(4),
        radii: reader.f32s(4),
        paintId: reader.u32(),
      };
    case DisplayOpcode.FillPath:
      return { type: "fillPath", pathId: reader.u32(), paintId: reader.u32() };
    case DisplayOpcode.DrawGlyphRun:
      return {
        type: "drawGlyphRun",
        fontId: reader.u32(),
        size: reader.f32(),
        origin: reader.f32s(2),
        glyphSpanId: reader.u32(),
      };
    case DisplayOpcode.DrawTextFallback:
      return {
        type: "drawTextFallback",
        stringId: reader.u32(),
        fontDescriptionId: reader.u32(),
        origin: reader.f32s(2),
      };
    case DisplayOpcode.DrawImage:
      return {
        type: "drawImage",
        imageId: reader.u32(),
        source: reader.f32s(4),
        destination: reader.f32s(4),
      };
    case DisplayOpcode.DrawPicture:
      return { type: "drawPicture", pictureId: reader.u32(), offset: reader.f32s(2) };
    default:
      return fail(`unknown display-list opcode ${String(opcode)}`);
  }
}

/** @internal Allocation-free cursor over one DisplayList. */
export class DisplayListReader {
  readonly #view: DataView;
  readonly #length: number;
  #offset = 0;

  public constructor(input: Uint8Array) {
    this.#view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    this.#length = input.byteLength;
  }

  public get remaining(): number {
    return this.#length - this.#offset;
  }

  public get offset(): number {
    return this.#offset;
  }

  public instruction(): DisplayOpcode {
    if (this.#offset % PROTOCOL_ALIGNMENT !== 0) fail("instruction is not aligned");
    this.require(INSTRUCTION_HEADER_BYTES);
    const opcode = this.u8();
    const flags = this.u8();
    if (flags !== 0) fail("unsupported instruction flags");
    if (this.u16() !== 0) fail("reserved instruction bytes must be zero");
    if (typeof DisplayOpcode[opcode] !== "string") {
      fail(`unknown display-list opcode ${String(opcode)}`);
    }
    return opcode;
  }

  public u8(): number {
    this.require(1);
    return this.#view.getUint8(this.#offset++);
  }

  public u16(): number {
    this.require(2);
    const result = this.#view.getUint16(this.#offset, true);
    this.#offset += 2;
    return result;
  }

  public u32(): number {
    this.require(4);
    const result = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return result;
  }

  public f32(): number {
    this.require(4);
    const result = this.#view.getFloat32(this.#offset, true);
    this.#offset += 4;
    if (!Number.isFinite(result)) fail("display-list float must be finite");
    return result;
  }

  public f32s(count: number): number[] {
    return Array.from({ length: count }, () => this.f32());
  }

  /** @internal Validates and advances over finite float fields without allocating. */
  public skipF32(count: number): void {
    for (let index = 0; index < count; index += 1) this.f32();
  }

  private require(length: number): void {
    if (length > this.remaining) fail("truncated display list");
  }
}

function fail(message: string): never {
  throw new DisplayListError(message);
}

/** @internal Verifies a generated fixed command layout. */
export function validateInstructionSize(opcode: DisplayOpcode, offset: number, end: number): void {
  const layout = DISPLAY_LAYOUTS[opcode];
  const actual = end - offset;
  if (layout.fixedBytes !== null && actual !== layout.fixedBytes) {
    fail(
      `display-list opcode ${String(opcode)} consumed ${String(actual)} bytes, expected ${String(layout.fixedBytes)}`,
    );
  }
}
