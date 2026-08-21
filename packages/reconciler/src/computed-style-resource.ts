import {
  STYLE_COMPUTED_ENCODING,
  STYLE_FEATURE_BITS,
  STYLE_INTERACTION_STATE_MASK,
  STYLE_KEYWORD_IDS,
  STYLE_PROPERTIES,
  type ComputedStyle,
  type ResolveInteractionStylesResult,
  type StylePropertyName,
} from "@dopejs/pingo-style";

import {
  COMPUTED_STYLE_ENTRY_COUNT_OFFSET,
  COMPUTED_STYLE_FEATURE_BITS_OFFSET,
  COMPUTED_STYLE_PAYLOAD_BYTES_OFFSET,
  COMPUTED_STYLE_PAYLOAD_OFFSET,
  COMPUTED_STYLE_RESOURCE_VARIANT,
  COMPUTED_STYLE_VARIANT_OFFSET,
  COMPUTED_STYLE_VERSION_OFFSET,
  RESOURCE_ENCODING_VERSION,
} from "./generated";

const ENTRY_HEADER_BYTES = 8;
const TRANSFORM_RECORD_BYTES = 28;
const encoder = new TextEncoder();
const featureBitByPropertyId = new Map<number, number>(
  Object.values(STYLE_PROPERTIES).map((metadata) => [
    metadata.id,
    STYLE_FEATURE_BITS[metadata.feature as keyof typeof STYLE_FEATURE_BITS],
  ]),
);

/** Deterministically encodes resolved base and exact-state values for Core validation. */
export function encodeComputedStyleResource(result: ResolveInteractionStylesResult): Uint8Array {
  const entries: EncodedEntry[] = [];
  appendStyleEntries(entries, 0, result.style);
  for (const variant of result.variants) {
    requireStateMask(variant.stateMask);
    appendStyleEntries(entries, variant.stateMask, variant.style);
  }
  if (entries.length > STYLE_COMPUTED_ENCODING.maximumEntries) {
    throw new RangeError("computed style entry count exceeds the schema limit");
  }
  entries.sort(
    (left, right) => left.stateMask - right.stateMask || left.propertyId - right.propertyId,
  );
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.stateMask === current.stateMask &&
      previous.propertyId === current.propertyId
    ) {
      throw new Error("computed style contains a duplicate state/property entry");
    }
  }

  const payloadBytes = entries.reduce(
    (total, entry) => total + align4(ENTRY_HEADER_BYTES + entry.payload.byteLength),
    0,
  );
  const totalBytes = COMPUTED_STYLE_PAYLOAD_OFFSET + payloadBytes;
  if (totalBytes > STYLE_COMPUTED_ENCODING.maximumBytes) {
    throw new RangeError("computed style resource exceeds the schema byte limit");
  }
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  bytes[COMPUTED_STYLE_VERSION_OFFSET] = RESOURCE_ENCODING_VERSION;
  bytes[COMPUTED_STYLE_VARIANT_OFFSET] = COMPUTED_STYLE_RESOURCE_VARIANT;
  // The header declares the features this resource actually uses, not every
  // feature the Shell can emit. A Core that does not know a newer feature then
  // rejects only the resources that need it, instead of every resource.
  const featureBits = entries.reduce(
    (bits, entry) => bits | (featureBitByPropertyId.get(entry.propertyId) ?? 0),
    0,
  );
  view.setUint32(COMPUTED_STYLE_FEATURE_BITS_OFFSET, featureBits, true);
  view.setUint32(COMPUTED_STYLE_ENTRY_COUNT_OFFSET, entries.length, true);
  view.setUint32(COMPUTED_STYLE_PAYLOAD_BYTES_OFFSET, payloadBytes, true);
  let offset = COMPUTED_STYLE_PAYLOAD_OFFSET;
  for (const entry of entries) {
    view.setUint16(offset, entry.propertyId, true);
    view.setUint8(offset + 2, entry.stateMask);
    view.setUint8(offset + 3, entry.tag);
    view.setUint16(offset + 4, entry.payload.byteLength, true);
    view.setUint16(offset + 6, 0, true);
    bytes.set(entry.payload, offset + ENTRY_HEADER_BYTES);
    offset += align4(ENTRY_HEADER_BYTES + entry.payload.byteLength);
  }
  return bytes;
}

interface EncodedEntry {
  readonly propertyId: number;
  readonly stateMask: number;
  readonly tag: number;
  readonly payload: Uint8Array;
}

