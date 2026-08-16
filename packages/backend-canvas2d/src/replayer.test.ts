import { describe, expect, it } from "vitest";

import { ABI_VERSION, DISPLAY_LIST_MAGIC, DisplayOpcode, STREAM_HEADER_BYTES } from "./generated";
import { Canvas2DReplayer, type Canvas2DContext } from "./replayer";
import { Canvas2DResourceRegistry } from "./resources";

function glyphSpan(spanId: number) {
  return { spanId, paintId: 1, bitmaps: [], placements: [] } as const;
}

describe("Canvas2DReplayer", () => {
  it("validates all commands and resources before touching canvas", () => {
    const calls: unknown[][] = [];
    const context = fakeContext(calls);
    const resources = new Canvas2DResourceRegistry();
    const golden = fromHex(
      "444f504401001000440000000400000001000000040000000000000000000000000020440000f0431000000000008040000000410000c8420000a0410200000002000000",
    );

    expect(() => new Canvas2DReplayer().replay(context, golden, resources)).toThrow(
      /paint resource is missing/u,
    );
    expect(calls).toEqual([]);

    resources.definePaint(2, "#f00");
    expect(new Canvas2DReplayer().replay(context, golden, resources)).toEqual({
      commands: 4,
      pictures: 0,
      maximumPictureDepth: 0,
    });
    expect(calls).toEqual([
      ["save"],
      ["save"],
      ["beginPath"],
      ["rect", 0, 0, 640, 480],
      ["clip"],
      ["fillRect", 4, 8, 100, 20, "#f00"],
      ["restore"],
      ["restore"],
    ]);
  });

  it("expands immutable pictures with isolated translations", () => {
    const nested = displayList([
      command(DisplayOpcode.FillRect, 20, (view) => {
        writeF32s(view, 4, [1, 2, 3, 4]);
        view.setUint32(20, 7, true);
      }),
    ]);
    const root = displayList([
      command(DisplayOpcode.DrawPicture, 12, (view) => {
        view.setUint32(4, 9, true);
        writeF32s(view, 8, [10, 20]);
      }),
    ]);
    const resources = new Canvas2DResourceRegistry();
    resources.definePaint(7, "blue");
    resources.definePicture(9, nested);
    nested.fill(0xff);
    const calls: unknown[][] = [];

    expect(new Canvas2DReplayer().replay(fakeContext(calls), root, resources)).toEqual({
      commands: 2,
      pictures: 1,
      maximumPictureDepth: 1,
    });
    expect(calls).toEqual([
      ["save"],
      ["save"],
      ["translate", 10, 20],
      ["fillRect", 1, 2, 3, 4, "blue"],
      ["restore"],
      ["restore"],
    ]);
  });

  it("rejects picture cycles before drawing", () => {
    const recursive = displayList([
      command(DisplayOpcode.DrawPicture, 12, (view) => {
        view.setUint32(4, 1, true);
        writeF32s(view, 8, [0, 0]);
      }),
    ]);
    const resources = new Canvas2DResourceRegistry();
    resources.definePicture(1, recursive);
    const calls: unknown[][] = [];
    expect(() => new Canvas2DReplayer().replay(fakeContext(calls), recursive, resources)).toThrow(
      /cycle/u,
    );
    expect(calls).toEqual([]);
  });

  it("replays every M1 backend command with resolved resources", () => {
    const resources = new Canvas2DResourceRegistry();
    const pathValue = {} as Path2D;
    const imageValue = {} as CanvasImageSource;
    resources.definePaint(1, "#123456");
    resources.definePath(2, pathValue);
    resources.defineFont(3, { faceIndex: 0, byteLength: 4 });
    resources.defineGlyphSpan(4, glyphSpan(4));
    resources.defineText(5, "hello");
    resources.defineTextStyle(6, {
      font: "500 14px Inter",
      fillStyle: "#abcdef",
      direction: "rtl",
      textAlign: "center",
      textBaseline: "middle",
    });
    resources.defineImage(7, imageValue);
    resources.drawGlyphRun = (context, fontId, size, x, y, glyphSpanId) => {
      expect(context).toBeDefined();
      calls.push(["glyph", fontId, size, x, y, glyphSpanId]);
    };
    const list = displayList([
      command(DisplayOpcode.Transform, 24, (view) => {
        writeF32s(view, 4, [1, 2, 3, 4, 5, 6]);
      }),
      command(DisplayOpcode.Alpha, 4, (view) => view.setFloat32(4, 0.5, true)),
      command(DisplayOpcode.FillRRect, 36, (view) => {
        writeF32s(view, 4, [1, 2, 30, 40, 3, 4, 5, 6]);
        view.setUint32(36, 1, true);
      }),
      command(DisplayOpcode.FillPath, 8, (view) => {
        view.setUint32(4, 2, true);
        view.setUint32(8, 1, true);
      }),
      command(DisplayOpcode.DrawGlyphRun, 20, (view) => {
        view.setUint32(4, 3, true);
        view.setFloat32(8, 16, true);
        writeF32s(view, 12, [10, 20]);
        view.setUint32(20, 4, true);
      }),
      command(DisplayOpcode.DrawTextFallback, 16, (view) => {
        view.setUint32(4, 5, true);
        view.setUint32(8, 6, true);
        writeF32s(view, 12, [11, 22]);
      }),
      inlineTextCommand(6, 12, 23, "编🙂"),
      command(DisplayOpcode.DrawImage, 36, (view) => {
        view.setUint32(4, 7, true);
        writeF32s(view, 8, [0, 1, 2, 3, 10, 11, 12, 13]);
      }),
    ]);
    const calls: unknown[][] = [];

    expect(new Canvas2DReplayer().replay(fakeContext(calls), list, resources).commands).toBe(8);
    expect(calls).toContainEqual(["transform", 1, 2, 3, 4, 5, 6]);
    expect(calls).toContainEqual(["roundRect", 1, 2, 30, 40, [3, 4, 5, 6]]);
    expect(calls).toContainEqual(["fillPath", pathValue, "#123456"]);
    expect(calls).toContainEqual(["glyph", 3, 16, 10, 20, 4]);
    expect(calls).toContainEqual([
      "fillText",
      "hello",
      11,
      22,
      "500 14px Inter",
      "#abcdef",
      "rtl",
      "center",
      "middle",
    ]);
    expect(calls).toContainEqual([
      "fillText",
      "编🙂",
      12,
      23,
      "500 14px Inter",
      "#abcdef",
      "rtl",
      "center",
      "middle",
    ]);
    expect(calls).toContainEqual(["drawImage", imageValue, 0, 1, 2, 3, 10, 11, 12, 13]);
  });

  it("replays system-font fallback hard lines with encoded line height", () => {
    const resources = new Canvas2DResourceRegistry();
    resources.defineText(1, "first\nsecond");
    resources.defineTextStyle(2, {
      font: "400 10px sans-serif",
      fillStyle: "black",
      lineHeight: 14,
    });
    const list = displayList([
      command(DisplayOpcode.DrawTextFallback, 16, (view) => {
        view.setUint32(4, 1, true);
        view.setUint32(8, 2, true);
        writeF32s(view, 12, [3, 5]);
      }),
    ]);
    const calls: unknown[][] = [];

    new Canvas2DReplayer().replay(fakeContext(calls), list, resources);

    expect(calls).toContainEqual([
      "fillText",
      "first",
      3,
      5,
      "400 10px sans-serif",
      "black",
      "inherit",
      "start",
      "alphabetic",
    ]);
    expect(calls).toContainEqual([
      "fillText",
      "second",
      3,
      19,
      "400 10px sans-serif",
      "black",
      "inherit",
      "start",
      "alphabetic",
    ]);
  });

  it("rejects invalid numeric commands before touching canvas", () => {
    const resources = new Canvas2DResourceRegistry();
    resources.definePaint(1, "red");
    resources.defineFont(2, { faceIndex: 0, byteLength: 4 });
    resources.defineGlyphSpan(3, glyphSpan(3));
    const cases = [
      command(DisplayOpcode.Alpha, 4, (view) => view.setFloat32(4, 1.1, true)),
      command(DisplayOpcode.FillRRect, 36, (view) => {
        writeF32s(view, 4, [0, 0, 10, 10, -1, 0, 0, 0]);
        view.setUint32(36, 1, true);
      }),
      command(DisplayOpcode.DrawGlyphRun, 20, (view) => {
        view.setUint32(4, 2, true);
        view.setFloat32(8, -1, true);
        writeF32s(view, 12, [0, 0]);
        view.setUint32(20, 3, true);
      }),
    ];
    for (const invalid of cases) {
      const calls: unknown[][] = [];
      expect(() =>
        new Canvas2DReplayer().replay(fakeContext(calls), displayList([invalid]), resources),
      ).toThrow();
      expect(calls).toEqual([]);
    }
  });
});

