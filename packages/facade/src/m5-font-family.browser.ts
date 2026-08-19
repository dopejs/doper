import { expect, it } from "vitest";

import { cssFont } from "@dopejs/pingo-backend-canvas2d";

/**
 * A unit test can only pin the string. What actually broke was how the browser
 * resolves it: a quoted generic is a family name no font has, and Canvas2D then
 * silently draws the default face instead of failing. Only a real browser can
 * tell the two apart, so the assertion is on measured advances.
 */
it("resolves a generic family instead of falling through to the default face", () => {
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 60;
  document.body.append(canvas);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("2d context unavailable");

  const widthOf = (font: string): number => {
    context.font = font;
    return context.measureText("canvas 原生编辑").width;
  };

  const generic = widthOf("400 13px sans-serif");
  const quoted = widthOf('400 13px "sans-serif"');
  const fallthrough = widthOf('400 13px "no-such-family-here"');

  // The quoted form is indistinguishable from naming a font that does not
  // exist: that is the defect, and it is what the backend used to emit.
  expect(quoted).toBeCloseTo(fallthrough, 3);
  expect(generic).not.toBeCloseTo(fallthrough, 1);

  expect(widthOf(cssFont(400, 13, "sans-serif"))).toBeCloseTo(generic, 3);
  expect(widthOf(cssFont(400, 13, "no-such-family-here, sans-serif"))).toBeCloseTo(generic, 3);
});
