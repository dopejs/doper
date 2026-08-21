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
  tabsListDescriptor,
  tabsTriggerDescriptor,
  type TabsContentProps,
  type TabsContextValue,
} from "./tabs";

afterEach(() => setTheme("light"));

type Host = { props: Record<string, unknown> };

function context(
  value: string | undefined,
  overrides: Partial<TabsContextValue> = {},
): TabsContextValue {
  return {
    value,
    onSelect: () => {},
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
      context("a", { onSelect }),
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
  it("renders the list row", () => {
    const node = tabsListDescriptor(
      { children: "x", className: "mine" },
      context("a"),
    ) as unknown as Host;
    expect(node.props.className).toBe("pui-tabs__list mine");
    expect(node.props.direction).toBe("row");
    expect(node.props.semanticRole).toBe("tablist");
  });

  it("moves selection and focus with the horizontal arrows, Home and End", () => {
    const onSelect = vi.fn();
    const focusTrigger = vi.fn();
    const children = [
      createElement(TabsTrigger, { value: "a", children: "甲" }),
      createElement(TabsTrigger, { value: "b", children: "乙" }),
      createElement(TabsTrigger, { value: "c", children: "丙" }),
    ];
    const press = (current: string, key: string): void => {
      const node = tabsListDescriptor(
        { children },
        context(current, { onSelect, focusTrigger }),
      ) as unknown as Host;
      (node.props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
        key,
        preventDefault: () => {},
      });
    };

    press("a", "ArrowRight");
    expect(onSelect).toHaveBeenLastCalledWith("b");
    // Selection without focus would send the next arrow back to the old tab.
    expect(focusTrigger).toHaveBeenLastCalledWith("b");

    press("a", "ArrowLeft");
    expect(onSelect).toHaveBeenLastCalledWith("c");
    press("b", "Home");
    expect(onSelect).toHaveBeenLastCalledWith("a");
    press("b", "End");
    expect(onSelect).toHaveBeenLastCalledWith("c");
  });

  it("leaves keys it does not navigate with alone", () => {
    const onSelect = vi.fn();
    const node = tabsListDescriptor(
      { children: [createElement(TabsTrigger, { value: "a", children: "甲" })] },
      context("a", { onSelect }),
    ) as unknown as Host;
    const prevented = vi.fn();
    for (const key of ["ArrowUp", "ArrowDown", "a", "Escape"]) {
      (node.props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
        key,
        preventDefault: prevented,
      });
    }
    expect(onSelect).not.toHaveBeenCalled();
    expect(prevented).not.toHaveBeenCalled();
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
