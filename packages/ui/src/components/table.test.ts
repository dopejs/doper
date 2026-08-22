import { describe, expect, it, vi } from "vitest";

import { alignClass, columnStyle, tableDescriptor, type TableColumn } from "./table";

type Node = { readonly props: Record<string, unknown> };

const columns: TableColumn<{ name: string }>[] = [
  { key: "name", header: "名称", cell: (row) => row.name },
  { key: "size", header: "大小", width: 80, align: "end", cell: () => null },
];

function table(rowCount: number, extra: Record<string, unknown> = {}): Node {
  return tableDescriptor({
    columns,
    rowCount,
    getRow: (index) => ({ name: `row-${String(index)}` }),
    ...extra,
  }) as unknown as Node;
}

describe("columnStyle", () => {
  it("gives a fixed column its width and keeps it out of the remainder", () => {
    expect(columnStyle({ key: "a", header: "A", width: 80, cell: () => null })).toEqual({
      width: 80,
      flex: "0 0 auto",
    });
  });

  it("shares the remainder by flex when no width is given", () => {
    expect(columnStyle({ key: "a", header: "A", cell: () => null })).toEqual({ flex: "1 1 0px" });
    expect(columnStyle({ key: "a", header: "A", flex: 3, cell: () => null })).toEqual({
      flex: "3 1 0px",
    });
  });
});

describe("alignClass", () => {
  it("defaults to start", () => {
    expect(alignClass(undefined)).toBe("pui-table__cell--start");
    expect(alignClass("end")).toBe("pui-table__cell--end");
  });
});

describe("tableDescriptor", () => {
  it("gives the header and the rows the same column widths", () => {
    // This is what replaces table layout: one spec consumed twice. If the two
    // could disagree, every row would drift out of line with its heading.
    const node = table(3);
    const [header, body] = node.props["children"] as Node[];
    const headerCells = header?.props["children"] as Node[];
    const row = (body?.props["renderItem"] as (index: number) => Node)(0);
    const rowCells = row.props["children"] as Node[];

    expect(headerCells.map((cell) => cell.props["style"])).toEqual(
      rowCells.map((cell) => cell.props["style"]),
    );
    expect(headerCells[1]?.props["style"]).toMatchObject({ width: 80 });
  });

  it("renders rows through the virtual list rather than up front", () => {
    // A million rows must cost a screenful. Materialising them here would
    // defeat the only reason this component is shaped the way it is.
    const getRow = vi.fn((index: number) => ({ name: String(index) }));
    const node = tableDescriptor({ columns, rowCount: 1_000_000, getRow }) as unknown as Node;
    const body = (node.props["children"] as Node[])[1];
    expect(body?.props["itemCount"]).toBe(1_000_000);
    expect(getRow).not.toHaveBeenCalled();

    (body?.props["renderItem"] as (index: number) => Node)(999_999);
    expect(getRow).toHaveBeenCalledExactlyOnceWith(999_999);
  });

  it("shows the empty label instead of an empty list", () => {
    const [, body] = table(0).props["children"] as Node[];
    expect(body?.props["value"]).toBe("暂无数据");
    expect(body?.props["itemCount"]).toBeUndefined();
  });

  it("makes rows pressable only when the caller wants them to be", () => {
    const inert = (
      (table(1).props["children"] as Node[])[1]?.props["renderItem"] as (index: number) => Node
    )(0);
    expect(inert.props["onTap"]).toBeUndefined();

    const onRowPress = vi.fn();
    const live = (
      (table(1, { onRowPress }).props["children"] as Node[])[1]?.props["renderItem"] as (
        index: number,
      ) => Node
    )(0);
    (live.props["onTap"] as () => void)();
    expect(onRowPress).toHaveBeenCalledWith(0);
  });

  it("carries table semantics", () => {
    const node = table(1);
    expect(node.props["semanticRole"]).toBe("table");
    const header = (node.props["children"] as Node[])[0];
    expect(header?.props["semanticRole"]).toBe("row");
    expect((header?.props["children"] as Node[])[0]?.props["semanticRole"]).toBe("columnheader");
  });
});
