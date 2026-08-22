/**
 * SVG path-data (`d`) parsing and encoding to the Core's path resource.
 *
 * Only the `d` grammar is handled here, not SVG documents: shapes like rect and
 * circle are expressible as paths, and a document reader is a separate concern
 * that would drag in a namespace-aware XML parser for no engine benefit.
 */

import {
  PATH_FILL_RULE_OFFSET,
  PATH_POINT_COUNT_OFFSET,
  PATH_RESERVED_OFFSET,
  PATH_VARIANT_OFFSET,
  PATH_VERB_COUNT_OFFSET,
  PATH_VERSION_OFFSET,
  PATH_VIEW_BOX_HEIGHT_OFFSET,
  PATH_VIEW_BOX_WIDTH_OFFSET,
  PATH_VIEW_BOX_X_OFFSET,
  PATH_VIEW_BOX_Y_OFFSET,
  PATH_PAYLOAD_OFFSET,
  PATH_RESOURCE_VARIANT,
  RESOURCE_ENCODING_VERSION,
} from "./generated";

/** Verb codes, matching `PathVerb` on the Rust side. */
const MOVE = 0;
const LINE = 1;
const QUAD = 2;
const CUBIC = 3;
const CLOSE = 4;

// From the schema, never a literal: the header grew once already, and a
// hardcoded size here would disagree with the decoder rather than fail to
// compile.
const HEADER_BYTES = PATH_PAYLOAD_OFFSET;

export type PathFillRule = "nonzero" | "evenodd";

/** A parsed outline, ready to encode. */
export interface ParsedPath {
  readonly verbs: Uint8Array;
  readonly points: Float32Array;
}

export class PathDataError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PathDataError";
  }
}

function fail(message: string): never {
  throw new PathDataError(message);
}

/**
 * Parses an SVG `d` attribute into verbs and points.
 *
 * Arcs are converted to cubics rather than rejected: elliptical arcs appear
 * throughout real icon sets, and a parser that drops them produces artwork that
 * is subtly wrong rather than obviously missing.
 */
export function parsePathData(data: string): ParsedPath {
  const verbs: number[] = [];
  const points: number[] = [];
  const scanner = new Scanner(data);
  let current: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  // Reflection origin for the smooth variants, per the SVG grammar.
  let previousControl: [number, number] | undefined;
  let previousCommand = "";

  const emit = (verb: number, coordinates: readonly number[]): void => {
    verbs.push(verb);
    points.push(...coordinates);
  };

  while (!scanner.done()) {
    let command = scanner.command();
    if (command === undefined) {
      // A repeated coordinate set continues the previous command, except that
      // a repeated moveto means lineto — the one place the grammar surprises.
      if (previousCommand === "") fail("path data must begin with a command");
      command = previousCommand === "M" ? "L" : previousCommand === "m" ? "l" : previousCommand;
    }
    const relative = command === command.toLowerCase();
    const absolute = (x: number, y: number): [number, number] =>
      relative ? [current[0] + x, current[1] + y] : [x, y];

    switch (command.toUpperCase()) {
      case "M": {
        const point = absolute(scanner.number(), scanner.number());
        emit(MOVE, point);
        current = point;
        start = point;
        previousControl = undefined;
        break;
      }
      case "L": {
        const point = absolute(scanner.number(), scanner.number());
        emit(LINE, point);
        current = point;
        previousControl = undefined;
        break;
      }
      case "H": {
        const x = scanner.number();
        const point: [number, number] = [relative ? current[0] + x : x, current[1]];
        emit(LINE, point);
        current = point;
        previousControl = undefined;
        break;
      }
      case "V": {
        const y = scanner.number();
        const point: [number, number] = [current[0], relative ? current[1] + y : y];
        emit(LINE, point);
        current = point;
        previousControl = undefined;
        break;
      }
      case "Q": {
        const control = absolute(scanner.number(), scanner.number());
        const end = absolute(scanner.number(), scanner.number());
        emit(QUAD, [...control, ...end]);
        current = end;
        previousControl = control;
        break;
      }
      case "T": {
        const control = reflect(current, previousCommand, previousControl, "QT");
        const end = absolute(scanner.number(), scanner.number());
        emit(QUAD, [...control, ...end]);
        current = end;
        previousControl = control;
        break;
      }
      case "C": {
        const first = absolute(scanner.number(), scanner.number());
        const second = absolute(scanner.number(), scanner.number());
        const end = absolute(scanner.number(), scanner.number());
        emit(CUBIC, [...first, ...second, ...end]);
        current = end;
        previousControl = second;
        break;
      }
      case "S": {
        const first = reflect(current, previousCommand, previousControl, "CS");
        const second = absolute(scanner.number(), scanner.number());
        const end = absolute(scanner.number(), scanner.number());
        emit(CUBIC, [...first, ...second, ...end]);
        current = end;
        previousControl = second;
        break;
      }
      case "A": {
        const rx = scanner.number();
        const ry = scanner.number();
        const rotation = scanner.number();
        const largeArc = scanner.flag();
        const sweep = scanner.flag();
        const end = absolute(scanner.number(), scanner.number());
        for (const cubic of arcToCubics(current, rx, ry, rotation, largeArc, sweep, end)) {
          emit(CUBIC, cubic);
        }
        current = end;
        previousControl = undefined;
        break;
      }
      case "Z": {
        emit(CLOSE, []);
        current = start;
        previousControl = undefined;
        break;
      }
      default:
        fail(`unknown path command ${command}`);
    }
    previousCommand = command;
  }
  if (verbs.length === 0) fail("path data is empty");
  if (verbs[0] !== MOVE) fail("path data must begin with a move");
  return { verbs: Uint8Array.from(verbs), points: Float32Array.from(points) };
}

