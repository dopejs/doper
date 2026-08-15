import { createElement, type DoperNode, type NodeHandle } from "@dopejs/doper-jsx";
import { signal, useEffect } from "@dopejs/doper-runtime";
import { describe, expect, it, vi } from "vitest";

import { NodeKind, Prop } from "./generated.js";
import { decodeMutationBatch, type Mutation, type MutationBatch } from "./mutation-stream.js";
import { createRoot, type MutationSink } from "./reconciler.js";

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

  it("preserves keyed host identity while reordering siblings", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const list = (order: readonly string[]): DoperNode =>
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
    const App = (): DoperNode => createElement("text", { value: value.get() });

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
    const App = (): DoperNode => {
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
    const App = (): DoperNode => createElement("text", { value: source.get() });
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
    const App = (): DoperNode => {
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
    const App = (): DoperNode => {
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
