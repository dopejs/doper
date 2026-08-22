import { Text, View, VirtualList, type PingoEvent, type PingoNode } from "@dopejs/pingo-jsx";

import { classes } from "../overlay";
import { useTheme } from "../theme";

export type TableAlign = "start" | "center" | "end";

export type TableColumn<Row> = {
  readonly key: string;
  readonly header: string;
  /** Fixed width in logical pixels; omit to share the remainder. */
  readonly width?: number;
  /** Share of the remainder when `width` is absent. Defaults to 1. */
  readonly flex?: number;
  readonly align?: TableAlign;
  readonly cell: (row: Row, index: number) => PingoNode;
};

export type TableProps<Row> = {
  readonly columns: readonly TableColumn<Row>[];
  readonly rowCount: number;
  readonly getRow: (index: number) => Row;
  readonly estimatedRowHeight?: number;
  readonly onRowPress?: (index: number) => void;
  readonly emptyLabel?: string;
  /**
   * Replaces the default header cell for a column.
   *
   * A hook rather than post-processing the built tree: DataTable needs
   * pressable headers, and reaching into a node's children to swap them is
   * fragile in exactly the way a structural change would expose.
   */
  readonly renderHeaderCell?: (column: TableColumn<Row>, index: number) => PingoNode;
  readonly className?: string;
};

/**
 * Layout for one column, shared by the header and every row.
 *
 * A virtualised table cannot size columns from content: rows that were never
 * rendered cannot participate in measurement, and a column that resized as the
 * user scrolled would be unusable. So the width comes from the spec, and the
 * header and body consume the same one — which is also what keeps them aligned
 * without a table layout to align them.
 */
export function columnStyle<Row>(column: TableColumn<Row>): Record<string, unknown> {
  return column.width === undefined
    ? { flex: `${String(column.flex ?? 1)} 1 0px` }
    : { width: column.width, flex: "0 0 auto" };
}

/** Class for a column's horizontal alignment. */
export function alignClass(align: TableAlign | undefined): string {
  return `pui-table__cell--${align ?? "start"}`;
}

/** Pure builder: safe to call without a component scope (tests use this). */
export function tableDescriptor<Row>(props: TableProps<Row>): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const header = View({
    className: classes("pui-table__header", dark),
    direction: "row",
    semanticRole: "row",
    children: props.columns.map(
      (column, index) =>
        props.renderHeaderCell?.(column, index) ??
        Text({
          key: column.key,
          className: classes("pui-table__head", alignClass(column.align), dark),
          style: columnStyle(column),
          value: column.header,
          semanticRole: "columnheader",
        }),
    ),
  });
  const row = (index: number): PingoNode => {
    const value = props.getRow(index);
    const press = props.onRowPress;
    return View({
      className: classes("pui-table__row", dark),
      direction: "row",
      semanticRole: "row",
      ...(press === undefined
        ? {}
        : {
            onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
            onTap: () => press(index),
            onClick: () => press(index),
          }),
      children: props.columns.map((column) =>
        View({
          key: column.key,
          className: classes("pui-table__cell", alignClass(column.align), dark),
          style: columnStyle(column),
          children: column.cell(value, index),
        }),
      ),
    });
  };
  return View({
    className: classes("pui-table", props.className),
    semanticRole: "table",
    children: [
      header,
      props.rowCount === 0
        ? Text({
            className: classes("pui-table__empty", dark),
            value: props.emptyLabel ?? "暂无数据",
          })
        : // Core plans the window and calls renderItem only for the range it
          // asks for, so a million rows costs the same as a screenful.
          VirtualList({
            className: "pui-table__body",
            itemCount: props.rowCount,
            estimatedItemHeight: props.estimatedRowHeight ?? 44,
            renderItem: row,
          }),
    ],
  });
}

/**
 * Virtualised table. The column spec drives both the header and the rows.
 *
 * Deliberately not memoized. `memo` needs a non-generic props type, and giving
 * up the row type to gain it would be a poor trade — but more to the point,
 * `getRow` and every column's `cell` are closures rebuilt on each render, so a
 * memo would compare unequal every time and cost a comparison for nothing.
 */
export const Table = tableDescriptor;
