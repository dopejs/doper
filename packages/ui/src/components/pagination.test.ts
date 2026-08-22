import { describe, expect, it, vi } from "vitest";

import { paginationDescriptor, paginationRange } from "./pagination";

type Node = { readonly props: Record<string, unknown> };

function entries(props: Parameters<typeof paginationDescriptor>[0]): Node[] {
  return ((paginationDescriptor(props) as unknown as Node).props["children"] as Node[]) ?? [];
}

describe("paginationRange", () => {
  it("keeps both edges, the current page and its siblings", () => {
    expect(paginationRange(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
  });

  it("fills a one-page gap instead of eliding it", () => {
    // An ellipsis standing in for a single page is wider than the page it
    // replaces, so 1 … 3 4 5 would be both uglier and less useful than 1 2 3 4 5.
    expect(paginationRange(3, 6)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("never elides at the ends", () => {
    expect(paginationRange(1, 10)).toEqual([1, 2, null, 10]);
    expect(paginationRange(10, 10)).toEqual([1, null, 9, 10]);
  });

  it("survives a page outside the range and a nonsensical count", () => {
    expect(paginationRange(99, 3)).toEqual([1, 2, 3]);
    expect(paginationRange(1, 0)).toEqual([]);
    expect(paginationRange(1, -1)).toEqual([]);
  });

  it("collapses to a single entry for one page", () => {
    expect(paginationRange(1, 1)).toEqual([1]);
  });
});

describe("paginationDescriptor", () => {
  it("disables the control that would leave the range", () => {
    const first = entries({ page: 1, pageCount: 5 });
    expect(first[0]?.props["className"]).toContain("pui-pagination__control--disabled");
    expect(first[0]?.props["onTap"]).toBeUndefined();

    const last = entries({ page: 5, pageCount: 5 });
    expect(last[last.length - 1]?.props["className"]).toContain(
      "pui-pagination__control--disabled",
    );
  });

  it("refuses a move that lands outside the range or on the current page", () => {
    const onPageChange = vi.fn();
    const nodes = entries({ page: 3, pageCount: 5, onPageChange });
    const current = nodes.find((node) => node.props["value"] === "3");
    (current?.props["onTap"] as () => void)();
    expect(onPageChange).not.toHaveBeenCalled();

    const other = nodes.find((node) => node.props["value"] === "4");
    (other?.props["onTap"] as () => void)();
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it("moves with the arrow keys and claims no other key", () => {
    const onPageChange = vi.fn();
    const root = paginationDescriptor({ page: 3, pageCount: 5, onPageChange }) as unknown as Node;
    const keyDown = root.props["onKeyDown"] as (event: unknown) => void;

    const preventDefault = vi.fn();
    keyDown({ key: "ArrowRight", preventDefault });
    expect(onPageChange).toHaveBeenCalledWith(4);
    keyDown({ key: "ArrowLeft", preventDefault });
    expect(onPageChange).toHaveBeenLastCalledWith(2);

    const ignored = vi.fn();
    keyDown({ key: "Enter", preventDefault: ignored });
    expect(ignored).not.toHaveBeenCalled();
    expect(onPageChange).toHaveBeenCalledTimes(2);
  });

  it("marks the current page for assistive technology", () => {
    const nodes = entries({ page: 2, pageCount: 3 });
    const current = nodes.find((node) => node.props["value"] === "2");
    expect(current?.props["semanticValue"]).toBe("current");
    expect(
      nodes.find((node) => node.props["value"] === "1")?.props["semanticValue"],
    ).toBeUndefined();
  });
});
