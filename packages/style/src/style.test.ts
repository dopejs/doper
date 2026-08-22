import { describe, expect, it } from "vitest";

import {
  CSS_SUBSET_VERSION,
  STYLE_INTERACTION_STATES,
  STYLE_PROPERTIES,
  type STYLE_SHORTHANDS,
  StyleSheetCompileError,
  compileStyleSheet,
  createStyleSheet,
  resolveInteractionStyles,
  resolveStyle,
  styleCapabilities,
  supportsStyle,
  type PingoStyle,
} from "./index";
import { sha256 } from "./hash";

describe("style schema capabilities", () => {
  it("uses a stable SHA-256 stylesheet identity", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("exposes every generated longhand without claiming Core support", () => {
    const capabilities = styleCapabilities();
    expect(capabilities.cssSubsetVersion).toBe(CSS_SUBSET_VERSION);
    expect(capabilities.resolverReady).toBe(true);
    expect(capabilities.engineReady).toBe(true);
    expect(capabilities.properties).toHaveLength(Object.keys(STYLE_PROPERTIES).length);
    expect(capabilities.properties.every((property) => property.engineSupport === "m6-core")).toBe(
      true,
    );
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.properties)).toBe(true);
  });

  it("accepts every schema initial value and representative shorthands", () => {
    for (const property of Object.values(STYLE_PROPERTIES)) {
      expect(supportsStyle(property.jsName, property.initial), property.jsName).toBe(true);
    }
    const shorthandExamples: Readonly<Record<keyof typeof STYLE_SHORTHANDS, unknown>> = {
      border: "1px solid #abc",
      borderColor: "#abc #1234",
      borderStyle: "solid",
      borderWidth: "1px 2px 3px 4px",
      flex: "1 1 auto",
      gap: "8px 12px",
      inset: "0 auto",
      margin: "auto 2px",
      overflow: "hidden auto",
      padding: 8,
    };
    for (const [name, value] of Object.entries(shorthandExamples)) {
      expect(supportsStyle(name, value), name).toBe(true);
    }
    expect(supportsStyle("width", "calc(100% - 1px)")).toBe(false);
    expect(supportsStyle("width", "10")).toBe(false);
    expect(supportsStyle("width", 10)).toBe(true);
    expect(supportsStyle("transform", "scale(nope)")).toBe(false);
    expect(supportsStyle("transform", "translate(10px, 20%) rotate(0.5turn)")).toBe(true);
    // `position: absolute` is in the subset since E3; `relative` is not.
    expect(supportsStyle("position", "absolute")).toBe(true);
    expect(supportsStyle("position", "relative")).toBe(false);
  });
});

