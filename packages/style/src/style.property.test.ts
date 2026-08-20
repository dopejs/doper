import { describe, expect, it } from "vitest";

import {
  STYLE_PROPERTIES,
  STYLE_INVALIDATION_DOMAINS,
  IncrementalStyleResolver,
  compileStyleSheet,
  createStyleSheet,
  resolveStyle,
  type ComputedStyle,
  type PingoStyle,
  type ResolveStyleOptions,
  type StyleInvalidationDomain,
  type StylePropertyName,
} from "./index";
import { resolveStyleReference } from "./reference-resolver";

describe("style parser fuzzing", () => {
  it("is non-throwing and deterministic for seeded arbitrary text", () => {
    const random = xorshift32(0x6a09e667);
    const alphabet =
      ".#{}:;,()[]/*!'\"\\-_ abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789%\n\t\u0000é中";

    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const length = randomInteger(random, 257);
      let source = "";
      for (let index = 0; index < length; index += 1) {
        source += alphabet[randomInteger(random, alphabet.length)] ?? "";
      }
      const first = compileStyleSheet(source, { sourceName: "fuzz.css" });
      const second = compileStyleSheet(source, { sourceName: "fuzz.css" });
      expect(second.diagnostics).toEqual(first.diagnostics);
      expect(second.styleSheet?.contentHash).toBe(first.styleSheet?.contentHash);
      expect(second.styleSheet?.ruleCount).toBe(first.styleSheet?.ruleCount);
    }
  });

  it("does not throw when diagnostics describe cyclic migration values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = resolveStyle({
      nodeType: "view",
      legacyStyle: { width: cyclic },
    });
    expect(result.diagnostics[0]).toMatchObject({ code: "unsupported-value", property: "width" });
  });
});

describe("reference cascade differential", () => {
  it("matches an independent candidate-list oracle across seeded cases", () => {
    const random = xorshift32(0xbb67ae85);

    for (let iteration = 0; iteration < 750; iteration += 1) {
      const sheet = createStyleSheet({
        "base": randomViewStyle(random),
        ".base.accent": randomViewStyle(random),
        "alternate": randomViewStyle(random),
      });
      const parentStyle = resolveStyle({
        nodeType: "view",
        inlineStyle: randomViewStyle(random),
      }).style;
      const options: ResolveStyleOptions = {
        nodeType: "view",
        className: choose(random, ["base", "base accent", "alternate", "missing", "base bad$"]),
        styleSheets: [sheet],
        inlineStyle: randomViewStyle(random),
        parentStyle,
        ...(randomInteger(random, 4) === 0
          ? { legacyStyle: { width: choose(random, [4, 12, Number.NaN]) } }
          : {}),
      };
      expect(resolveStyle(options), `seeded case ${String(iteration)}`).toEqual(
        resolveStyleReference(options),
      );
    }
  });
});

