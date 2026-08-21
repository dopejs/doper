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

  it("gives the input field the remaining line and pins its adornments", () => {
    const shell = resolve("pui-input");
    expect(shell.flexDirection).toBe("row");
    expect(shell.columnGap).toBe("8px");

    const field = resolveStyle({
      nodeType: "input",
      className: "pui-input__field",
      styleSheets,
    }).style;
    expect(field.flexGrow).toBe(1);
    expect(field.flexShrink).toBe(1);
    expect(field.flexBasis).toBe("0px");

    for (const slot of ["pui-input__prefix", "pui-input__suffix"]) {
      const style = resolve(slot);
      expect(style.flexGrow, slot).toBe(0);
      expect(style.flexShrink, slot).toBe(0);
      expect(style.flexBasis, slot).toBe("auto");
      expect(style.color, slot).toBe("#71717aff");
    }
    expect(resolve("pui-input__prefix pui-dark").color).toBe("#a1a1aaff");
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
