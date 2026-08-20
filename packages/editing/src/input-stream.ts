import {
  ABI_VERSION,
  INPUT_LAYOUTS,
  INPUT_MAGIC,
  INSTRUCTION_FLAG_MASK,
  INSTRUCTION_FLAG_OPTIONAL,
  INSTRUCTION_HEADER_BYTES,
  INSTRUCTION_LENGTH_ESCAPE,
  MINIMUM_READABLE_ABI_VERSION,
  InputOpcode,
  MAX_INPUT_BYTES,
  MAX_INPUT_INSTRUCTIONS,
  MAX_WORD_BOUNDARIES,
  MAX_RESOURCE_BYTES,
  PROTOCOL_ALIGNMENT,
  STREAM_HEADER_BYTES,
} from "./generated";

const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const MAX_SCROLL_DELTA = 1_000_000;
const MAX_SCROLL_DELTA_MICROS = 1_000_000;

/**
 * Marks a wheel sample as a high-precision delta such as a trackpad gesture.
 *
 * High-precision deltas are already smooth and already carry platform momentum,
 * so Core applies them one-to-one. Samples without this bit are discrete wheel
 * notches, which browsers animate rather than jump.
 */
export const EVENT_FLAG_PRECISE_WHEEL = 1;

/** Every event flag bit defined by this ABI version. */
export const EVENT_FLAG_MASK = EVENT_FLAG_PRECISE_WHEEL;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Visual edge preference at a browser-facing UTF-16 position. */
export enum InputAffinity {
  Upstream = 0,
  Downstream = 1,
}

const INPUT_AFFINITIES = new Set<number>([InputAffinity.Upstream, InputAffinity.Downstream]);

/** One UTF-16 offset and visual affinity. */
export interface InputPosition {
  readonly offset: number;
  readonly affinity: InputAffinity;
}

/** Directed anchor/focus selection. */
export interface InputSelection {
  readonly anchor: InputPosition;
  readonly focus: InputPosition;
}

/** Keyboard caret movement direction resolved by Core text layout. */
export type CaretMoveDirection = "backward" | "down" | "forward" | "lineEnd" | "lineStart" | "up";

/** Horizontal caret movement granularity. */
export type CaretMoveGranularity = "grapheme" | "word";

export type InputEventKind =
  "click" | "pointercancel" | "pointerdown" | "pointermove" | "pointerup" | "wheel";

interface InputTarget {
  readonly nodeId: number;
  readonly baseRevision: bigint;
}

/** Browser-independent editing or direct-manipulation command. */
export type InputCommand =
  | (InputTarget & {
      readonly type: "replace";
      readonly start: number;
      readonly end: number;
      readonly text: string;
    })
  | (InputTarget & { readonly type: "insert"; readonly text: string })
  | (InputTarget & { readonly type: "deleteBackward" })
  | (InputTarget & { readonly type: "deleteForward" })
  | (InputTarget & { readonly type: "setSelection"; readonly selection: InputSelection })
  | (InputTarget & { readonly type: "beginComposition" })
  | (InputTarget & { readonly type: "updateComposition"; readonly text: string })
  | (InputTarget & { readonly type: "commitComposition"; readonly text?: string })
  | (InputTarget & { readonly type: "cancelComposition" })
  | (InputTarget & { readonly type: "undo" })
  | (InputTarget & { readonly type: "redo" })
  | { readonly type: "focusEditable"; readonly nodeId: number }
  | { readonly type: "blurEditable"; readonly nodeId: number }
  | {
      readonly type: "requestCharacterBounds";
      readonly nodeId: number;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly type: "placeCaret";
      readonly nodeId: number;
      readonly x: number;
      readonly y: number;
      readonly extend: boolean;
      readonly word: boolean;
    }
  | {
      /**
       * Dictionary word boundaries for the value a following word operation
       * will act on.
       *
       * UAX #29 has no dictionary, so Core alone makes every Han ideograph its
       * own word and a double click selects one character. `baseRevision` is the
       * session revision these describe; Core ignores a stale one rather than
       * selecting against text the user has already changed.
       */
      readonly type: "setWordBoundaries";
      readonly nodeId: number;
      readonly baseRevision: bigint;
      readonly boundaries: readonly number[];
    }
  | {
      readonly type: "moveCaret";
      readonly nodeId: number;
      readonly direction: CaretMoveDirection;
      readonly granularity: CaretMoveGranularity;
      readonly extend: boolean;
    }
  | { readonly type: "scrollBegin"; readonly nodeId: number }
  | {
      readonly type: "scrollDelta";
      readonly nodeId: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly elapsedMicros: number;
    }
  | { readonly type: "scrollEnd"; readonly nodeId: number }
  | { readonly type: "scrollCancel"; readonly nodeId: number }
  | {
      readonly type: "setScrollVelocity";
      readonly nodeId: number;
      readonly velocityX: number;
      readonly velocityY: number;
    }
  | {
      readonly type: "dispatchEvent";
      readonly eventId: number;
      readonly kind: InputEventKind;
      /** Event source bits; see {@link EVENT_FLAG_PRECISE_WHEEL}. */
      readonly flags: number;
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly buttons: number;
      readonly modifiers: number;
      readonly pointerId: number;
      readonly elapsedMicros: number;
    };

