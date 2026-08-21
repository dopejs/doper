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
  radioGroupDescriptor,
  radioGroupItemDescriptor,
  type RadioGroupContextValue,
  type RadioGroupItemProps,
} from "./radio-group";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };

function descriptor(props: RadioGroupItemProps, context: RadioGroupContextValue | undefined): Host {
  return radioGroupItemDescriptor(props, context) as unknown as Host;
}

function context(
  value: string | undefined,
  disabled = false,
  overrides: Partial<RadioGroupContextValue> = {},
): RadioGroupContextValue {
  return {
    value,
    disabled,
    onSelect: () => {},
    registerItem: () => {},
    focusItem: () => {},
    ...overrides,
  };
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
    const node = descriptor({ value: "b" }, context("a", false, { onSelect }));
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

describe("radioGroupDescriptor", () => {
  it("moves selection and focus with either arrow pair", () => {
    const onSelect = vi.fn();
    const focusItem = vi.fn();
    const children = [
      createElement(RadioGroupItem, { value: "a" }),
      createElement(RadioGroupItem, { value: "b" }),
      createElement(RadioGroupItem, { value: "c" }),
    ];
    const press = (current: string, key: string): void => {
      const node = radioGroupDescriptor(
        { children },
        context(current, false, { onSelect, focusItem }),
        "pui-radiogroup",
      ) as unknown as Host;
      (node.props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
        key,
        preventDefault: () => {},
      });
    };

    for (const [current, key, expected] of [
      ["a", "ArrowRight", "b"],
      ["a", "ArrowDown", "b"],
      ["a", "ArrowLeft", "c"],
      ["a", "ArrowUp", "c"],
    ] as const) {
      press(current, key);
      expect(onSelect).toHaveBeenLastCalledWith(expected);
      // Selection without focus would send the next arrow to the old item.
      expect(focusItem).toHaveBeenLastCalledWith(expected);
    }
  });

  it("does not navigate while the group is disabled", () => {
    const node = radioGroupDescriptor(
      { children: [createElement(RadioGroupItem, { value: "a" })] },
      context("a", true),
      "pui-radiogroup",
    ) as unknown as Host;
    expect(node.props.onKeyDown).toBeUndefined();
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