function appendStyleEntries(
  entries: EncodedEntry[],
  stateMask: number,
  style: ComputedStyle,
): void {
  for (const metadata of Object.values(STYLE_PROPERTIES)) {
    const value = style[metadata.jsName];
    if (value === undefined) continue;
    entries.push({
      propertyId: metadata.id,
      stateMask,
      ...encodeValue(metadata.jsName, metadata.canonical, value),
    });
  }
}

function encodeValue(
  property: StylePropertyName,
  canonical: string,
  value: number | string,
): Pick<EncodedEntry, "tag" | "payload"> {
  const tags = STYLE_COMPUTED_ENCODING.valueTags;
  switch (canonical) {
    case "keyword": {
      const keyword = STYLE_KEYWORD_IDS[value as keyof typeof STYLE_KEYWORD_IDS];
      if (keyword === undefined)
        throw new TypeError(`${property} has an unknown canonical keyword`);
      return { tag: tags.keyword, payload: u16Payload(keyword) };
    }
    case "length":
      return { tag: tags.length, payload: lengthPayload(requireString(value, property)) };
    case "rgba8":
      return { tag: tags.rgba8, payload: u32Payload(parseRgba(value, property)) };
    case "f32":
      return { tag: tags.f32, payload: f32Payload(requireFinite(value, property)) };
    case "font-family-list":
      return { tag: tags.fontFamilyList, payload: utf8Payload(requireString(value, property)) };
    case "u16": {
      const number = requireFinite(value, property);
      if (!Number.isInteger(number) || number < 0 || number > 0xffff) {
        throw new RangeError(`${property} must fit in an unsigned 16-bit value`);
      }
      return { tag: tags.u16, payload: u16Payload(number) };
    }
    case "line-height":
      return {
        tag: tags.lineHeight,
        payload:
          typeof value === "number"
            ? lengthPayloadFromParts(STYLE_COMPUTED_ENCODING.lengthUnits.number, value)
            : lengthPayload(value),
      };
    case "position":
      return { tag: tags.position, payload: positionPayload(requireString(value, property)) };
    case "transform-list":
      return { tag: tags.transformList, payload: transformPayload(requireString(value, property)) };
    default:
      throw new TypeError(`${property} uses unsupported canonical type ${canonical}`);
  }
}

function lengthPayload(value: string): Uint8Array {
  const units = STYLE_COMPUTED_ENCODING.lengthUnits;
  if (value === "auto") return lengthPayloadFromParts(units.auto, 0);
  if (value === "none") return lengthPayloadFromParts(units.none, 0);
  if (value === "normal") return lengthPayloadFromParts(units.normal, 0);
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|%)$/u.exec(value);
  if (match === null) throw new TypeError(`invalid canonical length ${JSON.stringify(value)}`);
  return lengthPayloadFromParts(match[2] === "%" ? units.percent : units.px, Number(match[1]));
}

function lengthPayloadFromParts(unit: number, value: number): Uint8Array {
  if (!Number.isFinite(value)) throw new RangeError("canonical length must be finite");
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setUint8(0, unit);
  view.setFloat32(4, value, true);
  return payload;
}

function positionPayload(value: string): Uint8Array {
  const parts = value.split(" ");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new TypeError("canonical position must contain exactly two axes");
  }
  const payload = new Uint8Array(16);
  payload.set(lengthPayload(parts[0]), 0);
  payload.set(lengthPayload(parts[1]), 8);
  return payload;
}

