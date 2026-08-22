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
  accordionDescriptor,
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

function context(
  openValue: string | undefined,
  overrides: Partial<AccordionContextValue> = {},
): AccordionContextValue {
  return {
    openValue,
    onToggle: () => {},
    registerTrigger: () => {},
    focusTrigger: () => {},
    ...overrides,
  };
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
    // A drawn chevron, not a font glyph: the indicator is now geometry.
    expect((chevron.props.children as { props: Record<string, unknown> }[])[0]?.props.d).toContain(
      "6 6",
    );
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
      context("a", { onToggle }),
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

describe("accordionDescriptor", () => {
  function cursor(initial?: string): { peek: () => string | undefined; set: (v?: string) => void } {
    let value = initial;
    return {
      peek: () => value,
      set: (next) => {
        value = next;
      },
    };
  }

  it("moves focus between headers without opening anything", () => {
    const onToggle = vi.fn();
    const focusTrigger = vi.fn();
    const focused = cursor();
    const children = [
      createElement(AccordionItem, { value: "a", title: "甲", children: "x" }),
      createElement(AccordionItem, { value: "b", title: "乙", children: "y" }),
    ];
    const press = (key: string): void => {
      const node = accordionDescriptor(
        { children },
        context("a", { onToggle, focusTrigger }),
        "pui-accordion",
        focused,
      ) as unknown as Host;
      (node.props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
        key,
        preventDefault: () => {},
      });
    };

    press("ArrowDown");
    expect(focusTrigger).toHaveBeenLastCalledWith("b");
    press("ArrowDown");
    expect(focusTrigger).toHaveBeenLastCalledWith("a");
    // Moving the cursor must never open a panel.
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("toggles a header on Enter and Space and ignores other keys", () => {
    const onToggle = vi.fn();
    const node = descriptor(
      { value: "b", title: "t", children: "body" },
      context("a", { onToggle }),
    );
    const trigger = (node.props.children as Host[])[0] as Host;
    const press = (key: string): void => {
      (trigger.props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
        key,
        preventDefault: () => {},
      });
    };

    press("Enter");
    press(" ");
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenCalledWith("b");

    onToggle.mockClear();
    for (const key of ["ArrowDown", "Escape", "a"]) press(key);
    expect(onToggle).not.toHaveBeenCalled();
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
