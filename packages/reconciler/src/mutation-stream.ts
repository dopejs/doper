import {
  ABI_VERSION,
  INSTRUCTION_HEADER_BYTES,
  MAX_MUTATION_BYTES,
  MAX_MUTATION_INSTRUCTIONS,
  MAX_RESOURCE_BYTES,
  MUTATION_MAGIC,
  MUTATION_LAYOUTS,
  MutationOpcode,
  NodeKind,
  PROP_METADATA,
  PROTOCOL_ALIGNMENT,
  ResourceKind,
  STREAM_HEADER_BYTES,
  VirtualAxis,
  INSTRUCTION_FLAG_MASK,
  INSTRUCTION_FLAG_OPTIONAL,
  INSTRUCTION_LENGTH_ESCAPE,
  MINIMUM_READABLE_ABI_VERSION,
} from "./generated";
import type { Prop } from "./generated";

/** Sentinel used for an absent parent or sibling. */
export { NULL_NODE_ID } from "./generated";

/** A generated, validated mutation command. */
export type Mutation =
  | {
      readonly type: "createNode";
      readonly nodeId: number;
      readonly kind: NodeKind;
      readonly parent: number;
      readonly beforeSibling: number;
    }
  | { readonly type: "removeNode"; readonly nodeId: number }
  | {
      readonly type: "reparent";
      readonly nodeId: number;
      readonly newParent: number;
      readonly beforeSibling: number;
    }
  | {
      readonly type: "setF32";
      readonly nodeId: number;
      readonly prop: Prop;
      readonly value: number;
    }
  | {
      readonly type: "setVec4";
      readonly nodeId: number;
      readonly prop: Prop;
      readonly value: readonly [number, number, number, number];
    }
  | {
      readonly type: "setRef";
      readonly nodeId: number;
      readonly prop: Prop;
      readonly resourceId: number;
    }
  | {
      readonly type: "setFlags";
      readonly nodeId: number;
      readonly set: number;
      readonly clear: number;
    }
  | { readonly type: "clearProp"; readonly nodeId: number; readonly prop: Prop }
  | {
      readonly type: "setTextRun";
      readonly nodeId: number;
      readonly stringId: number;
      readonly styleId: number;
    }
  | {
      readonly type: "defineResource";
      readonly resourceId: number;
      readonly kind: ResourceKind;
      readonly bytes: Uint8Array;
    }
  | { readonly type: "releaseResource"; readonly resourceId: number }
  | {
      readonly type: "scrollTo";
      readonly nodeId: number;
      readonly x: number;
      readonly y: number;
      readonly behavior: number;
    }
  | {
      readonly type: "configureVirtualList";
      readonly nodeId: number;
      readonly itemCount: number;
      readonly estimatedItemSize: number;
      readonly baseOverscanViewports: number;
      readonly velocityHorizonSeconds: number;
      readonly maximumAheadViewports: number;
      readonly axis: VirtualAxis;
    }
  | {
      readonly type: "setVirtualItem";
      readonly nodeId: number;
      readonly itemIndex: number;
    }
  | {
      readonly type: "configureEditable";
      readonly nodeId: number;
      readonly revision: bigint;
      readonly flags: number;
      readonly maxGraphemes: number;
    }
  | {
      /**
       * Declares or withdraws Shell interest in one node's laid-out geometry.
       *
       * Core reports geometry only for observed nodes, because exporting every
       * node's rect each frame would allocate in proportion to the scene.
       */
      readonly type: "observeGeometry";
      readonly nodeId: number;
      /** {@link OBSERVE_GEOMETRY_FLAG_ACTIVE}; zero withdraws the observation. */
      readonly flags: number;
    };

/** Bit 0 asks Core to report this node's geometry. Zero withdraws. */
export const OBSERVE_GEOMETRY_FLAG_ACTIVE = 1;

/** A complete transaction. Commit is encoded automatically at the end. */
export interface MutationBatch {
  readonly frameSeq: number;
  readonly mutations: readonly Mutation[];
}

