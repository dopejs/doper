import { describe, expect, it } from "vitest";
import {
  STYLE_COMPUTED_ENCODING,
  STYLE_INTERACTION_STATES,
  STYLE_PROPERTIES,
  createStyleSheet,
  resolveInteractionStyles,
} from "@dopejs/pingo-style";

import { encodeComputedStyleResource } from "./computed-style-resource";
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

describe("computed style resource", () => {
  it("encodes a deterministic, sorted, bounded base and exact-state table", () => {
    const resolved = resolveInteractionStyles({
      nodeType: "view",
      className: "card",
      styleSheets: [
        createStyleSheet(`
          .card { width: 50%; background-color: #1234; transform: translate(10px, 20%) rotate(90deg); }
          .card:hover { opacity: 0.5; cursor: pointer; }
          .card:hover:active { opacity: 0.25; }
        `),
      ],
    });
    const first = encodeComputedStyleResource(resolved);
    const second = encodeComputedStyleResource(resolved);
    expect(second).toEqual(first);
    expect(first.byteLength).toBeLessThanOrEqual(STYLE_COMPUTED_ENCODING.maximumBytes);

    const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
    expect(first[COMPUTED_STYLE_VERSION_OFFSET]).toBe(RESOURCE_ENCODING_VERSION);
    expect(first[COMPUTED_STYLE_VARIANT_OFFSET]).toBe(COMPUTED_STYLE_RESOURCE_VARIANT);
    expect(view.getUint32(COMPUTED_STYLE_FEATURE_BITS_OFFSET, true)).not.toBe(0);
    const count = view.getUint32(COMPUTED_STYLE_ENTRY_COUNT_OFFSET, true);
    expect(count).toBeGreaterThan(Object.keys(STYLE_PROPERTIES).length / 2);
    expect(count).toBeLessThanOrEqual(STYLE_COMPUTED_ENCODING.maximumEntries);
    expect(view.getUint32(COMPUTED_STYLE_PAYLOAD_BYTES_OFFSET, true)).toBe(
      first.byteLength - COMPUTED_STYLE_PAYLOAD_OFFSET,
    );

    const pairs: Array<readonly [number, number]> = [];
    let offset = COMPUTED_STYLE_PAYLOAD_OFFSET;
    for (let index = 0; index < count; index += 1) {
      const property = view.getUint16(offset, true);
      const state = view.getUint8(offset + 2);
      const tag = view.getUint8(offset + 3);
      const payloadBytes = view.getUint16(offset + 4, true);
      expect(view.getUint16(offset + 6, true)).toBe(0);
      expect(tag).toBeGreaterThan(0);
      expect(payloadBytes).toBeGreaterThan(0);
      pairs.push([state, property]);
      offset += align4(8 + payloadBytes);
    }
    expect(offset).toBe(first.byteLength);
    expect(pairs).toEqual(
      [...pairs].sort((left, right) => left[0] - right[0] || left[1] - right[1]),
    );
    expect(
      pairs.some(
        ([state, property]) =>
          state === STYLE_INTERACTION_STATES.hover && property === STYLE_PROPERTIES.opacity.id,
      ),
    ).toBe(true);
    expect(
      pairs.some(
        ([state, property]) =>
          state === (STYLE_INTERACTION_STATES.hover | STYLE_INTERACTION_STATES.active) &&
          property === STYLE_PROPERTIES.opacity.id,
      ),
    ).toBe(true);
  });

  it("rejects forged interaction states before producing bytes", () => {
    const resolved = resolveInteractionStyles({ nodeType: "view" });
    expect(() =>
      encodeComputedStyleResource({
        ...resolved,
        variants: [{ stateMask: 0x80, style: { opacity: 0.5 } }],
      }),
    ).toThrow(RangeError);
  });
});

function align4(value: number): number {
  return (value + 3) & ~3;
}
