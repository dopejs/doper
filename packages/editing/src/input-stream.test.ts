import { describe, expect, it } from "vitest";

import { InputOpcode } from "./generated";
import {
  InputAffinity,
  InputStreamError,
  decodeInputBatch,
  encodeInputBatch,
  type InputBatch,
} from "./input-stream";

const REVISION = 0x0123_4567_89ab_cdefn;

function sampleBatch(): InputBatch {
  return {
    frameSeq: 77,
    commands: [
      {
        type: "replace",
        nodeId: 1,
        baseRevision: REVISION,
        start: 2,
        end: 4,
        text: "替换",
      },
      { type: "insert", nodeId: 1, baseRevision: REVISION + 1n, text: "👨‍👩‍👧‍👦" },
      { type: "deleteBackward", nodeId: 1, baseRevision: REVISION + 2n },
      { type: "deleteForward", nodeId: 1, baseRevision: REVISION + 3n },
      {
        type: "setSelection",
        nodeId: 1,
        baseRevision: REVISION + 4n,
        selection: {
          anchor: { offset: 8, affinity: InputAffinity.Upstream },
          focus: { offset: 3, affinity: InputAffinity.Downstream },
        },
      },
      { type: "beginComposition", nodeId: 1, baseRevision: REVISION + 5n },
      { type: "updateComposition", nodeId: 1, baseRevision: REVISION + 6n, text: "に" },
      {
        type: "commitComposition",
        nodeId: 1,
        baseRevision: REVISION + 7n,
        text: "日本",
      },
      { type: "commitComposition", nodeId: 1, baseRevision: REVISION + 8n },
      { type: "cancelComposition", nodeId: 1, baseRevision: REVISION + 9n },
      { type: "undo", nodeId: 1, baseRevision: REVISION + 10n },
      { type: "redo", nodeId: 1, baseRevision: REVISION + 11n },
      { type: "placeCaret", nodeId: 1, x: 42.5, y: 11, extend: true, word: false },
      { type: "placeCaret", nodeId: 1, x: -3, y: 0.25, extend: false, word: true },
      { type: "scrollBegin", nodeId: 2 },
      { type: "scrollDelta", nodeId: 2, deltaX: -3.5, deltaY: 24.25, elapsedMicros: 16_667 },
      { type: "scrollEnd", nodeId: 2 },
      { type: "scrollCancel", nodeId: 2 },
      {
        type: "dispatchEvent",
        eventId: 19,
        kind: "wheel",
        x: 12.5,
        y: 24,
        deltaX: -3,
        deltaY: 40,
        buttons: 1,
        modifiers: 9,
        pointerId: 0,
        elapsedMicros: 16_667,
      },
    ],
  };
}

