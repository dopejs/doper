import { CSS_SUBSET_VERSION, STYLE_FEATURE_BITS } from "./generated";
import {
  INTERNAL_STYLE_SHEET,
  type CompiledDeclaration,
  type CompiledRule,
  type InternalStyleSheet,
} from "./internal";
import { StyleSheetCompileError } from "./error";
import { sha256 } from "./hash";
import { expandDeclaration } from "./values";
import type {
  CompileStyleSheetOptions,
  PingoStyleSheet,
  PingoStyleSheetObject,
  StyleDiagnostic,
  StyleSheetCompilation,
  StyleSourceLocation,
} from "./types";

const classNamePattern = /^[_a-zA-Z][_a-zA-Z0-9-]*$/u;
const selectorPattern = /^(?:\.[_a-zA-Z][_a-zA-Z0-9-]*)+$/u;
const MAX_STYLESHEET_CODE_UNITS = 1_048_576;

/** Compiles CSS text or a type-safe class map without throwing. */
export function compileStyleSheet(
  input: string | PingoStyleSheetObject,
  options: CompileStyleSheetOptions = {},
): StyleSheetCompilation {
  const content = typeof input === "string" ? input : stableObjectText(input);
  if (content.length > MAX_STYLESHEET_CODE_UNITS) {
    return Object.freeze({
      styleSheet: null,
      diagnostics: Object.freeze([
        {
          code: "invalid-css" as const,
          severity: "error" as const,
          message: `Stylesheet exceeds the ${String(MAX_STYLESHEET_CODE_UNITS)} code-unit limit`,
        },
      ]),
    });
  }
  const compiled =
    typeof input === "string"
      ? compileCssText(input, options.sourceName)
      : compileObject(input, options.sourceName);
  if (compiled.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return Object.freeze({ styleSheet: null, diagnostics: Object.freeze(compiled.diagnostics) });
  }
  const sheet: InternalStyleSheet = Object.freeze({
    [INTERNAL_STYLE_SHEET]: true as const,
    cssSubsetVersion: CSS_SUBSET_VERSION,
    contentHash: sha256(content),
    featureBits: Object.values(STYLE_FEATURE_BITS).reduce((bits, value) => bits | value, 0),
    ruleCount: compiled.rules.length,
    rules: Object.freeze(compiled.rules.map(freezeRule)),
    diagnostics: Object.freeze(compiled.diagnostics),
  });
  return Object.freeze({ styleSheet: sheet, diagnostics: sheet.diagnostics });
}

/** Compiles a stylesheet and throws StyleSheetCompileError on invalid input. */
export function createStyleSheet(
  input: string | PingoStyleSheetObject,
  options: CompileStyleSheetOptions = {},
): PingoStyleSheet {
  const result = compileStyleSheet(input, options);
  if (result.styleSheet === null) throw new StyleSheetCompileError(result.diagnostics);
  return result.styleSheet;
}

interface CompiledSource {
  readonly rules: CompiledRule[];
  readonly diagnostics: StyleDiagnostic[];
}

function compileCssText(source: string, sourceName?: string): CompiledSource {
  const diagnostics: StyleDiagnostic[] = [];
  const sanitized = replaceComments(source, diagnostics, sourceName);
  if (sanitized === null) return { rules: [], diagnostics };
  const rules: CompiledRule[] = [];
  let cursor = 0;
  while (cursor < sanitized.length) {
    cursor = skipWhitespace(sanitized, cursor);
    if (cursor >= sanitized.length) break;
    const open = sanitized.indexOf("{", cursor);
    if (open < 0) {
      diagnostics.push(
        sourceDiagnostic("invalid-css", "Expected '{' after selector", source, cursor, sourceName),
      );
      break;
    }
    const strayClose = sanitized.indexOf("}", cursor);
    if (strayClose >= 0 && strayClose < open) {
      diagnostics.push(
        sourceDiagnostic("invalid-css", "Unexpected '}'", source, strayClose, sourceName),
      );
      cursor = strayClose + 1;
      continue;
    }
    const block = findBlockEnd(sanitized, open);
    if (block.close < 0) {
      diagnostics.push(
        sourceDiagnostic(
          "invalid-css",
          "Unterminated or malformed declaration block",
          source,
          block.malformedOffset ?? open,
          sourceName,
        ),
      );
      break;
    }
    const close = block.close;
    if (block.nestedOffset !== undefined) {
      diagnostics.push(
        sourceDiagnostic(
          "unsupported-selector",
          "Nested rules and at-rules are not supported",
          source,
          block.nestedOffset,
          sourceName,
        ),
      );
      cursor = close + 1;
      continue;
    }
    const selectorText = sanitized.slice(cursor, open).trim();
    const selectorOffset = cursor + sanitized.slice(cursor, open).indexOf(selectorText);
    const selectors = parseSelectorList(
      selectorText,
      source,
      selectorOffset,
      sourceName,
      diagnostics,
    );
    const declarations = parseCssDeclarations(
      sanitized.slice(open + 1, close),
      source,
      open + 1,
      sourceName,
      diagnostics,
    );
    for (const selector of selectors) {
      rules.push({
        classes: selector.classes,
        specificity: selector.classes.length,
        declarations,
      });
    }
    cursor = close + 1;
  }
  return { rules, diagnostics };
}

