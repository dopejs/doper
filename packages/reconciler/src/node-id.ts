import { NODE_ID_GENERATION_BITS, NODE_ID_INDEX_BITS, NULL_NODE_ID } from "./generated.js";

const INDEX_RANGE = 2 ** NODE_ID_INDEX_BITS;
const INDEX_MASK = INDEX_RANGE - 1;
const MAX_NODE_SLOTS = INDEX_MASK;
const MAX_GENERATION = 2 ** NODE_ID_GENERATION_BITS - 1;

/** Unpacked generation-bearing node identifier. */
export interface DecodedNodeId {
  readonly index: number;
  readonly generation: number;
}

/** A deterministic NodeId allocation or stale-handle error. */
export class NodeIdError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NodeIdError";
  }
}

interface Slot {
  generation: number;
  active: boolean;
  retired: boolean;
}

/** Shell-owned deterministic allocator matching Core's generated NodeId layout. */
export class NodeIdAllocator {
  readonly #slots: Slot[] = [];
  readonly #free: number[] = [];

  /** Allocates a fresh handle, reusing only a slot with a strictly newer generation. */
  public allocate(): number {
    while (this.#free.length > 0) {
      const index = this.#free.pop();
      if (index === undefined) break;
      const slot = this.#slots[index];
      if (slot === undefined || slot.active || slot.retired) continue;
      if (slot.generation >= MAX_GENERATION) {
        slot.retired = true;
        continue;
      }
      slot.generation += 1;
      slot.active = true;
      return encodeNodeId(index, slot.generation);
    }

    if (this.#slots.length >= MAX_NODE_SLOTS) {
      throw new NodeIdError("NodeId slot capacity exhausted");
    }
    const index = this.#slots.length;
    this.#slots.push({ generation: 1, active: true, retired: false });
    return encodeNodeId(index, 1);
  }

  /** Releases a live handle. Stale or duplicate release is rejected. */
  public release(raw: number): void {
    const { index, generation } = decodeNodeId(raw);
    const slot = this.#slots[index];
    if (slot === undefined || !slot.active || slot.generation !== generation) {
      throw new NodeIdError("cannot release a stale NodeId");
    }
    slot.active = false;
    if (slot.generation === MAX_GENERATION) {
      slot.retired = true;
    } else {
      this.#free.push(index);
    }
  }

  /** Returns whether a handle currently identifies a live allocation. */
  public isLive(raw: number): boolean {
    try {
      const { index, generation } = decodeNodeId(raw);
      const slot = this.#slots[index];
      return slot?.active === true && slot.generation === generation;
    } catch {
      return false;
    }
  }

  /** Number of active allocations. Intended for diagnostics, not hot-path iteration. */
  public get activeCount(): number {
    let result = 0;
    for (const slot of this.#slots) if (slot.active) result += 1;
    return result;
  }
}

/** Validates and unpacks a wire NodeId. */
export function decodeNodeId(raw: number): DecodedNodeId {
  assertU32(raw);
  if (raw === NULL_NODE_ID) throw new NodeIdError("null is not a live NodeId");
  const index = raw % INDEX_RANGE;
  const generation = Math.floor(raw / INDEX_RANGE);
  if (index >= MAX_NODE_SLOTS) throw new NodeIdError("NodeId uses the reserved index");
  if (generation < 1 || generation > MAX_GENERATION) {
    throw new NodeIdError("NodeId has an invalid generation");
  }
  return { index, generation };
}

function encodeNodeId(index: number, generation: number): number {
  const raw = generation * INDEX_RANGE + index;
  assertU32(raw);
  if (raw === NULL_NODE_ID) throw new NodeIdError("NodeId collides with null sentinel");
  return raw;
}

function assertU32(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new NodeIdError("NodeId must be a u32");
  }
}
