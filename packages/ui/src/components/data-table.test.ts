import { describe, expect, it, vi } from "vitest";

import { dataTableDescriptor, nextSort, type DataTableColumn } from "./data-table";

type Node = { readonly props: Record<string, unknown> };

const columns: DataTableColumn<{ name: string }>[] = [
  { key: "name", header: "名称", sortable: true, cell: (row) => row.name },
  { key: "size", header: "大小", cell: () => null },
];

function headerCells(extra: Record<string, unknown> = {}): Node[] {
  const node = dataTableDescriptor({
    columns,
    rowCount: 1,
    getRow: () => ({ name: "a" }),
    ...extra,
  }) as unknown as Node;
  const header = (node.props["children"] as Node[])[0];
  return header?.props["children"] as Node[];
}

describe("nextSort", () => {
  it("cycles ascending, descending, then off", () => {
    // The third state matters: without it a user who sorted by accident cannot
    // get back to the order the data arrived in, which for a server-ordered
    // table is the only meaningful one.
    expect(nextSort(undefined, "a")).toEqual({ key: "a", direction: "ascending" });
    expect(nextSort({ key: "a", direction: "ascending" }, "a")).toEqual({
      key: "a",
      direction: "descending",
    });
    expect(nextSort({ key: "a", direction: "descending" }, "a")).toBeUndefined();
  });

  it("starts fresh when a different column is chosen", () => {
    expect(nextSort({ key: "a", direction: "descending" }, "b")).toEqual({
      key: "b",
      direction: "ascending",
    });
  });
});

describe("dataTableDescriptor", () => {
  it("makes only sortable headers pressable", () => {
    const cells = headerCells({ onSortChange: vi.fn() });
    expect(cells[0]?.props["onTap"]).toBeDefined();
    expect(cells[1]?.props["onTap"]).toBeUndefined();
    expect(cells[1]?.props["className"]).not.toContain("pui-table__head--sortable");
  });

  it("leaves headers inert when the caller cannot receive a sort", () => {
    // Offering a control that reports nowhere is worse than not offering it.
    const cells = headerCells();
    expect(cells[0]?.props["onTap"]).toBeUndefined();
  });

  it("marks direction on the active column only", () => {
    const cells = headerCells({
      onSortChange: vi.fn(),
      sort: { key: "name", direction: "descending" },
    });
    expect(cells[0]?.props["semanticValue"]).toBe("descending");
    expect(cells[0]?.props["value"]).toBe("名称 ▼");
    expect(cells[1]?.props["semanticValue"]).toBeUndefined();
  });

  it("reports the sort rather than reordering the rows", () => {
    // Reordering would mean materialising every row, which is the one thing
    // virtualisation exists to avoid.
    const onSortChange = vi.fn();
    const getRow = vi.fn(() => ({ name: "a" }));
    const cells = headerCells({ onSortChange, getRow });
    (cells[0]?.props["onTap"] as () => void)();
    expect(onSortChange).toHaveBeenCalledWith({ key: "name", direction: "ascending" });
    expect(getRow).not.toHaveBeenCalled();
  });

  it("keeps the shared column widths from Table", () => {
    const cells = headerCells({ onSortChange: vi.fn() });
    expect(cells[0]?.props["style"]).toEqual({ flex: "1 1 0px" });
  });
});