/** Control point reflected through the current point, per the SVG grammar. */
function reflect(
  current: readonly [number, number],
  previousCommand: string,
  previousControl: readonly [number, number] | undefined,
  continuing: string,
): [number, number] {
  // Only a matching curve command reflects; anything else starts flat, which is
  // what the specification says and what browsers do.
  if (previousControl === undefined || !continuing.includes(previousCommand.toUpperCase())) {
    return [current[0], current[1]];
  }
  return [2 * current[0] - previousControl[0], 2 * current[1] - previousControl[1]];
}

/**
 * Converts one elliptical arc into up to four cubics.
 *
 * Follows the endpoint-to-centre conversion in SVG 1.1 F.6.5, including the
 * radius correction in F.6.6: an arc whose radii are too small to reach the
 * endpoint is scaled up rather than rejected, because that is what the
 * specification requires and real files rely on it.
 */
export function arcToCubics(
  from: readonly [number, number],
  radiusX: number,
  radiusY: number,
  rotationDegrees: number,
  largeArc: boolean,
  sweep: boolean,
  to: readonly [number, number],
): number[][] {
  const [x1, y1] = from;
  const [x2, y2] = to;
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(radiusX);
  let ry = Math.abs(radiusY);
  // A zero radius degenerates to a straight line, expressed as a cubic so the
  // caller does not need a second code path.
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];

  const phi = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = Math.sqrt(Math.max(numerator / denominator, 0)) * (largeArc === sweep ? -1 : 1);
  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

  const start = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
  const end = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
  let sweepAngle = end - start;
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  else if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

  // A quarter turn per segment keeps the cubic approximation error negligible;
  // more segments would cost bytes for accuracy nobody can see.
  const segments = Math.max(Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)), 1);
  const delta = sweepAngle / segments;
  const alpha = (4 / 3) * Math.tan(delta / 4);
  const cubics: number[][] = [];
  let theta = start;
  let point = ellipsePoint(cx, cy, rx, ry, cos, sin, theta);
  for (let index = 0; index < segments; index += 1) {
    const next = theta + delta;
    const nextPoint = ellipsePoint(cx, cy, rx, ry, cos, sin, next);
    const tangent = ellipseTangent(rx, ry, cos, sin, theta);
    const nextTangent = ellipseTangent(rx, ry, cos, sin, next);
    cubics.push([
      point[0] + alpha * tangent[0],
      point[1] + alpha * tangent[1],
      nextPoint[0] - alpha * nextTangent[0],
      nextPoint[1] - alpha * nextTangent[1],
      nextPoint[0],
      nextPoint[1],
    ]);
    theta = next;
    point = nextPoint;
  }
  return cubics;
}

