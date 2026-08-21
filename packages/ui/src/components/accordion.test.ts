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
  Accordion,
  AccordionItem,
  accordionItemDescriptor,
  type AccordionContextValue,
  type AccordionItemProps,
} from "./accordion";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };

function descriptor(props: AccordionItemProps, context: AccordionContextValue | undefined): Host {
  return accordionItemDescriptor(props, context) as unknown as Host;
}

function context(openValue: string | undefined): AccordionContextValue {
  return { openValue, onToggle: () => {} };
}

class RecordingSink implements MutationSink {
  public readonly batches: MutationBatch[] = [];

  public commit(bytes: Uint8Array): void {
    this.batches.push(decodeMutationBatch(bytes));
  }
}

describe("accordionItemDescriptor", () => {
  it("renders a closed item with a hidden content panel", () => {
    const node = descriptor({ value: "a", title: "标题", children: "body" }, context(undefined));
    expect(node.props.className).toBe("pui-accordion__item");
    const [trigger, content] = node.props.children as [Host, Host];
    expect(trigger.props.className).toBe("pui-accordion__trigger");
    expect(trigger.props.semanticRole).toBe("button");
    expect(trigger.props.semanticValue).toBe("closed");
    const [title, chevron] = trigger.props.children as [Host, Host];
    expect(title.props.value).toBe("标题");
    expect(chevron.props.value).toBe("▾");
    expect(chevron.props.style).toBeUndefined();
    expect(content.props.className).toBe("pui-accordion__content");
    expect(content.props.style).toEqual({ display: "none" });
  });

  it("renders an open item with a rotated chevron and visible panel", () => {
    const node = descriptor({ value: "a", title: "标题", children: "body" }, context("a"));
    const [trigger, content] = node.props.children as [Host, Host];
    expect(trigger.props.semanticValue).toBe("open");
    const [, chevron] = trigger.props.children as [Host, Host];
    expect(chevron.props.style).toEqual({ transform: "rotate(180deg)" });
    expect(content.props.style).toEqual({ display: "flex" });
  });

  it("forwards the item value to onToggle", () => {
    const onToggle = vi.fn();
    const node = descriptor(
      { value: "b", title: "t", children: "body" },
      {
        openValue: "a",
        onToggle,
      },
    );
    const [trigger] = node.props.children as [Host, Host];
    (trigger.props.onTap as () => void)();
    expect(onToggle).toHaveBeenCalledWith("b");
  });

  it("appends dark markers and keeps the user className last", () => {
    setTheme("dark");
    const node = descriptor(
      { value: "a", title: "t", children: "body", className: "mine" },
      context("a"),
    );
    expect(node.props.className).toBe("pui-accordion__item pui-dark mine");
    const [trigger, content] = node.props.children as [Host, Host];
    expect(trigger.props.className).toBe("pui-accordion__trigger pui-dark");
    expect(content.props.className).toBe("pui-accordion__content pui-dark");
  });
});

describe("Accordion", () => {
  it("renders uncontrolled and controlled through createElement without throwing", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const tree = (value: { openValue?: string; defaultOpenValue?: string }) =>
      createElement(Accordion, {
        ...value,
        children: [
          createElement(AccordionItem, { value: "a", title: "A", children: "body A" }),
          createElement(AccordionItem, { value: "b", title: "B", children: "body B" }),
        ],
      });
    expect(() => {
      root.render(tree({ defaultOpenValue: "a" }));
      root.render(tree({ openValue: "b" }));
      root.flushSync();
    }).not.toThrow();
    expect(sink.batches.length).toBeGreaterThanOrEqual(2);
  });
});