/**
 * What a decoder had to tolerate to read a stream.
 *
 * A downgrade nobody can see is indistinguishable from a decoder that simply
 * lost data, so every skipped instruction is counted and reported alongside the
 * producer's version.
 */
export interface DecodeReport {
  readonly skippedInstructions: number;
  readonly producerAbiVersion: number;
}

/** A deterministic contract violation detected before bytes are emitted or consumed. */
export class MutationEncodingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MutationEncodingError";
  }
}

/** Encodes one canonical little-endian transaction. */
export function encodeMutationBatch(batch: MutationBatch): Uint8Array {
  assertU32(batch.frameSeq, "frameSeq");
  if (batch.mutations.length + 1 > MAX_MUTATION_INSTRUCTIONS) {
    fail("mutation instruction count exceeds limit");
  }
  const writer = new ByteWriter();
  writer.u32(MUTATION_MAGIC);
  writer.u16(ABI_VERSION);
  writer.u16(STREAM_HEADER_BYTES);
  writer.u32(0);
  writer.u32(0);

  let instructionCount = 0;
  for (const mutation of batch.mutations) {
    encodeMutation(writer, mutation);
    instructionCount += 1;
  }
  writer.instruction(MutationOpcode.Commit);
  writer.u32(batch.frameSeq);
  instructionCount += 1;

  const bytes = writer.finish();
  if (bytes.byteLength > MAX_MUTATION_BYTES) {
    fail(`mutation stream exceeds ${String(MAX_MUTATION_BYTES)} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, instructionCount, true);
  return bytes;
}

/** Decodes transaction bytes for contract testing, recording, and diagnostics. */
export function decodeMutationBatch(input: Uint8Array): MutationBatch {
  return decodeMutationBatchWithReport(input).batch;
}

/** Decodes and reports what this build had to tolerate to read the stream. */
export function decodeMutationBatchWithReport(input: Uint8Array): {
  readonly batch: MutationBatch;
  readonly report: DecodeReport;
} {
  if (input.byteLength > MAX_MUTATION_BYTES) fail("mutation stream exceeds maximum size");
  if (input.byteLength % PROTOCOL_ALIGNMENT !== 0) fail("mutation stream is not four-byte aligned");
  const reader = new ByteReader(input);
  if (reader.u32() !== MUTATION_MAGIC) fail("wrong mutation stream magic");
  // A stream from a newer build stays readable: every instruction carries its
  // own length, so one this build has never heard of can be stepped over when
  // its producer marked it optional. A stream from before that framing existed
  // cannot be stepped through, so it is refused rather than parsed into garbage.
  const producerVersion = reader.u16();
  if (producerVersion < MINIMUM_READABLE_ABI_VERSION) fail("unsupported mutation ABI version");
  if (reader.u16() !== STREAM_HEADER_BYTES) fail("invalid mutation header length");
  if (reader.u32() !== input.byteLength) fail("declared mutation length does not match input");
  const declaredCount = reader.u32();
  if (declaredCount > MAX_MUTATION_INSTRUCTIONS) fail("mutation instruction count exceeds limit");
  const mutations: Mutation[] = [];
  let actualCount = 0;
  let skipped = 0;
  let frameSeq: number | undefined;

  while (reader.remaining > 0) {
    if (frameSeq !== undefined) fail("Commit must be the last instruction");
    const offset = reader.offset;
    const header = reader.instruction();
    actualCount += 1;
    // Skipping is the producer's call, not the reader's: dropping an unknown
    // structural mutation would leave every later one addressing a node that
    // does not exist.
    if (!isKnownOpcode(MutationOpcode, header.opcode)) {
      if (!header.optional) fail(`unknown mutation opcode ${String(header.opcode)}`);
      skipped += 1;
      reader.seekTo(header.end);
      continue;
    }
    const opcode = header.opcode;
    if (opcode === MutationOpcode.Commit) {
      frameSeq = reader.u32();
      validateInstructionSize(opcode, offset, reader.offset);
    } else {
      mutations.push(decodeMutation(reader, opcode));
      validateInstructionSize(opcode, offset, reader.offset);
    }
    // A declared length that disagrees with what was consumed would let a
    // skipping reader and this one disagree about where the next one starts.
    if (reader.offset !== header.end) fail("instruction length does not match its payload");
  }
  if (actualCount !== declaredCount) fail("instruction count does not match input");
  if (frameSeq === undefined) fail("mutation stream is missing Commit");
  return {
    batch: { frameSeq, mutations },
    report: { skippedInstructions: skipped, producerAbiVersion: producerVersion },
  };
}

function encodeMutation(writer: ByteWriter, mutation: Mutation): void {
  switch (mutation.type) {
    case "createNode":
      assertU32(mutation.nodeId, "nodeId");
      assertEnum(NodeKind, mutation.kind, "node kind");
      assertU32(mutation.parent, "parent");
      assertU32(mutation.beforeSibling, "beforeSibling");
      writer.instruction(MutationOpcode.CreateNode);
      writer.u32(mutation.nodeId);
      writer.u16(mutation.kind);
      writer.u16(0);
      writer.u32(mutation.parent);
      writer.u32(mutation.beforeSibling);
      return;
    case "removeNode":
      assertU32(mutation.nodeId, "nodeId");
      writer.instruction(MutationOpcode.RemoveNode);
      writer.u32(mutation.nodeId);
      return;
    case "reparent":
      assertU32(mutation.nodeId, "nodeId");
      assertU32(mutation.newParent, "newParent");
      assertU32(mutation.beforeSibling, "beforeSibling");
      writer.instruction(MutationOpcode.Reparent);
      writer.u32(mutation.nodeId);
      writer.u32(mutation.newParent);
      writer.u32(mutation.beforeSibling);
      return;
    case "setF32":
      assertProp(mutation.prop, "f32");
      assertU32(mutation.nodeId, "nodeId");
      writer.instruction(MutationOpcode.SetF32);
      writer.u32(mutation.nodeId);
      writer.u16(mutation.prop);
      writer.u16(0);
      writer.f32(mutation.value);
      return;
    case "setVec4":
      assertProp(mutation.prop, "vec4");
      assertU32(mutation.nodeId, "nodeId");
      writer.instruction(MutationOpcode.SetVec4);
      writer.u32(mutation.nodeId);
      writer.u16(mutation.prop);
      writer.u16(0);
      for (const value of mutation.value) writer.f32(value);
      return;
    case "setRef":
      assertProp(mutation.prop, "ref");
      assertU32(mutation.nodeId, "nodeId");
      assertU32(mutation.resourceId, "resourceId");
      writer.instruction(MutationOpcode.SetRef);
      writer.u32(mutation.nodeId);
      writer.u16(mutation.prop);
      writer.u16(0);
      writer.u32(mutation.resourceId);
      return;
    case "setFlags":
      assertU32(mutation.nodeId, "nodeId");
      assertU32(mutation.set, "set flags");
      assertU32(mutation.clear, "clear flags");
      if ((mutation.set & mutation.clear) !== 0) fail("set and clear flags overlap");
      writer.instruction(MutationOpcode.SetFlags);
      writer.u32(mutation.nodeId);
      writer.u32(mutation.set);
      writer.u32(mutation.clear);
      return;
    case "clearProp":
      assertU32(mutation.nodeId, "nodeId");
      assertGeneratedProp(mutation.prop);
      writer.instruction(MutationOpcode.ClearProp);
      writer.u32(mutation.nodeId);
      writer.u16(mutation.prop);
      writer.u16(0);
      return;
    case "setTextRun":
      assertU32(mutation.nodeId, "nodeId");
      assertU32(mutation.stringId, "stringId");
      assertU32(mutation.styleId, "styleId");
      writer.instruction(MutationOpcode.SetTextRun);
      writer.u32(mutation.nodeId);
      writer.u32(mutation.stringId);
      writer.u32(mutation.styleId);
      return;
    case "defineResource":
      assertU32(mutation.resourceId, "resourceId");
      assertEnum(ResourceKind, mutation.kind, "resource kind");
      if (mutation.bytes.byteLength > MAX_RESOURCE_BYTES) fail("resource exceeds maximum size");
      writer.instruction(MutationOpcode.DefineResource);
      writer.u32(mutation.resourceId);
      writer.u16(mutation.kind);
      writer.u16(0);
      writer.u32(mutation.bytes.byteLength);
      writer.bytes(mutation.bytes);
      writer.pad();
      return;
    case "releaseResource":
      assertU32(mutation.resourceId, "resourceId");
      writer.instruction(MutationOpcode.ReleaseResource);
      writer.u32(mutation.resourceId);
      return;
    case "scrollTo":
      assertU32(mutation.nodeId, "nodeId");
      assertU16(mutation.behavior, "behavior");
      writer.instruction(MutationOpcode.ScrollTo);
      writer.u32(mutation.nodeId);
      writer.f32(mutation.x);
      writer.f32(mutation.y);
      writer.u16(mutation.behavior);
      writer.u16(0);
      return;
    case "configureVirtualList":
      assertU32(mutation.nodeId, "nodeId");
      assertU32(mutation.itemCount, "itemCount");
      writer.instruction(MutationOpcode.ConfigureVirtualList);
      writer.u32(mutation.nodeId);
      writer.u32(mutation.itemCount);
      writer.f32(mutation.estimatedItemSize);
      writer.f32(mutation.baseOverscanViewports);
      writer.f32(mutation.velocityHorizonSeconds);
      writer.f32(mutation.maximumAheadViewports);
      assertEnum(VirtualAxis, mutation.axis, "virtual axis");
      writer.u8(mutation.axis);
      writer.u8(0);
      writer.u16(0);
      return;
    case "setVirtualItem":
      assertU32(mutation.nodeId, "nodeId");
      assertU32(mutation.itemIndex, "itemIndex");
      writer.instruction(MutationOpcode.SetVirtualItem);
      writer.u32(mutation.nodeId);
      writer.u32(mutation.itemIndex);
      return;
    case "configureEditable":
      assertU32(mutation.nodeId, "nodeId");
      assertU64(mutation.revision, "revision");
      assertU32(mutation.flags, "editable flags");
      assertU32(mutation.maxGraphemes, "maxGraphemes");
      writer.instruction(MutationOpcode.ConfigureEditable);
      writer.u32(mutation.nodeId);
      writer.u32(Number(mutation.revision & 0xffff_ffffn));
      writer.u32(Number(mutation.revision >> 32n));
      writer.u32(mutation.flags);
      writer.u32(mutation.maxGraphemes);
      return;
    case "observeGeometry":
      assertU32(mutation.nodeId, "nodeId");
      assertU32(mutation.flags, "observe flags");
      if ((mutation.flags & ~OBSERVE_GEOMETRY_FLAG_ACTIVE) !== 0) {
        // Core rejects reserved bits rather than masking them, so sending one
        // would fail the whole frame at the decoder instead of here.
        fail("observe flags use reserved bits");
      }
      writer.instruction(MutationOpcode.ObserveGeometry);
      writer.u32(mutation.nodeId);
      writer.u32(mutation.flags);
      return;
  }
}

function decodeMutation(reader: ByteReader, opcode: MutationOpcode): Mutation {
  switch (opcode) {
    case MutationOpcode.CreateNode: {
      const nodeId = reader.u32();
      const kind = reader.u16();
      reader.zeroes(2);
      assertEnum(NodeKind, kind, "node kind");
      return {
        type: "createNode",
        nodeId,
        kind,
        parent: reader.u32(),
        beforeSibling: reader.u32(),
      };
    }
    case MutationOpcode.RemoveNode:
      return { type: "removeNode", nodeId: reader.u32() };
    case MutationOpcode.Reparent:
      return {
        type: "reparent",
        nodeId: reader.u32(),
        newParent: reader.u32(),
        beforeSibling: reader.u32(),
      };
    case MutationOpcode.SetF32: {
      const nodeId = reader.u32();
      const prop = reader.prop("f32");
      return { type: "setF32", nodeId, prop, value: reader.f32() };
    }
    case MutationOpcode.SetVec4: {
      const nodeId = reader.u32();
      const prop = reader.prop("vec4");
      return {
        type: "setVec4",
        nodeId,
        prop,
        value: [reader.f32(), reader.f32(), reader.f32(), reader.f32()],
      };
    }
    case MutationOpcode.SetRef: {
      const nodeId = reader.u32();
      const prop = reader.prop("ref");
      return { type: "setRef", nodeId, prop, resourceId: reader.u32() };
    }
    case MutationOpcode.SetFlags: {
      const result: Mutation = {
        type: "setFlags",
        nodeId: reader.u32(),
        set: reader.u32(),
        clear: reader.u32(),
      };
      if ((result.set & result.clear) !== 0) fail("set and clear flags overlap");
      return result;
    }
    case MutationOpcode.ClearProp: {
      const nodeId = reader.u32();
      const prop = reader.u16();
      reader.zeroes(2);
      assertGeneratedProp(prop);
      return { type: "clearProp", nodeId, prop };
    }
    case MutationOpcode.SetTextRun:
      return {
        type: "setTextRun",
        nodeId: reader.u32(),
        stringId: reader.u32(),
        styleId: reader.u32(),
      };
    case MutationOpcode.DefineResource: {
      const resourceId = reader.u32();
      const kind = reader.u16();
      reader.zeroes(2);
      assertEnum(ResourceKind, kind, "resource kind");
      const length = reader.u32();
      if (length > MAX_RESOURCE_BYTES) fail("resource exceeds maximum size");
      const bytes = reader.bytes(length);
      reader.zeroes(padding(length));
      return { type: "defineResource", resourceId, kind, bytes };
    }
    case MutationOpcode.ReleaseResource:
      return { type: "releaseResource", resourceId: reader.u32() };
    case MutationOpcode.ScrollTo: {
      const nodeId = reader.u32();
      const x = reader.f32();
      const y = reader.f32();
      const behavior = reader.u16();
      reader.zeroes(2);
      return { type: "scrollTo", nodeId, x, y, behavior };
    }
    case MutationOpcode.ConfigureVirtualList: {
      const nodeId = reader.u32();
      const itemCount = reader.u32();
      const estimatedItemSize = reader.f32();
      const baseOverscanViewports = reader.f32();
      const velocityHorizonSeconds = reader.f32();
      const maximumAheadViewports = reader.f32();
      const axis = reader.u8();
      assertEnum(VirtualAxis, axis, "virtual axis");
      reader.zeroes(3);
      return {
        type: "configureVirtualList",
        nodeId,
        itemCount,
        estimatedItemSize,
        baseOverscanViewports,
        velocityHorizonSeconds,
        maximumAheadViewports,
        axis,
      };
    }
    case MutationOpcode.SetVirtualItem:
      return {
        type: "setVirtualItem",
        nodeId: reader.u32(),
        itemIndex: reader.u32(),
      };
    case MutationOpcode.ConfigureEditable:
      return {
        type: "configureEditable",
        nodeId: reader.u32(),
        revision: BigInt(reader.u32()) | (BigInt(reader.u32()) << 32n),
        flags: reader.u32(),
        maxGraphemes: reader.u32(),
      };
    case MutationOpcode.ObserveGeometry: {
      const nodeId = reader.u32();
      const flags = reader.u32();
      if ((flags & ~OBSERVE_GEOMETRY_FLAG_ACTIVE) !== 0) {
        return fail("observe flags use reserved bits");
      }
      return { type: "observeGeometry", nodeId, flags };
    }
    default:
      return fail(`unknown mutation opcode ${String(opcode)}`);
  }
}

class ByteWriter {
  readonly #bytes: number[] = [];
  #instructionOpcode: MutationOpcode | undefined;
  #instructionStart = 0;

  public instruction(opcode: MutationOpcode): void {
    this.validateInstruction();
    this.#instructionOpcode = opcode;
    this.#instructionStart = this.#bytes.length;
    this.u8(opcode);
    this.u8(0);
    this.u16(0);
  }

  public u8(value: number): void {
    this.#bytes.push(value);
  }

  public u16(value: number): void {
    assertU16(value, "u16");
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }

  public u32(value: number): void {
    assertU32(value, "u32");
    this.#bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }

  public f32(value: number): void {
    if (!Number.isFinite(value)) fail("float must be finite");
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    this.bytes(bytes);
  }

  public bytes(bytes: Uint8Array): void {
    for (const byte of bytes) this.#bytes.push(byte);
  }

  public pad(): void {
    while (this.#bytes.length % PROTOCOL_ALIGNMENT !== 0) this.#bytes.push(0);
  }

  public finish(): Uint8Array {
    this.validateInstruction();
    if (this.#bytes.length % PROTOCOL_ALIGNMENT !== 0) fail("encoder produced misaligned stream");
    return Uint8Array.from(this.#bytes);
  }

  /**
   * Closes the instruction that just ended, writing its length into the header.
   *
   * The length is not known when the header goes out, so it is patched in here
   * rather than at any call site. Instructions are four-byte aligned, so the
   * length is stored in words and a `u16` reaches 256 KiB; a resource may be
   * far larger, so an oversized instruction writes the escape value and carries
   * its byte length in the word right after the header, where a reader that
   * does not know the opcode can still find it.
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
  readonly #view: DataView;
  readonly #input: Uint8Array;
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
    // A length that is too small, misaligned, or past the end of the stream
    // would let a skipping reader resume mid-instruction.
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
    if (!Number.isFinite(value)) fail("float must be finite");
    return value;
  }

  public bytes(length: number): Uint8Array {
    this.require(length);
    const result = this.#input.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  public zeroes(length: number): void {
    const bytes = this.bytes(length);
    if (bytes.some((byte) => byte !== 0)) fail("reserved bytes must be zero");
  }

  public prop(valueType: "f32" | "vec4" | "ref"): Prop {
    const value = this.u16();
    this.zeroes(2);
    assertProp(value, valueType);
    return value;
  }

  private require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      fail("truncated mutation stream");
    }
  }
}

function assertProp(value: number, valueType: "f32" | "vec4" | "ref"): asserts value is Prop {
  const metadata = PROP_METADATA[value as keyof typeof PROP_METADATA];
  if (metadata === undefined) fail(`unknown prop ${String(value)}`);
  if (metadata.valueType !== valueType)
    fail(`prop ${metadata.name} requires ${metadata.valueType}`);
}

function assertGeneratedProp(value: number): asserts value is Prop {
  if (PROP_METADATA[value as keyof typeof PROP_METADATA] === undefined) {
    fail(`unknown prop ${String(value)}`);
  }
}

function assertEnum<T extends Record<string, string | number>>(
  values: T,
  value: number,
  label: string,
): asserts value is T[keyof T] & number {
  if (typeof values[value] !== "string") fail(`unknown ${label} ${String(value)}`);
}

function assertU16(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) fail(`${label} must be a u16`);
}

function assertU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) fail(`${label} must be a u32`);
}

function assertU64(value: bigint, label: string): void {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) fail(`${label} must be a u64`);
}

function padding(length: number): number {
  return (PROTOCOL_ALIGNMENT - (length % PROTOCOL_ALIGNMENT)) % PROTOCOL_ALIGNMENT;
}

function validateInstructionSize(opcode: MutationOpcode, offset: number, end: number): void {
  const layout = MUTATION_LAYOUTS[opcode];
  const actual = end - offset;
  if (layout.fixedBytes !== null && actual !== layout.fixedBytes) {
    fail(
      `mutation opcode ${String(opcode)} consumed ${String(actual)} bytes, expected ${String(layout.fixedBytes)}`,
    );
  }
  if (actual < layout.minimumBytes) {
    fail(`mutation opcode ${String(opcode)} is shorter than its generated layout`);
  }
}

function fail(message: string): never {
  throw new MutationEncodingError(message);
}

/** Whether an opcode byte names a member this build knows. */
function isKnownOpcode<T extends Record<string, string | number>>(
  values: T,
  value: number,
): value is T[keyof T] & number {
  return typeof values[value] === "string";
}
