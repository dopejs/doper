import { describe, expect, it, vi } from "vitest";

import {
  calendarDescriptor,
  daysInMonth,
  monthGrid,
  sameDate,
  shiftMonth,
  type CalendarDate,
} from "./calendar";

type Node = { readonly props: Record<string, unknown> };

describe("daysInMonth", () => {
  it("knows the short months", () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it("applies the full leap rule, not just the four-year one", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });
});

describe("monthGrid", () => {
  it("always returns six weeks so the calendar does not change height", () => {
    // A grid that grows and shrinks moves everything under it as the user pages.
    for (const month of [1, 2, 5, 12]) {
      expect(monthGrid(2026, month)).toHaveLength(42);
    }
  });

  it("places the first day on its real weekday", () => {
    // 2026-01-01 is a Thursday: index 4, counting from Sunday.
    const grid = monthGrid(2026, 1);
    expect(grid.indexOf(1)).toBe(4);
    expect(grid[3]).toBeNull();
  });

  it("holds every day of the month and nothing more", () => {
    const grid = monthGrid(2024, 2);
    expect(grid.filter((day) => day !== null)).toHaveLength(29);
    expect(Math.max(...grid.filter((day): day is number => day !== null))).toBe(29);
  });
});

describe("shiftMonth", () => {
  it("carries the year in both directions", () => {
    expect(shiftMonth({ year: 2026, month: 12, day: 1 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
    expect(shiftMonth({ year: 2026, month: 1, day: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
      day: 1,
    });
  });

  it("moves by more than a year", () => {
    expect(shiftMonth({ year: 2026, month: 6, day: 1 }, 18)).toEqual({
      year: 2027,
      month: 12,
      day: 1,
    });
  });
});

describe("sameDate", () => {
  it("is false for undefined rather than throwing", () => {
    expect(sameDate(undefined, { year: 2026, month: 1, day: 1 })).toBe(false);
  });
});

describe("calendarDescriptor", () => {
  const month: CalendarDate = { year: 2026, month: 1, day: 1 };

  function weeks(props: Parameters<typeof calendarDescriptor>[0] = {}): Node[] {
    const node = calendarDescriptor(props, month) as unknown as Node;
    return (node.props["children"] as Node[]).slice(2);
  }

  it("marks the selected day and no other", () => {
    const days = weeks({ value: { year: 2026, month: 1, day: 5 } })
      .flatMap((week) => week.props["children"] as Node[])
      .filter((cell) => cell.props["value"] !== undefined);
    const selected = days.filter((cell) => cell.props["semanticValue"] === "selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.props["value"]).toBe("5");
  });

  it("gives a disabled day no handlers", () => {
    const days = weeks({ isDisabled: (date) => date.day === 3 })
      .flatMap((week) => week.props["children"] as Node[])
      .filter((cell) => cell.props["value"] === "3");
    expect(days[0]?.props["onTap"]).toBeUndefined();
    expect(days[0]?.props["className"]).toContain("pui-calendar__day--disabled");
  });

  it("pages with PageUp and PageDown but claims no other key", () => {
    const onMonthChange = vi.fn();
    const node = calendarDescriptor({ onMonthChange }, month) as unknown as Node;
    const keyDown = node.props["onKeyDown"] as (event: unknown) => void;
    const preventDefault = vi.fn();
    keyDown({ key: "PageDown", preventDefault });
    expect(onMonthChange).toHaveBeenCalledWith({ year: 2026, month: 2, day: 1 });
    const ignored = vi.fn();
    keyDown({ key: "ArrowDown", preventDefault: ignored });
    expect(ignored).not.toHaveBeenCalled();
  });

  it("reports the chosen day with the month it belongs to", () => {
    const onSelect = vi.fn();
    const day = weeks({ onSelect })
      .flatMap((week) => week.props["children"] as Node[])
      .find((cell) => cell.props["value"] === "7");
    (day?.props["onTap"] as () => void)();
    expect(onSelect).toHaveBeenCalledWith({ year: 2026, month: 1, day: 7 });
  });
});
