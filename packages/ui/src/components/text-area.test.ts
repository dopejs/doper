import { TextEditingController, type EditTransaction } from "@dopejs/pingo-editing";
import { createElement } from "@dopejs/pingo-jsx";
import {
  createRoot,
  decodeMutationBatch,
  type MutationBatch,
  type MutationSink,
} from "@dopejs/pingo-reconciler";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setTheme } from "../theme";
import { TextArea, textAreaDescriptor } from "./text-area";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };
type Tree = Host & { props: { children: { props: Record<string, unknown> } } };

function descriptor(props: Parameters<typeof textAreaDescriptor>[0]): Tree {
  return textAreaDescriptor(props, new TextEditingController({ value: "" })) as unknown as Tree;
}

class RecordingSink implements MutationSink {
  public readonly batches: MutationBatch[] = [];
  public readonly events: string[] = [];

  public commit(bytes: Uint8Array): void {
    this.events.push("commit");
    this.batches.push(decodeMutationBatch(bytes));
  }
}

describe("TextArea", () => {
  it("renders the shell with skin classes and a multiline field child", () => {
    const node = descriptor({ semanticLabel: "备注" });
    expect(node.props.className).toBe("pui-input pui-textarea");
    expect(node.props.children.props.className).toBe("pui-input__field");
    expect(node.props.children.props.multiline).toBe(true);
  });

  it("marks disabled as readOnly with the disabled class", () => {
    const node = descriptor({ disabled: true });
    expect(node.props.className).toBe("pui-input pui-textarea pui-input--disabled");
    expect(node.props.children.props.readOnly).toBe(true);
  });

  it("appends the dark marker and user className", () => {
    setTheme("dark");
    const node = descriptor({ className: "mine" });
    expect(node.props.className).toBe("pui-input pui-textarea pui-dark mine");
  });

  it("derives the shell min-height from rows", () => {
    const node = descriptor({ rows: 4 });
    expect(node.props.style).toEqual({ minHeight: 92 });
  });

  it("reports the controller-applied value to onValueChange", () => {
    const controller = new TextEditingController({ value: "a" });
    const onValueChange = vi.fn();
    const node = textAreaDescriptor({ onValueChange }, controller) as unknown as Tree;
    const transaction: EditTransaction = {
      baseRevision: 0n,
      delta: { range: { start: 1, end: 1 }, text: "b" },
      kind: "edit",
      nodeId: 1,
      revision: 1n,
      selection: {
        anchor: 2,
        anchorAffinity: "downstream",
        focus: 2,
        focusAffinity: "downstream",
      },
    };
    // The reconciler applies the transaction to the controller before
    // invoking onTransaction; mirror that ordering here.
    controller.applyTransaction(transaction);
    const onTransaction = node.props.children.props.onTransaction as (t: EditTransaction) => void;
    onTransaction(transaction);
    expect(onValueChange).toHaveBeenCalledWith("ab");
  });

  it("renders through createElement without throwing across re-renders", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    expect(() => {
      root.render(createElement(TextArea, { semanticLabel: "x" }));
      // semanticLabel changes so the re-render emits an observable commit.
      root.render(createElement(TextArea, { semanticLabel: "y", className: "mine" }));
      // Component re-renders flush via the scheduler; force the pending one.
      root.flushSync();
    }).not.toThrow();
    expect(sink.batches.length).toBeGreaterThanOrEqual(2);
  });
});
