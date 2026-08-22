import {
  DISPLAY_LIST_MAGIC,
  DISPLAY_LAYOUTS,
  DisplayOpcode,
  INSTRUCTION_FLAG_MASK,
  INSTRUCTION_FLAG_OPTIONAL,
  INSTRUCTION_HEADER_BYTES,
  INSTRUCTION_LENGTH_ESCAPE,
  MINIMUM_READABLE_ABI_VERSION,
  MAX_DISPLAY_INSTRUCTIONS,
  MAX_DISPLAY_LIST_BYTES,
  MAX_RESOURCE_BYTES,
  PROTOCOL_ALIGNMENT,
  STREAM_HEADER_BYTES,
} from "./generated";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A decoded drawing command used by diagnostics and contract tests. */
export type DisplayCommand =
  | { readonly type: "save" }
  | { readonly type: "restore" }
  | { readonly type: "transform"; readonly value: readonly number[] }
  | { readonly type: "clipRect"; readonly rect: readonly number[] }
  | { readonly type: "alpha"; readonly value: number }
  | { readonly type: "fillRect"; readonly rect: readonly number[]; readonly paintId: number }
  | { readonly type: "fillColorRect"; readonly rect: readonly number[]; readonly rgba: number }
  | {
      readonly type: "fillColorRRect";
      readonly rect: readonly number[];
      readonly radii: readonly number[];
      readonly rgba: number;
    }
  | {
      readonly type: "fillColorShadow";
      /** Shadow rectangle, with CSS spread already folded in by Core. */
      readonly rect: readonly number[];
      readonly radii: readonly number[];
      readonly offset: readonly number[];
      readonly blur: number;
      readonly rgba: number;
    }
  | {
      readonly type: "fillColorBorder";
      readonly rect: readonly number[];
      readonly radii: readonly number[];
      readonly widths: readonly number[];
      readonly colors: readonly number[];
    }
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
      readonly type: "drawTextInlineFallback";
      readonly fontDescriptionId: number;
      readonly origin: readonly number[];
      readonly text: string;
    }
  | {
      /** Core-authored skeleton for a virtual item the Shell has not materialized. */
      readonly type: "fillPlaceholder";
      readonly rect: readonly number[];
      readonly rgba: number;
    }
  | {
      readonly type: "drawEditorDecoration";
      readonly rect: readonly number[];
      readonly rgba: number;
      readonly kind: "caret" | "composition" | "selection";
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
    const header = reader.instruction();
    if (!isKnownOpcode(DisplayOpcode, header.opcode)) {
      if (!header.optional) fail(`unknown display-list opcode ${String(header.opcode)}`);
      reader.seekTo(header.end);
      continue;
    }
    const opcode = header.opcode;
    if (opcode === DisplayOpcode.Save) saveDepth += 1;
    if (opcode === DisplayOpcode.Restore) {
      if (saveDepth === 0) fail("Restore underflows the graphics-state stack");
      saveDepth -= 1;
    }
    commands.push(decodeCommand(reader, opcode));
    validateInstructionSize(opcode, offset, reader.offset);
    if (reader.offset !== header.end) fail("instruction length does not match its payload");
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
  // A newer producer stays readable: every instruction carries its own length,
  // so an unknown one the producer marked optional can be stepped over. Losing a
  // draw command costs a visual detail, which is the defined downgrade.
  if (reader.u16() < MINIMUM_READABLE_ABI_VERSION) fail("unsupported display-list ABI version");
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
    case DisplayOpcode.FillColorRect: {
      const rect = reader.f32s(4);
      if ((rect[2] ?? -1) < 0 || (rect[3] ?? -1) < 0) {
        return fail("color rectangle has negative extent");
      }
      return { type: "fillColorRect", rect, rgba: reader.u32() };
    }
    case DisplayOpcode.FillColorRRect: {
      const rect = reader.f32s(4);
      const radii = reader.f32s(4);
      if ((rect[2] ?? -1) < 0 || (rect[3] ?? -1) < 0) {
        return fail("rounded color rectangle has negative extent");
      }
      if (radii.some((radius) => radius < 0)) {
        return fail("rounded color rectangle has negative radius");
      }
      return { type: "fillColorRRect", rect, radii, rgba: reader.u32() };
    }
    case DisplayOpcode.FillColorShadow: {
      const rect = reader.f32s(4);
      const radii = reader.f32s(4);
      if ((rect[2] ?? -1) < 0 || (rect[3] ?? -1) < 0) {
        return fail("shadow has negative extent");
      }
      if (radii.some((radius) => radius < 0)) return fail("shadow has negative radius");
      const offset = reader.f32s(2);
      const blur = reader.f32();
      if (blur < 0) return fail("shadow has negative blur");
      return { type: "fillColorShadow", rect, radii, offset, blur, rgba: reader.u32() };
    }
    case DisplayOpcode.FillColorBorder: {
      const rect = reader.f32s(4);
      const radii = reader.f32s(4);
      const widths = reader.f32s(4);
      if ((rect[2] ?? -1) < 0 || (rect[3] ?? -1) < 0) {
        return fail("color border has negative extent");
      }
      if (radii.some((radius) => radius < 0) || widths.some((width) => width < 0)) {
        return fail("color border has a negative radius or width");
      }
      return {
        type: "fillColorBorder",
        rect,
        radii,
        widths,
        colors: [reader.u32(), reader.u32(), reader.u32(), reader.u32()],
      };
    }
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
    case DisplayOpcode.DrawTextInlineFallback: {
      const fontDescriptionId = reader.u32();
      const origin = reader.f32s(2);
      return {
        type: "drawTextInlineFallback",
        fontDescriptionId,
        origin,
        text: reader.utf8(reader.u32()),
      };
    }
    case DisplayOpcode.FillPlaceholder: {
      const rect = reader.f32s(4);
      if ((rect[2] ?? -1) < 0 || (rect[3] ?? -1) < 0) {
        return fail("placeholder has negative extent");
      }
      return { type: "fillPlaceholder", rect, rgba: reader.u32() };
    }
    case DisplayOpcode.DrawEditorDecoration: {
      const rect = reader.f32s(4);
      if ((rect[2] ?? -1) < 0 || (rect[3] ?? -1) < 0) {
        return fail("editor decoration has negative extent");
      }
      const rgba = reader.u32();
      const rawKind = reader.u16();
      reader.zeroes(2);
      const kind =
        rawKind === 1
          ? "selection"
          : rawKind === 2
            ? "caret"
            : rawKind === 3
              ? "composition"
              : fail("unknown editor decoration kind");
      return { type: "drawEditorDecoration", rect, rgba, kind };
    }
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
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #length: number;
  #offset = 0;

  public constructor(input: Uint8Array) {
    this.#bytes = input;
    this.#view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    this.#length = input.byteLength;
  }

  public get remaining(): number {
    return this.#length - this.#offset;
  }

  public get offset(): number {
    return this.#offset;
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
    if (end > this.#length) fail("instruction length runs past the stream");
    return { opcode, optional: (flags & INSTRUCTION_FLAG_OPTIONAL) !== 0, end };
  }

  /** Moves the cursor forward to an instruction boundary. */
  public seekTo(offset: number): void {
    if (offset < this.#offset || offset > this.#length) fail("invalid instruction skip");
    this.#offset = offset;
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

  public zeroes(length: number): void {
    this.require(length);
    for (let index = 0; index < length; index += 1) {
      if (this.#bytes[this.#offset++] !== 0) fail("reserved display-list bytes must be zero");
    }
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

  /** @internal Reads bounded UTF-8 bytes and verifies zero alignment padding. */
  public utf8(length: number): string {
    if (!Number.isInteger(length) || length < 0 || length > MAX_RESOURCE_BYTES) {
      fail("inline fallback text exceeds its byte limit");
    }
    this.require(length);
    const start = this.#offset;
    this.#offset += length;
    let value: string;
    try {
      value = utf8Decoder.decode(this.#bytes.subarray(start, this.#offset));
    } catch {
      return fail("inline fallback text is not UTF-8");
    }
    const padding = (PROTOCOL_ALIGNMENT - (length % PROTOCOL_ALIGNMENT)) % PROTOCOL_ALIGNMENT;
    this.require(padding);
    for (let index = 0; index < padding; index += 1) {
      if (this.#bytes[this.#offset++] !== 0) fail("inline fallback padding must be zero");
    }
    return value;
  }

  private require(length: number): void {
    if (length > this.remaining) fail("truncated display list");
  }
}

function fail(message: string): never {
  throw new DisplayListError(message);
}

/** @internal Verifies a generated command layout. */
export function validateInstructionSize(opcode: DisplayOpcode, offset: number, end: number): void {
  const layout = DISPLAY_LAYOUTS[opcode];
  const actual = end - offset;
  if (layout.fixedBytes !== null && actual !== layout.fixedBytes) {
    fail(
      `display-list opcode ${String(opcode)} consumed ${String(actual)} bytes, expected ${String(layout.fixedBytes)}`,
    );
  }
  if (
    layout.fixedBytes === null &&
    (actual < layout.minimumBytes || actual % PROTOCOL_ALIGNMENT !== 0)
  ) {
    fail(`display-list opcode ${String(opcode)} consumed an invalid variable length`);
  }
}

/** Whether an opcode byte names a member this build knows. */
function isKnownOpcode<T extends Record<string, string | number>>(
  values: T,
  value: number,
): value is T[keyof T] & number {
  return typeof values[value] === "string";
}
