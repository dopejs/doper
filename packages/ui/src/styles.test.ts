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

  it("lets the product molecules push their trailing slots to the edge", () => {
    // These three are the first real consumers of flexGrow: the growing column
    // is what puts actions, deltas and trailing slots on the far edge without
    // anyone measuring anything.
    for (const className of ["pui-topbar__title", "pui-statcard__value", "pui-list-row__text"]) {
      const style = resolve(className);
      expect(style.flexGrow, className).toBe(1);
      expect(style.flexShrink, className).toBe(1);
      expect(style.flexBasis, className).toBe("0px");
    }
    expect(resolve("pui-topbar").flexDirection).toBe("row");
    expect(resolve("pui-list-row").flexDirection).toBe("row");
    expect(resolve("pui-sidebar").flexDirection).toBe("column");
    // A trend colour comes from the token ramp, and themes with the skin.
    expect(resolve("pui-statcard__delta--up").color).toBe("#16a34aff");
    expect(resolve("pui-statcard__delta--up pui-dark").color).toBe("#4ade80ff");
  });

  it("layers overlays above page content and pins them to their parent", () => {
    const overlay = resolve("pui-overlay");
    expect(overlay.position).toBe("absolute");
    expect(overlay.zIndex).toBe(1100);
    // inset:0 fills the parent, which is the containing block in this engine.
    expect([overlay.top, overlay.right, overlay.bottom, overlay.left]).toEqual([
      "0px",
      "0px",
      "0px",
      "0px",
    ]);

    // An anchored surface hangs off the bottom of its anchor and sits on the
    // dropdown layer, below a modal and below a toast.
    const anchored = resolve("pui-anchor__content");
    expect(anchored.position).toBe("absolute");
    expect(anchored.top).toBe("100%");
    expect(anchored.zIndex).toBe(1000);
    expect(resolve("pui-toast__viewport").zIndex).toBe(1200);
  });

  it("gives the card an elevation that themes with the skin", () => {
    expect(resolve("pui-card").boxShadow).toBe("0px 1px 2px 0px #0000000d");
    expect(resolve("pui-card pui-dark").boxShadow).toBe("0px 1px 2px 0px #00000066");
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