interface BlockEnd {
  readonly close: number;
  readonly nestedOffset?: number;
  readonly malformedOffset?: number;
}

function findBlockEnd(source: string, open: number): BlockEnd {
  let quote: '"' | "'" | null = null;
  let parenthesisDepth = 0;
  let nestedOffset: number | undefined;
  for (let index = open + 1; index < source.length; index += 1) {
    const character = source[index];
    const escaped = index > open + 1 && source[index - 1] === "\\";
    if ((character === '"' || character === "'") && !escaped) {
      quote = quote === null ? character : quote === character ? null : quote;
      continue;
    }
    if (quote !== null) continue;
    if (character === "(") parenthesisDepth += 1;
    else if (character === ")") {
      parenthesisDepth -= 1;
      if (parenthesisDepth < 0) return { close: -1, malformedOffset: index };
    } else if (character === "{" && nestedOffset === undefined) nestedOffset = index;
    else if (character === "}" && parenthesisDepth === 0) {
      return { close: index, ...(nestedOffset === undefined ? {} : { nestedOffset }) };
    }
  }
  return { close: -1, malformedOffset: source.length };
}

function compileObject(input: PingoStyleSheetObject, sourceName?: string): CompiledSource {
  const rules: CompiledRule[] = [];
  const diagnostics: StyleDiagnostic[] = [];
  for (const [rawSelector, style] of Object.entries(input)) {
    const selectorText = rawSelector.startsWith(".") ? rawSelector : `.${rawSelector}`;
    const selectors = parseSelectorList(selectorText, selectorText, 0, sourceName, diagnostics);
    const declarations: CompiledDeclaration[] = [];
    if (!isRecord(style)) {
      diagnostics.push({
        code: "invalid-css",
        severity: "error",
        message: `Style rule ${JSON.stringify(rawSelector)} must be an object`,
      });
      continue;
    }
    for (const [name, value] of Object.entries(style)) {
      const expanded = expandDeclaration(name, value, "js");
      declarations.push(...expanded.declarations);
      diagnostics.push(...expanded.diagnostics);
    }
    for (const selector of selectors) {
      rules.push({
        classes: selector.classes,
        specificity: selector.classes.length,
        declarations: [...declarations],
      });
    }
  }
  return { rules, diagnostics };
}

function parseCssDeclarations(
  body: string,
  originalSource: string,
  bodyOffset: number,
  sourceName: string | undefined,
  diagnostics: StyleDiagnostic[],
): CompiledDeclaration[] {
  const declarations: CompiledDeclaration[] = [];
  for (const segment of splitDeclarations(body)) {
    const text = segment.text.trim();
    if (text === "") continue;
    const textOffset = bodyOffset + segment.offset + segment.text.indexOf(text);
    const colon = findTopLevelColon(text);
    if (colon < 1) {
      diagnostics.push(
        sourceDiagnostic(
          "invalid-css",
          "Expected a property/value declaration",
          originalSource,
          textOffset,
          sourceName,
        ),
      );
      continue;
    }
    const name = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim();
    const location = sourceLocation(originalSource, textOffset, sourceName);
    if (/!\s*important\s*$/iu.test(value)) {
      diagnostics.push({
        code: "important-not-supported",
        severity: "error",
        message: "!important is not supported by the pingo CSS subset",
        property: name,
        location,
      });
      continue;
    }
    const expanded = expandDeclaration(name, value, "css", location);
    declarations.push(...expanded.declarations);
    diagnostics.push(...expanded.diagnostics);
  }
  return declarations;
}

interface ParsedSelector {
  readonly classes: readonly string[];
}

