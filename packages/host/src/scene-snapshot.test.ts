import {
  NULL_NODE_ID,
  NodeKind,
  Prop,
  ResourceKind,
  decodeMutationBatch,
  encodeMutationBatch,
  type Mutation,
} from "@dopejs/doper-reconciler";
import { describe, expect, it } from "vitest";

import { MutationSceneSnapshot } from "./scene-snapshot";

describe("MutationSceneSnapshot", () => {
  it("compacts incremental state into one deterministic full replacement transaction", () => {
    const snapshot = new MutationSceneSnapshot();
    snapshot.apply(
      batch(10, [
        {
          bytes: Uint8Array.of(1, 2, 3, 4),
          kind: ResourceKind.Paint,
          resourceId: 50,
          type: "defineResource",
        },
        create(1, NodeKind.Root, NULL_NODE_ID),
        create(2, NodeKind.Container, 1),
        create(3, NodeKind.Container, 1),
        create(4, NodeKind.Scroll, 2),
        { nodeId: 2, prop: Prop.Width, type: "setF32", value: 100 },
        { nodeId: 2, prop: Prop.Padding, type: "setVec4", value: [1, 2, 3, 4] },
        { nodeId: 2, prop: Prop.BackgroundColor, resourceId: 50, type: "setRef" },
        { clear: 0, nodeId: 2, set: 5, type: "setFlags" },
        { behavior: 1, nodeId: 4, type: "scrollTo", x: 7, y: 9 },
      ]),
    );
    snapshot.apply(
      batch(11, [
        { beforeSibling: NULL_NODE_ID, newParent: 3, nodeId: 4, type: "reparent" },
        { nodeId: 2, prop: Prop.Width, type: "clearProp" },
        { nodeId: 2, type: "removeNode" },
      ]),
    );

    const encoded = snapshot.encode();
    const decoded = decodeMutationBatch(encoded);
    expect(decoded.frameSeq).toBe(11);
    expect(decoded.mutations.filter(({ type }) => type === "createNode")).toEqual([
      create(1, NodeKind.Root, NULL_NODE_ID),
      create(3, NodeKind.Container, 1),
      create(4, NodeKind.Scroll, 3),
    ]);
    expect(decoded.mutations).toContainEqual({
      behavior: 1,
      nodeId: 4,
      type: "scrollTo",
      x: 7,
      y: 9,
    });
    expect(
      decoded.mutations.some((mutation) => "nodeId" in mutation && mutation.nodeId === 2),
    ).toBe(false);

    const restored = new MutationSceneSnapshot();
    restored.apply(encoded);
    expect(restored.encode()).toEqual(encoded);
    expect(restored).toMatchObject({ frameSeq: 11, nodeCount: 3, resourceCount: 1 });
  });

  it("rolls back topology, resources, and frame sequence after a rejected transaction", () => {
    const snapshot = new MutationSceneSnapshot();
    snapshot.apply(
      batch(1, [create(1, NodeKind.Root, NULL_NODE_ID), create(2, NodeKind.Container, 1)]),
    );
    const before = snapshot.encode();

    expect(() =>
      snapshot.apply(
        batch(2, [
          {
            bytes: Uint8Array.of(1, 2, 3, 4),
            kind: ResourceKind.Paint,
            resourceId: 9,
            type: "defineResource",
          },
          { beforeSibling: NULL_NODE_ID, newParent: 2, nodeId: 1, type: "reparent" },
        ]),
      ),
    ).toThrow(/root/u);
    expect(snapshot.encode()).toEqual(before);
    expect(snapshot).toMatchObject({ frameSeq: 1, nodeCount: 2, resourceCount: 0 });
  });

  it("rejects stale frames and invalid lifecycle operations without mutation", () => {
    const snapshot = new MutationSceneSnapshot();
    snapshot.apply(batch(8, [create(1, NodeKind.Root, NULL_NODE_ID)]));
    const before = snapshot.encode();
    expect(() => snapshot.apply(batch(8, []))).toThrow(/not newer/u);
    expect(() => snapshot.apply(batch(9, [{ nodeId: 99, type: "removeNode" }]))).toThrow(
      /does not exist/u,
    );
    expect(snapshot.encode()).toEqual(before);
  });

  it("preserves u32 frame ordering across wrap", () => {
    const snapshot = new MutationSceneSnapshot();
    snapshot.apply(batch(0xffff_ffff, [create(1, NodeKind.Root, NULL_NODE_ID)]));
    snapshot.apply(batch(1, []));
    expect(snapshot.frameSeq).toBe(1);
  });

  it("removes a complete subtree with the same semantics as Core", () => {
    const snapshot = new MutationSceneSnapshot();
    snapshot.apply(
      batch(1, [
        create(1, NodeKind.Root, NULL_NODE_ID),
        create(2, NodeKind.Container, 1),
        create(3, NodeKind.Container, 2),
      ]),
    );
    snapshot.apply(batch(2, [{ nodeId: 2, type: "removeNode" }]));
    expect(snapshot.nodeCount).toBe(1);
    expect(
      decodeMutationBatch(snapshot.encode()).mutations.filter(({ type }) => type === "createNode"),
    ).toEqual([create(1, NodeKind.Root, NULL_NODE_ID)]);
  });

  it("does not publish staged state when the external commit rejects it", () => {
    const snapshot = new MutationSceneSnapshot();
    snapshot.apply(batch(1, [create(1, NodeKind.Root, NULL_NODE_ID)]));
    const before = snapshot.encode();
    expect(() =>
      snapshot.applyAfterAccepted(batch(2, [create(2, NodeKind.Container, 1)]), () => {
        throw new Error("transport rejected frame");
      }),
    ).toThrow(/transport rejected/u);
    expect(snapshot.encode()).toEqual(before);

    snapshot.applyAfterAccepted(batch(2, [create(2, NodeKind.Container, 1)]), () => undefined);
    expect(snapshot).toMatchObject({ frameSeq: 2, nodeCount: 2 });
  });

  it("preserves virtual-list configuration and materialized item identity during recovery", () => {
    const snapshot = new MutationSceneSnapshot();
    snapshot.apply(
      batch(1, [
        create(1, NodeKind.Root, NULL_NODE_ID),
        create(2, NodeKind.Scroll, 1),
        create(3, NodeKind.Container, 2),
        {
          type: "configureVirtualList",
          nodeId: 2,
          itemCount: 1_000_000,
          estimatedItemHeight: 24,
          baseOverscanViewports: 1,
          velocityHorizonSeconds: 0.25,
          maximumAheadViewports: 4,
        },
        { type: "setVirtualItem", nodeId: 3, itemIndex: 456_789 },
      ]),
    );

    const mutations = decodeMutationBatch(snapshot.encode()).mutations;
    expect(mutations).toContainEqual({
      type: "configureVirtualList",
      nodeId: 2,
      itemCount: 1_000_000,
      estimatedItemHeight: 24,
      baseOverscanViewports: 1,
      velocityHorizonSeconds: 0.25,
      maximumAheadViewports: 4,
    });
    expect(mutations).toContainEqual({ type: "setVirtualItem", nodeId: 3, itemIndex: 456_789 });
  });
});

function batch(frameSeq: number, mutations: readonly Mutation[]): Uint8Array {
  return encodeMutationBatch({ frameSeq, mutations });
}

function create(nodeId: number, kind: NodeKind, parent: number): Mutation {
  return { beforeSibling: NULL_NODE_ID, kind, nodeId, parent, type: "createNode" };
}