describe("incremental computed style", () => {
  it("matches full recomputation and reports exact changed-property invalidation", () => {
    const random = xorshift32(0x3c6ef372);
    const resolver = new IncrementalStyleResolver();
    let previous: ComputedStyle | undefined;
    let lastOptions: ResolveStyleOptions | undefined;
    let expectedCacheHits = 0;

    for (let iteration = 0; iteration < 500; iteration += 1) {
      const repeat = iteration > 0 && iteration % 5 === 0;
      const options =
        repeat && lastOptions !== undefined
          ? lastOptions
          : {
              nodeType: "view" as const,
              className: choose(random, ["base", "base accent", "alternate", ""]),
              styleSheets: [
                createStyleSheet({
                  "base": randomViewStyle(random),
                  ".base.accent": randomViewStyle(random),
                  "alternate": randomViewStyle(random),
                }),
              ],
              inlineStyle: randomViewStyle(random),
              parentStyle: resolveStyle({
                nodeType: "view",
                inlineStyle: randomViewStyle(random),
              }).style,
            };

      const incremental = resolver.resolve(options);
      const full = resolveStyle(options);
      expect(incremental.result, `seeded step ${String(iteration)}`).toEqual(full);

      if (repeat) {
        expectedCacheHits += 1;
        expect(incremental.cacheHit).toBe(true);
        expect(incremental.changedProperties).toEqual([]);
        expect(incremental.invalidation).toEqual([]);
        expect(incremental.recomputedProperties).toBe(0);
      } else {
        const changed = changedProperties(previous, full.style);
        expect(incremental.cacheHit).toBe(false);
        expect(incremental.changedProperties).toEqual(changed);
        expect(incremental.invalidation).toEqual(expectedInvalidation(changed));
        expect(incremental.recomputedProperties).toBeGreaterThan(0);
      }

      previous = full.style;
      lastOptions = options;
    }

    expect(resolver.metrics()).toMatchObject({
      resolutions: 500,
      fullResolutions: 500 - expectedCacheHits,
      cacheHits: expectedCacheHits,
      cacheClears: 0,
    });
  });

  it("does not treat reordered shorthand/longhand declarations or mutated values as unchanged", () => {
    const resolver = new IncrementalStyleResolver();
    const firstStyle = { margin: 1, marginTop: 2 } satisfies PingoStyle;
    const reversedStyle = { marginTop: 2, margin: 1 } satisfies PingoStyle;
    expect(
      resolver.resolve({ nodeType: "view", inlineStyle: firstStyle }).result.style.marginTop,
    ).toBe("2px");
    expect(
      resolver.resolve({ nodeType: "view", inlineStyle: reversedStyle }).result.style.marginTop,
    ).toBe("1px");

    const mutable = { width: 10 };
    resolver.resolve({ nodeType: "view", inlineStyle: mutable });
    mutable.width = 20;
    const updated = resolver.resolve({ nodeType: "view", inlineStyle: mutable });
    expect(updated.cacheHit).toBe(false);
    expect(updated.result.style.width).toBe("20px");
    expect(updated.changedProperties).toContain("width");
  });

  it("clears memoized state while retaining observable cumulative counters", () => {
    const resolver = new IncrementalStyleResolver();
    const options = { nodeType: "view" as const, inlineStyle: { width: 10 } };
    resolver.resolve(options);
    expect(resolver.resolve(options).cacheHit).toBe(true);
    resolver.clear();
    expect(resolver.resolve(options).cacheHit).toBe(false);
    expect(resolver.metrics()).toMatchObject({
      resolutions: 3,
      fullResolutions: 2,
      cacheHits: 1,
      cacheClears: 1,
    });
  });
});

function randomViewStyle(random: () => number): PingoStyle {
  const style = {} as { -readonly [Name in keyof PingoStyle]: PingoStyle[Name] };
  if (randomBoolean(random)) style.width = choose(random, [0, 4, 12, "25%", "auto", "initial"]);
  if (randomBoolean(random)) style.height = choose(random, [0, 8, 16, "50%", "auto", "unset"]);
  if (randomBoolean(random)) style.margin = choose(random, [0, 2, "1px 2px", "auto 4px"]);
  if (randomBoolean(random)) style.marginTop = choose(random, [0, 3, "8px", "inherit"]);
  if (randomBoolean(random)) style.padding = choose(random, [0, 1, "2px 4px", "1px 2px 3px"]);
  if (randomBoolean(random))
    style.color = choose(random, ["#123", "#abcdef", "transparent", "inherit"]);
  if (randomBoolean(random))
    style.borderColor = choose(random, ["#456", "currentColor", "initial"]);
  if (randomBoolean(random)) style.opacity = choose(random, [0, 0.25, 1, 2, "unset"]);
  if (randomBoolean(random))
    style.overflowX = choose(random, ["visible", "clip", "auto", "scroll"]);
  if (randomBoolean(random))
    style.overflowY = choose(random, ["visible", "hidden", "auto", "scroll"]);
  if (randomBoolean(random)) style.visibility = choose(random, ["visible", "hidden", "inherit"]);
  return style;
}

function changedProperties(
  previous: ComputedStyle | undefined,
  current: ComputedStyle,
): readonly StylePropertyName[] {
  return Object.values(STYLE_PROPERTIES)
    .filter((property) => !Object.is(previous?.[property.jsName], current[property.jsName]))
    .map((property) => property.jsName);
}

function expectedInvalidation(
  changed: readonly StylePropertyName[],
): readonly StyleInvalidationDomain[] {
  const domains = new Set(changed.flatMap((property) => STYLE_PROPERTIES[property].invalidation));
  return STYLE_INVALIDATION_DOMAINS.filter((domain) => domains.has(domain));
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function randomInteger(random: () => number, exclusiveMaximum: number): number {
  return random() % exclusiveMaximum;
}

function randomBoolean(random: () => number): boolean {
  return (random() & 1) === 1;
}

function choose<const T>(random: () => number, values: readonly T[]): T {
  const value = values[randomInteger(random, values.length)];
  if (value === undefined) throw new Error("choose requires at least one value");
  return value;
}