function displayList(commands: readonly Uint8Array[]): Uint8Array {
  const byteLength =
    STREAM_HEADER_BYTES + commands.reduce((sum, command) => sum + command.length, 0);
  const result = new Uint8Array(byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, DISPLAY_LIST_MAGIC, true);
  view.setUint16(4, ABI_VERSION, true);
  view.setUint16(6, STREAM_HEADER_BYTES, true);
  view.setUint32(8, byteLength, true);
  view.setUint32(12, commands.length, true);
  let offset = STREAM_HEADER_BYTES;
  for (const commandBytes of commands) {
    result.set(commandBytes, offset);
    offset += commandBytes.length;
  }
  return result;
}

function command(
  opcode: DisplayOpcode,
  payloadBytes: number,
  write: (view: DataView) => void,
): Uint8Array {
  const result = new Uint8Array(4 + payloadBytes);
  result[0] = opcode;
  write(new DataView(result.buffer));
  return result;
}

function inlineTextCommand(styleId: number, x: number, y: number, text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const padding = (4 - (encoded.byteLength % 4)) % 4;
  return command(
    DisplayOpcode.DrawTextInlineFallback,
    16 + encoded.byteLength + padding,
    (view) => {
      view.setUint32(4, styleId, true);
      writeF32s(view, 8, [x, y]);
      view.setUint32(16, encoded.byteLength, true);
      new Uint8Array(view.buffer).set(encoded, 20);
    },
  );
}

