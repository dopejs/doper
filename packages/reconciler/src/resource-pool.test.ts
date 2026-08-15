import { describe, expect, it } from "vitest";

import {
  TEXT_STYLE_FAMILY_BYTES_OFFSET,
  TEXT_STYLE_FAMILY_OFFSET,
  TEXT_STYLE_PAINT_ID_OFFSET,
  ResourceKind,
} from "./generated";
import type { Mutation } from "./mutation-stream";
import { ResourcePool, encodeSolidPaint, encodeTextStyle } from "./resource-pool";

describe("ResourcePool", () => {
  it("discards retained entries when a root becomes unusable", () => {
    const pool = new ResourcePool();
    const mutations: Mutation[] = [];
    pool.acquire(ResourceKind.Utf8String, new TextEncoder().encode("retained"), mutations);
    expect(pool.size).toBe(1);
    pool.discard();
    expect(pool.size).toBe(0);
  });

  it("interns identical bytes and releases the Core resource on the last reference", () => {
    const pool = new ResourcePool();
    const mutations: Mutation[] = [];
    const bytes = encodeSolidPaint("#1234");
    const first = pool.acquire(ResourceKind.Paint, bytes, mutations);
    const second = pool.acquire(ResourceKind.Paint, bytes.slice(), mutations);

    expect(second).toBe(first);
    expect(pool.size).toBe(1);
    expect(mutations).toHaveLength(1);

    pool.release(first, mutations);
    expect(pool.size).toBe(1);
    expect(mutations).toHaveLength(1);
    pool.release(second, mutations);
    expect(pool.size).toBe(0);
    expect(mutations.at(-1)).toEqual({ type: "releaseResource", resourceId: first });
  });

  it("uses the schema family offset and four-byte padding for text styles", () => {
    const bytes = encodeTextStyle(0x0102_0304, 16, 20, 500, "Inter");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(bytes.byteLength % 4).toBe(0);
    expect(view.getUint32(TEXT_STYLE_PAINT_ID_OFFSET, true)).toBe(0x0102_0304);
    expect(view.getUint32(TEXT_STYLE_FAMILY_BYTES_OFFSET, true)).toBe(5);
    expect(new TextDecoder().decode(bytes.subarray(TEXT_STYLE_FAMILY_OFFSET, 29))).toBe("Inter");
  });

  it("rejects invalid colors and stale replacement identifiers", () => {
    expect(() => encodeSolidPaint("red" as `#${string}`)).toThrow(/unsupported color/u);
    const pool = new ResourcePool();
    expect(() => pool.replace(99, ResourceKind.Paint, encodeSolidPaint("#000"), [])).toThrow(
      /unknown resource/u,
    );
  });
});
