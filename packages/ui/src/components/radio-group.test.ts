import { createElement } from "@dopejs/pingo-jsx";
import {
  createRoot,
  decodeMutationBatch,
  type MutationBatch,
  type MutationSink,
} from "@dopejs/pingo-reconciler";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setTheme } from "../theme";
import {
  RadioGroup,
  RadioGroupItem,
  radioGroupItemDescriptor,
  type RadioGroupContextValue,
  type RadioGroupItemProps,
} from "./radio-group";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };

function descriptor(props: RadioGroupItemProps, context: RadioGroupContextValue | undefined): Host {
  return radioGroupItemDescriptor(props, context) as unknown as Host;
}

function context(value: string | undefined, disabled = false): RadioGroupContextValue {
  return { value, disabled, onSelect: () => {} };
}

class RecordingSink implements MutationSink {
  public readonly batches: MutationBatch[] = [];

  public commit(bytes: Uint8Array): void {
    this.batches.push(decodeMutationBatch(bytes));
  }
}

describe("radioGroupItemDescriptor", () => {
  it("renders unchecked with an empty circle", () => {
    const node = descriptor({ value: "a" }, context("b"));
    expect(node.props.className).toBe("pui-radio");
    expect(node.props.semanticRole).toBe("radio");
    expect(node.props.semanticValue).toBe("unchecked");
    const [circle] = node.props.children as [Host];
    expect(circle.props.className).toBe("pui-radio__circle");
    expect(circle.props.children ?? null).toBeNull();
  });

  it("renders the indicator when the group value matches", () => {
    const node = descriptor({ value: "a" }, context("a"));
    expect(node.props.semanticValue).toBe("checked");
    const [circle] = node.props.children as [Host];
    expect((circle.props.children as Host).props.className).toBe("pui-radio__indicator");
  });

  it("forwards the item value to the group onSelect", () => {
    const onSelect = vi.fn();
    const node = descriptor({ value: "b" }, { value: "a", disabled: false, onSelect });
    (node.props.onTap as () => void)();
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("omits handlers and reports disabled when the group is disabled", () => {
    const node = descriptor({ value: "a" }, context("a", true));
    expect(node.props.className).toBe("pui-radio pui-radio--disabled");
    expect(node.props.semanticValue).toBe("disabled");
    expect(node.props.onTap).toBeUndefined();
    expect(node.props.onPointerDown).toBeUndefined();
  });

  it("renders the optional label text", () => {
    const node = descriptor({ value: "a", label: "甲" }, context("a"));
    const [, label] = node.props.children as [Host, Host];
    expect(label.props.className).toBe("pui-label pui-radio__label");
    expect(label.props.value).toBe("甲");
  });

  it("appends dark markers and keeps the user className last", () => {
    setTheme("dark");
    const node = descriptor({ value: "a", label: "L", className: "mine" }, context("a"));
    expect(node.props.className).toBe("pui-radio pui-dark mine");
    const [circle, label] = node.props.children as [Host, Host];
    expect(circle.props.className).toBe("pui-radio__circle pui-dark");
    expect((circle.props.children as Host).props.className).toBe("pui-radio__indicator pui-dark");
    expect(label.props.className).toBe("pui-label pui-radio__label pui-dark");
  });
});

describe("RadioGroup", () => {
  it("renders uncontrolled and controlled through createElement without throwing", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    expect(() => {
      root.render(
        createElement(RadioGroup, {
          defaultValue: "a",
          children: [
            createElement(RadioGroupItem, { value: "a", label: "A" }),
            createElement(RadioGroupItem, { value: "b", label: "B" }),
          ],
        }),
      );
      // Controlled re-render flips the selected value from the parent.
      root.render(
        createElement(RadioGroup, {
          value: "b",
          children: [
            createElement(RadioGroupItem, { value: "a", label: "A" }),
            createElement(RadioGroupItem, { value: "b", label: "B" }),
          ],
        }),
      );
      root.flushSync();
    }).not.toThrow();
    expect(sink.batches.length).toBeGreaterThanOrEqual(2);
  });
});