function writeF32s(view: DataView, offset: number, values: readonly number[]): void {
  for (const value of values) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }
}

function fakeContext(calls: unknown[][]): Canvas2DContext {
  const state = {
    direction: "inherit" as CanvasDirection,
    fillStyle: "",
    font: "",
    globalAlpha: 1,
    textAlign: "start" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
  };
  return {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      state.fillStyle = typeof value === "string" ? value : "[canvas-style]";
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(value: number) {
      state.globalAlpha = value;
    },
    get direction() {
      return state.direction;
    },
    set direction(value: CanvasDirection) {
      state.direction = value;
    },
    get font() {
      return state.font;
    },
    set font(value: string) {
      state.font = value;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(value: CanvasTextAlign) {
      state.textAlign = value;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(value: CanvasTextBaseline) {
      state.textBaseline = value;
    },
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    beginPath: () => calls.push(["beginPath"]),
    rect: (...values: number[]) => calls.push(["rect", ...values]),
    clip: () => calls.push(["clip"]),
    fillRect: (...values: number[]) => calls.push(["fillRect", ...values, state.fillStyle]),
    translate: (...values: number[]) => calls.push(["translate", ...values]),
    transform: (...values: number[]) => calls.push(["transform", ...values]),
    roundRect: (x: number, y: number, width: number, height: number, radii: unknown) =>
      calls.push(["roundRect", x, y, width, height, radii]),
    fill: (path?: Path2D) =>
      calls.push(path === undefined ? ["fill"] : ["fillPath", path, state.fillStyle]),
    fillText: (text: string, x: number, y: number) =>
      calls.push([
        "fillText",
        text,
        x,
        y,
        state.font,
        state.fillStyle,
        state.direction,
        state.textAlign,
        state.textBaseline,
      ]),
    drawImage: (image: CanvasImageSource, ...values: number[]) =>
      calls.push(["drawImage", image, ...values]),
  } as unknown as Canvas2DContext;
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
}
