import { describe, expect, it } from "vitest";

import { encodeGlyphResourceBatch } from "./glyph-resources";
import { ABI_VERSION, DISPLAY_LIST_MAGIC, DisplayOpcode, ResourceKind } from "./generated";
import { Canvas2DReplayer } from "./replayer";
import { Canvas2DResourceRegistry } from "./resources";

describe("Canvas2D glyph raster replay", () => {
  it("installs a complete span before drawing its tinted alpha masks", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext("2d");
    expect(context).not.toBeNull();
    if (context === null) return;

    const resources = new Canvas2DResourceRegistry();
    resources.defineEncodedResource(
      1,
      ResourceKind.Paint,
      Uint8Array.of(1, 1, 0, 0, 12, 34, 56, 255),
    );
    resources.defineEncodedResource(4, ResourceKind.Font, sfntFont());
    resources.applyGlyphResourceBatch(
      encodeGlyphResourceBatch([
        {
          type: "define",
          span: {
            spanId: 7,
            paintId: 1,
            bitmaps: [
              {
                glyphId: 42,
                left: 0,
                top: 2,
                width: 2,
                height: 2,
                devicePixelRatio: 1,
                data: Uint8Array.of(255, 255, 255, 255),
              },
            ],
            placements: [{ bitmapIndex: 0, x: 0, y: 2 }],
          },
        },
      ]),
    );

    new Canvas2DReplayer().replay(context, glyphDisplayList(), resources);
    expect([...context.getImageData(2, 2, 1, 1).data]).toEqual([12, 34, 56, 255]);
    expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([0, 0, 0, 0]);
  });
});

function glyphDisplayList(): Uint8Array {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, DISPLAY_LIST_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, 16, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, 1, true);
  bytes[16] = DisplayOpcode.DrawGlyphRun;
  // Instruction length in four-byte words, covering the header.
  view.setUint16(18, (bytes.byteLength - 16) / 4, true);
  view.setUint32(20, 4, true);
  view.setFloat32(24, 10, true);
  view.setFloat32(28, 2, true);
  view.setFloat32(32, 2, true);
  view.setUint32(36, 7, true);
  return bytes;
}

function sfntFont(): Uint8Array {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes[1] = 1;
  view.setUint32(8, 8, true);
  bytes.set([0x4f, 0x54, 0x54, 0x4f, 0, 0, 0, 0], 12);
  return bytes;
}
