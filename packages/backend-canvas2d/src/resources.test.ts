import { describe, expect, it } from "vitest";

import { RESOURCE_ENCODING_VERSION, ResourceKind } from "./generated";
import { Canvas2DResourceRegistry } from "./resources";

describe("Canvas2DResourceRegistry", () => {
  it("decodes schema-versioned paint, text, and text-style resources", () => {
    const resources = new Canvas2DResourceRegistry();
    resources.defineEncodedResource(
      1,
      ResourceKind.Paint,
      Uint8Array.of(RESOURCE_ENCODING_VERSION, 1, 0, 0, 0x12, 0x34, 0x56, 0x80),
    );
    resources.defineEncodedResource(2, ResourceKind.Utf8String, new TextEncoder().encode("hello"));
    resources.defineEncodedResource(3, ResourceKind.TextStyle, textStyle(1, 16, 20, 400, "Inter"));

    expect(resources.getPaint(1)).toBe("#12345680");
    expect(resources.getText(2)).toBe("hello");
    expect(resources.getTextStyle(3)).toEqual({
      font: '400 16px "Inter"',
      fillStyle: "#12345680",
      textBaseline: "alphabetic",
    });
  });

  it("rejects malformed payloads, unresolved dependencies, and duplicate ids", () => {
    const resources = new Canvas2DResourceRegistry();
    expect(() =>
      resources.defineEncodedResource(1, ResourceKind.Paint, Uint8Array.of(1, 1, 1, 0, 0, 0, 0, 0)),
    ).toThrow(/invalid/u);
    expect(() =>
      resources.defineEncodedResource(
        2,
        ResourceKind.TextStyle,
        textStyle(99, 16, 20, 400, "Inter"),
      ),
    ).toThrow(/missing paint/u);
    resources.definePaint(5, "red");
    expect(() => resources.definePaint(5, "blue")).toThrow(/already defined/u);
    resources.defineEncodedResource(6, ResourceKind.Paint, solidPaint());
    expect(() => resources.defineEncodedResource(6, ResourceKind.Paint, solidPaint())).toThrow(
      /already defined/u,
    );
  });

  it("releases encoded backing values with exact kind validation", () => {
    const resources = new Canvas2DResourceRegistry();
    resources.defineEncodedResource(1, ResourceKind.Paint, solidPaint());
    resources.releaseEncodedResource(1, ResourceKind.Paint);
    expect(resources.getPaint(1)).toBeUndefined();
    expect(() => resources.releaseEncodedResource(1, ResourceKind.Paint)).toThrow(/kind/u);

    const affine = new Uint8Array(28);
    affine[0] = RESOURCE_ENCODING_VERSION;
    affine[1] = 1;
    const view = new DataView(affine.buffer);
    view.setFloat32(4, 1, true);
    view.setFloat32(16, 1, true);
    resources.defineEncodedResource(2, ResourceKind.Affine, affine);
    resources.releaseEncodedResource(2, ResourceKind.Affine);
  });
});

function solidPaint(): Uint8Array {
  return Uint8Array.of(RESOURCE_ENCODING_VERSION, 1, 0, 0, 0, 0, 0, 255);
}

function textStyle(
  paintId: number,
  fontSize: number,
  lineHeight: number,
  weight: number,
  family: string,
): Uint8Array {
  const encodedFamily = new TextEncoder().encode(family);
  const length = (24 + encodedFamily.length + 3) & ~3;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes[0] = RESOURCE_ENCODING_VERSION;
  bytes[1] = 1;
  view.setUint32(4, paintId, true);
  view.setFloat32(8, fontSize, true);
  view.setFloat32(12, lineHeight, true);
  view.setUint16(16, weight, true);
  view.setUint32(20, encodedFamily.length, true);
  bytes.set(encodedFamily, 24);
  return bytes;
}
