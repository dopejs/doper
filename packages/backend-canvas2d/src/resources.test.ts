import { describe, expect, it } from "vitest";

import { RESOURCE_ENCODING_VERSION, ResourceKind } from "./generated";
import { Canvas2DResourceRegistry, cssFont } from "./resources";

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
      font: "400 16px Inter",
      fillStyle: "#12345680",
      lineHeight: 20,
      textBaseline: "alphabetic",
    });
  });

  it("decodes TextStyle v2 posture, alignment, and justification metadata", () => {
    const resources = new Canvas2DResourceRegistry();
    resources.defineEncodedResource(1, ResourceKind.Paint, solidPaint());
    resources.defineEncodedResource(
      2,
      ResourceKind.TextStyle,
      textStyleV2(1, 18, 24, 650, "Inter", 24, 6, 31, 1, 15),
    );
    expect(resources.getTextStyle(2)).toEqual({
      font: "italic 650 18px Inter",
      fillStyle: "#000000ff",
      lineHeight: 24,
      textAlign: "center",
      textBaseline: "alphabetic",
    });

    resources.defineEncodedResource(
      3,
      ResourceKind.TextStyle,
      textStyleV2(1, 18, 24, 400, "Inter", 29, 25, 29, 29, 7),
    );
    expect(resources.getTextStyle(3)).toMatchObject({ justify: true });
  });

  it("measures hard lines against a post-transaction preview without installing it", () => {
    const resources = new Canvas2DResourceRegistry();
    const actions = [
      {
        type: "define" as const,
        id: 2,
        kind: ResourceKind.Utf8String,
        bytes: new TextEncoder().encode("wide\nxx"),
      },
      {
        type: "define" as const,
        id: 3,
        kind: ResourceKind.TextStyle,
        bytes: textStyle(1, 16, 20, 400, "Inter"),
      },
    ];
    const fonts: string[] = [];
    const state = { font: "initial" };
    const context = {
      get font() {
        return state.font;
      },
      set font(value: string) {
        state.font = value;
      },
      save: () => undefined,
      restore: () => undefined,
      measureText(text: string) {
        fonts.push(state.font);
        return { width: text.length * 7 } as TextMetrics;
      },
    } as unknown as CanvasRenderingContext2D;

    expect(
      resources.measureSystemTextPairs(context, actions, [{ stringId: 2, styleId: 3 }]),
    ).toEqual([
      {
        stringId: 2,
        styleId: 3,
        maxLineWidth: 28,
        lineCount: 2,
        advances: [],
        positionalAdvances: [],
        contractions: [],
      },
    ]);
    // Two calls, one per hard line: an ordinary pair must not pay for advances.
    expect(fonts).toEqual(["400 16px Inter", "400 16px Inter"]);

    fonts.length = 0;
    expect(
      resources.measureSystemTextPairs(context, actions, [
        { stringId: 2, styleId: 3, measureAdvances: true },
      ]),
    ).toEqual([
      // The newline advances nothing because the caret returns to the line start.
      {
        stringId: 2,
        styleId: 3,
        measureAdvances: true,
        maxLineWidth: 28,
        lineCount: 2,
        // Ascending by code point, deduplicated, newline measured as zero.
        advances: [
          [0x0a, 0],
          [0x64, 7],
          [0x65, 7],
          [0x69, 7],
          [0x77, 7],
          [0x78, 7],
        ],
        // In string order from prefix differences; the newline resets the line.
        positionalAdvances: [7, 7, 7, 7, 0, 7, 7],
        // The fake context is linear in length, so nothing contracts.
        contractions: [],
      },
    ]);
    // Two lines, one call per distinct code point other than the newline ("x"
    // appears twice and is measured once), and one prefix call per code point
    // for the positional advances.
    expect(fonts).toHaveLength(18);

    fonts.length = 0;
    expect(
      resources.measureSystemTextPairs(context, actions, [
        // IME preedit code points are in no Scene string, so they arrive here.
        { stringId: 2, styleId: 3, measureAdvances: true, extraCodePoints: [0x4e2d, 0x77] },
      ])[0]?.advances,
    ).toEqual([
      [0x0a, 0],
      [0x64, 7],
      [0x65, 7],
      [0x69, 7],
      [0x77, 7],
      [0x78, 7],
      [0x4e2d, 7],
    ]);
    // The extra "w" was already measured for the string, so it costs nothing
    // beyond the prefix calls for the positional advances.
    expect(fonts).toHaveLength(20);
    expect(resources.getText(2)).toBeUndefined();
    expect(resources.getTextStyle(3)).toBeUndefined();
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

  it("does not install ordinary resources when the same frame has an invalid glyph batch", () => {
    const resources = new Canvas2DResourceRegistry();
    expect(() =>
      resources.applyResourceTransaction(
        [{ type: "define", id: 1, kind: ResourceKind.Paint, bytes: solidPaint() }],
        Uint8Array.of(1, 2, 3, 4),
      ),
    ).toThrow();
    expect(resources.getPaint(1)).toBeUndefined();
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

    resources.defineEncodedResource(3, ResourceKind.Font, sfntFont());
    expect(resources.getFont(3)).toEqual({ faceIndex: 0, byteLength: 8 });
    resources.releaseEncodedResource(3, ResourceKind.Font);
    expect(resources.getFont(3)).toBeUndefined();
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

function textStyleV2(
  paintId: number,
  fontSize: number,
  lineHeight: number,
  weight: number,
  family: string,
  fontStyle: number,
  textAlign: number,
  whiteSpace: number,
  overflowWrap: number,
  textOverflow: number,
): Uint8Array {
  const encodedFamily = new TextEncoder().encode(family);
  const length = (28 + encodedFamily.length + 3) & ~3;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes[0] = RESOURCE_ENCODING_VERSION;
  bytes[1] = 2;
  bytes[2] = fontStyle;
  bytes[3] = textAlign;
  view.setUint32(4, paintId, true);
  view.setFloat32(8, fontSize, true);
  view.setFloat32(12, lineHeight, true);
  view.setUint16(16, weight, true);
  bytes[18] = whiteSpace;
  bytes[19] = overflowWrap;
  bytes[20] = textOverflow;
  view.setUint32(24, encodedFamily.length, true);
  bytes.set(encodedFamily, 28);
  return bytes;
}

function sfntFont(): Uint8Array {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  bytes[0] = RESOURCE_ENCODING_VERSION;
  bytes[1] = 1;
  view.setUint32(4, 0, true);
  view.setUint32(8, 8, true);
  bytes.set([0x4f, 0x54, 0x54, 0x4f, 0, 0, 0, 0], 12);
  return bytes;
}

describe("cssFont", () => {
  it("never quotes a generic family keyword", () => {
    // A quoted generic is a family name no font has, so the browser silently
    // renders the default face: measured in Chromium, '400 13px "sans-serif"'
    // gives the same advances as `serif`, not as `sans-serif`.
    expect(cssFont(400, 13, "sans-serif")).toBe("400 13px sans-serif");
    expect(cssFont(700, 16, "Serif")).toBe("700 16px serif");
    expect(cssFont(400, 13, "system-ui")).toBe("400 13px system-ui");
  });

  it("emits a family list per entry", () => {
    // Quoting the whole list would make it one nonexistent family name.
    expect(cssFont(400, 13, "Inter, Helvetica Neue, sans-serif")).toBe(
      "400 13px Inter, Helvetica Neue, sans-serif",
    );
  });

  it("quotes only names that need it, and keeps existing quotes", () => {
    expect(cssFont(400, 13, "2Fast")).toBe('400 13px "2Fast"');
    expect(cssFont(400, 13, "Noto Sans SC")).toBe("400 13px Noto Sans SC");
    expect(cssFont(400, 13, '"My Font"')).toBe('400 13px "My Font"');
  });

  it("falls back to a generic rather than leaving the font unset", () => {
    // An invalid shorthand is a no-op on a Canvas2D context, so the previous
    // draw's font would silently apply to this one.
    expect(cssFont(400, 13, " , ")).toBe("400 13px sans-serif");
  });
});
