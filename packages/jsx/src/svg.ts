/**
 * SVG document subset: markup in, drawable shapes out.
 *
 * A deliberately small hand-written reader rather than `DOMParser`. The engine
 * has to produce identical geometry in a browser, in a worker and in a headless
 * differential test, and `DOMParser` is absent from workers, reports failures
 * through a browser-specific error element, and would make icon geometry depend
 * on which host happened to parse it.
 *
 * The subset is what icon sets actually contain. Anything outside it is rejected
 * by name, so a caller learns what was dropped instead of finding a blank box.
 */

/** Row-major affine, in the same order the engine uses. */
export type SvgMatrix = readonly [number, number, number, number, number, number];

const IDENTITY: SvgMatrix = [1, 0, 0, 1, 0, 0];

/** One drawable outline extracted from a document. */
export interface PingoSvgShape {
  /** SVG path data, in the coordinate space `transform` maps from. */
  readonly d: string;
  /** Transform to apply to the parsed points; identity when the document had none. */
  readonly transform: SvgMatrix;
  /** Packed `RGBA8` fill, or `undefined` to inherit the node's colour. */
  readonly fill: number | undefined;
  /** Packed `RGBA8` stroke, or `undefined` when the shape is not stroked. */
  readonly stroke: number | undefined;
  readonly strokeWidth: number;
  readonly fillRule: "nonzero" | "evenodd";
  /** False when the document explicitly set `fill="none"`. */
  readonly filled: boolean;
}

/** A parsed document, ready to render. */
export class PingoSvg {
  /** Author-space box every shape is expressed in. */
  public readonly viewBox: readonly [number, number, number, number];
  public readonly shapes: readonly PingoSvgShape[];

  public constructor(
    viewBox: readonly [number, number, number, number],
    shapes: readonly PingoSvgShape[],
  ) {
    this.viewBox = viewBox;
    this.shapes = shapes;
  }
}

export class PingoSvgError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PingoSvgError";
  }
}

function fail(message: string): never {
  throw new PingoSvgError(message);
}

/** Presentation state inherited down the element tree. */
interface Inherited {
  readonly fill: number | undefined;
  readonly filled: boolean;
  readonly stroke: number | undefined;
  readonly strokeWidth: number;
  readonly fillRule: "nonzero" | "evenodd";
  readonly transform: SvgMatrix;
}

const ROOT: Inherited = {
  fill: undefined,
  filled: true,
  stroke: undefined,
  strokeWidth: 1,
  fillRule: "nonzero",
  transform: IDENTITY,
};

/**
 * Parses SVG markup into shapes.
 *
 * `currentColor` and an absent paint both resolve to `undefined`, which the
 * renderer draws in the node's own colour. That is what makes a single-colour
 * icon inherit like text, and it is the behaviour every icon set assumes.
 */
export function createSvg(markup: string): PingoSvg {
  const tags = tokenize(markup);
  let viewBox: [number, number, number, number] | undefined;
  const shapes: PingoSvgShape[] = [];
  const stack: Inherited[] = [ROOT];

  for (const tag of tags) {
    if (tag.closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const parent = stack[stack.length - 1] ?? ROOT;
    const inherited = inherit(parent, tag.attributes);
    if (tag.name === "svg") {
      viewBox = readViewBox(tag.attributes);
    } else {
      const data = shapeData(tag.name, tag.attributes);
      if (data !== undefined) {
        shapes.push({
          d: data,
          transform: inherited.transform,
          fill: inherited.fill,
          stroke: inherited.stroke,
          strokeWidth: inherited.strokeWidth,
          fillRule: inherited.fillRule,
          filled: inherited.filled,
        });
      }
    }
    if (!tag.selfClosing) stack.push(inherited);
  }

  if (viewBox === undefined) fail("svg is missing a viewBox");
  if (shapes.length === 0) fail("svg contains no drawable shape");
  return new PingoSvg(viewBox, shapes);
}

/** Loads and parses a document from a URL. */
export async function loadSvg(url: string, init?: RequestInit): Promise<PingoSvg> {
  const response = await fetch(url, init);
  if (!response.ok) fail(`svg request failed with status ${String(response.status)}`);
  return createSvg(await response.text());
}

interface Tag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
  readonly closing: boolean;
}

const DRAWABLE = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const STRUCTURAL = new Set(["svg", "g", "title", "desc", "defs", "metadata"]);

