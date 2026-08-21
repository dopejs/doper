import { describe, expect, it } from "vitest";

import { STYLE_INTERACTION_STATES, resolveStyle } from "@dopejs/pingo-style";

import { createPingoUiStyleSheet, pingoUiCssText } from "./generated/styles";

const styleSheets = [createPingoUiStyleSheet()];

function resolve(className: string, interactionState = 0) {
  const result = resolveStyle({ nodeType: "view", className, styleSheets, interactionState });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.style;
}

describe("pingo-ui skin", () => {
  it("compiles without diagnostics", () => {
    expect(pingoUiCssText).toContain(".pui-button--default:hover");
    expect(pingoUiCssText).toContain(".pui-button--default.pui-dark");
  });

  it("resolves the default button in light theme", () => {
    const style = resolve("pui-button pui-button--default");
    expect(style.backgroundColor).toBe("#18181bff");
    expect(style.color).toBe("#fafafaff");
    expect(style.height).toBe("36px");
  });

  it("resolves hover state from the precompiled interaction rules", () => {
    const style = resolve("pui-button pui-button--default", STYLE_INTERACTION_STATES.hover);
    expect(style.backgroundColor).toBe("#18181be6");
  });

  it("resolves the dark compound override", () => {
    const style = resolve("pui-button pui-button--default pui-dark");
    expect(style.backgroundColor).toBe("#fafafaff");
    expect(style.color).toBe("#18181bff");
  });

  it("dark hover wins over light hover by source order", () => {
    const style = resolve(
      "pui-button pui-button--default pui-dark",
      STYLE_INTERACTION_STATES.hover,
    );
    expect(style.backgroundColor).toBe("#fafafae6");
  });

  it("resolves muted description color in dark theme", () => {
    const style = resolve("pui-card-description pui-dark");
    expect(style.color).toBe("#a1a1aaff");
  });
});
