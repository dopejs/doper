import type { Canvas2DContext, Canvas2DResources, CanvasTextStyle } from "./replayer";
import { decodeGlyphResourceBatch, type CanvasGlyphSpan } from "./glyph-resources";
import {
  AFFINE_A_OFFSET,
  AFFINE_RESOURCE_FIXED_BYTES,
  AFFINE_RESOURCE_VARIANT,
  AFFINE_VARIANT_OFFSET,
  AFFINE_VERSION_OFFSET,
  IMAGE_BITMAP_HEIGHT_OFFSET,
  IMAGE_BITMAP_PIXEL_BYTES_OFFSET,
  IMAGE_BITMAP_PIXELS_OFFSET,
  IMAGE_BITMAP_RESOURCE_MINIMUM_BYTES,
  IMAGE_BITMAP_RESOURCE_VARIANT,
  IMAGE_BITMAP_VARIANT_OFFSET,
  IMAGE_BITMAP_VERSION_OFFSET,
  IMAGE_BITMAP_WIDTH_OFFSET,
  RESOURCE_ENCODING_VERSION,
  ResourceKind,
  SFNT_FONT_DATA_BYTES_OFFSET,
  SFNT_FONT_DATA_OFFSET,
  SFNT_FONT_FACE_INDEX_OFFSET,
  SFNT_FONT_RESOURCE_MINIMUM_BYTES,
  SFNT_FONT_RESOURCE_VARIANT,
  SFNT_FONT_VARIANT_OFFSET,
  SFNT_FONT_VERSION_OFFSET,
  SOLID_PAINT_ALPHA_OFFSET,
  SOLID_PAINT_BLUE_OFFSET,
  SOLID_PAINT_GREEN_OFFSET,
  SOLID_PAINT_RED_OFFSET,
  SOLID_PAINT_RESOURCE_FIXED_BYTES,
  SOLID_PAINT_RESOURCE_VARIANT,
  SOLID_PAINT_VARIANT_OFFSET,
  SOLID_PAINT_VERSION_OFFSET,
  TEXT_STYLE_FAMILY_BYTES_OFFSET,
  TEXT_STYLE_FAMILY_OFFSET,
  TEXT_STYLE_FONT_SIZE_OFFSET,
  TEXT_STYLE_LINE_HEIGHT_OFFSET,
  TEXT_STYLE_PAINT_ID_OFFSET,
  TEXT_STYLE_RESOURCE_MINIMUM_BYTES,
  TEXT_STYLE_RESOURCE_VARIANT,
  TEXT_STYLE_VARIANT_OFFSET,
  TEXT_STYLE_VERSION_OFFSET,
  TEXT_STYLE_WEIGHT_OFFSET,
  MAX_SYSTEM_TEXT_LINES,
} from "./generated";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Host-side metadata for one validated explicit SFNT font resource. */
export interface CanvasFontResource {
  readonly faceIndex: number;
  readonly byteLength: number;
}

type Rgba = readonly [number, number, number, number];

interface PreparedGlyphSpan {
  readonly span: CanvasGlyphSpan;
  readonly sources: readonly CanvasImageSource[];
}

interface TextMeasurementStyle {
  readonly font: string;
  readonly lineHeight: number;
}

/** Immutable string/style resource pair requiring browser system-font metrics. */
export interface CanvasSystemTextPair {
  readonly stringId: number;
  readonly styleId: number;
}

/** Canvas-measured fallback dimensions in logical CSS pixels. */
export interface CanvasSystemTextMetric extends CanvasSystemTextPair {
  readonly maxLineWidth: number;
  readonly lineCount: number;
}

/** One portable resource lifecycle action accepted by an atomic backend transaction. */
export type CanvasEncodedResourceAction =
  | {
      readonly type: "define";
      readonly id: number;
      readonly kind: ResourceKind;
      readonly bytes: Uint8Array;
    }
  | { readonly type: "release"; readonly id: number; readonly kind: ResourceKind };

