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
      gap: "8px 12px",
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
    expect(supportsStyle("position", "absolute")).toBe(false);
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
