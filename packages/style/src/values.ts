import {
  STYLE_PROPERTIES,
  STYLE_GRAMMAR_KEYWORDS,
  STYLE_SHORTHANDS,
  type StyleDeclarationName,
  type StylePropertyMetadata,
  type StylePropertyName,
} from "./generated";
import type { CompiledDeclaration, GlobalStyleKeyword, SpecifiedStyleValue } from "./internal";
import type { StyleDiagnostic, StyleSourceLocation } from "./types";

const propertyMetadata = Object.values(STYLE_PROPERTIES) as readonly StylePropertyMetadata[];
const propertyByCssName = new Map<string, StylePropertyMetadata>(
  propertyMetadata.map((metadata) => [metadata.cssName, metadata]),
);
const propertyByJsName = new Map<string, StylePropertyMetadata>(
  propertyMetadata.map((metadata) => [metadata.jsName, metadata]),
);
const shorthandMetadata = Object.values(STYLE_SHORTHANDS);
type ShorthandMetadata = (typeof shorthandMetadata)[number];
const shorthandByCssName = new Map<string, ShorthandMetadata>(
  shorthandMetadata.map((metadata) => [metadata.cssName, metadata]),
);
const shorthandByJsName = new Map<string, ShorthandMetadata>(
  shorthandMetadata.map((metadata) => [metadata.jsName, metadata]),
);
const globalKeywords = new Set<GlobalStyleKeyword>(["inherit", "initial", "unset"]);

export interface DeclarationExpansion {
  readonly declarations: readonly CompiledDeclaration[];
  readonly diagnostics: readonly StyleDiagnostic[];
}

export function expandDeclaration(
  rawName: string,
  rawValue: unknown,
  syntax: "css" | "js",
  location?: StyleSourceLocation,
): DeclarationExpansion {
  const lookupName = syntax === "css" ? rawName.toLowerCase() : rawName;
  const property =
    syntax === "css" ? propertyByCssName.get(lookupName) : propertyByJsName.get(lookupName);
  const shorthand =
    syntax === "css" ? shorthandByCssName.get(lookupName) : shorthandByJsName.get(lookupName);
  if (property === undefined && shorthand === undefined) {
    return {
      declarations: [],
      diagnostics: [
        diagnostic(
          "unknown-property",
          `Unsupported style property ${JSON.stringify(rawName)}`,
          rawName,
          location,
        ),
      ],
    };
  }

  const global = parseGlobalKeyword(
    syntax === "css" && typeof rawValue === "string" ? rawValue.toLowerCase() : rawValue,
  );
  if (global !== null) {
    const names = property === undefined ? shorthand?.longhands : [property.jsName];
    return {
      declarations: (names ?? []).map((name) => declaration(name, { global }, location)),
      diagnostics: [],
    };
  }

  if (property !== undefined) {
    const value = parsePropertyValue(property.grammar, rawValue);
    if (value === null) return invalidValue(rawName, rawValue, location);
    return { declarations: [declaration(property.jsName, value, location)], diagnostics: [] };
  }
  return expandShorthand(shorthand, rawName, rawValue, location);
}

export function metadataForProperty(name: StylePropertyName): StylePropertyMetadata {
  return STYLE_PROPERTIES[name];
}

export function propertyNameFromUnknown(name: string): StyleDeclarationName | null {
  if (propertyByCssName.has(name) || shorthandByCssName.has(name)) {
    return propertyByCssName.get(name)?.jsName ?? shorthandByCssName.get(name)?.jsName ?? null;
  }
  if (propertyByJsName.has(name) || shorthandByJsName.has(name)) {
    return name as StyleDeclarationName;
  }
  return null;
}

