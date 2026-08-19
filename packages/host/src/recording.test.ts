import { encodeInputBatch } from "@dopejs/pingo-editing";
import { NULL_NODE_ID, NodeKind, encodeMutationBatch } from "@dopejs/pingo-reconciler";
import { describe, expect, it, vi } from "vitest";

import {
  BinaryReplayRecorder,
  decodeReplayRecording,
  encodeReplayRecording,
  replayRecording,
  type ReplayDataClassification,
} from "./recording";
import { encodeSystemTextMetricBatch } from "./system-text-metrics";

describe("binary replay recording", () => {
  it("preserves exact transaction bytes and observed order", () => {
    const mutation = mutationBytes();
    const input = inputBytes();
    const metrics = systemTextMetricBytes();
    const bytes = encodeReplayRecording({
      records: [
        { type: "mutation", bytes: mutation },
        { type: "systemTextMetrics", bytes: metrics },
        { type: "input", bytes: input },
      ],
    });

    expect(decodeReplayRecording(bytes)).toEqual({
      records: [
        { type: "mutation", bytes: mutation },
        { type: "systemTextMetrics", bytes: metrics },
        { type: "input", bytes: input },
      ],
    });
    const events: string[] = [];
    replayRecording(bytes, {
      mutation: (nested) => events.push(`mutation:${String(nested.byteLength)}`),
      input: (nested) => events.push(`input:${String(nested.byteLength)}`),
      systemTextMetrics: (nested) => events.push(`metrics:${String(nested.byteLength)}`),
    });
    expect(events).toEqual([
      `mutation:${String(mutation.byteLength)}`,
      `metrics:${String(metrics.byteLength)}`,
      `input:${String(input.byteLength)}`,
    ]);
  });

  it("detaches retained and replayed buffers from callers", () => {
    const source = mutationBytes();
    const recorder = new BinaryReplayRecorder();
    expect(recorder.captureMutation(source, "recordable")).toBe(true);
    source.fill(0);

    const handler = vi.fn((nested: Uint8Array) => nested.fill(0));
    const archive = recorder.export();
    replayRecording(archive, { mutation: handler, input: vi.fn(), systemTextMetrics: vi.fn() });
    expect(handler).toHaveBeenCalledOnce();
    expect(() => decodeReplayRecording(archive)).not.toThrow();
  });

  it("requires privacy classification and never retains sensitive streams", () => {
    const recorder = new BinaryReplayRecorder();
    expect(recorder.captureInput(Uint8Array.of(1), "sensitive")).toBe(false);
    expect(recorder.size).toBe(0);
    expect(() =>
      recorder.captureInput(inputBytes(), "unknown" as ReplayDataClassification),
    ).toThrow(/classification/u);
    expect(recorder.size).toBe(0);
    expect(recorder.captureInput(inputBytes(), "recordable")).toBe(true);
    expect(recorder.size).toBe(1);
    recorder.clear();
    expect(decodeReplayRecording(recorder.export()).records).toEqual([]);
  });

  it("fails closed for hostile envelopes and malformed nested streams", () => {
    const canonical = encodeReplayRecording({
      records: [{ type: "mutation", bytes: mutationBytes() }],
    });
    // Bit zero of the record flags now means "skippable"; an undefined bit is
    // what must still be refused.
    const flagged = canonical.slice();
    flagged[17] = 2;
    expect(() => decodeReplayRecording(flagged)).toThrow(/flags/u);

    const unknown = canonical.slice();
    unknown[16] = 0xff;
    expect(() => decodeReplayRecording(unknown)).toThrow(/unknown/u);

    const hostileCount = canonical.slice();
    new DataView(hostileCount.buffer).setUint32(12, 0xffff_ffff, true);
    expect(() => decodeReplayRecording(hostileCount)).toThrow(/count/u);

    const malformedNested = canonical.slice();
    malformedNested[24] = 0;
    expect(() => decodeReplayRecording(malformedNested)).toThrow(/nested mutation/u);
    expect(() =>
      encodeReplayRecording({ records: [{ type: "input", bytes: Uint8Array.of(1, 2, 3, 4) }] }),
    ).toThrow(/nested input/u);
  });
});

function mutationBytes(): Uint8Array {
  return encodeMutationBatch({
    frameSeq: 1,
    mutations: [
      {
        type: "createNode",
        nodeId: 1 << 20,
        kind: NodeKind.Root,
        parent: NULL_NODE_ID,
        beforeSibling: NULL_NODE_ID,
      },
    ],
  });
}

function inputBytes(): Uint8Array {
  return encodeInputBatch({
    frameSeq: 2,
    commands: [{ type: "insert", nodeId: 1 << 20, baseRevision: 7n, text: "你" }],
  });
}

function systemTextMetricBytes(): Uint8Array {
  return encodeSystemTextMetricBatch([
    {
      type: "upsert",
      metric: {
        stringId: 7,
        styleId: 9,
        maxLineWidth: 42,
        lineCount: 1,
        advances: [],
        positionalAdvances: [],
        contractions: [],
      },
    },
  ]);
}