/** Complete ordered transaction; Commit is encoded automatically. */
export interface InputBatch {
  readonly frameSeq: number;
  readonly commands: readonly InputCommand[];
}

/** Deterministic Input Stream contract violation. */
export class InputStreamError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InputStreamError";
  }
}

/** Encodes one canonical little-endian Input Stream transaction. */
export function encodeInputBatch(batch: InputBatch): Uint8Array {
  assertU32(batch.frameSeq, "frameSeq");
  if (batch.commands.length + 1 > MAX_INPUT_INSTRUCTIONS) {
    fail("input instruction count exceeds limit");
  }
  const writer = new ByteWriter();
  writer.u32(INPUT_MAGIC);
  writer.u16(ABI_VERSION);
  writer.u16(STREAM_HEADER_BYTES);
  writer.u32(0);
  writer.u32(0);
  for (const command of batch.commands) encodeCommand(writer, command);
  writer.instruction(InputOpcode.Commit);
  writer.u32(batch.frameSeq);
  const bytes = writer.finish();
  if (bytes.byteLength > MAX_INPUT_BYTES) fail("input stream exceeds maximum size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, batch.commands.length + 1, true);
  return bytes;
}

/** Decodes untrusted bytes for recording, replay, and diagnostics. */
export function decodeInputBatch(input: Uint8Array): InputBatch {
  if (input.byteLength > MAX_INPUT_BYTES) fail("input stream exceeds maximum size");
  if (input.byteLength % PROTOCOL_ALIGNMENT !== 0) fail("input stream is not aligned");
  const reader = new ByteReader(input);
  if (reader.u32() !== INPUT_MAGIC) fail("wrong input stream magic");
  // Newer producers stay readable through the self-describing instruction
  // framing; anything older than it cannot be stepped through safely.
  if (reader.u16() < MINIMUM_READABLE_ABI_VERSION) fail("unsupported input ABI version");
  if (reader.u16() !== STREAM_HEADER_BYTES) fail("invalid input header length");
  if (reader.u32() !== input.byteLength) fail("declared input length does not match input");
  const declaredCount = reader.u32();
  if (declaredCount > MAX_INPUT_INSTRUCTIONS) fail("input instruction count exceeds limit");
  if (declaredCount > Math.floor(reader.remaining / INSTRUCTION_HEADER_BYTES)) {
    fail("input instruction count cannot fit in remaining bytes");
  }
  const commands: InputCommand[] = [];
  let actualCount = 0;
  let frameSeq: number | undefined;
  while (reader.remaining > 0) {
    if (frameSeq !== undefined) fail("Commit must be the last input instruction");
    const offset = reader.offset;
    const header = reader.instruction();
    actualCount += 1;
    // Skipping is the producer's call: dropping an unmarked input command
    // could silently change what the user's gesture did.
    if (!isKnownOpcode(InputOpcode, header.opcode)) {
      if (!header.optional) fail(`unknown input opcode ${String(header.opcode)}`);
      reader.seekTo(header.end);
      continue;
    }
    const opcode = header.opcode;
    if (opcode === InputOpcode.Commit) {
      frameSeq = reader.u32();
      validateInstructionSize(opcode, offset, reader.offset);
    } else {
      commands.push(decodeCommand(reader, opcode));
      validateInstructionSize(opcode, offset, reader.offset);
    }
    if (reader.offset !== header.end) fail("instruction length does not match its payload");
  }
  if (actualCount !== declaredCount) fail("input instruction count does not match input");
  if (frameSeq === undefined) fail("input stream is missing Commit");
  return { frameSeq, commands };
}

function encodeCommand(writer: ByteWriter, command: InputCommand): void {
  const opcode = opcodeFor(command);
  writer.instruction(opcode);
  switch (command.type) {
    case "focusEditable":
    case "blurEditable":
    case "scrollBegin":
    case "scrollEnd":
    case "scrollCancel":
      assertU32(command.nodeId, "scroll nodeId");
      writer.u32(command.nodeId);
      return;
    case "scrollDelta":
      assertU32(command.nodeId, "scroll nodeId");
      assertScrollDelta(command.deltaX, "scroll deltaX");
      assertScrollDelta(command.deltaY, "scroll deltaY");
      if (
        !Number.isInteger(command.elapsedMicros) ||
        command.elapsedMicros < 1 ||
        command.elapsedMicros > MAX_SCROLL_DELTA_MICROS
      ) {
        fail("scroll delta elapsed time is invalid");
      }
      writer.u32(command.nodeId);
      writer.f32(command.deltaX);
      writer.f32(command.deltaY);
      writer.u32(command.elapsedMicros);
      return;
    case "setScrollVelocity":
      assertU32(command.nodeId, "scroll nodeId");
      assertScrollDelta(command.velocityX, "scroll velocityX");
      assertScrollDelta(command.velocityY, "scroll velocityY");
      writer.u32(command.nodeId);
      writer.f32(command.velocityX);
      writer.f32(command.velocityY);
      return;
    case "requestCharacterBounds":
      assertU32(command.nodeId, "editable nodeId");
      assertU32(command.start, "character bounds start");
      assertU32(command.end, "character bounds end");
      if (command.start > command.end) fail("character bounds range is reversed");
      writer.u32(command.nodeId);
      writer.u32(command.start);
      writer.u32(command.end);
      return;
    case "placeCaret":
      assertU32(command.nodeId, "editable nodeId");
      if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) {
        fail("caret placement coordinate is invalid");
      }
      writer.u32(command.nodeId);
      writer.f32(command.x);
      writer.f32(command.y);
      writer.u32((command.extend ? 1 : 0) | (command.word ? 2 : 0));
      return;
    case "setWordBoundaries": {
      assertU32(command.nodeId, "editable nodeId");
      if (command.boundaries.length > MAX_WORD_BOUNDARIES) fail("too many word boundaries");
      let previous = -1;
      for (const offset of command.boundaries) {
        assertU32(offset, "word boundary offset");
        // Ascending and unique keeps one segmentation one byte sequence.
        if (offset <= previous) fail("word boundaries must ascend without duplicates");
        previous = offset;
      }
      writer.u32(command.nodeId);
      writer.u32(Number(command.baseRevision & 0xffff_ffffn));
      writer.u32(Number((command.baseRevision >> 32n) & 0xffff_ffffn));
      writer.u32(command.boundaries.length);
      for (const offset of command.boundaries) writer.u32(offset);
      return;
    }
    case "moveCaret":
      assertU32(command.nodeId, "editable nodeId");
      writer.u32(command.nodeId);
      writer.u8(caretDirectionCode(command.direction));
      writer.u8(command.granularity === "word" ? 1 : 0);
      writer.u8(command.extend ? 1 : 0);
      writer.u8(0);
      return;
    case "dispatchEvent":
      assertU32(command.eventId, "eventId");
      validateEventFields(command);
      writer.u32(command.eventId);
      writer.u16(eventKindCode(command.kind));
      writer.u16(command.flags);
      writer.f32(command.x);
      writer.f32(command.y);
      writer.f32(command.deltaX);
      writer.f32(command.deltaY);
      writer.u32(command.buttons);
      writer.u32(command.modifiers);
      writer.u32(command.pointerId);
      writer.u32(command.elapsedMicros);
      return;
  }
  writer.target(command);
  switch (command.type) {
    case "replace":
      assertU32(command.start, "range start");
      assertU32(command.end, "range end");
      writer.u32(command.start);
      writer.u32(command.end);
      writer.text(command.text);
      return;
    case "insert":
    case "updateComposition":
      writer.text(command.text);
      return;
    case "setSelection":
      writer.position(command.selection.anchor);
      writer.position(command.selection.focus);
      writer.u8(command.selection.anchor.affinity);
      writer.u8(command.selection.focus.affinity);
      writer.u16(0);
      return;
    case "commitComposition":
      writer.u8(command.text === undefined ? 0 : 1);
      writer.u8(0);
      writer.u16(0);
      writer.text(command.text ?? "");
      return;
    default:
      return;
  }
}