describe("stylesheet compilation", () => {
  it("compiles class and compound-class rules into an immutable sheet", () => {
    const sheet = createStyleSheet(
      `
        /* stable source offsets */
        .button { color: #abc; padding: 4px 8px; }
        .button.primary, .cta { color: #123456; opacity: 1.5; }
      `,
      { sourceName: "controls.css" },
    );
    expect(sheet.cssSubsetVersion).toBe(CSS_SUBSET_VERSION);
    expect(sheet.ruleCount).toBe(3);
    expect(sheet.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(sheet.featureBits).not.toBe(0);
    expect(Object.isFrozen(sheet)).toBe(true);
  });

  it("keeps class matching case-sensitive while CSS names, units, and keywords are insensitive", () => {
    const sheet = createStyleSheet('.Card { WIDTH: 10PX; DISPLAY: FLEX; font-family: "a}b"; }');
    expect(
      resolveStyle({ nodeType: "view", className: "Card", styleSheets: [sheet] }).style,
    ).toMatchObject({ width: "10px", display: "flex", fontFamily: '"a}b"' });
    expect(
      resolveStyle({ nodeType: "view", className: "card", styleSheets: [sheet] }).style.width,
    ).toBe("auto");
  });

  it("supports the type-safe object form with or without a leading dot", () => {
    const first = createStyleSheet({
      "button": { color: "#fff", margin: "1px 2px 3px" },
      ".button.primary": { backgroundColor: "transparent" },
    });
    const second = createStyleSheet({
      "button": { color: "#fff", margin: "1px 2px 3px" },
      ".button.primary": { backgroundColor: "transparent" },
    });
    expect(first.ruleCount).toBe(2);
    expect(first.contentHash).toBe(second.contentHash);
  });

  it("returns structured source diagnostics and the throwing API preserves them", () => {
    const result = compileStyleSheet(
      ".ok { width: 10px; }\n.bad > .child { mystery: 1px !important; }",
      { sourceName: "bad.css" },
    );
    expect(result.styleSheet).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({
      code: "unsupported-selector",
      location: { line: 2, sourceName: "bad.css" },
    });
    expect(() =>
      createStyleSheet(".bad { width: calc(100% - 1px); }", { sourceName: "bad.css" }),
    ).toThrow(StyleSheetCompileError);
    try {
      createStyleSheet(".bad { color: red !important; }");
    } catch (error) {
      expect(error).toBeInstanceOf(StyleSheetCompileError);
      expect((error as StyleSheetCompileError).diagnostics[0]?.code).toBe(
        "important-not-supported",
      );
    }
  });

  it("compiles same-node interaction pseudos and rejects feedback-loop declarations", () => {
    const sheet = createStyleSheet(`
      :focus-visible { color: #fff; }
      .button:hover, .button.primary:active:focus { opacity: 0.5; cursor: pointer; }
    `);
    expect(sheet.ruleCount).toBe(3);

    const invalid = compileStyleSheet(".button:hover { width: 10px; overflow: hidden; }");
    expect(invalid.styleSheet).toBeNull();
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "state-property-not-supported",
      "state-property-not-supported",
      "state-property-not-supported",
    ]);
  });

  it("rejects an automatic minimum the subset cannot compute", () => {
    // `min-width: auto` is min-content in CSS. This subset has no intrinsic
    // measurement, so accepting it would silently mean `0` — the opposite of
    // the floor the author asked for. Rejecting makes the gap visible at
    // compile time; see the flex-item-minimum note in docs/style-support.md.
    for (const property of ["min-width", "min-height"]) {
      const result = compileStyleSheet(`.a { ${property}: auto; }`);
      expect(result.styleSheet).toBeNull();
      expect(result.diagnostics[0]).toMatchObject({ code: "unsupported-value", property });
      // Negative minimums are not CSS either, and would silently do nothing.
      expect(compileStyleSheet(`.a { ${property}: -1px; }`).diagnostics[0]?.code).toBe(
        "unsupported-value",
      );
      // Lengths and percentages still compile: only the two lies are gone.
      expect(compileStyleSheet(`.a { ${property}: 50%; }`).styleSheet).not.toBeNull();
    }
    // `auto` stays meaningful where the subset can honour it.
    expect(compileStyleSheet(".a { width: auto; margin-left: auto; }").styleSheet).not.toBeNull();
  });

  it("rejects malformed CSS, unsupported values, and invalid object rules", () => {
    expect(compileStyleSheet("/* open").diagnostics[0]?.code).toBe("invalid-css");
    expect(compileStyleSheet(".a color: #fff").diagnostics[0]?.code).toBe("invalid-css");
    expect(compileStyleSheet(".a { color #fff; }").diagnostics[0]?.code).toBe("invalid-css");
    expect(compileStyleSheet(".a { unknown: 1; }").diagnostics[0]?.code).toBe("unknown-property");
    expect(compileStyleSheet(".a { padding: -1px; }").diagnostics[0]?.code).toBe(
      "unsupported-value",
    );
    expect(
      compileStyleSheet(`.a { color: #fff; }${" ".repeat(1_048_576)}`).diagnostics[0]?.code,
    ).toBe("invalid-css");
    expect(
      compileStyleSheet({ invalid: null as unknown as Record<string, never> }).diagnostics[0]?.code,
    ).toBe("invalid-css");
  });
});