function parseSelectorList(
  selectorText: string,
  originalSource: string,
  selectorOffset: number,
  sourceName: string | undefined,
  diagnostics: StyleDiagnostic[],
): ParsedSelector[] {
  const selectors: ParsedSelector[] = [];
  for (const rawSelector of selectorText.split(",")) {
    const selector = rawSelector.trim();
    const offset =
      selectorOffset + selectorText.indexOf(rawSelector) + rawSelector.indexOf(selector);
    if (!selectorPattern.test(selector)) {
      diagnostics.push(
        sourceDiagnostic(
          "unsupported-selector",
          `Only same-node class selectors are supported; received ${JSON.stringify(selector)}`,
          originalSource,
          Math.max(0, offset),
          sourceName,
        ),
      );
      continue;
    }
    const classes = selector
      .split(".")
      .slice(1)
      .filter((name) => classNamePattern.test(name));
    if (new Set(classes).size !== classes.length) {
      diagnostics.push(
        sourceDiagnostic(
          "unsupported-selector",
          `Duplicate class in selector ${JSON.stringify(selector)}`,
          originalSource,
          Math.max(0, offset),
          sourceName,
        ),
      );
      continue;
    }
    selectors.push({ classes });
  }
  return selectors;
}

function replaceComments(
  source: string,
  diagnostics: StyleDiagnostic[],
  sourceName?: string,
): string | null {
  let result = "";
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("/*", cursor);
    if (open < 0) return result + source.slice(cursor);
    result += source.slice(cursor, open);
    const close = source.indexOf("*/", open + 2);
    if (close < 0) {
      diagnostics.push(
        sourceDiagnostic("invalid-css", "Unterminated CSS comment", source, open, sourceName),
      );
      return null;
    }
    const comment = source.slice(open, close + 2);
    result += comment.replace(/[^\n]/gu, " ");
    cursor = close + 2;
  }
  return result;
}

interface DeclarationSegment {
  readonly text: string;
  readonly offset: number;
}

function splitDeclarations(body: string): DeclarationSegment[] {
  const result: DeclarationSegment[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let index = 0; index <= body.length; index += 1) {
    const character = body[index];
    const escaped = index > 0 && body[index - 1] === "\\";
    if ((character === '"' || character === "'") && !escaped) {
      quote = quote === null ? character : quote === character ? null : quote;
    } else if (quote === null && character === "(") {
      depth += 1;
    } else if (quote === null && character === ")") {
      depth -= 1;
    }
    if ((character === ";" || character === undefined) && quote === null && depth === 0) {
      result.push({ text: body.slice(start, index), offset: start });
      start = index + 1;
    }
  }
  return result;
}

function findTopLevelColon(value: string): number {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const escaped = index > 0 && value[index - 1] === "\\";
    if ((character === '"' || character === "'") && !escaped) {
      quote = quote === null ? character : quote === character ? null : quote;
    } else if (quote === null && character === "(") depth += 1;
    else if (quote === null && character === ")") depth -= 1;
    else if (quote === null && depth === 0 && character === ":") return index;
  }
  return -1;
}

function sourceDiagnostic(
  code: StyleDiagnostic["code"],
  message: string,
  source: string,
  offset: number,
  sourceName?: string,
): StyleDiagnostic {
  return {
    code,
    severity: "error",
    message,
    location: sourceLocation(source, offset, sourceName),
  };
}

function sourceLocation(source: string, offset: number, sourceName?: string): StyleSourceLocation {
  const prefix = source.slice(0, offset);
  const lines = prefix.split("\n");
  return {
    offset,
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
    ...(sourceName === undefined ? {} : { sourceName }),
  };
}

function skipWhitespace(value: string, offset: number): number {
  let cursor = offset;
  while (cursor < value.length && /\s/u.test(value[cursor] ?? "")) cursor += 1;
  return cursor;
}

function freezeRule(rule: CompiledRule): CompiledRule {
  return Object.freeze({
    classes: Object.freeze([...rule.classes]),
    specificity: rule.specificity,
    declarations: Object.freeze(rule.declarations.map((declaration) => Object.freeze(declaration))),
  });
}

function stableObjectText(input: PingoStyleSheetObject): string {
  return Object.entries(input)
    .map(([selector, style]) => {
      const declarations = isRecord(style)
        ? style
        : { invalidRuleValue: style === null ? "null" : typeof style };
      return `${selector}{${Object.entries(declarations)
        .map(([name, value]) => `${name}:${JSON.stringify(value)}`)
        .join(";")}}`;
    })
    .join("");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