/** Mutable setup-time registry; replay observes stable synchronous snapshots. */
export class Canvas2DResourceRegistry implements Canvas2DResources {
  readonly #paints = new Map<number, string | CanvasGradient | CanvasPattern>();
  readonly #solidPaints = new Map<number, Rgba>();
  readonly #paths = new Map<number, Path2D>();
  readonly #images = new Map<number, CanvasImageSource>();
  readonly #texts = new Map<number, string>();
  readonly #textStyles = new Map<number, CanvasTextStyle>();
  readonly #textMeasurementStyles = new Map<number, TextMeasurementStyle>();
  readonly #fonts = new Map<number, CanvasFontResource>();
  readonly #glyphSpans = new Map<number, CanvasGlyphSpan>();
  readonly #glyphRasters = new Map<number, PreparedGlyphSpan>();
  readonly #pictures = new Map<number, Uint8Array>();
  readonly #encodedKinds = new Map<number, ResourceKind>();

  /** Shaped-glyph renderer when the environment can create raster surfaces. */
  public drawGlyphRun: Canvas2DResources["drawGlyphRun"];

  public constructor() {
    this.drawGlyphRun = canCreateGlyphSurface()
      ? (context, _fontId, _size, x, y, glyphSpanId) => {
          const prepared = this.#glyphRasters.get(glyphSpanId);
          if (prepared === undefined) {
            throw new Error(`glyph span ${String(glyphSpanId)} is not prepared`);
          }
          for (const placement of prepared.span.placements) {
            const bitmap = prepared.span.bitmaps[placement.bitmapIndex];
            const source = prepared.sources[placement.bitmapIndex];
            if (bitmap === undefined || source === undefined) {
              throw new Error("glyph placement references an unavailable raster");
            }
            const ratio = bitmap.devicePixelRatio;
            context.drawImage(
              source,
              x + placement.x + bitmap.left / ratio,
              y + placement.y - bitmap.top / ratio,
              bitmap.width / ratio,
              bitmap.height / ratio,
            );
          }
        }
      : undefined;
  }