describe("Input Stream", () => {
  it("round trips every command without losing u64 revisions or Unicode", () => {
    const batch = sampleBatch();
    const bytes = encodeInputBatch(batch);
    expect(bytes.byteLength % 4).toBe(0);
    expect(decodeInputBatch(bytes)).toEqual(batch);
  });

  it("rejects invalid revisions and range fields before encoding", () => {
    expect(() =>
      encodeInputBatch({
        frameSeq: 1,
        commands: [{ type: "undo", nodeId: 1, baseRevision: -1n }],
      }),
    ).toThrow(/u64 bigint/u);
    expect(() =>
      encodeInputBatch({
        frameSeq: 1,
        commands: [
          {
            type: "replace",
            nodeId: 1,
            baseRevision: 0n,
            start: -1,
            end: 0,
            text: "",
          },
        ],
      }),
    ).toThrow(/u32/u);
  });

  it("rejects non-finite, oversized, and untimed scroll deltas", () => {
    for (const command of [
      { type: "scrollDelta", nodeId: 1, deltaX: Number.NaN, deltaY: 0, elapsedMicros: 1 },
      { type: "scrollDelta", nodeId: 1, deltaX: 0, deltaY: 1_000_001, elapsedMicros: 1 },
      { type: "scrollDelta", nodeId: 1, deltaX: 0, deltaY: 1, elapsedMicros: 0 },
    ] as const) {
      expect(() => encodeInputBatch({ frameSeq: 1, commands: [command] })).toThrow(
        InputStreamError,
      );
    }

    const invalid = encodeInputBatch({
      frameSeq: 1,
      commands: [{ type: "scrollDelta", nodeId: 1, deltaX: 0, deltaY: 1, elapsedMicros: 16_667 }],
    });
    new DataView(invalid.buffer).setFloat32(24, Number.POSITIVE_INFINITY, true);
    expect(() => decodeInputBatch(invalid)).toThrow(/non-finite f32/u);
  });

  it("rejects non-finite caret placement coordinates and reserved flag bits", () => {
    const place = (x: number, y: number) =>
      encodeInputBatch({
        frameSeq: 1,
        commands: [{ type: "placeCaret", nodeId: 1, x, y, extend: false, word: false }],
      });
    expect(() => place(Number.NaN, 0)).toThrow(/coordinate/u);
    expect(() => place(0, Number.POSITIVE_INFINITY)).toThrow(/coordinate/u);
    const bytes = place(4, 8);
    const view = new DataView(bytes.buffer);
    // The flags word is the final field before the 8-byte Commit instruction.
    view.setUint32(bytes.byteLength - 12, 0xff, true);
    expect(() => decodeInputBatch(bytes)).toThrow(/reserved/u);
  });

  it("rejects invalid event coordinates and reserved flag bits", () => {
    const valid = {
      type: "dispatchEvent" as const,
      eventId: 1,
      kind: "pointerdown" as const,
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: 0,
      buttons: 1,
      modifiers: 0,
      pointerId: 1,
      elapsedMicros: 16_667,
    };
    for (const command of [
      { ...valid, x: Number.NaN },
      { ...valid, x: 1_000_000_001 },
      { ...valid, deltaY: 1_000_001 },
      { ...valid, buttons: 0x1_0000 },
      { ...valid, modifiers: 0x10 },
    ]) {
      expect(() => encodeInputBatch({ frameSeq: 1, commands: [command] })).toThrow(
        InputStreamError,
      );
    }
  });

  it("fails closed on unknown affinities, non-zero padding, and invalid UTF-8", () => {
    const selection = encodeInputBatch({
      frameSeq: 1,
      commands: [
        {
          type: "setSelection",
          nodeId: 1,
          baseRevision: 0n,
          selection: {
            anchor: { offset: 0, affinity: InputAffinity.Upstream },
            focus: { offset: 0, affinity: InputAffinity.Downstream },
          },
        },
      ],
    });
    selection[40] = 2;
    expect(() => decodeInputBatch(selection)).toThrow(/unknown input affinity/u);

    const padded = encodeInputBatch({
      frameSeq: 1,
      commands: [{ type: "insert", nodeId: 1, baseRevision: 0n, text: "x" }],
    });
    padded[37] = 1;
    expect(() => decodeInputBatch(padded)).toThrow(/reserved input bytes/u);

    const invalidUtf8 = encodeInputBatch({
      frameSeq: 1,
      commands: [{ type: "insert", nodeId: 1, baseRevision: 0n, text: "x" }],
    });
    invalidUtf8[36] = 0xff;
    expect(() => decodeInputBatch(invalidUtf8)).toThrow(/not valid UTF-8/u);
  });

  it("rejects hostile envelopes and arbitrary bytes without leaking native errors", () => {
    const canonical = encodeInputBatch({ frameSeq: 1, commands: [] });
    const unknown = canonical.slice();
    unknown[16] = 0xfe;
    expect(() => decodeInputBatch(unknown)).toThrow(InputStreamError);

    const notLast = new Uint8Array(canonical.byteLength + 8);
    notLast.set(canonical);
    notLast.set([InputOpcode.Commit, 0, 0, 0, 2, 0, 0, 0], canonical.byteLength);
    const view = new DataView(notLast.buffer);
    view.setUint32(8, notLast.byteLength, true);
    view.setUint32(12, 2, true);
    expect(() => decodeInputBatch(notLast)).toThrow(/must be the last/u);

    let state = 0x1234_5678;
    for (let sample = 0; sample < 1_000; sample += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const bytes = new Uint8Array(state % 128);
      for (let index = 0; index < bytes.length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        bytes[index] = state & 0xff;
      }
      try {
        decodeInputBatch(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(InputStreamError);
      }
    }
  });
});
