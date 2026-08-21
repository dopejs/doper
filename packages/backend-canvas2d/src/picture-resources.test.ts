import { describe, expect, it } from "vitest";

import { Canvas2DResourceRegistry } from "./resources";
import { decodePictureResourceBatch, encodePictureResourceBatch } from "./picture-resources";
import { ABI_VERSION, DISPLAY_LIST_MAGIC, DisplayOpcode, STREAM_HEADER_BYTES } from "./generated";

describe("Picture resource transactions", () => {
  it("round-trips definitions and releases", () => {
    const bytes = encodePictureResourceBatch([
      { type: "define", pictureId: 7, bytes: emptyList() },
      { type: "release", pictureId: 8 },
    ]);
    expect(decodePictureResourceBatch(bytes)).toEqual([
      { type: "define", pictureId: 7, bytes: emptyList() },
      { type: "release", pictureId: 8 },
    ]);
  });

  it("installs nested graphs atomically and rejects missing references", () => {
    const resources = new Canvas2DResourceRegistry();
    resources.applyPictureResourceBatch(
      encodePictureResourceBatch([
        { type: "define", pictureId: 2, bytes: emptyList() },
        { type: "define", pictureId: 1, bytes: pictureList(2) },
      ]),
    );
    expect(resources.getPicture(1)).toBeDefined();
    expect(resources.pictureResidency().count).toBe(2);

    expect(() =>
      resources.applyPictureResourceBatch(
        encodePictureResourceBatch([{ type: "define", pictureId: 3, bytes: pictureList(99) }]),
      ),
    ).toThrow(/missing picture/u);
    expect(resources.getPicture(3)).toBeUndefined();
    expect(resources.pictureResidency().count).toBe(2);
  });

  it("rejects duplicate ids, malformed payloads, cycles, and stale releases", () => {
    expect(() =>
      encodePictureResourceBatch([
        { type: "release", pictureId: 4 },
        { type: "release", pictureId: 4 },
      ]),
    ).toThrow(/more than once/u);
    expect(() =>
      encodePictureResourceBatch([
        { type: "define", pictureId: 5, bytes: new Uint8Array([1, 2, 3, 4]) },
      ]),
    ).toThrow();

    const resources = new Canvas2DResourceRegistry();
    expect(() =>
      resources.applyPictureResourceBatch(
        encodePictureResourceBatch([{ type: "define", pictureId: 6, bytes: pictureList(6) }]),
      ),
    ).toThrow(/cycle/u);
    expect(() =>
      resources.applyPictureResourceBatch(
        encodePictureResourceBatch([{ type: "release", pictureId: 123 }]),
      ),
    ).toThrow(/not defined/u);
  });
});

function emptyList(): Uint8Array {
  const bytes = new Uint8Array(STREAM_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, DISPLAY_LIST_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, STREAM_HEADER_BYTES, true);
  view.setUint32(8, bytes.byteLength, true);
  return bytes;
}

function pictureList(pictureId: number): Uint8Array {
  const bytes = new Uint8Array(STREAM_HEADER_BYTES + 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, DISPLAY_LIST_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, STREAM_HEADER_BYTES, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, 1, true);
  view.setUint8(STREAM_HEADER_BYTES, DisplayOpcode.DrawPicture);
  view.setUint16(STREAM_HEADER_BYTES + 2, 4, true);
  view.setUint32(STREAM_HEADER_BYTES + 4, pictureId, true);
  return bytes;
}
