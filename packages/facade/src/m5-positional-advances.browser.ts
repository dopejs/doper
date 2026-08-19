import { expect, it } from "vitest";

import { Canvas2DResourceRegistry, ResourceKind } from "@dopejs/pingo-backend-canvas2d";

/**
 * The per-code-point table sums isolated widths, and a real font applies
 * contextual contraction a unit fake cannot: Chromium renders consecutive
 * full-width punctuation narrower than two isolated marks. The positional
 * advances are prefix differences, so their sum must equal the width of the
 * rendered line — that equality is exactly what places the caret on the glyphs.
 */
it("positional advances sum to the true rendered line width", () => {
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 60;
  document.body.append(canvas);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("2d context unavailable");

  const text = "IME、、撤销\n第二行";
  const registry = new Canvas2DResourceRegistry();
  const actions = [
    {
      type: "define" as const,
      id: 2,
      kind: ResourceKind.Utf8String,
      bytes: new TextEncoder().encode(text),
    },
    {
      type: "define" as const,
      id: 3,
      kind: ResourceKind.TextStyle,
      bytes: textStyle(16),
    },
  ];
  const [metric] = registry.measureSystemTextPairs(context, actions, [
    { stringId: 2, styleId: 3, measureAdvances: true },
  ]);
  if (metric === undefined) throw new Error("metric missing");

  context.font = "400 16px sans-serif";
  const lines = text.split("\n");
  const codePoints = [...text];
  expect(metric.positionalAdvances).toHaveLength(codePoints.length);
  let cursor = 0;
  for (const line of lines) {
    const lineCodePoints = [...line].length;
    const sum = metric.positionalAdvances
      .slice(cursor, cursor + lineCodePoints)
      .reduce((total, advance) => total + advance, 0);
    expect(sum).toBeCloseTo(context.measureText(line).width, 2);
    cursor += lineCodePoints + 1;
  }

  // Whether the font contracts consecutive full-width punctuation is a
  // platform property (macOS PingFang does, the CI Linux fonts do not), so it
  // cannot be a hard assertion. What must hold everywhere is the invariant
  // above: the positional sum equals the rendered width, contracted or not.
  //
  // Where it does contract, the table must carry it: positional advances stop
  // applying the moment the editing value diverges from the measured string,
  // and an application is never required to write the value back.
  const isolated = context.measureText("\u3001").width * 2;
  const together = context.measureText("\u3001\u3001").width;
  if (Math.abs(together - isolated) > 0.01) {
    const entry = metric.contractions.find(
      ([first, second]) => first === 0x3001 && second === 0x3001,
    );
    expect(entry, "a contracting pair must reach Core").toBeDefined();
    expect(entry?.[2]).toBeCloseTo(together - isolated, 2);

    // Which half the font trims decides where the caret between the pair goes,
    // so the attribution is checked against ink, independently of the advance
    // arithmetic that produced it.
    const single = context.measureText("\u3001").width;
    expect(entry?.[3]).toBeCloseTo(inkOffsetOfSecond(context) - single, 1);
  }
});

/**
 * Where the second glyph of a contracting pair actually starts, from pixels.
 *
 * Independent ground truth: reading it off the same `measureText` model the
 * production path uses would make the assertion circular.
 */
function inkOffsetOfSecond(reference: CanvasRenderingContext2D): number {
  const canvas = document.createElement("canvas");
  canvas.width = 120;
  canvas.height = 30;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("2d context unavailable");
  const blobs = (text: string): Array<readonly [number, number]> => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = reference.font;
    context.fillStyle = "#000";
    context.textBaseline = "alphabetic";
    context.fillText(text, 0, 22);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const found: Array<readonly [number, number]> = [];
    let start = -1;
    for (let x = 0; x <= canvas.width; x += 1) {
      const inked =
        x < canvas.width &&
        Array.from(
          { length: canvas.height },
          (_, y) => data[(y * canvas.width + x) * 4 + 3] ?? 0,
        ).some((alpha) => alpha > 40);
      if (inked) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        found.push([start, x - 1]);
        start = -1;
      }
    }
    return found;
  };
  const one = blobs("\u3001");
  const two = blobs("\u3001\u3001");
  const firstInk = one[0];
  const secondInk = two[1];
  if (firstInk === undefined || secondInk === undefined) {
    throw new Error("the mark did not render as two separate blobs");
  }
  return secondInk[0] - firstInk[0];
}

function textStyle(fontSize: number): Uint8Array {
  const family = new TextEncoder().encode("sans-serif");
  const bytes = new Uint8Array((24 + family.length + 3) & ~3);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes[1] = 1;
  view.setUint32(4, 1, true);
  view.setFloat32(8, fontSize, true);
  view.setFloat32(12, fontSize * 1.25, true);
  view.setUint16(16, 400, true);
  view.setUint32(20, family.length, true);
  bytes.set(family, 24);
  return bytes;
}