function tokenize(markup: string): Tag[] {
  const tags: Tag[] = [];
  const pattern =
    /<\s*(\/)?\s*([a-zA-Z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?>/gu;
  let match = pattern.exec(markup);
  while (match !== null) {
    const [, closing, rawName, rawAttributes, selfClosing] = match;
    const name = (rawName ?? "").toLowerCase().replace(/^.*:/u, "");
    if (!DRAWABLE.has(name) && !STRUCTURAL.has(name)) {
      fail(`unsupported svg element <${name}>`);
    }
    tags.push({
      name,
      attributes: readAttributes(rawAttributes ?? ""),
      selfClosing: selfClosing !== undefined,
      closing: closing !== undefined,
    });
    match = pattern.exec(markup);
  }
  if (tags.length === 0) fail("svg markup contains no elements");
  return tags;
}

function readAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  let match = pattern.exec(source);
  while (match !== null) {
    attributes.set((match[1] ?? "").toLowerCase(), match[2] ?? match[3] ?? "");
    match = pattern.exec(source);
  }
  return attributes;
}

function readViewBox(attributes: ReadonlyMap<string, string>): [number, number, number, number] {
  const raw = attributes.get("viewbox");
  if (raw === undefined) {
    // width and height stand in for a missing viewBox, which is legal and
    // common in exported icons.
    const width = Number(attributes.get("width"));
    const height = Number(attributes.get("height"));
    if (!(width > 0) || !(height > 0)) fail("svg is missing a viewBox");
    return [0, 0, width, height];
  }
  const parts = raw
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    fail("svg viewBox must be four numbers");
  }
  const [x, y, width, height] = parts as [number, number, number, number];
  if (!(width > 0) || !(height > 0)) fail("svg viewBox must have positive extent");
  return [x, y, width, height];
}

function inherit(parent: Inherited, attributes: ReadonlyMap<string, string>): Inherited {
  const fill = attributes.get("fill");
  const stroke = attributes.get("stroke");
  const strokeWidth = attributes.get("stroke-width");
  const fillRule = attributes.get("fill-rule");
  const transform = attributes.get("transform");
  const width = strokeWidth === undefined ? parent.strokeWidth : Number(strokeWidth);
  if (!Number.isFinite(width) || width < 0) fail("svg stroke-width must be finite and positive");
  return {
    fill: fill === undefined ? parent.fill : parseColor(fill),
    // `fill="none"` is how stroke-only icon sets say "outline, no body", and it
    // has to survive as a distinct state from "no fill attribute at all".
    filled: fill === undefined ? parent.filled : fill.trim().toLowerCase() !== "none",
    stroke: stroke === undefined ? parent.stroke : parseColor(stroke),
    strokeWidth: width,
    fillRule:
      fillRule === undefined ? parent.fillRule : fillRule === "evenodd" ? "evenodd" : "nonzero",
    transform:
      transform === undefined
        ? parent.transform
        : multiply(parent.transform, parseTransform(transform)),
  };
}

/**
 * Hex colours and the keywords icon sets use.
 *
 * `currentColor` becomes `undefined` so the node's own colour wins. Named CSS
 * colours are rejected rather than guessed: a partial name table would render
 * some documents and silently blacken others.
 */
export function parseColor(value: string): number | undefined {
  const text = value.trim().toLowerCase();
  if (text === "none" || text === "transparent" || text === "currentcolor") return undefined;
  const hex = /^#([0-9a-f]{3,8})$/u.exec(text);
  if (hex === null) fail(`unsupported svg colour ${value}`);
  const digits = hex[1] ?? "";
  const nibble = (index: number): number => Number.parseInt((digits[index] ?? "0").repeat(2), 16);
  const pair = (index: number): number => Number.parseInt(digits.slice(index, index + 2), 16);
  if (digits.length === 3 || digits.length === 4) {
    const alpha = digits.length === 4 ? nibble(3) : 255;
    return ((nibble(0) << 24) | (nibble(1) << 16) | (nibble(2) << 8) | alpha) >>> 0;
  }
  if (digits.length === 6 || digits.length === 8) {
    const alpha = digits.length === 8 ? pair(6) : 255;
    return ((pair(0) << 24) | (pair(2) << 16) | (pair(4) << 8) | alpha) >>> 0;
  }
  return fail(`unsupported svg colour ${value}`);
}

function multiply(left: SvgMatrix, right: SvgMatrix): SvgMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

/** `translate`, `scale`, `rotate` and `matrix`; skew is not in the subset. */
export function parseTransform(source: string): SvgMatrix {
  let result: SvgMatrix = IDENTITY;
  const pattern = /([a-z]+)\s*\(([^)]*)\)/giu;
  let match = pattern.exec(source);
  while (match !== null) {
    const name = (match[1] ?? "").toLowerCase();
    const values = (match[2] ?? "")
      .trim()
      .split(/[\s,]+/u)
      .filter(Boolean)
      .map(Number);
    if (values.some((value) => !Number.isFinite(value))) {
      fail("svg transform value is not a number");
    }
    result = multiply(result, singleTransform(name, values));
    match = pattern.exec(source);
  }
  return result;
}