  /** Defines a fill style exactly once. */
  public definePaint(id: number, value: string | CanvasGradient | CanvasPattern): void {
    define(this.#paints, id, value, "paint");
  }

  /** Defines a path exactly once. */
  public definePath(id: number, value: Path2D): void {
    define(this.#paths, id, value, "path");
  }

  /** Defines an image exactly once. */
  public defineImage(id: number, value: CanvasImageSource): void {
    define(this.#images, id, value, "image");
  }

  /** Defines a fallback string exactly once. */
  public defineText(id: number, value: string): void {
    define(this.#texts, id, value, "text");
  }

  /** Defines a fallback font/fill style exactly once. */
  public defineTextStyle(id: number, value: CanvasTextStyle): void {
    define(this.#textStyles, id, Object.freeze({ ...value }), "text style");
  }

  /** Defines a text-backend font resource exactly once. */
  public defineFont(id: number, value: CanvasFontResource): void {
    define(this.#fonts, id, value, "font");
  }

  /** Defines a text-backend glyph span exactly once. */
  public defineGlyphSpan(id: number, value: CanvasGlyphSpan): void {
    define(this.#glyphSpans, id, value, "glyph span");
  }

  /** Atomically applies a fully validated Core-owned glyph-span delta batch. */
  public applyGlyphResourceBatch(bytes: Uint8Array): void {
    this.applyResourceTransaction([], bytes);
  }

  /** Defines a copied immutable picture payload exactly once. */
  public definePicture(id: number, value: Uint8Array): void {
    define(this.#pictures, id, value.slice(), "picture");
  }

  /** Decodes a portable Core resource whose Canvas representation is deterministic. */
  public defineEncodedResource(id: number, kind: ResourceKind, bytes: Uint8Array): void {
    this.applyResourceTransaction([{ type: "define", id, kind, bytes }]);
  }

  /** Releases one portable resource after Core accepted the same transaction. */
  public releaseEncodedResource(id: number, kind: ResourceKind): void {
    this.applyResourceTransaction([{ type: "release", id, kind }]);
  }

  /** Preflights and atomically installs one complete frame's portable resources. */
  public applyResourceTransaction(
    actions: readonly CanvasEncodedResourceAction[],
    glyphBytes?: Uint8Array,
  ): void {
    const paints = new Map(this.#paints);
    const solidPaints = new Map(this.#solidPaints);
    const texts = new Map(this.#texts);
    const textStyles = new Map(this.#textStyles);
    const textMeasurementStyles = new Map(this.#textMeasurementStyles);
    const fonts = new Map(this.#fonts);
    const encodedKinds = new Map(this.#encodedKinds);
    const images = new Map(this.#images);
    const glyphSpans = new Map(this.#glyphSpans);
    const glyphRasters = new Map(this.#glyphRasters);

    for (const action of actions) {
      if (action.type === "define") {
        if (encodedKinds.has(action.id)) {
          throw new Error(`encoded resource ${String(action.id)} is already defined`);
        }
        switch (action.kind) {
          case ResourceKind.Utf8String:
            define(texts, action.id, decodeUtf8(action.bytes, "UTF-8 string"), "text");
            break;
          case ResourceKind.Paint: {
            const paint = decodeSolidPaint(action.bytes);
            define(paints, action.id, paint.style, "paint");
            solidPaints.set(action.id, paint.rgba);
            break;
          }
          case ResourceKind.TextStyle: {
            const decoded = decodeTextStyle(action.bytes);
            const fillStyle = paints.get(decoded.paintId);
            if (fillStyle === undefined) {
              throw new Error(
                `text style references missing paint resource ${String(decoded.paintId)}`,
              );
            }
            define(
              textStyles,
              action.id,
              Object.freeze({
                font: `${String(decoded.weight)} ${String(decoded.fontSize)}px ${JSON.stringify(decoded.family)}`,
                fillStyle,
                lineHeight: decoded.lineHeight,
                textBaseline: "alphabetic" as const,
              }),
              "text style",
            );
            textMeasurementStyles.set(
              action.id,
              Object.freeze({
                font: `${String(decoded.weight)} ${String(decoded.fontSize)}px ${JSON.stringify(decoded.family)}`,
                lineHeight: decoded.lineHeight,
              }),
            );
            break;
          }
          case ResourceKind.Font:
            define(fonts, action.id, decodeSfntFont(action.bytes), "font");
            break;
          case ResourceKind.Image:
            define(images, action.id, decodeImageBitmap(action.bytes), "image");
            break;
          case ResourceKind.Affine:
            validateAffine(action.bytes);
            break;
          default:
            throw new Error(
              `resource kind ${String(action.kind)} requires a host-specific resolver`,
            );
        }
        encodedKinds.set(action.id, action.kind);
      } else {
        const actual = encodedKinds.get(action.id);
        if (actual !== action.kind) {
          throw new Error(
            `encoded resource ${String(action.id)} has kind ${String(actual)} instead of ${String(action.kind)}`,
          );
        }
        encodedKinds.delete(action.id);
        const removed = (() => {
          switch (action.kind) {
            case ResourceKind.Utf8String:
              return texts.delete(action.id);
            case ResourceKind.Paint:
              solidPaints.delete(action.id);
              return paints.delete(action.id);
            case ResourceKind.TextStyle:
              textMeasurementStyles.delete(action.id);
              return textStyles.delete(action.id);
            case ResourceKind.Font:
              return fonts.delete(action.id);
            case ResourceKind.Image:
              return images.delete(action.id);
            case ResourceKind.Affine:
              return true;
            default:
              return false;
          }
        })();
        if (!removed) {
          throw new Error(`encoded resource ${String(action.id)} backing value is missing`);
        }
      }
    }

    const deltas = glyphBytes === undefined ? [] : decodeGlyphResourceBatch(glyphBytes);
    for (const delta of deltas) {
      if (delta.type === "define") {
        if (glyphSpans.has(delta.span.spanId)) {
          throw new Error(`glyph span ${String(delta.span.spanId)} is already defined`);
        }
        const paint = solidPaints.get(delta.span.paintId);
        if (paint === undefined) {
          throw new Error(
            `glyph span ${String(delta.span.spanId)} references missing paint ${String(delta.span.paintId)} or the paint is not solid`,
          );
        }
        glyphSpans.set(delta.span.spanId, delta.span);
        if (this.drawGlyphRun !== undefined) {
          glyphRasters.set(delta.span.spanId, prepareGlyphSpan(delta.span, paint));
        }
      } else if (!glyphSpans.delete(delta.spanId)) {
        throw new Error(`glyph span ${String(delta.spanId)} is not defined`);
      } else {
        glyphRasters.delete(delta.spanId);
      }
    }

    replaceMap(this.#paints, paints);
    replaceMap(this.#solidPaints, solidPaints);
    replaceMap(this.#texts, texts);
    replaceMap(this.#textStyles, textStyles);
    replaceMap(this.#textMeasurementStyles, textMeasurementStyles);
    replaceMap(this.#fonts, fonts);
    replaceMap(this.#images, images);
    replaceMap(this.#encodedKinds, encodedKinds);
    replaceMap(this.#glyphSpans, glyphSpans);
    replaceMap(this.#glyphRasters, glyphRasters);
  }

  public getPaint(id: number): string | CanvasGradient | CanvasPattern | undefined {
    return this.#paints.get(id);
  }

  public getPath(id: number): Path2D | undefined {
    return this.#paths.get(id);
  }

  public getImage(id: number): CanvasImageSource | undefined {
    return this.#images.get(id);
  }

  public getText(id: number): string | undefined {
    return this.#texts.get(id);
  }

  public getTextStyle(id: number): CanvasTextStyle | undefined {
    return this.#textStyles.get(id);
  }

  /**
   * Measures immutable fallback pairs against the post-transaction text/style
   * preview without installing resources or touching canvas pixels.
   */
  public measureSystemTextPairs(
    context: Canvas2DContext,
    actions: readonly CanvasEncodedResourceAction[],
    pairs: readonly CanvasSystemTextPair[],
  ): CanvasSystemTextMetric[] {
    const texts = new Map(this.#texts);
    const styles = new Map(this.#textMeasurementStyles);
    for (const action of actions) {
      if (action.kind === ResourceKind.Utf8String) {
        if (action.type === "define") {
          define(texts, action.id, decodeUtf8(action.bytes, "UTF-8 string"), "text");
        } else if (!texts.delete(action.id)) {
          throw new Error(`text resource ${String(action.id)} is not defined`);
        }
      } else if (action.kind === ResourceKind.TextStyle) {
        if (action.type === "define") {
          const decoded = decodeTextStyle(action.bytes);
          define(
            styles,
            action.id,
            Object.freeze({
              font: `${String(decoded.weight)} ${String(decoded.fontSize)}px ${JSON.stringify(decoded.family)}`,
              lineHeight: decoded.lineHeight,
            }),
            "text measurement style",
          );
        } else if (!styles.delete(action.id)) {
          throw new Error(`text measurement style ${String(action.id)} is not defined`);
        }
      }
    }

    const metrics: CanvasSystemTextMetric[] = [];
    const seen = new Set<string>();
    context.save();
    try {
      for (const pair of pairs) {
        const key = `${String(pair.stringId)}:${String(pair.styleId)}`;
        if (seen.has(key)) throw new Error("system text pair occurs more than once");
        seen.add(key);
        const text = texts.get(pair.stringId);
        const style = styles.get(pair.styleId);
        if (text === undefined || style === undefined) {
          throw new Error(`system text pair ${key} references an unavailable string or text style`);
        }
        context.font = style.font;
        const measured = measureHardLines(context, text);
        metrics.push(Object.freeze({ ...pair, ...measured }));
      }
    } finally {
      context.restore();
    }
    return metrics;
  }

  public getFont(id: number): CanvasFontResource | undefined {
    return this.#fonts.get(id);
  }

  public getGlyphSpan(id: number): CanvasGlyphSpan | undefined {
    return this.#glyphSpans.get(id);
  }

  public getPicture(id: number): Uint8Array | undefined {
    return this.#pictures.get(id);
  }
}

function decodeSfntFont(bytes: Uint8Array): CanvasFontResource {
  validateHeader(
    bytes,
    SFNT_FONT_RESOURCE_VARIANT,
    SFNT_FONT_VERSION_OFFSET,
    SFNT_FONT_VARIANT_OFFSET,
    SFNT_FONT_FACE_INDEX_OFFSET,
    undefined,
    SFNT_FONT_RESOURCE_MINIMUM_BYTES,
  );
  if (bytes.byteLength % 4 !== 0) throw new Error("SFNT font resource must be aligned");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const faceIndex = view.getUint32(SFNT_FONT_FACE_INDEX_OFFSET, true);
  const dataBytes = view.getUint32(SFNT_FONT_DATA_BYTES_OFFSET, true);
  const dataEnd = SFNT_FONT_DATA_OFFSET + dataBytes;
  if (dataBytes === 0 || dataEnd > bytes.byteLength) {
    throw new Error("SFNT font resource has an invalid data length");
  }
  for (let index = dataEnd; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) throw new Error("SFNT font resource padding must be zero");
  }
  const data = bytes.subarray(SFNT_FONT_DATA_OFFSET, dataEnd);
  if (!hasSfntSignature(data)) throw new Error("font resource is not decoded SFNT data");
  return Object.freeze({ faceIndex, byteLength: dataBytes });
}

function hasSfntSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const signature = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  return (
    signature === "\u0000\u0001\u0000\u0000" ||
    signature === "OTTO" ||
    signature === "true" ||
    signature === "typ1" ||
    signature === "ttcf"
  );
}

function decodeSolidPaint(bytes: Uint8Array): { readonly style: string; readonly rgba: Rgba } {
  validateHeader(
    bytes,
    SOLID_PAINT_RESOURCE_VARIANT,
    SOLID_PAINT_VERSION_OFFSET,
    SOLID_PAINT_VARIANT_OFFSET,
    SOLID_PAINT_RED_OFFSET,
    SOLID_PAINT_RESOURCE_FIXED_BYTES,
  );
  const rgba = [
    requiredByte(bytes, SOLID_PAINT_RED_OFFSET),
    requiredByte(bytes, SOLID_PAINT_GREEN_OFFSET),
    requiredByte(bytes, SOLID_PAINT_BLUE_OFFSET),
    requiredByte(bytes, SOLID_PAINT_ALPHA_OFFSET),
  ] as const;
  return {
    style: `#${hex(rgba[0])}${hex(rgba[1])}${hex(rgba[2])}${hex(rgba[3])}`,
    rgba,
  };
}

function prepareGlyphSpan(span: CanvasGlyphSpan, paint: Rgba): PreparedGlyphSpan {
  const sources = span.bitmaps.map((bitmap) => {
    const surface = createGlyphSurface(bitmap.width, bitmap.height);
    const context = glyphSurfaceContext(surface);
    if (context === null) throw new Error("glyph raster surface has no Canvas2D context");
    const image = context.createImageData(bitmap.width, bitmap.height);
    for (let pixel = 0; pixel < bitmap.data.length; pixel += 1) {
      const target = pixel * 4;
      image.data[target] = paint[0];
      image.data[target + 1] = paint[1];
      image.data[target + 2] = paint[2];
      image.data[target + 3] = Math.round((bitmap.data[pixel] ?? 0) * (paint[3] / 255));
    }
    context.putImageData(image, 0, 0);
    return surface;
  });
  return Object.freeze({ span, sources: Object.freeze(sources) });
}

function glyphSurfaceContext(
  surface: OffscreenCanvas | HTMLCanvasElement,
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  return typeof OffscreenCanvas === "function" && surface instanceof OffscreenCanvas
    ? surface.getContext("2d")
    : (surface as HTMLCanvasElement).getContext("2d");
}

/**
 * Turns an RGBA8 image resource into a drawable surface.
 *
 * Synchronous by construction: resource transactions are applied atomically at
 * a commit boundary, so an asynchronous decode of an encoded format could not
 * participate. That is why the resource carries pixels rather than PNG bytes.
 */
function decodeImageBitmap(bytes: Uint8Array): CanvasImageSource {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < IMAGE_BITMAP_RESOURCE_MINIMUM_BYTES ||
    bytes[IMAGE_BITMAP_VERSION_OFFSET] !== RESOURCE_ENCODING_VERSION ||
    bytes[IMAGE_BITMAP_VARIANT_OFFSET] !== IMAGE_BITMAP_RESOURCE_VARIANT
  ) {
    throw new Error("image resource header is malformed");
  }
  const width = view.getUint32(IMAGE_BITMAP_WIDTH_OFFSET, true);
  const height = view.getUint32(IMAGE_BITMAP_HEIGHT_OFFSET, true);
  const pixelBytes = view.getUint32(IMAGE_BITMAP_PIXEL_BYTES_OFFSET, true);
  if (
    width === 0 ||
    height === 0 ||
    pixelBytes !== width * height * 4 ||
    IMAGE_BITMAP_PIXELS_OFFSET + pixelBytes > bytes.byteLength
  ) {
    throw new Error("image resource dimensions do not describe its pixels");
  }
  if (!canCreateGlyphSurface()) throw new Error("image surfaces are unavailable");
  const surface = createGlyphSurface(width, height);
  const context = glyphSurfaceContext(surface);
  if (context === null) throw new Error("image surface has no Canvas2D context");
  const image = context.createImageData(width, height);
  image.data.set(
    bytes.subarray(IMAGE_BITMAP_PIXELS_OFFSET, IMAGE_BITMAP_PIXELS_OFFSET + pixelBytes),
  );
  context.putImageData(image, 0, 0);
  return surface;
}

function canCreateGlyphSurface(): boolean {
  return typeof OffscreenCanvas === "function" || typeof document !== "undefined";
}

function createGlyphSurface(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  if (typeof document === "undefined") throw new Error("glyph raster surfaces are unavailable");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function validateAffine(bytes: Uint8Array): void {
  validateHeader(
    bytes,
    AFFINE_RESOURCE_VARIANT,
    AFFINE_VERSION_OFFSET,
    AFFINE_VARIANT_OFFSET,
    AFFINE_A_OFFSET,
    AFFINE_RESOURCE_FIXED_BYTES,
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = AFFINE_A_OFFSET; offset < bytes.byteLength; offset += 4) {
    if (!Number.isFinite(view.getFloat32(offset, true))) {
      throw new Error("affine resource contains a non-finite component");
    }
  }
}

function decodeTextStyle(bytes: Uint8Array): {
  readonly paintId: number;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly weight: number;
  readonly family: string;
} {
  validateHeader(
    bytes,
    TEXT_STYLE_RESOURCE_VARIANT,
    TEXT_STYLE_VERSION_OFFSET,
    TEXT_STYLE_VARIANT_OFFSET,
    TEXT_STYLE_PAINT_ID_OFFSET,
    undefined,
    TEXT_STYLE_RESOURCE_MINIMUM_BYTES,
  );
  if (
    bytes.byteLength % 4 !== 0 ||
    bytes[TEXT_STYLE_WEIGHT_OFFSET + 2] !== 0 ||
    bytes[TEXT_STYLE_WEIGHT_OFFSET + 3] !== 0
  ) {
    throw new Error("text style resource has invalid alignment or reserved bytes");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const paintId = view.getUint32(TEXT_STYLE_PAINT_ID_OFFSET, true);
  const fontSize = view.getFloat32(TEXT_STYLE_FONT_SIZE_OFFSET, true);
  const lineHeight = view.getFloat32(TEXT_STYLE_LINE_HEIGHT_OFFSET, true);
  const weight = view.getUint16(TEXT_STYLE_WEIGHT_OFFSET, true);
  const familyLength = view.getUint32(TEXT_STYLE_FAMILY_BYTES_OFFSET, true);
  const familyEnd = TEXT_STYLE_FAMILY_OFFSET + familyLength;
  if (
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    !Number.isFinite(lineHeight) ||
    lineHeight <= 0 ||
    weight < 1 ||
    weight > 1000 ||
    familyEnd > bytes.byteLength
  ) {
    throw new Error("text style resource has invalid numeric fields or family length");
  }
  for (let index = familyEnd; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) throw new Error("text style resource padding must be zero");
  }
  const family = decodeUtf8(bytes.subarray(TEXT_STYLE_FAMILY_OFFSET, familyEnd), "font family");
  if (family.length === 0) throw new Error("font family must not be empty");
  return { paintId, fontSize, lineHeight, weight, family };
}

function measureHardLines(
  context: Canvas2DContext,
  text: string,
): Pick<CanvasSystemTextMetric, "lineCount" | "maxLineWidth"> {
  let lineCount = 0;
  let maxLineWidth = 0;
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text.charCodeAt(index) !== 0x0a) continue;
    lineCount += 1;
    if (lineCount > MAX_SYSTEM_TEXT_LINES) {
      throw new RangeError("system text exceeds the supported hard-line limit");
    }
    const width = context.measureText(text.slice(start, index)).width;
    if (!Number.isFinite(width) || width < 0) {
      throw new Error("Canvas measureText returned an invalid width");
    }
    maxLineWidth = Math.max(maxLineWidth, width);
    start = index + 1;
  }
  return { lineCount, maxLineWidth };
}

function validateHeader(
  bytes: Uint8Array,
  variant: number,
  versionOffset: number,
  variantOffset: number,
  payloadOffset: number,
  fixedBytes?: number,
  minimumBytes = 4,
): void {
  if (
    bytes.byteLength < minimumBytes ||
    (fixedBytes !== undefined && bytes.byteLength !== fixedBytes) ||
    bytes[versionOffset] !== RESOURCE_ENCODING_VERSION ||
    bytes[variantOffset] !== variant
  ) {
    throw new Error("resource has invalid version, variant, size, or reserved bytes");
  }
  for (let index = variantOffset + 1; index < payloadOffset; index += 1) {
    if (bytes[index] !== 0) {
      throw new Error("resource has invalid version, variant, size, or reserved bytes");
    }
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error(`${label} resource is not valid UTF-8`);
  }
}

function hex(value: number | undefined): string {
  if (value === undefined) throw new Error("solid paint resource is truncated");
  return value.toString(16).padStart(2, "0");
}

function requiredByte(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset];
  if (value === undefined) throw new Error("solid paint resource is truncated");
  return value;
}

function define<T>(map: Map<number, T>, id: number, value: T, kind: string): void {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) {
    throw new RangeError(`${kind} resource id must be an unsigned 32-bit integer`);
  }
  if (map.has(id)) throw new Error(`${kind} resource ${String(id)} is already defined`);
  map.set(id, value);
}

function replaceMap<T>(target: Map<number, T>, source: ReadonlyMap<number, T>): void {
  target.clear();
  for (const [id, value] of source) target.set(id, value);
}
