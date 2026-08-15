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
      readonly estimatedItemHeight: number;
      readonly baseOverscanViewports: number;
      readonly velocityHorizonSeconds: number;
      readonly maximumAheadViewports: number;
    }
  | {
      readonly type: "setVirtualItem";
      readonly nodeId: number;
      readonly itemIndex: number;
    };

/** A complete transaction. Commit is encoded automatically at the end. */
export interface MutationBatch {
  readonly frameSeq: number;
  readonly mutations: readonly Mutation[];
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
  if (input.byteLength > MAX_MUTATION_BYTES) fail("mutation stream exceeds maximum size");
  if (input.byteLength % PROTOCOL_ALIGNMENT !== 0) fail("mutation stream is not four-byte aligned");
  const reader = new ByteReader(input);
  if (reader.u32() !== MUTATION_MAGIC) fail("wrong mutation stream magic");
  if (reader.u16() !== ABI_VERSION) fail("unsupported mutation ABI version");
  if (reader.u16() !== STREAM_HEADER_BYTES) fail("invalid mutation header length");
  if (reader.u32() !== input.byteLength) fail("declared mutation length does not match input");
  const declaredCount = reader.u32();
  if (declaredCount > MAX_MUTATION_INSTRUCTIONS) fail("mutation instruction count exceeds limit");
  const mutations: Mutation[] = [];
  let actualCount = 0;
  let frameSeq: number | undefined;

  while (reader.remaining > 0) {
    if (frameSeq !== undefined) fail("Commit must be the last instruction");
    const offset = reader.offset;
    const opcode = reader.instruction();
    actualCount += 1;
    if (opcode === MutationOpcode.Commit) {
      frameSeq = reader.u32();
      validateInstructionSize(opcode, offset, reader.offset);
      continue;
    }
    mutations.push(decodeMutation(reader, opcode));
    validateInstructionSize(opcode, offset, reader.offset);
  }
  if (actualCount !== declaredCount) fail("instruction count does not match input");
  if (frameSeq === undefined) fail("mutation stream is missing Commit");
  return { frameSeq, mutations };
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
      writer.f32(mutation.estimatedItemHeight);
      writer.f32(mutation.baseOverscanViewports);
      writer.f32(mutation.velocityHorizonSeconds);
      writer.f32(mutation.maximumAheadViewports);
      return;
    case "setVirtualItem":
      assertU32(mutation.nodeId, "nodeId");
      assertU32(mutation.itemIndex, "itemIndex");
      writer.instruction(MutationOpcode.SetVirtualItem);
      writer.u32(mutation.nodeId);
      writer.u32(mutation.itemIndex);
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
    case MutationOpcode.ConfigureVirtualList:
      return {
        type: "configureVirtualList",
        nodeId: reader.u32(),
        itemCount: reader.u32(),
        estimatedItemHeight: reader.f32(),
        baseOverscanViewports: reader.f32(),
        velocityHorizonSeconds: reader.f32(),
        maximumAheadViewports: reader.f32(),
      };
    case MutationOpcode.SetVirtualItem:
      return {
        type: "setVirtualItem",
        nodeId: reader.u32(),
        itemIndex: reader.u32(),
      };
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

  private validateInstruction(): void {
    if (this.#instructionOpcode === undefined) return;
    validateInstructionSize(this.#instructionOpcode, this.#instructionStart, this.#bytes.length);
    this.#instructionOpcode = undefined;
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

  public instruction(): MutationOpcode {
    if (this.#offset % PROTOCOL_ALIGNMENT !== 0) fail("instruction is not aligned");
    this.require(INSTRUCTION_HEADER_BYTES);
    const opcode = this.u8();
    const flags = this.u8();
    if (flags !== 0) fail("unsupported instruction flags");
    this.zeroes(2);
    assertEnum(MutationOpcode, opcode, "mutation opcode");
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