function decodeCommand(reader: ByteReader, opcode: InputOpcode): InputCommand {
  switch (opcode) {
    case InputOpcode.Replace:
      return {
        ...reader.target(),
        type: "replace",
        start: reader.u32(),
        end: reader.u32(),
        text: reader.text(),
      };
    case InputOpcode.Insert:
      return { ...reader.target(), type: "insert", text: reader.text() };
    case InputOpcode.DeleteBackward:
      return { ...reader.target(), type: "deleteBackward" };
    case InputOpcode.DeleteForward:
      return { ...reader.target(), type: "deleteForward" };
    case InputOpcode.SetSelection: {
      const target = reader.target();
      const anchorOffset = reader.u32();
      const focusOffset = reader.u32();
      const anchorAffinity = reader.affinity();
      const focusAffinity = reader.affinity();
      reader.zeroes(2);
      return {
        ...target,
        type: "setSelection",
        selection: {
          anchor: { offset: anchorOffset, affinity: anchorAffinity },
          focus: { offset: focusOffset, affinity: focusAffinity },
        },
      };
    }
    case InputOpcode.BeginComposition:
      return { ...reader.target(), type: "beginComposition" };
    case InputOpcode.UpdateComposition:
      return { ...reader.target(), type: "updateComposition", text: reader.text() };
    case InputOpcode.CommitComposition: {
      const target = reader.target();
      const hasText = reader.u8();
      reader.zeroes(3);
      const text = reader.text();
      if (hasText === 0 && text.length === 0) return { ...target, type: "commitComposition" };
      if (hasText === 1) return { ...target, type: "commitComposition", text };
      if (hasText === 0) fail("absent composition text is non-empty");
      return fail("invalid composition text presence flag");
    }
    case InputOpcode.CancelComposition:
      return { ...reader.target(), type: "cancelComposition" };
    case InputOpcode.Undo:
      return { ...reader.target(), type: "undo" };
    case InputOpcode.Redo:
      return { ...reader.target(), type: "redo" };
    case InputOpcode.FocusEditable:
      return { type: "focusEditable", nodeId: reader.u32() };
    case InputOpcode.BlurEditable:
      return { type: "blurEditable", nodeId: reader.u32() };
    case InputOpcode.RequestCharacterBounds: {
      const nodeId = reader.u32();
      const start = reader.u32();
      const end = reader.u32();
      if (start > end) fail("character bounds range is reversed");
      return { type: "requestCharacterBounds", nodeId, start, end };
    }
    case InputOpcode.MoveCaret: {
      const nodeId = reader.u32();
      const direction = caretDirectionName(reader.u8());
      const granularityCode = reader.u8();
      if (granularityCode > 1) fail("caret movement granularity is unknown");
      const extendCode = reader.u8();
      if (extendCode > 1) fail("caret extend flag is unknown");
      if (reader.u8() !== 0) fail("caret movement padding must be zero");
      return {
        type: "moveCaret",
        nodeId,
        direction,
        granularity: granularityCode === 1 ? "word" : "grapheme",
        extend: extendCode === 1,
      };
    }
    case InputOpcode.PlaceCaret: {
      const nodeId = reader.u32();
      const x = reader.f32();
      const y = reader.f32();
      const flags = reader.u32();
      if (!Number.isFinite(x) || !Number.isFinite(y)) fail("caret placement coordinate is invalid");
      if ((flags & ~0x03) !== 0) fail("caret placement flags are reserved");
      return {
        type: "placeCaret",
        nodeId,
        x,
        y,
        extend: (flags & 1) !== 0,
        word: (flags & 2) !== 0,
      };
    }
    case InputOpcode.SetWordBoundaries: {
      const nodeId = reader.u32();
      const low = BigInt(reader.u32());
      const high = BigInt(reader.u32());
      const declared = reader.u32();
      if (declared > MAX_WORD_BOUNDARIES) fail("too many word boundaries");
      // Bound against the bytes that remain before allocating.
      if (declared > Math.floor(reader.remaining / 4)) fail("truncated input batch");
      const boundaries: number[] = [];
      let previous = -1;
      for (let index = 0; index < declared; index += 1) {
        const offset = reader.u32();
        if (offset <= previous) fail("word boundaries must ascend without duplicates");
        previous = offset;
        boundaries.push(offset);
      }
      return {
        type: "setWordBoundaries",
        nodeId,
        baseRevision: low | (high << 32n),
        boundaries: Object.freeze(boundaries),
      };
    }
    case InputOpcode.ScrollBegin:
      return { type: "scrollBegin", nodeId: reader.u32() };
    case InputOpcode.ScrollDelta: {
      const nodeId = reader.u32();
      const deltaX = reader.f32();
      const deltaY = reader.f32();
      assertScrollDelta(deltaX, "scroll deltaX");
      assertScrollDelta(deltaY, "scroll deltaY");
      const elapsedMicros = reader.u32();
      if (elapsedMicros < 1 || elapsedMicros > MAX_SCROLL_DELTA_MICROS) {
        return fail("scroll delta elapsed time is invalid");
      }
      return { type: "scrollDelta", nodeId, deltaX, deltaY, elapsedMicros };
    }
    case InputOpcode.ScrollEnd:
      return { type: "scrollEnd", nodeId: reader.u32() };
    case InputOpcode.ScrollCancel:
      return { type: "scrollCancel", nodeId: reader.u32() };
    case InputOpcode.SetScrollVelocity: {
      const nodeId = reader.u32();
      const velocityX = reader.f32();
      const velocityY = reader.f32();
      assertScrollDelta(velocityX, "scroll velocityX");
      assertScrollDelta(velocityY, "scroll velocityY");
      return { type: "setScrollVelocity", nodeId, velocityX, velocityY };
    }
    case InputOpcode.DispatchEvent: {
      const eventId = reader.u32();
      const kind = eventKind(reader.u16());
      const flags = reader.u16();
      const command = {
        type: "dispatchEvent" as const,
        eventId,
        kind,
        flags,
        x: reader.f32(),
        y: reader.f32(),
        deltaX: reader.f32(),
        deltaY: reader.f32(),
        buttons: reader.u32(),
        modifiers: reader.u32(),
        pointerId: reader.u32(),
        elapsedMicros: reader.u32(),
      };
      validateEventFields(command);
      return command;
    }
    default:
      return fail(`unexpected input opcode ${String(opcode)}`);
  }
}