function transformPayload(value: string): Uint8Array {
  if (value === "none") return u32Payload(0);
  const functions = [...value.matchAll(/([a-zA-Z][a-zA-Z0-9]*)\(([^()]*)\)/gu)];
  if (functions.length === 0 || functions.map((match) => match[0]).join(" ") !== value) {
    throw new TypeError("invalid canonical transform list");
  }
  const payload = new Uint8Array(4 + functions.length * TRANSFORM_RECORD_BYTES);
  const view = new DataView(payload.buffer);
  view.setUint32(0, functions.length, true);
  let offset = 4;
  for (const match of functions) {
    const name = match[1] ?? "";
    const arguments_ = (match[2] ?? "")
      .trim()
      .split(/\s*,\s*|\s+/u)
      .filter(Boolean);
    const values = new Array<number>(6).fill(0);
    let operation: number;
    let xUnit = 0;
    let yUnit = 0;
    if (name === "matrix") {
      operation = STYLE_COMPUTED_ENCODING.transformOperations.matrix;
      if (arguments_.length !== 6) throw new TypeError("matrix requires six values");
      for (let index = 0; index < 6; index += 1)
        values[index] = requireNumberToken(arguments_[index]);
    } else if (name === "translate" || name === "translateX" || name === "translateY") {
      operation = STYLE_COMPUTED_ENCODING.transformOperations.translate;
      const x = name === "translateY" ? "0px" : arguments_[0];
      const y =
        name === "translateX"
          ? "0px"
          : (arguments_[1] ?? (name === "translate" ? "0px" : arguments_[0]));
      const xLength = transformLength(x);
      const yLength = transformLength(y);
      xUnit = xLength.unit;
      yUnit = yLength.unit;
      values[0] = xLength.value;
      values[1] = yLength.value;
    } else if (name === "scale" || name === "scaleX" || name === "scaleY") {
      operation = STYLE_COMPUTED_ENCODING.transformOperations.scale;
      const first = requireNumberToken(arguments_[0]);
      values[0] = name === "scaleY" ? 1 : first;
      values[1] = name === "scaleX" ? 1 : requireNumberToken(arguments_[1] ?? arguments_[0]);
    } else if (name === "rotate") {
      operation = STYLE_COMPUTED_ENCODING.transformOperations.rotate;
      values[0] = angleRadians(arguments_[0]);
    } else {
      throw new TypeError(`unsupported canonical transform operation ${name}`);
    }
    view.setUint8(offset, operation);
    view.setUint8(offset + 1, xUnit);
    view.setUint8(offset + 2, yUnit);
    for (let index = 0; index < 6; index += 1) {
      view.setFloat32(offset + 4 + index * 4, values[index] ?? 0, true);
    }
    offset += TRANSFORM_RECORD_BYTES;
  }
  return payload;
}

function transformLength(value: string | undefined): {
  readonly unit: number;
  readonly value: number;
} {
  if (value === undefined) throw new TypeError("transform length is missing");
  const payload = lengthPayload(value);
  const view = new DataView(payload.buffer);
  const unit = view.getUint8(0);
  if (
    unit !== STYLE_COMPUTED_ENCODING.lengthUnits.px &&
    unit !== STYLE_COMPUTED_ENCODING.lengthUnits.percent
  ) {
    throw new TypeError("transform translation requires px or percent");
  }
  return { unit, value: view.getFloat32(4, true) };
}

function angleRadians(value: string | undefined): number {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(deg|rad|turn)$/u.exec(value ?? "");
  if (match === null) throw new TypeError("rotate requires a canonical angle");
  const number = Number(match[1]);
  const radians =
    match[2] === "deg"
      ? (number * Math.PI) / 180
      : match[2] === "turn"
        ? number * Math.PI * 2
        : number;
  if (!Number.isFinite(radians)) throw new RangeError("rotation must be finite");
  return radians;
}

function parseRgba(value: number | string, property: string): number {
  if (typeof value !== "string") throw new TypeError(`${property} must be canonical rgba8 text`);
  const match = /^#([0-9a-f]{8})$/u.exec(value);
  if (match?.[1] === undefined) throw new TypeError(`${property} must be canonical #rrggbbaa`);
  return Number.parseInt(match[1], 16) >>> 0;
}

function utf8Payload(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const payload = new Uint8Array(4 + bytes.byteLength);
  new DataView(payload.buffer).setUint32(0, bytes.byteLength, true);
  payload.set(bytes, 4);
  return payload;
}

function u16Payload(value: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint16(0, value, true);
  return payload;
}

function u32Payload(value: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, value, true);
  return payload;
}

function f32Payload(value: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setFloat32(0, value, true);
  return payload;
}

function requireFinite(value: number | string, property: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${property} must be a finite canonical number`);
  }
  return value;
}

function requireString(value: number | string, property: string): string {
  if (typeof value !== "string") throw new TypeError(`${property} must be a canonical string`);
  return value;
}

function requireNumberToken(value: string | undefined): number {
  const number = Number(value);
  if (value === undefined || value.trim() === "" || !Number.isFinite(number)) {
    throw new TypeError("transform argument must be finite");
  }
  return number;
}

function requireStateMask(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || (value & ~STYLE_INTERACTION_STATE_MASK) !== 0) {
    throw new RangeError("computed style variant has invalid interaction-state bits");
  }
}

function align4(value: number): number {
  return (value + 3) & ~3;
}
