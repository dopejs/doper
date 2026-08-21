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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  tabsContentDescriptor,
  tabsTriggerDescriptor,
  type TabsContentProps,
  type TabsContextValue,
} from "./tabs";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };

function context(value: string | undefined): TabsContextValue {
  return { value, onSelect: () => {} };
}

class RecordingSink implements MutationSink {
  public readonly batches: MutationBatch[] = [];

  public commit(bytes: Uint8Array): void {
    this.batches.push(decodeMutationBatch(bytes));
  }
}

describe("tabsTriggerDescriptor", () => {
  it("renders an inactive tab trigger", () => {
    const node = tabsTriggerDescriptor(
      { value: "a", children: "甲" },
      context("b"),
    ) as unknown as Host;
    expect(node.props.className).toBe("pui-tabs__trigger");
    expect(node.props.semanticRole).toBe("tab");
    expect(node.props.semanticValue).toBe("inactive");
    expect((node.props.children as Host).props.value).toBe("甲");
  });

  it("renders the active variant when the tab is selected", () => {
    const node = tabsTriggerDescriptor(
      { value: "a", children: "甲" },
      context("a"),
    ) as unknown as Host;
    expect(node.props.className).toBe("pui-tabs__trigger pui-tabs__trigger--active");
    expect(node.props.semanticValue).toBe("active");
  });

  it("forwards the trigger value to onSelect", () => {
    const onSelect = vi.fn();
    const node = tabsTriggerDescriptor(
      { value: "b", children: "乙" },
      {
        value: "a",
        onSelect,
      },
    ) as unknown as Host;
    (node.props.onTap as () => void)();
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("appends the dark marker and keeps the user className last", () => {
    setTheme("dark");
    const node = tabsTriggerDescriptor(
      { value: "a", children: "甲", className: "mine" },
      context("a"),
    ) as unknown as Host;
    expect(node.props.className).toBe("pui-tabs__trigger pui-tabs__trigger--active pui-dark mine");
  });
});

describe("tabsContentDescriptor", () => {
  const props: TabsContentProps = { value: "a", children: "panel" };

  it("shows the panel with display flex when active", () => {
    const node = tabsContentDescriptor(props, context("a")) as unknown as Host;
    expect(node.props.className).toBe("pui-tabs__content");
    expect(node.props.style).toEqual({ display: "flex" });
  });

  it("hides the panel with display none when inactive", () => {
    const node = tabsContentDescriptor(props, context("b")) as unknown as Host;
    expect(node.props.style).toEqual({ display: "none" });
  });

  it("appends the dark marker and keeps the user className last", () => {
    setTheme("dark");
    const node = tabsContentDescriptor(
      { ...props, className: "mine" },
      context("a"),
    ) as unknown as Host;
    expect(node.props.className).toBe("pui-tabs__content pui-dark mine");
  });
});

describe("TabsList", () => {
  it("renders the list row without needing context", () => {
    const node = TabsList.component({ children: "x", className: "mine" }) as unknown as Host;
    expect(node.props.className).toBe("pui-tabs__list mine");
    expect(node.props.direction).toBe("row");
  });
});

describe("Tabs", () => {
  it("renders uncontrolled and controlled through createElement without throwing", () => {
    const sink = new RecordingSink();
    const root = createRoot(sink);
    const tree = (value: { value?: string; defaultValue?: string }) =>
      createElement(Tabs, {
        ...value,
        children: [
          createElement(TabsList, {
            children: [
              createElement(TabsTrigger, { value: "a", children: "A" }),
              createElement(TabsTrigger, { value: "b", children: "B" }),
            ],
          }),
          createElement(TabsContent, { value: "a", children: "panel A" }),
          createElement(TabsContent, { value: "b", children: "panel B" }),
        ],
      });
    expect(() => {
      root.render(tree({ defaultValue: "a" }));
      root.render(tree({ value: "b" }));
      root.flushSync();
    }).not.toThrow();
    expect(sink.batches.length).toBeGreaterThanOrEqual(2);
  });
});