function opcodeFor(command: InputCommand): InputOpcode {
  switch (command.type) {
    case "replace":
      return InputOpcode.Replace;
    case "insert":
      return InputOpcode.Insert;
    case "deleteBackward":
      return InputOpcode.DeleteBackward;
    case "deleteForward":
      return InputOpcode.DeleteForward;
    case "setSelection":
      return InputOpcode.SetSelection;
    case "beginComposition":
      return InputOpcode.BeginComposition;
    case "updateComposition":
      return InputOpcode.UpdateComposition;
    case "commitComposition":
      return InputOpcode.CommitComposition;
    case "cancelComposition":
      return InputOpcode.CancelComposition;
    case "undo":
      return InputOpcode.Undo;
    case "redo":
      return InputOpcode.Redo;
    case "focusEditable":
      return InputOpcode.FocusEditable;
    case "blurEditable":
      return InputOpcode.BlurEditable;
    case "requestCharacterBounds":
      return InputOpcode.RequestCharacterBounds;
    case "placeCaret":
      return InputOpcode.PlaceCaret;
    case "moveCaret":
      return InputOpcode.MoveCaret;
    case "setWordBoundaries":
      return InputOpcode.SetWordBoundaries;
    case "scrollBegin":
      return InputOpcode.ScrollBegin;
    case "scrollDelta":
      return InputOpcode.ScrollDelta;
    case "scrollEnd":
      return InputOpcode.ScrollEnd;
    case "scrollCancel":
      return InputOpcode.ScrollCancel;
    case "setScrollVelocity":
      return InputOpcode.SetScrollVelocity;
    case "dispatchEvent":
      return InputOpcode.DispatchEvent;
  }
}