function expandShorthand(
  shorthand: ShorthandMetadata | undefined,
  rawName: string,
  rawValue: unknown,
  location?: StyleSourceLocation,
): DeclarationExpansion {
  if (shorthand === undefined) return invalidValue(rawName, rawValue, location);
  const grammar = shorthand.grammar;
  if (grammar === "border") return expandBorder(shorthand.longhands, rawName, rawValue, location);
  if (grammar === "flex") return expandFlex(shorthand.longhands, rawName, rawValue, location);
  const parts = splitWhitespace(rawValue);
  if (parts === null) return invalidValue(rawName, rawValue, location);

  if (grammar.startsWith("box-")) {
    if (parts.length < 1 || parts.length > 4) return invalidValue(rawName, rawValue, location);
    const itemGrammar = grammar === "box-length-auto" ? "length-auto" : grammar.slice(4);
    const parsed = parts.map((part) => parsePropertyValue(itemGrammar, part));
    if (parsed.some((value) => value === null)) return invalidValue(rawName, rawValue, location);
    const [top, right = top, bottom = top, left = right] =
      parsed.length === 3
        ? [parsed[0], parsed[1], parsed[2], parsed[1]]
        : parsed.length === 4
          ? parsed
          : parsed.length === 2
            ? [parsed[0], parsed[1], parsed[0], parsed[1]]
            : [parsed[0], parsed[0], parsed[0], parsed[0]];
    const values = [top, right, bottom, left] as readonly SpecifiedStyleValue[];
    return {
      declarations: shorthand.longhands.map((name, index) =>
        declaration(name, values[index] as SpecifiedStyleValue, location),
      ),
      diagnostics: [],
    };
  }

  if (grammar === "pair-overflow" || grammar === "pair-non-negative-length-normal") {
    if (parts.length < 1 || parts.length > 2) return invalidValue(rawName, rawValue, location);
    const itemGrammar = grammar === "pair-overflow" ? "overflow" : "non-negative-length-normal";
    const first = parsePropertyValue(itemGrammar, parts[0]);
    const second = parsePropertyValue(itemGrammar, parts[1] ?? parts[0]);
    if (first === null || second === null) return invalidValue(rawName, rawValue, location);
    return {
      declarations: [
        declaration(shorthand.longhands[0], first, location),
        declaration(shorthand.longhands[1], second, location),
      ],
      diagnostics: [],
    };
  }
  return invalidValue(rawName, rawValue, location);
}

/**
 * Expands `flex` into its three longhands.
 *
 * `flex: <number>` uses a `0px` basis rather than CSS's `0%`: an indefinite
 * container makes `0%` behave as `auto`, while `0px` is always definite, and
 * the two agree inside a definite container. See docs/style-support.md.
 */
function expandFlex(
  longhands: readonly string[],
  rawName: string,
  rawValue: unknown,
  location?: StyleSourceLocation,
): DeclarationExpansion {
  // splitWhitespace turns a bare number into a px length because every other
  // shorthand takes lengths. A bare number in `flex` is a grow factor.
  const parts = typeof rawValue === "number" ? [String(rawValue)] : splitWhitespace(rawValue);
  if (parts === null || parts.length < 1 || parts.length > 3) {
    return invalidValue(rawName, rawValue, location);
  }
  const emit = (
    grow: SpecifiedStyleValue,
    shrink: SpecifiedStyleValue,
    basis: SpecifiedStyleValue,
  ): DeclarationExpansion => ({
    declarations: [grow, shrink, basis].map((value, index) =>
      declaration(longhands[index] as StylePropertyName, value, location),
    ),
    diagnostics: [],
  });

  if (parts.length === 1) {
    const single = parts[0];
    if (single === "none") return emit(0, 0, "auto");
    if (single === "auto") return emit(1, 1, "auto");
    const grow = parsePropertyValue("non-negative-number", single);
    if (grow !== null) return emit(grow, 1, "0px");
    const basis = parsePropertyValue("length-auto", single);
    if (basis !== null) return emit(1, 1, basis);
    return invalidValue(rawName, rawValue, location);
  }

  const grow = parsePropertyValue("non-negative-number", parts[0]);
  if (grow === null) return invalidValue(rawName, rawValue, location);
  const second = parts[1];
  const shrink = parsePropertyValue("non-negative-number", second);
  if (parts.length === 2) {
    if (shrink !== null) return emit(grow, shrink, "0px");
    const basis = parsePropertyValue("length-auto", second);
    if (basis !== null) return emit(grow, 1, basis);
    return invalidValue(rawName, rawValue, location);
  }
  const basis = parsePropertyValue("length-auto", parts[2]);
  if (shrink === null || basis === null) return invalidValue(rawName, rawValue, location);
  return emit(grow, shrink, basis);
}

