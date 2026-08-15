import type { Canvas2DResources, CanvasTextStyle } from "./replayer.js";
import {
  AFFINE_A_OFFSET,
  AFFINE_RESOURCE_FIXED_BYTES,
  AFFINE_RESOURCE_VARIANT,
  AFFINE_VARIANT_OFFSET,
  AFFINE_VERSION_OFFSET,
  RESOURCE_ENCODING_VERSION,
  ResourceKind,
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
} from "./generated.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Mutable setup-time registry; replay observes stable synchronous snapshots. */
export class Canvas2DResourceRegistry implements Canvas2DResources {
  readonly #paints = new Map<number, string | CanvasGradient | CanvasPattern>();
  readonly #paths = new Map<number, Path2D>();
  readonly #images = new Map<number, CanvasImageSource>();
  readonly #texts = new Map<number, string>();
  readonly #textStyles = new Map<number, CanvasTextStyle>();
  readonly #fonts = new Map<number, object>();
  readonly #glyphSpans = new Map<number, object>();
  readonly #pictures = new Map<number, Uint8Array>();
  readonly #encodedKinds = new Map<number, ResourceKind>();

  /** Optional shaped-glyph renderer installed by the text backend. */
  public drawGlyphRun: Canvas2DResources["drawGlyphRun"] = undefined;

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
  public defineFont(id: number, value: object): void {
    define(this.#fonts, id, value, "font");
  }

  /** Defines a text-backend glyph span exactly once. */
  public defineGlyphSpan(id: number, value: object): void {
    define(this.#glyphSpans, id, value, "glyph span");
  }

  /** Defines a copied immutable picture payload exactly once. */
  public definePicture(id: number, value: Uint8Array): void {
    define(this.#pictures, id, value.slice(), "picture");
  }

  /** Decodes a portable Core resource whose Canvas representation is deterministic. */
  public defineEncodedResource(id: number, kind: ResourceKind, bytes: Uint8Array): void {
    if (this.#encodedKinds.has(id)) {
      throw new Error(`encoded resource ${String(id)} is already defined`);
    }
    switch (kind) {
      case ResourceKind.Utf8String:
        this.defineText(id, decodeUtf8(bytes, "UTF-8 string"));
        break;
      case ResourceKind.Paint:
        this.definePaint(id, decodeSolidPaint(bytes));
        break;
      case ResourceKind.TextStyle: {
        const decoded = decodeTextStyle(bytes);
        const fillStyle = this.getPaint(decoded.paintId);
        if (fillStyle === undefined) {
          throw new Error(
            `text style references missing paint resource ${String(decoded.paintId)}`,
          );
        }
        this.defineTextStyle(id, {
          font: `${String(decoded.weight)} ${String(decoded.fontSize)}px ${JSON.stringify(decoded.family)}`,
          fillStyle,
          textBaseline: "alphabetic",
        });
        break;
      }
      case ResourceKind.Affine:
        // Paint resolves affine resources into DisplayList transforms, so the
        // Canvas backend only tracks their lifetime.
        validateAffine(bytes);
        break;
      default:
        throw new Error(`resource kind ${String(kind)} requires a host-specific resolver`);
    }
    this.#encodedKinds.set(id, kind);
  }

  /** Releases one portable resource after Core accepted the same transaction. */
  public releaseEncodedResource(id: number, kind: ResourceKind): void {
    const actual = this.#encodedKinds.get(id);
    if (actual !== kind) {
      throw new Error(
        `encoded resource ${String(id)} has kind ${String(actual)} instead of ${String(kind)}`,
      );
    }
    this.#encodedKinds.delete(id);
    const removed = (() => {
      switch (kind) {
        case ResourceKind.Utf8String:
          return this.#texts.delete(id);
        case ResourceKind.Paint:
          return this.#paints.delete(id);
        case ResourceKind.TextStyle:
          return this.#textStyles.delete(id);
        case ResourceKind.Affine:
          return true;
        default:
          return false;
      }
    })();
    if (!removed) throw new Error(`encoded resource ${String(id)} backing value is missing`);
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

  public getFont(id: number): object | undefined {
    return this.#fonts.get(id);
  }

  public getGlyphSpan(id: number): object | undefined {
    return this.#glyphSpans.get(id);
  }

  public getPicture(id: number): Uint8Array | undefined {
    return this.#pictures.get(id);
  }
}

function decodeSolidPaint(bytes: Uint8Array): string {
  validateHeader(
    bytes,
    SOLID_PAINT_RESOURCE_VARIANT,
    SOLID_PAINT_VERSION_OFFSET,
    SOLID_PAINT_VARIANT_OFFSET,
    SOLID_PAINT_RED_OFFSET,
    SOLID_PAINT_RESOURCE_FIXED_BYTES,
  );
  return `#${hex(bytes[SOLID_PAINT_RED_OFFSET])}${hex(bytes[SOLID_PAINT_GREEN_OFFSET])}${hex(bytes[SOLID_PAINT_BLUE_OFFSET])}${hex(bytes[SOLID_PAINT_ALPHA_OFFSET])}`;
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
  return { paintId, fontSize, weight, family };
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

function define<T>(map: Map<number, T>, id: number, value: T, kind: string): void {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) {
    throw new RangeError(`${kind} resource id must be an unsigned 32-bit integer`);
  }
  if (map.has(id)) throw new Error(`${kind} resource ${String(id)} is already defined`);
  map.set(id, value);
}