function caretDirectionCode(direction: CaretMoveDirection): number {
  switch (direction) {
    case "backward":
      return 1;
    case "forward":
      return 2;
    case "up":
      return 3;
    case "down":
      return 4;
    case "lineStart":
      return 5;
    case "lineEnd":
      return 6;
  }
}

function caretDirectionName(code: number): CaretMoveDirection {
  switch (code) {
    case 1:
      return "backward";
    case 2:
      return "forward";
    case 3:
      return "up";
    case 4:
      return "down";
    case 5:
      return "lineStart";
    case 6:
      return "lineEnd";
    default:
      return fail("caret movement direction is unknown");
  }
}

function eventKindCode(kind: InputEventKind): number {
  switch (kind) {
    case "pointerdown":
      return 1;
    case "pointerup":
      return 2;
    case "pointermove":
      return 3;
    case "pointercancel":
      return 4;
    case "click":
      return 5;
    case "wheel":
      return 6;
  }
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
      return fail("unknown input event kind");
  }
}

function validateEventFields(
  command: Pick<
    Extract<InputCommand, { readonly type: "dispatchEvent" }>,
    | "buttons"
    | "deltaX"
    | "deltaY"
    | "elapsedMicros"
    | "flags"
    | "modifiers"
    | "pointerId"
    | "x"
    | "y"
  >,
): void {
  if (!Number.isInteger(command.flags) || command.flags < 0 || command.flags > EVENT_FLAG_MASK) {
    fail("event flags are invalid");
  }
  for (const [value, label, maximum] of [
    [command.x, "event x", 1_000_000_000],
    [command.y, "event y", 1_000_000_000],
    [command.deltaX, "event deltaX", MAX_SCROLL_DELTA],
    [command.deltaY, "event deltaY", MAX_SCROLL_DELTA],
  ] as const) {
    if (!Number.isFinite(value) || Math.abs(value) > maximum) fail(`${label} is invalid`);
  }
  if (!Number.isInteger(command.buttons) || command.buttons < 0 || command.buttons > 0xffff) {
    fail("event buttons are invalid");
  }
  if (!Number.isInteger(command.modifiers) || command.modifiers < 0 || command.modifiers > 0x0f) {
    fail("event modifiers are invalid");
  }
  assertU32(command.pointerId, "event pointerId");
  if (
    !Number.isInteger(command.elapsedMicros) ||
    command.elapsedMicros < 1 ||
    command.elapsedMicros > MAX_SCROLL_DELTA_MICROS
  ) {
    fail("event elapsed time is invalid");
  }
}