function expandBorder(
  longhands: readonly string[],
  rawName: string,
  rawValue: unknown,
  location?: StyleSourceLocation,
): DeclarationExpansion {
  const parts = splitWhitespace(rawValue);
  if (parts === null || parts.length < 1 || parts.length > 3) {
    return invalidValue(rawName, rawValue, location);
  }
  let width: SpecifiedStyleValue = "0px";
  let style: SpecifiedStyleValue = "none";
  let color: SpecifiedStyleValue = "currentColor";
  let widthSeen = false;
  let styleSeen = false;
  let colorSeen = false;
  for (const part of parts) {
    const parsedWidth = parsePropertyValue("non-negative-length", part);
    const parsedStyle = parsePropertyValue("border-style", part);
    const parsedColor = parsePropertyValue("color-current", part);
    if (parsedWidth !== null && !widthSeen) {
      width = parsedWidth;
      widthSeen = true;
    } else if (parsedStyle !== null && !styleSeen) {
      style = parsedStyle;
      styleSeen = true;
    } else if (parsedColor !== null && !colorSeen) {
      color = parsedColor;
      colorSeen = true;
    } else {
      return invalidValue(rawName, rawValue, location);
    }
  }
  const values: SpecifiedStyleValue[] = [];
  for (let index = 0; index < 4; index += 1) values.push(width);
  for (let index = 0; index < 4; index += 1) values.push(color);
  for (let index = 0; index < 4; index += 1) values.push(style);
  return {
    declarations: longhands.map((name, index) =>
      declaration(name as StylePropertyName, values[index] as SpecifiedStyleValue, location),
    ),
    diagnostics: [],
  };
}

function parsePropertyValue(grammar: string, rawValue: unknown): SpecifiedStyleValue | null {
  switch (grammar) {
    case "length-auto":
      return rawValue === "auto" ? "auto" : parseLength(rawValue, false, false);
    case "length-none":
      return rawValue === "none" ? "none" : parseLength(rawValue, false, false);
    case "non-negative-length":
      return parseLength(rawValue, true, false);
    case "non-negative-number": {
      const number = parseFiniteNumber(rawValue);
      return number === null || number < 0 ? null : number;
    }
    case "non-negative-length-normal":
      return rawValue === "normal" ? "normal" : parseLength(rawValue, true, false);
    case "positive-length":
      return parseLength(rawValue, true, true);
    case "opacity": {
      const number = parseFiniteNumber(rawValue);
      return number === null ? null : Math.min(1, Math.max(0, number));
    }
    case "font-weight":
      if (rawValue === "normal") return 400;
      if (rawValue === "bold") return 700;
      {
        const number = parseFiniteNumber(rawValue);
        return number !== null && number >= 1 && number <= 1000 ? number : null;
      }
    case "line-height":
      if (rawValue === "normal") return "normal";
      if (typeof rawValue === "number")
        return rawValue >= 0 && Number.isFinite(rawValue) ? rawValue : null;
      return parseLength(rawValue, true, false);
    case "color":
      return parseColor(rawValue, false);
    case "color-current":
      return parseColor(rawValue, true);
    case "font-family":
      return typeof rawValue === "string" && rawValue.trim().length > 0
        ? rawValue.trim().replace(/\s+/gu, " ")
        : null;
    case "position":
      return parsePosition(rawValue);
    case "transform":
      return parseTransform(rawValue);
    case "box-shadow":
      return parseBoxShadow(rawValue);
    case "z-index": {
      if (rawValue === "auto") return "auto";
      const number = parseFiniteNumber(rawValue);
      // CSS z-index is an integer; a fractional one is a typo, not a hint.
      return number === null || !Number.isInteger(number) || Math.abs(number) > 0x7fff_ffff
        ? null
        : number;
    }
    default:
      return parseEnum(grammar, rawValue);
  }
}

function parseEnum(grammar: string, rawValue: unknown): string | null {
  const values = (STYLE_GRAMMAR_KEYWORDS as Readonly<Record<string, readonly string[]>>)[grammar];
  if (typeof rawValue !== "string") return null;
  const normalized = rawValue.toLowerCase();
  return values?.includes(normalized) === true ? normalized : null;
}

function parseLength(rawValue: unknown, nonNegative: boolean, positive: boolean): string | null {
  let number: number;
  let unit: "px" | "%" = "px";
  if (typeof rawValue === "number") {
    number = rawValue;
  } else if (typeof rawValue === "string") {
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|%)?$/u.exec(rawValue.trim().toLowerCase());
    if (match === null) return null;
    number = Number(match[1]);
    if (match[2] === undefined && number !== 0) return null;
    unit = (match[2] ?? "px") as "px" | "%";
  } else {
    return null;
  }
  if (!Number.isFinite(number) || (nonNegative && number < 0) || (positive && number <= 0)) {
    return null;
  }
  return `${canonicalNumber(number)}${unit}`;
}

