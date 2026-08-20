import {
  createElement,
  createFont,
  type PingoEvent,
  type PingoNode,
  type NodeHandle,
} from "@dopejs/pingo-jsx";
import { signal, useEffect } from "@dopejs/pingo-runtime";
import { describe, expect, it, vi } from "vitest";

import { NodeKind, Prop, ResourceKind } from "./generated";
import { decodeMutationBatch, type Mutation, type MutationBatch } from "./mutation-stream";
import { createRoot, type MutationSink } from "./reconciler";

class RecordingSink implements MutationSink {
  public readonly batches: MutationBatch[] = [];
  public readonly events: string[] = [];

  public commit(bytes: Uint8Array): void {
    this.events.push("commit");
    this.batches.push(decodeMutationBatch(bytes));
  }
}

describe("reconciler", () => {
  it("mounts a deterministic host tree and removes cleared resources", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    root.render(
      createElement("container", {
        backgroundColor: "#123456",
        children: createElement("text", { value: "hello" }),
      }),
    );

    expect(createdKinds(sink.batches[0])).toEqual([
      NodeKind.Root,
      NodeKind.Container,
      NodeKind.Text,
    ]);
    expect(mutationsOfType(sink.batches[0], "setTextRun")).toHaveLength(1);

    root.render(
      createElement("container", {
        children: createElement("text", { value: "hello" }),
      }),
    );
    expect(sink.batches).toHaveLength(2);
    expect(mutationsOfType(sink.batches[1], "clearProp")).toContainEqual(
      expect.objectContaining({ prop: Prop.BackgroundColor }),
    );
    expect(mutationsOfType(sink.batches[1], "releaseResource")).toHaveLength(1);
  });

  it("binds an explicit immutable font independently from fallback text style", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const font = createFont(Uint8Array.of(0x4f, 0x54, 0x54, 0x4f, 0, 0, 0, 0), {
      fallbackFamily: "Fixture",
    });
    root.render(createElement("text", { value: "hello", font }));

    const batch = sink.batches[0];
    expect(mutationsOfType(batch, "defineResource")).toContainEqual(
      expect.objectContaining({ kind: ResourceKind.Font }),
    );
    expect(mutationsOfType(batch, "setRef")).toContainEqual(
      expect.objectContaining({ prop: Prop.Font }),
    );

    root.render(createElement("text", { value: "hello" }));
    expect(mutationsOfType(sink.batches[1], "clearProp")).toContainEqual(
      expect.objectContaining({ prop: Prop.Font }),
    );
  });

  it("accepts every documented editable prop and still rejects unknown ones", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    // Every prop on EditableTextProps must survive the allowlist; a prop that
    // reaches normalization but not the allowlist fails only at runtime.
    expect(() =>
      root.render(
        createElement("editableText", {
          value: "a",
          revision: 1n,
          multiline: true,
          readOnly: false,
          password: false,
          maxGraphemes: 100,
          inputMode: "email",
          onTransaction: () => undefined,
          onSubmit: () => undefined,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      root.render(createElement("editableText", { value: "a", revision: 1n, bogus: 1 })),
    ).toThrow(/unknown editableText prop bogus/u);
  });

  it("applies revisioned edit deltas to the Shell mirror without stale prop overwrite", () => {
    const sink = new RecordingSink();
    const onTransaction = vi.fn();
    const root = createRoot(sink);
    root.render(createElement("editableText", { value: "a", revision: 0n, onTransaction }));
    const configuration = mutationsOfType(sink.batches[0], "configureEditable")[0];
    if (configuration === undefined) throw new Error("editable configuration missing");

    root.applyEditTransaction({
      nodeId: configuration.nodeId,
      baseRevision: 0n,
      revision: 1n,
      delta: { range: { start: 1, end: 1 }, text: "🙂" },
      selection: {
        anchor: 3,
        anchorAffinity: "downstream",
        focus: 3,
        focusAffinity: "downstream",
      },
      kind: "edit",
    });
    expect(onTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseRevision: 0n, revision: 1n }),
    );

    root.render(createElement("editableText", { value: "a", revision: 0n, onTransaction }));
    root.applyEditTransaction({
      nodeId: configuration.nodeId,
      baseRevision: 1n,
      revision: 2n,
      delta: { range: { start: 3, end: 3 }, text: "!" },
      selection: {
        anchor: 4,
        anchorAffinity: "downstream",
        focus: 4,
        focusAffinity: "downstream",
      },
      kind: "edit",
    });
    expect(onTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseRevision: 1n, revision: 2n }),
    );
  });

  it("preserves keyed host identity while reordering siblings", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const list = (order: readonly string[]): PingoNode =>
      createElement("container", {
        children: order.map((value) => createElement("text", { value, key: value })),
      });

    root.render(list(["a", "b", "c"]));
    root.render(list(["c", "a", "b"]));

    const update = sink.batches[1];
    expect(mutationsOfType(update, "createNode")).toHaveLength(0);
    expect(mutationsOfType(update, "removeNode")).toHaveLength(0);
    expect(mutationsOfType(update, "reparent")).toHaveLength(1);
  });

  it("rerenders only the component invalidated by a signal", () => {
    const sink = new RecordingSink();
    const scheduled: Array<() => void> = [];
    const value = signal("first");
    const root = createRoot(sink, { schedule: (task) => scheduled.push(task) });
    const App = (): PingoNode => createElement("text", { value: value.get() });

    root.render(createElement(App, {}));
    value.set("second");
    expect(scheduled).toHaveLength(1);
    root.flushSync();

    const update = sink.batches[1];
    expect(mutationsOfType(update, "createNode")).toHaveLength(0);
    expect(mutationsOfType(update, "removeNode")).toHaveLength(0);
    expect(mutationsOfType(update, "setTextRun")).toHaveLength(1);
  });

  it("runs refs and effects only after the mutation frame commits", () => {
    const sink = new RecordingSink();
    const ref = vi.fn((_handle: NodeHandle | null) => sink.events.push("ref"));
    const App = (): PingoNode => {
      useEffect(() => {
        sink.events.push("effect");
      }, []);
      return createElement("container", { ref });
    };

    createRoot(sink).render(createElement(App, {}));

    expect(sink.events).toEqual(["commit", "ref", "effect"]);
    expect(ref.mock.calls[0]?.[0]?.nodeId).toEqual(expect.any(Number));
  });

  it("routes callback identifiers and invalidates them when their prop is removed", () => {
    const sink = new RecordingSink();
    const callback = vi.fn();
    const root = createRoot(sink);
    root.render(createElement("container", { onTap: callback }));
    const binding = mutationsOfType(sink.batches[0], "setRef").find(
      (mutation) => mutation.prop === Prop.OnTap,
    );
    expect(binding).toBeDefined();

    root.invokeCallback(binding?.resourceId ?? 0);
    expect(callback).toHaveBeenCalledOnce();
    root.render(createElement("container", {}));
    expect(() => root.invokeCallback(binding?.resourceId ?? 0)).toThrow(/unknown callback/u);
  });

  it("propagates Core-hit-tested events through capture, target, and bubble phases", () => {
    const sink = new RecordingSink();
    const calls: string[] = [];
    const errors: Error[] = [];
    const root = createRoot(sink, { onPostCommitError: (error) => errors.push(error) });
    root.render(
      createElement("container", {
        onClickCapture: (event: PingoEvent) => {
          calls.push(`outer:${String(event.eventPhase)}:${String(event.currentTarget.nodeId)}`);
          throw new Error("observed callback failure");
        },
        onClick: () => calls.push("outer-bubble"),
        children: createElement("text", {
          value: "target",
          onClickCapture: (event: PingoEvent) =>
            calls.push(`target-capture:${String(event.eventPhase)}`),
          onClick: (event: PingoEvent) => {
            calls.push(`target-bubble:${String(event.eventPhase)}:${String(event.target.nodeId)}`);
            event.preventDefault();
            event.stopPropagation();
            expect(event.defaultPrevented).toBe(true);
          },
        }),
      }),
    );
    const nodes = mutationsOfType(sink.batches[0], "createNode");
    const rootId = nodes[0]?.nodeId ?? 0;
    const outerId = nodes[1]?.nodeId ?? 0;
    const targetId = nodes[2]?.nodeId ?? 0;

    root.applyEventTransaction({
      eventId: 7,
      kind: "click",
      target: targetId,
      x: 12,
      y: 8,
      deltaX: 0,
      deltaY: 0,
      buttons: 0,
      modifiers: 5,
      pointerId: 1,
      elapsedMicros: 16_667,
      path: [rootId, outerId, targetId],
    });

    expect(calls).toEqual([
      `outer:1:${String(outerId)}`,
      "target-capture:2",
      `target-bubble:2:${String(targetId)}`,
    ]);
    expect(errors).toHaveLength(1);
    expect(root.failed).toBe(false);

    root.applyEventTransaction({
      eventId: 8,
      kind: "click",
      target: 0xffff_fffe,
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: 0,
      buttons: 0,
      modifiers: 0,
      pointerId: 0,
      elapsedMicros: 16_667,
      path: [rootId, 0xffff_fffe],
    });
    expect(calls).toHaveLength(3);
  });

  it("materializes only Core-requested virtual-list windows and reuses overlapping items", () => {
    const sink = new RecordingSink();
    const renderItem = vi.fn((index: number) => createElement("text", { value: `item ${index}` }));
    const root = createRoot(sink);
    root.render(
      createElement("virtualList", {
        height: 320,
        itemCount: 1_000_000,
        estimatedItemHeight: 40,
        renderItem,
      }),
    );

    expect(renderItem).not.toHaveBeenCalled();
    expect(mutationsOfType(sink.batches[0], "createNode")).toHaveLength(2);
    const configuration = mutationsOfType(sink.batches[0], "configureVirtualList")[0];
    expect(configuration).toEqual(
      expect.objectContaining({
        itemCount: 1_000_000,
        estimatedItemHeight: 40,
        baseOverscanViewports: 1,
        velocityHorizonSeconds: 0.25,
        maximumAheadViewports: 4,
      }),
    );

    const nodeId = configuration?.nodeId ?? 0;
    root.refillVirtualRanges([{ nodeId, start: 0, end: 3 }]);
    expect(renderItem.mock.calls.map(([index]) => index)).toEqual([0, 1, 2]);
    expect(
      mutationsOfType(sink.batches[1], "setVirtualItem").map(({ itemIndex }) => itemIndex),
    ).toEqual([0, 1, 2]);
    expect(mutationsOfType(sink.batches[1], "createNode")).toHaveLength(6);

    root.refillVirtualRanges([{ nodeId, start: 2, end: 5 }]);
    expect(renderItem.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3, 4]);
    expect(
      mutationsOfType(sink.batches[2], "setVirtualItem").map(({ itemIndex }) => itemIndex),
    ).toEqual([3, 4]);
    expect(mutationsOfType(sink.batches[2], "createNode")).toHaveLength(4);
    expect(mutationsOfType(sink.batches[2], "removeNode")).toHaveLength(2);

    root.refillVirtualRanges([{ nodeId: 0xffff_fffe, start: 0, end: 1 }]);
    expect(sink.batches).toHaveLength(3);
  });

  it("coalesces virtual windows and clamps a request racing a smaller itemCount", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    root.render(
      createElement("virtualList", {
        itemCount: 10,
        estimatedItemHeight: 20,
        renderItem: (index: number) => createElement("text", { value: String(index) }),
      }),
    );
    const nodeId = mutationsOfType(sink.batches[0], "configureVirtualList")[0]?.nodeId ?? 0;
    root.refillVirtualRanges([
      { nodeId, start: 0, end: 2 },
      { nodeId, start: 3, end: 5 },
    ]);
    expect(
      mutationsOfType(sink.batches[1], "setVirtualItem").map(({ itemIndex }) => itemIndex),
    ).toEqual([3, 4]);

    root.refillVirtualRanges([{ nodeId, start: 9, end: 11 }]);
    expect(
      mutationsOfType(sink.batches[2], "setVirtualItem").map(({ itemIndex }) => itemIndex),
    ).toEqual([9]);
    root.refillVirtualRanges([{ nodeId, start: 11, end: 12 }]);
    expect(sink.batches).toHaveLength(3);
    expect(root.failed).toBe(false);
  });

  it("validates virtual-list policy before producing a frame", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    expect(() =>
      root.render(
        createElement("virtualList", {
          itemCount: 4_000_001,
          estimatedItemHeight: 20,
          renderItem: () => null,
        }),
      ),
    ).toThrow(/itemCount/u);
    expect(sink.batches).toHaveLength(0);
  });

  it("fails closed after a sink rejects a frame", () => {
    const error = new Error("transport unavailable");
    const onFatalError = vi.fn();
    const root = createRoot(
      {
        commit: () => {
          throw error;
        },
      },
      { onFatalError },
    );

    expect(() => root.render(createElement("container", {}))).toThrow(error);
    expect(root.failed).toBe(true);
    expect(onFatalError).toHaveBeenCalledWith(error);
    expect(() => root.render(null)).toThrow(/requires remount/u);
  });

  it("disposes component subscriptions after a fatal initial frame", () => {
    const scheduled: Array<() => void> = [];
    const source = signal("first");
    const App = (): PingoNode => createElement("text", { value: source.get() });
    const root = createRoot(
      {
        commit: () => {
          throw new Error("rejected");
        },
      },
      { schedule: (task) => scheduled.push(task) },
    );

    expect(() => root.render(createElement(App, {}))).toThrow("rejected");
    source.set("second");
    expect(scheduled).toHaveLength(0);
  });

  it("runs effect cleanup after a successful removal commit", () => {
    const sink = new RecordingSink();
    const App = (): PingoNode => {
      useEffect(() => {
        sink.events.push("effect");
        return () => sink.events.push("cleanup");
      }, []);
      return createElement("container", {});
    };
    const root = createRoot(sink);
    root.render(createElement(App, {}));
    root.render(null);

    expect(sink.events).toEqual(["commit", "effect", "commit", "cleanup"]);
  });

  it("runs effect cleanup after a rejected removal without masking the sink error", () => {
    const events: string[] = [];
    let reject = false;
    const sink: MutationSink = {
      commit: () => {
        events.push(reject ? "reject" : "commit");
        if (reject) throw new Error("sink failure");
      },
    };
    const App = (): PingoNode => {
      useEffect(() => {
        events.push("effect");
        return () => events.push("cleanup");
      }, []);
      return createElement("container", {});
    };
    const root = createRoot(sink);
    root.render(createElement(App, {}));
    reject = true;

    expect(() => root.render(null)).toThrow("sink failure");
    expect(events).toEqual(["commit", "effect", "reject", "cleanup"]);
  });

  it("unmounts once and releases all live resources", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    root.render(createElement("text", { value: "bye", color: "#abcdef" }));
    root.unmount();
    root.unmount();

    expect(sink.batches).toHaveLength(2);
    expect(mutationsOfType(sink.batches[1], "removeNode")).toHaveLength(2);
    expect(mutationsOfType(sink.batches[1], "releaseResource")).toHaveLength(3);
    expect(() => root.render(null)).toThrow(/unmounted/u);
  });
});

function createdKinds(batch: MutationBatch | undefined): NodeKind[] {
  return mutationsOfType(batch, "createNode").map((mutation) => mutation.kind);
}

function mutationsOfType<Type extends Mutation["type"]>(
  batch: MutationBatch | undefined,
  type: Type,
): Array<Extract<Mutation, { readonly type: Type }>> {
  return (
    batch?.mutations.filter(
      (mutation): mutation is Extract<Mutation, { readonly type: Type }> => mutation.type === type,
    ) ?? []
  );
}
