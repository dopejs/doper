import { describe, expect, it, vi } from "vitest";

import { breadcrumbDescriptor } from "./breadcrumb";

type Node = { readonly props: Record<string, unknown> };

function children(props: Parameters<typeof breadcrumbDescriptor>[0]): Node[] {
  return (breadcrumbDescriptor(props) as unknown as Node).props["children"] as Node[];
}

describe("breadcrumbDescriptor", () => {
  it("interleaves separators and omits the trailing one", () => {
    const nodes = children({ items: [{ label: "A" }, { label: "B" }, { label: "C" }] });
    expect(nodes.map((entry) => entry.props["value"])).toEqual(["A", "/", "B", "/", "C"]);
  });

  it("makes the last entry the current page rather than a link", () => {
    const nodes = children({
      items: [
        { label: "A", onNavigate: vi.fn() },
        { label: "B", onNavigate: vi.fn() },
      ],
    });
    const [first, , last] = nodes;
    expect(first?.props["semanticRole"]).toBe("link");
    expect(last?.props["semanticRole"]).toBe("text");
    expect(last?.props["semanticValue"]).toBe("current");
    // Navigating to where you already are is what marking it current prevents.
    expect(last?.props["onTap"]).toBeUndefined();
  });

  it("leaves an entry inert when the caller gave it nowhere to go", () => {
    const [first] = children({ items: [{ label: "A" }, { label: "B" }] });
    expect(first?.props["onTap"]).toBeUndefined();
  });

  it("navigates on press and on Enter", () => {
    const onNavigate = vi.fn();
    const [first] = children({ items: [{ label: "A", onNavigate }, { label: "B" }] });
    (first?.props["onTap"] as () => void)();
    const preventDefault = vi.fn();
    (first?.props["onKeyDown"] as (event: unknown) => void)({ key: "Enter", preventDefault });
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("uses a caller-supplied separator", () => {
    const nodes = children({ items: [{ label: "A" }, { label: "B" }], separator: "›" });
    expect(nodes[1]?.props["value"]).toBe("›");
  });
});
