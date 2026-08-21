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
import { Input, inputDescriptor } from "./input";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };
type Tree = Host & { props: { children: readonly Host[] } };

function descriptor(props: Parameters<typeof inputDescriptor>[0]): Tree {
  return inputDescriptor(props, new TextEditingController({ value: "" })) as unknown as Tree;
}

/** The editable field, wherever the adornments put it. */
function field(node: Tree): Record<string, unknown> {
  const found = node.props.children.find((child) =>
    String(child.props.className ?? "").includes("pui-input__field"),
  );
  if (found === undefined) throw new Error("input has no editable field");
  return found.props;
}

class RecordingSink implements MutationSink {
  public readonly batches: MutationBatch[] = [];
  public readonly events: string[] = [];

  public commit(bytes: Uint8Array): void {
    this.events.push("commit");
    this.batches.push(decodeMutationBatch(bytes));
  }
}

describe("Input", () => {
  it("renders the shell with skin classes and an editable field child", () => {
    const node = descriptor({ semanticLabel: "邮箱" });
    expect(node.props.className).toBe("pui-input");
    expect(node.props.children).toHaveLength(1);
    expect(field(node).className).toBe("pui-input__field");
  });

  it("marks disabled as readOnly with the disabled class", () => {
    const node = descriptor({ disabled: true });
    expect(node.props.className).toBe("pui-input pui-input--disabled");
    expect(field(node).readOnly).toBe(true);
  });

  it("renders prefix and suffix adornments around the field", () => {
    const node = descriptor({ prefix: "$", suffix: "USD" });
    expect(node.props.children.map((child) => child.props.className)).toEqual([
      "pui-input__prefix",
      "pui-input__field",
      "pui-input__suffix",
    ]);
    expect(node.props.children[0]?.props.children).toBe("$");
    expect(node.props.children[2]?.props.children).toBe("USD");
  });

  it("marks adornments dark so they theme without a descendant selector", () => {
    setTheme("dark");
    const node = descriptor({ prefix: "$" });
    expect(node.props.children[0]?.props.className).toBe("pui-input__prefix pui-dark");
  });

  it("appends the dark marker and user className", () => {
    setTheme("dark");
    const node = descriptor({ className: "mine" });
    expect(node.props.className).toBe("pui-input pui-dark mine");
  });

  it("forwards onValueChange through the controller transaction path", () => {
    const node = descriptor({ onValueChange: () => {} });
    expect(typeof field(node).onTransaction).toBe("function");
    expect(field(node).controller).toBeDefined();
  });

  it("reports the controller-applied value to onValueChange", () => {
    const controller = new TextEditingController({ value: "a" });
    const onValueChange = vi.fn();
    const node = inputDescriptor({ onValueChange }, controller) as unknown as Tree;
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
    const onTransaction = field(node).onTransaction as (t: EditTransaction) => void;
    onTransaction(transaction);
    expect(onValueChange).toHaveBeenCalledWith("ab");
  });

  it("renders through createElement without throwing across re-renders", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    expect(() => {
      root.render(createElement(Input, { semanticLabel: "x" }));
      // semanticLabel changes so the re-render emits an observable commit.
      root.render(createElement(Input, { semanticLabel: "y", className: "mine" }));
      // Component re-renders flush via the scheduler; force the pending one.
      root.flushSync();
    }).not.toThrow();
    expect(sink.batches.length).toBeGreaterThanOrEqual(2);
  });
});