function ellipsePoint(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  cos: number,
  sin: number,
  theta: number,
): [number, number] {
  const x = rx * Math.cos(theta);
  const y = ry * Math.sin(theta);
  return [cx + cos * x - sin * y, cy + sin * x + cos * y];
}

function ellipseTangent(
  rx: number,
  ry: number,
  cos: number,
  sin: number,
  theta: number,
): [number, number] {
  const x = -rx * Math.sin(theta);
  const y = ry * Math.cos(theta);
  return [cos * x - sin * y, sin * x + cos * y];
}

/** Tokenizer for the `d` grammar's loose number and flag syntax. */
class Scanner {
  readonly #source: string;
  #index = 0;

  public constructor(source: string) {
    this.#source = source;
  }

  public done(): boolean {
    this.skip();
    return this.#index >= this.#source.length;
  }

  public command(): string | undefined {
    this.skip();
    const character = this.#source[this.#index];
    if (character === undefined || !/[a-z]/iu.test(character)) return undefined;
    this.#index += 1;
    return character;
  }

  public number(): number {
    this.skip();
    const match = /^[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/u.exec(
      this.#source.slice(this.#index),
    );
    if (match === null) fail("expected a number in path data");
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail("path coordinate is not finite");
    return value;
  }

  /**
   * Reads an arc flag, which is a single digit and may not be separated.
   *
   * `a1 1 0 011 1` is legal and means flags 0 and 1 followed by 1,1; parsing
   * the flags as ordinary numbers would swallow the coordinates.
   */
  public flag(): boolean {
    this.skip();
    const character = this.#source[this.#index];
    if (character !== "0" && character !== "1") fail("arc flag must be 0 or 1");
    this.#index += 1;
    return character === "1";
  }

  private skip(): void {
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index] ?? "";
      if (character === "," || /\s/u.test(character)) this.#index += 1;
      else break;
    }
  }
}

/** Encodes a parsed outline as the Core's immutable path resource. */
export function encodePath(
  path: ParsedPath,
  viewBox: readonly [number, number, number, number],
  fillRule: PathFillRule = "nonzero",
): Uint8Array {
  const [x, y, width, height] = viewBox;
  if (!(width > 0) || !(height > 0)) fail("path view box must have positive extent");
  const verbsEnd = HEADER_BYTES + path.verbs.length;
  const pointsStart = verbsEnd + ((4 - (verbsEnd % 4)) % 4);
  const bytes = new Uint8Array(pointsStart + path.points.length * 4);
  const view = new DataView(bytes.buffer);
  bytes[PATH_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
  bytes[PATH_VARIANT_OFFSET] = PATH_RESOURCE_VARIANT;
  bytes[PATH_FILL_RULE_OFFSET] = fillRule === "evenodd" ? 1 : 0;
  bytes[PATH_RESERVED_OFFSET] = 0;
  view.setUint32(PATH_VERB_COUNT_OFFSET, path.verbs.length, true);
  view.setUint32(PATH_POINT_COUNT_OFFSET, path.points.length, true);
  view.setFloat32(PATH_VIEW_BOX_X_OFFSET, x, true);
  view.setFloat32(PATH_VIEW_BOX_Y_OFFSET, y, true);
  view.setFloat32(PATH_VIEW_BOX_WIDTH_OFFSET, width, true);
  view.setFloat32(PATH_VIEW_BOX_HEIGHT_OFFSET, height, true);
  bytes.set(path.verbs, HEADER_BYTES);
  for (const [index, value] of path.points.entries()) {
    view.setFloat32(pointsStart + index * 4, value, true);
  }
  return bytes;
}

/** Convenience: parse `d` and encode it in one step. */
export function encodePathData(
  data: string,
  viewBox: readonly [number, number, number, number],
  fillRule: PathFillRule = "nonzero",
): Uint8Array {
  return encodePath(parsePathData(data), viewBox, fillRule);
}
