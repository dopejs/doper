import { expect, it } from "vitest";

import { Canvas2DResourceRegistry, ResourceKind } from "@dopejs/doper-backend-canvas2d";

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
});

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