class ByteWriter {
  readonly #bytes: number[] = [];
  #instructionOpcode: InputOpcode | undefined;
  #instructionStart = 0;

  public instruction(opcode: InputOpcode): void {
    this.validateInstruction();
    this.#instructionOpcode = opcode;
    this.#instructionStart = this.#bytes.length;
    this.u8(opcode);
    this.u8(0);
    this.u16(0);
  }

  public target(target: InputTarget): void {
    assertU32(target.nodeId, "nodeId");
    assertU64(target.baseRevision, "baseRevision");
    this.u32(target.nodeId);
    this.u32(Number(target.baseRevision & 0xffff_ffffn));
    this.u32(Number(target.baseRevision >> 32n));
  }

  public position(position: InputPosition): void {
    assertU32(position.offset, "selection offset");
    assertAffinity(position.affinity);
    this.u32(position.offset);
  }

  public text(value: string): void {
    const bytes = utf8Encoder.encode(value);
    if (bytes.byteLength > MAX_RESOURCE_BYTES) fail("input text exceeds maximum size");
    this.u32(bytes.byteLength);
    this.bytes(bytes);
    this.pad();
  }

  public u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) fail("value must be a u8");
    this.#bytes.push(value);
  }

  public u16(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) fail("value must be a u16");
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }

  public u32(value: number): void {
    assertU32(value, "value");
    this.#bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }

  public f32(value: number): void {
    if (!Number.isFinite(value)) fail("value must be a finite f32");
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    this.bytes(bytes);
  }

  public bytes(value: Uint8Array): void {
    for (const byte of value) this.#bytes.push(byte);
  }

  public pad(): void {
    while (this.#bytes.length % PROTOCOL_ALIGNMENT !== 0) this.#bytes.push(0);
  }

  public finish(): Uint8Array {
    this.validateInstruction();
    if (this.#bytes.length % PROTOCOL_ALIGNMENT !== 0) fail("encoder produced misaligned input");
    return Uint8Array.from(this.#bytes);
  }

  /**
   * Closes the instruction that just ended, writing its length into the header.
   *
   * The length is unknown when the header goes out, so it is patched here and
   * no call site has to know it exists.
   */
  private validateInstruction(): void {
    if (this.#instructionOpcode === undefined) return;
    validateInstructionSize(this.#instructionOpcode, this.#instructionStart, this.#bytes.length);
    this.#instructionOpcode = undefined;
    const start = this.#instructionStart;
    const length = this.#bytes.length - start;
    const words = length / PROTOCOL_ALIGNMENT;
    if (words < INSTRUCTION_LENGTH_ESCAPE) {
      this.#bytes[start + 2] = words & 0xff;
      this.#bytes[start + 3] = (words >>> 8) & 0xff;
      return;
    }
    this.#bytes[start + 2] = INSTRUCTION_LENGTH_ESCAPE & 0xff;
    this.#bytes[start + 3] = (INSTRUCTION_LENGTH_ESCAPE >>> 8) & 0xff;
    const total = length + PROTOCOL_ALIGNMENT;
    this.#bytes.splice(
      start + INSTRUCTION_HEADER_BYTES,
      0,
      total & 0xff,
      (total >>> 8) & 0xff,
      (total >>> 16) & 0xff,
      (total >>> 24) & 0xff,
    );
  }
}

class ByteReader {
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
    if (end > this.#input.byteLength) fail("instruction length runs past the stream");
    return { opcode, optional: (flags & INSTRUCTION_FLAG_OPTIONAL) !== 0, end };
  }

  /** Moves the cursor forward to an instruction boundary. */
  public seekTo(offset: number): void {
    if (offset < this.#offset || offset > this.#input.byteLength) fail("invalid instruction skip");
    this.#offset = offset;
  }

  public target(): InputTarget {
    const nodeId = this.u32();
    const low = this.u32();
    const high = this.u32();
    return { nodeId, baseRevision: BigInt(low) | (BigInt(high) << 32n) };
  }

  public affinity(): InputAffinity {
    const value = this.u8();
    assertAffinity(value);
    return value;
  }

  public text(): string {
    const length = this.u32();
    if (length > MAX_RESOURCE_BYTES) fail("input text exceeds maximum size");
    const bytes = this.bytes(length);
    this.zeroes(padding(length));
    try {
      return utf8Decoder.decode(bytes);
    } catch (cause) {
      throw new InputStreamError("input text is not valid UTF-8", { cause });
    }
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
    if (!Number.isFinite(value)) fail("input contains a non-finite f32");
    return value;
  }

  public bytes(length: number): Uint8Array {
    this.require(length);
    const result = this.#input.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  public zeroes(length: number): void {
    if (this.bytes(length).some((byte) => byte !== 0)) fail("reserved input bytes must be zero");
  }

  private require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      fail("truncated input stream");
    }
  }
}

function validateInstructionSize(opcode: InputOpcode, offset: number, end: number): void {
  const layout = INPUT_LAYOUTS[opcode];
  const actual = end - offset;
  if (layout.fixedBytes !== null && actual !== layout.fixedBytes) {
    fail(`input opcode ${String(opcode)} consumed an invalid byte length`);
  }
  if (actual < layout.minimumBytes) fail(`input opcode ${String(opcode)} is too short`);
}

function assertAffinity(value: number): asserts value is InputAffinity {
  if (!INPUT_AFFINITIES.has(value)) {
    fail(`unknown input affinity ${String(value)}`);
  }
}

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail(`${label} must be a u32`);
  }
}

function assertU64(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    fail(`${label} must be a u64 bigint`);
  }
}

function assertScrollDelta(value: number, label: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_SCROLL_DELTA) {
    fail(`${label} exceeds the finite scroll delta bounds`);
  }
}

function padding(length: number): number {
  return (PROTOCOL_ALIGNMENT - (length % PROTOCOL_ALIGNMENT)) % PROTOCOL_ALIGNMENT;
}

function fail(message: string): never {
  throw new InputStreamError(message);
}

/** Whether an opcode byte names a member this build knows. */
function isKnownOpcode<T extends Record<string, string | number>>(
  values: T,
  value: number,
): value is T[keyof T] & number {
  return typeof values[value] === "string";
}
