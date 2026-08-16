import { describe, expect, it } from "vitest";

import { GlyphResourceError, decodeGlyphResourceBatch } from "./glyph-resources";
import {
  ABI_VERSION,
  GLYPH_RESOURCES_MAGIC,
  GlyphResourceOpcode,
  RESOURCE_ENCODING_VERSION,
  ResourceKind,
} from "./generated";
import { Canvas2DResourceRegistry } from "./resources";

describe("glyph resource batches", () => {
  it("decodes the Rust-compatible canonical span layout", () => {
    const bytes = sampleBatch();
    expect(decodeGlyphResourceBatch(bytes)).toEqual([
      {
        type: "define",
        span: {
          spanId: 7,
          paintId: 3,
          bitmaps: [
            {
              glyphId: 42,
              left: -1,
              top: 9,
              width: 2,
              height: 2,
              devicePixelRatio: 2,
              data: new Uint8Array([0, 127, 255, 64]),
            },
          ],
          placements: [{ bitmapIndex: 0, x: 1.5, y: 12 }],
        },
      },
      { type: "release", spanId: 8 },
    ]);
  });

  it("rejects malformed bytes and leaves the registry unchanged", () => {
    const registry = new Canvas2DResourceRegistry();
    registry.defineEncodedResource(
      3,
      ResourceKind.Paint,
      Uint8Array.of(RESOURCE_ENCODING_VERSION, 1, 0, 0, 255, 255, 255, 255),
    );
    const valid = defineOnlyBatch();
    registry.applyGlyphResourceBatch(valid);
    expect(registry.getGlyphSpan(7)?.placements).toHaveLength(1);

    const malformed = sampleBatch();
    new DataView(malformed.buffer).setUint32(52, 3, true);
    expect(() => registry.applyGlyphResourceBatch(malformed)).toThrow(GlyphResourceError);
    expect(registry.getGlyphSpan(7)?.bitmaps[0]?.width).toBe(2);
    expect(registry.getGlyphSpan(8)).toBeUndefined();
  });

  it("preflights lifecycle and paint dependencies transactionally", () => {
    const registry = new Canvas2DResourceRegistry();
    expect(() => registry.applyGlyphResourceBatch(defineOnlyBatch())).toThrow(/missing paint/u);
    expect(registry.getGlyphSpan(7)).toBeUndefined();
  });
});

function sampleBatch(): Uint8Array {
  const bytes = new Uint8Array(92);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const u8 = (value: number) => view.setUint8(offset++, value);
  const u16 = (value: number) => {
    view.setUint16(offset, value, true);
    offset += 2;
  };
  const u32 = (value: number) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };
  const f32 = (value: number) => {
    view.setFloat32(offset, value, true);
    offset += 4;
  };
  u32(GLYPH_RESOURCES_MAGIC);
  u16(ABI_VERSION);
  u16(16);
  u32(bytes.byteLength);
  u32(2);
  u8(GlyphResourceOpcode.DefineGlyphSpan);
  u8(0);
  u16(0);
  u32(7);
  u32(3);
  u32(1);
  u32(1);
  u32(44);
  u16(42);
  u16(0);
  f32(-1);
  f32(9);
  u32(2);
  u32(2);
  f32(2);
  u32(4);
  bytes.set([0, 127, 255, 64], offset);
  offset += 4;
  u32(0);
  f32(1.5);
  f32(12);
  u8(GlyphResourceOpcode.ReleaseGlyphSpan);
  u8(0);
  u16(0);
  u32(8);
  expect(offset).toBe(bytes.byteLength);
  return bytes;
}

function defineOnlyBatch(): Uint8Array {
  const bytes = sampleBatch().slice(0, -8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, 1, true);
  return bytes;
}