function singleTransform(name: string, values: readonly number[]): SvgMatrix {
  switch (name) {
    case "translate":
      return [1, 0, 0, 1, values[0] ?? 0, values[1] ?? 0];
    case "scale": {
      const x = values[0] ?? 1;
      return [x, 0, 0, values[1] ?? x, 0, 0];
    }
    case "rotate": {
      const radians = ((values[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const cx = values[1] ?? 0;
      const cy = values[2] ?? 0;
      // The three-argument form rotates about a point, which exported icons use
      // constantly; treating it as the two-argument form silently moves artwork.
      return multiply(multiply([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]), [
        1,
        0,
        0,
        1,
        -cx,
        -cy,
      ]);
    }
    case "matrix":
      if (values.length !== 6) fail("svg matrix transform needs six values");
      return [
        values[0] ?? 1,
        values[1] ?? 0,
        values[2] ?? 0,
        values[3] ?? 1,
        values[4] ?? 0,
        values[5] ?? 0,
      ];
    default:
      return fail(`unsupported svg transform ${name}`);
  }
}

/** Converts a primitive shape into path data in its own coordinate space. */
export function shapeData(
  name: string,
  attributes: ReadonlyMap<string, string>,
): string | undefined {
  const number = (key: string, fallback = 0): number => {
    const raw = attributes.get(key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) fail(`svg attribute ${key} is not a number`);
    return value;
  };
  switch (name) {
    case "path": {
      const d = attributes.get("d");
      return d === undefined || d.trim() === "" ? undefined : d;
    }
    case "circle": {
      const r = number("r");
      return r > 0 ? ellipsePath(number("cx"), number("cy"), r, r) : undefined;
    }
    case "ellipse": {
      const rx = number("rx");
      const ry = number("ry");
      return rx > 0 && ry > 0 ? ellipsePath(number("cx"), number("cy"), rx, ry) : undefined;
    }
    case "rect": {
      const width = number("width");
      const height = number("height");
      if (!(width > 0) || !(height > 0)) return undefined;
      return rectPath(number("x"), number("y"), width, height, number("rx", -1), number("ry", -1));
    }
    case "line":
      return `M${String(number("x1"))} ${String(number("y1"))}L${String(number("x2"))} ${String(number("y2"))}`;
    case "polyline":
    case "polygon":
      return polygonPath(attributes.get("points") ?? "", name === "polygon");
    default:
      return undefined;
  }
}

function polygonPath(source: string, close: boolean): string | undefined {
  const points = source
    .trim()
    .split(/[\s,]+/u)
    .filter(Boolean);
  if (points.length < 4) return undefined;
  const segments = [`M${points[0] ?? "0"} ${points[1] ?? "0"}`];
  for (let index = 2; index + 1 < points.length; index += 2) {
    segments.push(`L${points[index] ?? "0"} ${points[index + 1] ?? "0"}`);
  }
  return `${segments.join("")}${close ? "Z" : ""}`;
}

/** Two half arcs rather than four quarters: the path parser expands them anyway. */
function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  const left = String(cx - rx);
  const right = String(cx + rx);
  const arc = `A${String(rx)} ${String(ry)} 0 1 0`;
  return `M${left} ${String(cy)}${arc} ${right} ${String(cy)}${arc} ${left} ${String(cy)}Z`;
}

function rectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  rawRx: number,
  rawRy: number,
): string {
  // Either radius alone implies the other, which is what the specification says
  // and what rounded icon frames rely on.
  const rx = Math.min(rawRx < 0 ? Math.max(rawRy, 0) : rawRx, width / 2);
  const ry = Math.min(rawRy < 0 ? Math.max(rawRx, 0) : rawRy, height / 2);
  if (!(rx > 0) || !(ry > 0)) {
    return `M${String(x)} ${String(y)}H${String(x + width)}V${String(y + height)}H${String(x)}Z`;
  }
  const arc = `A${String(rx)} ${String(ry)} 0 0 1`;
  return [
    `M${String(x + rx)} ${String(y)}`,
    `H${String(x + width - rx)}`,
    `${arc} ${String(x + width)} ${String(y + ry)}`,
    `V${String(y + height - ry)}`,
    `${arc} ${String(x + width - rx)} ${String(y + height)}`,
    `H${String(x + rx)}`,
    `${arc} ${String(x)} ${String(y + height - ry)}`,
    `V${String(y + ry)}`,
    `${arc} ${String(x + rx)} ${String(y)}`,
    "Z",
  ].join("");
}