describe("computed style resolver", () => {
  it("applies specificity, source order, inline, and legacy migration priority", () => {
    const base = createStyleSheet(`
      .button { color: #111; width: 10px; }
      .button.primary { color: #222; }
      .button { color: #333; }
    `);
    const later = createStyleSheet(".button { width: 20px; }");
    const result = resolveStyle({
      nodeType: "view",
      className: "button primary",
      styleSheets: [base, later],
      inlineStyle: { color: "#444", width: 30 },
      legacyStyle: { width: 40 },
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "legacy-direct-prop-conflict",
        property: "width",
        severity: "warning",
      }),
    ]);
    expect(result.style.color).toBe("#444444ff");
    expect(result.style.width).toBe("40px");
  });

  it("expands inset and accepts only the positioning keywords", () => {
    const result = resolveStyle({
      nodeType: "view",
      inlineStyle: { position: "absolute", inset: "0 auto 4px 8px" },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.style).toMatchObject({
      position: "absolute",
      top: "0px",
      right: "auto",
      bottom: "4px",
      left: "8px",
    });
    expect(resolveStyle({ nodeType: "view", inlineStyle: { inset: 0 } }).style.left).toBe("0px");

    expect(supportsStyle("position", "static")).toBe(true);
    // relative and fixed are deliberately absent; see docs/style-support.md.
    for (const invalid of ["relative", "fixed", "sticky", "auto"]) {
      expect(supportsStyle("position", invalid), invalid).toBe(false);
    }
  });

  it("accepts an integer or auto z-index and nothing else", () => {
    const zIndex = (value: unknown): unknown =>
      resolveStyle({ nodeType: "view", inlineStyle: { zIndex: value } as PingoStyle }).style.zIndex;

    expect(zIndex("auto")).toBe("auto");
    expect(zIndex(0)).toBe(0);
    expect(zIndex(1200)).toBe(1200);
    expect(zIndex(-1)).toBe(-1);
    for (const invalid of [1.5, "1px", "10%", Number.NaN, Infinity, "top"]) {
      expect(supportsStyle("zIndex", invalid), String(invalid)).toBe(false);
    }
  });

  it("canonicalizes box-shadow layers and rejects inset", () => {
    const shadow = (value: unknown): unknown =>
      resolveStyle({ nodeType: "view", inlineStyle: { boxShadow: value } as PingoStyle }).style
        .boxShadow;

    expect(shadow("none")).toBe("none");
    expect(shadow("0 1px 2px rgba(0, 0, 0, 0.1)")).toBe("0px 1px 2px 0px #0000001a");
    expect(shadow("2px 4px 8px 1px #abc")).toBe("2px 4px 8px 1px #aabbccff");
    // Two layers, and the comma inside rgba() must not split them.
    expect(shadow("0 1px 2px rgba(0,0,0,.1), 0 2px 4px rgba(0,0,0,.1)")).toBe(
      "0px 1px 2px 0px #0000001a, 0px 2px 4px 0px #0000001a",
    );
    // A missing color takes the CSS initial, which is the current color; the
    // subset has no currentColor for shadows, so it takes opaque black.
    expect(shadow("1px 2px")).toBe("1px 2px 0px 0px #000000ff");
    // Offsets and spread may be negative; blur may not.
    expect(shadow("-1px -2px 3px -4px #000")).toBe("-1px -2px 3px -4px #000000ff");

    for (const invalid of [
      "inset 0 1px 2px #000",
      "0 1px -2px #000",
      "0",
      "0 1px 2px 3px 4px #000",
      "0 1px 2px #000, ",
      "0 1px 2px #000, 0 1px 2px #000, 0 1px 2px #000, 0 1px 2px #000, 0 1px 2px #000",
      "0 1px 2px notacolor",
    ]) {
      expect(supportsStyle("boxShadow", invalid), invalid).toBe(false);
    }
  });

  it("expands every documented flex shorthand form and rejects the rest", () => {
    const expand = (value: unknown): Record<string, unknown> => {
      const result = resolveStyle({ nodeType: "view", inlineStyle: { flex: value } as PingoStyle });
      expect(result.diagnostics, JSON.stringify(value)).toEqual([]);
      return {
        flexGrow: result.style.flexGrow,
        flexShrink: result.style.flexShrink,
        flexBasis: result.style.flexBasis,
      };
    };
    expect(expand("none")).toEqual({ flexGrow: 0, flexShrink: 0, flexBasis: "auto" });
    expect(expand("auto")).toEqual({ flexGrow: 1, flexShrink: 1, flexBasis: "auto" });
    expect(expand(2)).toEqual({ flexGrow: 2, flexShrink: 1, flexBasis: "0px" });
    expect(expand("2 3")).toEqual({ flexGrow: 2, flexShrink: 3, flexBasis: "0px" });
    expect(expand("2 40px")).toEqual({ flexGrow: 2, flexShrink: 1, flexBasis: "40px" });
    expect(expand("2 3 25%")).toEqual({ flexGrow: 2, flexShrink: 3, flexBasis: "25%" });
    expect(expand("2 3 auto")).toEqual({ flexGrow: 2, flexShrink: 3, flexBasis: "auto" });
    expect(expand("30px")).toEqual({ flexGrow: 1, flexShrink: 1, flexBasis: "30px" });

    for (const invalid of ["-1", "1 -1", "1 2 3 4", "1 2 nope", "", "1 solid"]) {
      expect(supportsStyle("flex", invalid), invalid).toBe(false);
    }
    expect(supportsStyle("flexGrow", -1)).toBe(false);
    expect(supportsStyle("flexShrink", "2")).toBe(true);
    expect(supportsStyle("flexBasis", "auto")).toBe(true);
  });

  it("expands box/gap/border shorthands and canonicalizes colors and numbers", () => {
    const result = resolveStyle({
      nodeType: "view",
      inlineStyle: {
        padding: "1px 2px 3px",
        gap: "4px 5%",
        border: "2px solid #abc",
        opacity: 2,
      },
    });
    expect(result.style).toMatchObject({
      paddingTop: "1px",
      paddingRight: "2px",
      paddingBottom: "3px",
      paddingLeft: "2px",
      rowGap: "4px",
      columnGap: "5%",
      borderTopWidth: "2px",
      borderRightStyle: "solid",
      borderBottomColor: "#aabbccff",
      opacity: 1,
    });
  });

  it("canonicalizes legacy and modern RGB/HSL color functions to rgba8", () => {
    const style = resolveStyle({
      nodeType: "view",
      inlineStyle: {
        color: "rgb(255, 0, 127)",
        backgroundColor: "rgb(100% 0% 50% / 25%)",
        borderTopColor: "hsl(120, 100%, 50%)",
        borderRightColor: "hsla(0.5turn 100% 25% / 0.5)",
        borderBottomColor: "rgba(300, -1, 0, 2)",
      },
    }).style;
    expect(style).toMatchObject({
      color: "#ff007fff",
      backgroundColor: "#ff008040",
      borderTopColor: "#00ff00ff",
      borderRightColor: "#00808080",
      borderBottomColor: "#ff0000ff",
    });
    expect(supportsStyle("color", "hsl(-120deg 100% 50%)")).toBe(true);
    expect(supportsStyle("color", "rgb(1, 2 3)")).toBe(false);
    expect(supportsStyle("color", "hsl(10 20 30)")).toBe(false);
    expect(supportsStyle("color", "hsl(1e308turn 100% 50%)")).toBe(false);
    expect(supportsStyle("color", "color(display-p3 1 0 0)")).toBe(false);
  });

  it("implements inheritance/global keywords and resolves currentColor", () => {
    const parent = resolveStyle({
      nodeType: "view",
      inlineStyle: { color: "#123456", visibility: "hidden" },
    }).style;
    const child = resolveStyle({
      nodeType: "text",
      parentStyle: parent,
      inlineStyle: { color: "unset", visibility: "inherit", fontSize: "initial" },
    });
    expect(child.style.color).toBe("#123456ff");
    expect(child.style.visibility).toBe("hidden");
    expect(child.style.fontSize).toBe("16px");

    const bordered = resolveStyle({
      nodeType: "view",
      inlineStyle: { color: "#abcdef", borderColor: "currentColor" },
    });
    expect(bordered.style.borderLeftColor).toBe("#abcdefff");
  });

  it("applies the two-axis overflow computed-value coupling", () => {
    expect(
      resolveStyle({
        nodeType: "view",
        inlineStyle: { overflowX: "visible", overflowY: "auto" },
      }).style,
    ).toMatchObject({ overflowX: "auto", overflowY: "auto" });
    expect(
      resolveStyle({
        nodeType: "view",
        inlineStyle: { overflowX: "clip", overflowY: "scroll" },
      }).style,
    ).toMatchObject({ overflowX: "hidden", overflowY: "scroll" });
  });

  it("cascades interaction rules from a validated state bitset", () => {
    const sheet = createStyleSheet(`
      .button { color: #111; opacity: 1; }
      .button:hover { color: #222; }
      .button:hover:active { color: #333; opacity: 0.6; }
      :focus-visible { cursor: text; }
    `);
    const base = { nodeType: "view" as const, className: "button", styleSheets: [sheet] };
    expect(resolveStyle(base).style).toMatchObject({ color: "#111111ff", opacity: 1 });
    expect(
      resolveStyle({ ...base, interactionState: STYLE_INTERACTION_STATES.hover }).style,
    ).toMatchObject({ color: "#222222ff", opacity: 1 });
    expect(
      resolveStyle({
        ...base,
        interactionState: STYLE_INTERACTION_STATES.hover | STYLE_INTERACTION_STATES.active,
      }).style,
    ).toMatchObject({ color: "#333333ff", opacity: 0.6 });
    expect(
      resolveStyle({
        ...base,
        interactionState: STYLE_INTERACTION_STATES["focus-visible"],
      }).style.cursor,
    ).toBe("text");
    expect(() => resolveStyle({ ...base, interactionState: 1 << 7 })).toThrow(RangeError);

    const compiled = resolveInteractionStyles(base);
    expect(compiled.variants).toHaveLength(12);
    expect(compiled.variants.find((variant) => variant.stateMask === 0b0011)?.style).toMatchObject({
      color: "#333333ff",
      opacity: 0.6,
    });
    expect(compiled.variants.find((variant) => variant.stateMask === 0b1000)?.style).toMatchObject({
      cursor: "text",
    });
  });

  it("normalizes keyword positions without swapping their axes", () => {
    expect(
      resolveStyle({ nodeType: "image", inlineStyle: { objectPosition: "top right" } }).style
        .objectPosition,
    ).toBe("100% 0%");
    expect(
      resolveStyle({ nodeType: "image", inlineStyle: { objectPosition: "bottom" } }).style
        .objectPosition,
    ).toBe("50% 100%");
  });

  it("reports invalid class tokens, forged sheets, values, and node applicability", () => {
    const result = resolveStyle({
      nodeType: "text",
      className: "valid bad$class",
      styleSheets: [
        {
          cssSubsetVersion: CSS_SUBSET_VERSION,
          contentHash: "forged",
          featureBits: 0,
          ruleCount: 0,
        },
      ],
      inlineStyle: { objectFit: "cover", width: Number.NaN },
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "invalid-class-name",
      "invalid-css",
      "property-not-applicable",
      "unsupported-value",
    ]);
  });
});