function parseFiniteNumber(rawValue: unknown): number | null {
  if (typeof rawValue === "number") return Number.isFinite(rawValue) ? rawValue : null;
  if (typeof rawValue !== "string" || rawValue.trim() === "") return null;
  const number = Number(rawValue);
  return Number.isFinite(number) ? number : null;
}

function parseColor(rawValue: unknown, allowCurrent: boolean): string | null {
  if (typeof rawValue !== "string") return null;
  const value = rawValue.trim().toLowerCase();
  if (value === "transparent") return "#00000000";
  if (allowCurrent && value === "currentcolor") return "currentColor";
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.exec(value);
  if (match !== null) {
    const digits = match[1];
    if (digits === undefined) return null;
    if (digits.length === 3 || digits.length === 4) {
      const expanded = [...digits].map((digit) => `${digit}${digit}`).join("");
      return `#${expanded}${digits.length === 3 ? "ff" : ""}`;
    }
    return `#${digits}${digits.length === 6 ? "ff" : ""}`;
  }
  return parseFunctionalColor(value);
}

const cssNumberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/u;

function parseFunctionalColor(value: string): string | null {
  const match = /^(rgb|rgba|hsl|hsla)\(([\s\S]*)\)$/u.exec(value);
  if (match === null) return null;
  const name = match[1];
  const body = match[2];
  if (name === undefined || body === undefined || /[()]/u.test(body)) return null;
  const arguments_ = parseColorArguments(body);
  if (arguments_ === null) return null;
  const alpha = arguments_.alpha === undefined ? 1 : parseAlpha(arguments_.alpha);
  if (alpha === null) return null;

  let channels: readonly [number, number, number] | null;
  if (name === "rgb" || name === "rgba") {
    channels = parseRgbChannels(arguments_.channels);
  } else {
    channels = parseHslChannels(arguments_.channels);
  }
  if (channels === null) return null;
  return rgba8(channels[0], channels[1], channels[2], alpha);
}

function parseColorArguments(
  body: string,
): { readonly channels: readonly string[]; readonly alpha?: string } | null {
  const trimmed = body.trim();
  if (trimmed === "") return null;
  if (trimmed.includes(",")) {
    if (trimmed.includes("/")) return null;
    const parts = trimmed.split(",").map((part) => part.trim());
    if (parts.some((part) => part === "") || (parts.length !== 3 && parts.length !== 4)) {
      return null;
    }
    return {
      channels: parts.slice(0, 3),
      ...(parts[3] === undefined ? {} : { alpha: parts[3] }),
    };
  }

  const slashParts = trimmed.split("/").map((part) => part.trim());
  if (slashParts.length > 2 || slashParts.some((part) => part === "")) return null;
  const channels = (slashParts[0] ?? "").split(/\s+/u);
  if (channels.length !== 3) return null;
  const alphaParts = slashParts[1]?.split(/\s+/u);
  if (alphaParts !== undefined && alphaParts.length !== 1) return null;
  return {
    channels,
    ...(alphaParts?.[0] === undefined ? {} : { alpha: alphaParts[0] }),
  };
}

function parseRgbChannels(tokens: readonly string[]): readonly [number, number, number] | null {
  const channels = tokens.map(parseRgbChannel);
  if (channels.some((channel) => channel === null)) return null;
  return channels as [number, number, number];
}

function parseRgbChannel(token: string): number | null {
  if (token.endsWith("%")) {
    const percentage = parseCssNumber(token.slice(0, -1));
    return percentage === null ? null : (clamp(percentage, 0, 100) * 255) / 100;
  }
  const number = parseCssNumber(token);
  return number === null ? null : clamp(number, 0, 255);
}

function parseHslChannels(tokens: readonly string[]): readonly [number, number, number] | null {
  const hue = parseHue(tokens[0] ?? "");
  const saturation = parsePercentage(tokens[1] ?? "");
  const lightness = parsePercentage(tokens[2] ?? "");
  if (hue === null || saturation === null || lightness === null) return null;

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (sector < 1) [red, green] = [chroma, secondary];
  else if (sector < 2) [red, green] = [secondary, chroma];
  else if (sector < 3) [green, blue] = [chroma, secondary];
  else if (sector < 4) [green, blue] = [secondary, chroma];
  else if (sector < 5) [red, blue] = [secondary, chroma];
  else [red, blue] = [chroma, secondary];
  const minimum = lightness - chroma / 2;
  return [(red + minimum) * 255, (green + minimum) * 255, (blue + minimum) * 255];
}

