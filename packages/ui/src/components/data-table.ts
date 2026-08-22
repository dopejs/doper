import { Text, type PingoEvent, type PingoNode } from "@dopejs/pingo-jsx";

import { classes } from "../overlay";
import { useTheme } from "../theme";

import {
  alignClass,
  columnStyle,
  tableDescriptor,
  type TableColumn,
  type TableProps,
} from "./table";

export type SortDirection = "ascending" | "descending";

export type SortState = {
  readonly key: string;
  readonly direction: SortDirection;
};

export type DataTableColumn<Row> = TableColumn<Row> & {
  readonly sortable?: boolean;
};

export type DataTableProps<Row> = Omit<TableProps<Row>, "columns"> & {
  readonly columns: readonly DataTableColumn<Row>[];
  readonly sort?: SortState;
  readonly onSortChange?: (sort: SortState | undefined) => void;
};

/**
 * The sort a click on `key` produces, given the current one.
 *
 * Cycles ascending, descending, none. The third state matters: without it a
 * user who sorted by accident has no way back to the order the data arrived
 * in, which for a server-ordered table is the only meaningful one.
 */
export function nextSort(current: SortState | undefined, key: string): SortState | undefined {
  if (current === undefined || current.key !== key) return { key, direction: "ascending" };
  if (current.direction === "ascending") return { key, direction: "descending" };
  return undefined;
}

/** Pure builder: safe to call without a component scope (tests use this). */
export function dataTableDescriptor<Row>(props: DataTableProps<Row>): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const sort = props.sort;
  const onSortChange = props.onSortChange;
  return tableDescriptor({
    ...props,
    columns: props.columns,
    renderHeaderCell: (column, index) => {
      const source = props.columns[index];
      const sortable = source?.sortable === true && onSortChange !== undefined;
      const active = sortable && sort?.key === column.key;
      // The indicator rides in the header text because there is no icon set and
      // no pseudo-element; it moves to a real glyph once one exists.
      const indicator = !active ? "" : sort?.direction === "ascending" ? " ▲" : " ▼";
      return Text({
        key: column.key,
        className: classes(
          "pui-table__head",
          alignClass(column.align),
          sortable ? "pui-table__head--sortable" : undefined,
          dark,
        ),
        style: columnStyle(column),
        value: `${column.header}${indicator}`,
        semanticRole: "columnheader",
        ...(sortable
          ? {
              semanticValue: active ? (sort?.direction ?? "none") : "none",
              onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
              onTap: () => onSortChange(nextSort(sort, column.key)),
              onClick: () => onSortChange(nextSort(sort, column.key)),
            }
          : {}),
      });
    },
  });
}

/**
 * Virtualised table with sortable headers.
 *
 * Sorting is reported, not performed. The rows come from `getRow`, which for a
 * virtualised table usually means a server or a store; reordering them here
 * would require materialising every row, which is the one thing virtualisation
 * exists to avoid.
 */
export const DataTable = dataTableDescriptor;
