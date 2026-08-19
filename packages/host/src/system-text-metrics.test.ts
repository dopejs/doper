import { describe, expect, it } from "vitest";

import {
  SystemTextMetricError,
  decodeSystemTextMetricBatch,
  encodeSystemTextMetricBatch,
  type SystemTextMetric,
  type SystemTextMetricDelta,
} from "./system-text-metrics";

const canonical: readonly SystemTextMetricDelta[] = [
  {
    type: "upsert",
    metric: {
      stringId: 7,
      styleId: 9,
      maxLineWidth: 123.5,
      lineCount: 2,
      advances: [
        [10, 0],
        [97, 6.5],
        [0x4e2d, 12],
      ],
    },
  },
  { type: "release", stringId: 8, styleId: 10 },
];

describe("system text metric batches", () => {
  it("round-trips canonical upsert and release deltas", () => {
    const bytes = encodeSystemTextMetricBatch(canonical);
    expect(decodeSystemTextMetricBatch(bytes)).toEqual(canonical);
    expect(encodeSystemTextMetricBatch(decodeSystemTextMetricBatch(bytes))).toEqual(bytes);
  });

  it("rejects duplicate pairs and invalid metric values", () => {
    expect(() => encodeSystemTextMetricBatch([...canonical, canonical[0]!])).toThrow(
      /more than once/u,
    );
    const invalid: readonly SystemTextMetric[] = [
      { stringId: 0, styleId: 1, maxLineWidth: 1, lineCount: 1, advances: [] },
      { stringId: 1, styleId: 1, maxLineWidth: -1, lineCount: 1, advances: [] },
      { stringId: 1, styleId: 1, maxLineWidth: 1, lineCount: 0, advances: [] },
      { stringId: 1, styleId: 1, maxLineWidth: Number.NaN, lineCount: 1, advances: [] },
      { stringId: 1, styleId: 1, maxLineWidth: Number.MAX_VALUE, lineCount: 1, advances: [] },
      { stringId: 1, styleId: 1, maxLineWidth: 1, lineCount: 1, advances: [[97, Number.NaN]] },
      { stringId: 1, styleId: 1, maxLineWidth: 1, lineCount: 1, advances: [[97, -1]] },
      // Surrogate halves are not scalar values, and an unsorted or duplicated
      // table would give one logical table two byte sequences.
      { stringId: 1, styleId: 1, maxLineWidth: 1, lineCount: 1, advances: [[0xd800, 1]] },
      { stringId: 1, styleId: 1, maxLineWidth: 1, lineCount: 1, advances: [[0x11_0000, 1]] },
      {
        stringId: 1,
        styleId: 1,
        maxLineWidth: 1,
        lineCount: 1,
        advances: [
          [98, 1],
          [97, 1],
        ],
      },
      {
        stringId: 1,
        styleId: 1,
        maxLineWidth: 1,
        lineCount: 1,
        advances: [
          [97, 1],
          [97, 1],
        ],
      },
    ];
    for (const metric of invalid) {
      expect(() => encodeSystemTextMetricBatch([{ type: "upsert", metric }])).toThrow(
        SystemTextMetricError,
      );
    }
  });

  it("fails closed for truncation, flags, reserved bytes, and hostile counts", () => {
    const canonicalBytes = encodeSystemTextMetricBatch(canonical);
    for (let length = 0; length < canonicalBytes.byteLength; length += 1) {
      expect(
        () => decodeSystemTextMetricBatch(canonicalBytes.slice(0, length)),
        `truncated at ${String(length)}`,
      ).toThrow(SystemTextMetricError);
    }
    // Byte 17 is the instruction flags: bit zero now means "skippable", so an
    // undefined bit is what must still be refused. Bytes 18 and 19 are the
    // declared length, where any change desynchronizes the payload.
    for (const [offset, value] of [
      [17, 2],
      [18, 1],
      [19, 1],
    ] as const) {
      const malformed = canonicalBytes.slice();
      malformed[offset] = value;
      expect(() => decodeSystemTextMetricBatch(malformed)).toThrow(SystemTextMetricError);
    }
    const hostile = canonicalBytes.slice(0, 16);
    const hostileView = new DataView(hostile.buffer);
    hostileView.setUint32(8, hostile.byteLength, true);
    hostileView.setUint32(12, 0xffff_ffff, true);
    expect(() => decodeSystemTextMetricBatch(hostile)).toThrow(/too many/u);
  });
});