function parseHue(token: string): number | null {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/u.exec(token);
  if (match === null) return null;
  const number = parseCssNumber(match[1] ?? "");
  if (number === null) return null;
  const unit = match[2] ?? "deg";
  const degrees =
    unit === "turn"
      ? number * 360
      : unit === "grad"
        ? number * 0.9
        : unit === "rad"
          ? (number * 180) / Math.PI
          : number;
  if (!Number.isFinite(degrees)) return null;
  return ((degrees % 360) + 360) % 360;
}

function parsePercentage(token: string): number | null {
  if (!token.endsWith("%")) return null;
  const number = parseCssNumber(token.slice(0, -1));
  return number === null ? null : clamp(number, 0, 100) / 100;
}

function parseAlpha(token: string): number | null {
  if (token.endsWith("%")) return parsePercentage(token);
  const number = parseCssNumber(token);
  return number === null ? null : clamp(number, 0, 1);
}

function parseCssNumber(token: string): number | null {
  if (!cssNumberPattern.test(token)) return null;
  const number = Number(token);
  return Number.isFinite(number) ? number : null;
}

function rgba8(red: number, green: number, blue: number, alpha: number): string {
  return `#${[red, green, blue, alpha * 255]
    .map((channel) =>
      Math.round(clamp(channel, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parsePosition(rawValue: unknown): string | null {
  const parts = splitWhitespace(rawValue);
  if (parts === null || parts.length < 1 || parts.length > 2) return null;
  const first = (parts[0] ?? "center").toLowerCase();
  if (parts.length === 1) {
    if (first === "left") return "0% 50%";
    if (first === "right") return "100% 50%";
    if (first === "top") return "50% 0%";
    if (first === "bottom") return "50% 100%";
    if (first === "center") return "50% 50%";
    const x = parseLength(first, false, false);
    return x === null ? null : `${x} 50%`;
  }
  const second = (parts[1] ?? "center").toLowerCase();
  const firstAxis = positionKeywordAxis(first);
  const secondAxis = positionKeywordAxis(second);
  if (firstAxis === "y" && secondAxis !== "y") {
    const x = parsePositionAxis(second, "x");
    const y = parsePositionAxis(first, "y");
    return x === null || y === null ? null : `${x} ${y}`;
  }
  if ((firstAxis === "x" && secondAxis === "x") || (firstAxis === "y" && secondAxis === "y")) {
    return null;
  }
  const x = parsePositionAxis(first, "x");
  const y = parsePositionAxis(second, "y");
  return x === null || y === null ? null : `${x} ${y}`;
}

/** Every shadow a node may declare; the decoder rejects a longer list. */
const MAXIMUM_SHADOWS = 4;

/**
 * Canonicalizes `box-shadow` into `<x>px <y>px <blur>px <spread>px #rrggbbaa`
 * layers joined by `, `, or `none`.
 *
 * `inset` is rejected rather than silently dropped: drawing one needs an
 * inverse path and a clip, and quietly turning an inset shadow into an outer
 * one would draw the opposite of what the author asked for. See
 * docs/style-support.md.
 */
function parseBoxShadow(rawValue: unknown): string | null {
  if (rawValue === "none") return "none";
  if (typeof rawValue !== "string" || rawValue.length > 1024) return null;
  const layers = splitTopLevel(rawValue);
  if (layers === null || layers.length === 0 || layers.length > MAXIMUM_SHADOWS) return null;
  const canonical: string[] = [];
  for (const layer of layers) {
    const parsed = parseShadowLayer(layer);
    if (parsed === null) return null;
    canonical.push(parsed);
  }
  return canonical.join(", ");
}

function parseShadowLayer(layer: string): string | null {
  const parts = splitWhitespace(layer);
  if (parts === null || parts.length < 2 || parts.length > 5) return null;
  if (parts.includes("inset")) return null;
  const lengths: string[] = [];
  let color: string | null = null;
  for (const part of parts) {
    const length = lengths.length < 4 ? parseLength(part, false, false) : null;
    if (length !== null && color === null) {
      lengths.push(length);
      continue;
    }
    if (color !== null) return null;
    color = parseColor(part, false);
    if (color === null) return null;
  }
  if (lengths.length < 2) return null;
  // Blur must not be negative; offsets and spread may be.
  if (Number.parseFloat(lengths[2] ?? "0") < 0) return null;
  while (lengths.length < 4) lengths.push("0px");
  return `${lengths.join(" ")} ${color ?? "#000000ff"}`;
}

/** Splits on top-level commas, so `rgba(0, 0, 0, .1)` stays one token. */
function splitTopLevel(value: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (depth < 0) return null;
    if (index === value.length || (character === "," && depth === 0)) {
      const part = value.slice(start, index).trim();
      if (part === "") return null;
      parts.push(part);
      start = index + 1;
    }
  }
  return depth === 0 ? parts : null;
}

