import { describe, expect, it } from "vitest";

import { NULL_NODE_ID } from "./generated";
import { NodeIdAllocator, decodeNodeId } from "./node-id";

describe("NodeIdAllocator", () => {
  it("reuses a released slot only with a newer generation", () => {
    const allocator = new NodeIdAllocator();
    const first = allocator.allocate();
    const second = allocator.allocate();
    expect(decodeNodeId(first)).toEqual({ index: 0, generation: 1 });
    expect(decodeNodeId(second)).toEqual({ index: 1, generation: 1 });

    allocator.release(first);
    const replacement = allocator.allocate();
    expect(decodeNodeId(replacement)).toEqual({ index: 0, generation: 2 });
    expect(allocator.isLive(first)).toBe(false);
    expect(allocator.isLive(replacement)).toBe(true);
  });

  it("rejects null, duplicate release, and arbitrary stale handles", () => {
    const allocator = new NodeIdAllocator();
    const node = allocator.allocate();
    allocator.release(node);
    expect(() => allocator.release(node)).toThrow(/stale/u);
    expect(() => decodeNodeId(NULL_NODE_ID)).toThrow(/null/u);
    expect(allocator.isLive(123)).toBe(false);
  });
});
