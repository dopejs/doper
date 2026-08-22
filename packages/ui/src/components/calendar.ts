import { memo, Text, View, type PingoEvent, type PingoNode } from "@dopejs/pingo-jsx";
import { useSignal } from "@dopejs/pingo-runtime";

import { classes } from "../overlay";
import { useTheme } from "../theme";

/** A calendar day, kept as parts so no time zone can shift it. */
export type CalendarDate = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
};

export type CalendarProps = {
  readonly value?: CalendarDate;
  readonly month?: CalendarDate;
  readonly defaultMonth?: CalendarDate;
  readonly onSelect?: (date: CalendarDate) => void;
  readonly onMonthChange?: (month: CalendarDate) => void;
  readonly weekdayLabels?: readonly string[];
  readonly monthLabel?: (month: CalendarDate) => string;
  readonly isDisabled?: (date: CalendarDate) => boolean;
  readonly className?: string;
};

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** Days in a month, Gregorian, with the leap rule spelled out. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * The six-week grid for a month, padded with nulls.
 *
 * Always six rows, so the calendar does not change height as the user pages
 * through months — a grid that grows and shrinks moves everything under it.
 */
export function monthGrid(year: number, month: number): readonly (number | null)[] {
  // Date is used only to ask which weekday the first falls on. Constructed in
  // UTC so a machine behind the meridian cannot shift it to the previous day.
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const total = daysInMonth(year, month);
  const cells: (number | null)[] = Array.from({ length: 42 }, () => null);
  for (let day = 1; day <= total; day += 1) cells[firstWeekday + day - 1] = day;
  return cells;
}

/** Moves a month by `delta`, carrying the year. */
export function shiftMonth(month: CalendarDate, delta: number): CalendarDate {
  const zero = month.year * 12 + (month.month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (((zero % 12) + 12) % 12) + 1, day: 1 };
}

/** Whether two dates name the same day. */
export function sameDate(left: CalendarDate | undefined, right: CalendarDate): boolean {
  return left?.year === right.year && left.month === right.month && left.day === right.day;
}

/** Pure builder: safe to call without a component scope (tests use this). */
export function calendarDescriptor(props: CalendarProps, month: CalendarDate): PingoNode {
  const dark = useTheme() === "dark" ? "pui-dark" : undefined;
  const labels = props.weekdayLabels ?? WEEKDAYS;
  const grid = monthGrid(month.year, month.month);
  const page = (delta: number): void => props.onMonthChange?.(shiftMonth(month, delta));
  const control = (label: string, delta: number, name: string): PingoNode =>
    Text({
      className: classes("pui-calendar__control", dark),
      value: label,
      semanticRole: "button",
      semanticLabel: name,
      onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
      onTap: () => page(delta),
      onClick: () => page(delta),
    });
  const cell = (day: number | null, index: number): PingoNode => {
    if (day === null) {
      return View({ className: "pui-calendar__cell", key: `pad-${String(index)}` });
    }
    const date: CalendarDate = { year: month.year, month: month.month, day };
    const disabled = props.isDisabled?.(date) === true;
    const selected = sameDate(props.value, date);
    return Text({
      key: String(day),
      className: classes(
        "pui-calendar__cell",
        "pui-calendar__day",
        selected ? "pui-calendar__day--selected" : undefined,
        disabled ? "pui-calendar__day--disabled" : undefined,
        dark,
      ),
      value: String(day),
      semanticRole: "button",
      ...(selected ? { semanticValue: "selected" } : {}),
      ...(disabled
        ? {}
        : {
            onPointerDown: (event: PingoEvent): void => event.currentTarget.focus(),
            onTap: () => props.onSelect?.(date),
            onClick: () => props.onSelect?.(date),
          }),
    });
  };
  const rows: PingoNode[] = [];
  for (let week = 0; week < 6; week += 1) {
    rows.push(
      View({
        className: "pui-calendar__row",
        key: `week-${String(week)}`,
        direction: "row",
        children: grid
          .slice(week * 7, week * 7 + 7)
          .map((day, index) => cell(day, week * 7 + index)),
      }),
    );
  }
  return View({
    className: classes("pui-calendar", props.className),
    semanticRole: "group",
    // Arrows page the month from anywhere in the grid, so a keyboard user is
    // never trapped in a month they cannot leave.
    onKeyDown: (event: PingoEvent): void => {
      const delta = event.key === "PageUp" ? -1 : event.key === "PageDown" ? 1 : 0;
      if (delta === 0) return;
      event.preventDefault();
      page(delta);
    },
    children: [
      View({
        className: "pui-calendar__header",
        direction: "row",
        children: [
          control("‹", -1, "previous month"),
          Text({
            className: classes("pui-calendar__title", dark),
            value:
              props.monthLabel?.(month) ?? `${String(month.year)} 年 ${String(month.month)} 月`,
          }),
          control("›", 1, "next month"),
        ],
      }),
      View({
        className: "pui-calendar__row",
        direction: "row",
        children: labels.map((label, index) =>
          Text({
            key: String(index),
            className: classes("pui-calendar__cell", "pui-calendar__weekday", dark),
            value: label,
          }),
        ),
      }),
      ...rows,
    ],
  });
}

/** shadcn-style month calendar. JSX-only: uses hooks. */
export const Calendar = memo(function CalendarImpl(props: CalendarProps): PingoNode {
  const fallback: CalendarDate = props.defaultMonth ??
    props.value ?? { year: 2026, month: 1, day: 1 };
  const internal = useSignal(fallback);
  // .get() (not .peek()): paging must re-render this component.
  const month = props.month ?? internal.get();
  return calendarDescriptor(
    {
      ...props,
      onMonthChange: (next) => {
        internal.set(next);
        props.onMonthChange?.(next);
      },
    },
    month,
  );
});
