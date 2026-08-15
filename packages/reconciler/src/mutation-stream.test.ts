import { describe, expect, it } from "vitest";

import { MAX_MUTATION_INSTRUCTIONS, NodeKind, Prop, ResourceKind } from "./generated";
import {
  NULL_NODE_ID,
  decodeMutationBatch,
  encodeMutationBatch,
  type Mutation,
  type MutationBatch,
} from "./mutation-stream";

const GOLDEN_BATCH: MutationBatch = {
  frameSeq: 42,
  mutations: [
    {
      type: "createNode",
      nodeId: 7,
      kind: NodeKind.Text,
      parent: NULL_NODE_ID,
      beforeSibling: NULL_NODE_ID,
    },
    { type: "setF32", nodeId: 7, prop: Prop.Width, value: 320.5 },
    {
      type: "defineResource",
      resourceId: 9,
      kind: ResourceKind.Utf8String,
      bytes: new TextEncoder().encode("hello"),
    },
    { type: "setTextRun", nodeId: 7, stringId: 9, styleId: 10 },
  ],
};

describe("Mutation Stream", () => {
  it("round-trips a canonical transaction", () => {
    const bytes = encodeMutationBatch(GOLDEN_BATCH);
    expect(decodeMutationBatch(bytes)).toEqual(GOLDEN_BATCH);
    expect(toHex(bytes)).toBe(
      "444f504d010010006400000005000000010000000700000003000000ffffffffffffffff1000000007000000010000000040a0433000000009000000010000000500000068656c6c6f0000002000000007000000090000000a000000f00000002a000000",
    );
  });

  it("fails closed for truncation, unknown opcodes, and wrong prop wire types", () => {
    const canonical = encodeMutationBatch(GOLDEN_BATCH);
    expect(() => decodeMutationBatch(canonical.slice(0, -1))).toThrow(/aligned/u);

    const unknown = canonical.slice();
    unknown[16] = 0xfe;
    expect(() => decodeMutationBatch(unknown)).toThrow(/unknown mutation opcode/u);

    const wrongProp = canonical.slice();
    wrongProp[44] = Prop.Padding;
    expect(() => decodeMutationBatch(wrongProp)).toThrow(/requires vec4/u);
  });

  it("rejects non-finite numbers and overlapping flag mutations before encoding", () => {
    expect(() =>
      encodeMutationBatch({
        frameSeq: 1,
        mutations: [{ type: "setF32", nodeId: 1, prop: Prop.Width, value: Number.NaN }],
      }),
    ).toThrow(/finite/u);
    expect(() =>
      encodeMutationBatch({
        frameSeq: 1,
        mutations: [{ type: "setFlags", nodeId: 1, set: 3, clear: 1 }],
      }),
    ).toThrow(/overlap/u);

    const oversized = { length: MAX_MUTATION_INSTRUCTIONS } as readonly Mutation[];
    expect(() => encodeMutationBatch({ frameSeq: 1, mutations: oversized })).toThrow(
      /instruction count/u,
    );
  });

  it("round-trips property clearing and resource release", () => {
    const batch: MutationBatch = {
      frameSeq: 9,
      mutations: [
        { type: "clearProp", nodeId: 1, prop: Prop.BackgroundColor },
        { type: "releaseResource", resourceId: 8 },
      ],
    };
    expect(decodeMutationBatch(encodeMutationBatch(batch))).toEqual(batch);
  });

  it("round-trips virtual-list configuration and materialized item identity", () => {
    const batch: MutationBatch = {
      frameSeq: 10,
      mutations: [
        {
          type: "configureVirtualList",
          nodeId: 1,
          itemCount: 1_000_000,
          estimatedItemHeight: 24,
          baseOverscanViewports: 1,
          velocityHorizonSeconds: 0.25,
          maximumAheadViewports: 4,
        },
        { type: "setVirtualItem", nodeId: 2, itemIndex: 999_999 },
      ],
    };
    expect(decodeMutationBatch(encodeMutationBatch(batch))).toEqual(batch);
    expect(() =>
      encodeMutationBatch({
        ...batch,
        mutations: [
          {
            ...(batch.mutations[0] as Extract<Mutation, { type: "configureVirtualList" }>),
            estimatedItemHeight: Number.NaN,
          },
        ],
      }),
    ).toThrow(/finite/u);
  });
});

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