function parseTransform(rawValue: unknown): string | null {
  if (rawValue === "none") return "none";
  if (typeof rawValue !== "string" || rawValue.length > 1024) return null;
  const value = rawValue.trim().replace(/\s+/gu, " ");
  const functions = [...value.matchAll(/([a-zA-Z][a-zA-Z0-9]*)\(([^()]*)\)/gu)];
  if (functions.length === 0 || functions.map((match) => match[0]).join(" ") !== value) return null;
  return functions.every((match) => validateTransformFunction(match[1] ?? "", match[2] ?? ""))
    ? value
    : null;
}

function validateTransformFunction(name: string, rawArguments: string): boolean {
  const arguments_ = rawArguments
    .trim()
    .split(/\s*,\s*|\s+/u)
    .filter((argument) => argument !== "");
  if (name === "matrix") return arguments_.length === 6 && arguments_.every(isFiniteNumberToken);
  if (name === "scale") {
    return (
      arguments_.length >= 1 && arguments_.length <= 2 && arguments_.every(isFiniteNumberToken)
    );
  }
  if (name === "scaleX" || name === "scaleY") {
    return arguments_.length === 1 && arguments_.every(isFiniteNumberToken);
  }
  if (name === "translate") {
    return arguments_.length >= 1 && arguments_.length <= 2 && arguments_.every(isLengthToken);
  }
  if (name === "translateX" || name === "translateY") {
    return arguments_.length === 1 && arguments_.every(isLengthToken);
  }
  if (name === "rotate") {
    return (
      arguments_.length === 1 &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:deg|rad|turn)$/u.test(arguments_[0] ?? "")
    );
  }
  return false;
}

function isFiniteNumberToken(value: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value) && Number.isFinite(Number(value));
}

function isLengthToken(value: string): boolean {
  return parseLength(value, false, false) !== null;
}

function positionKeywordAxis(value: string): "x" | "y" | "both" | null {
  if (value === "left" || value === "right") return "x";
  if (value === "top" || value === "bottom") return "y";
  if (value === "center") return "both";
  return null;
}

function parsePositionAxis(value: string, axis: "x" | "y"): string | null {
  if (value === "center") return "50%";
  if (axis === "x" && value === "left") return "0%";
  if (axis === "x" && value === "right") return "100%";
  if (axis === "y" && value === "top") return "0%";
  if (axis === "y" && value === "bottom") return "100%";
  if (positionKeywordAxis(value) !== null) return null;
  return parseLength(value, false, false);
}

function splitWhitespace(rawValue: unknown): string[] | null {
  if (typeof rawValue === "number") {
    return Number.isFinite(rawValue) ? [`${String(rawValue)}px`] : null;
  }
  if (typeof rawValue !== "string") return null;
  const value = rawValue.trim();
  if (value === "") return null;
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth < 0) return null;
    if ((character === undefined || /\s/u.test(character)) && depth === 0) {
      if (index > start) parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  return depth === 0 ? parts : null;
}

function parseGlobalKeyword(rawValue: unknown): GlobalStyleKeyword | null {
  return typeof rawValue === "string" && globalKeywords.has(rawValue as GlobalStyleKeyword)
    ? (rawValue as GlobalStyleKeyword)
    : null;
}

function declaration(
  property: string,
  value: SpecifiedStyleValue,
  location?: StyleSourceLocation,
): CompiledDeclaration {
  return {
    property: property as StylePropertyName,
    value,
    ...(location === undefined ? {} : { location }),
  };
}

function invalidValue(
  rawName: string,
  rawValue: unknown,
  location?: StyleSourceLocation,
): DeclarationExpansion {
  return {
    declarations: [],
    diagnostics: [
      diagnostic(
        "unsupported-value",
        `Unsupported value ${describeValue(rawValue)} for ${rawName}`,
        rawName,
        location,
      ),
    ],
  };
}

function describeValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function diagnostic(
  code: StyleDiagnostic["code"],
  message: string,
  property?: string,
  location?: StyleSourceLocation,
): StyleDiagnostic {
  return {
    code,
    severity: "error",
    message,
    ...(property === undefined ? {} : { property }),
    ...(location === undefined ? {} : { location }),
  };
}

function canonicalNumber(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}
