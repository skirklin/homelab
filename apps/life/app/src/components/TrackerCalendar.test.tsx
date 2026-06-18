/**
 * TrackerCalendar — the reusable Su–Sa grid. Verifies: it renders `weeks`
 * week-rows (+ a DOW header) with today marked and future days disabled; goal
 * overlay colors met vs cap-over days; plain (no-goal) calendars are binary
 * filled/empty; and tapping a non-future cell fires onTapDay with that day's
 * events while future cells are inert.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LifeEvent, LifeEntry, LifeGoal } from "@homelab/backend";
import { TrackerCalendar } from "./TrackerCalendar";
import { buildDayIndex } from "../lib/dayIndex";

const PT = "America/Los_Angeles";

let counter = 0;
function ev(subjectId: string, entries: LifeEntry[], iso: string): LifeEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    log: "log1",
    subjectId,
    timestamp: new Date(iso),
    entries,
    createdBy: "u1",
    created: iso,
    updated: iso,
  };
}
const num = (name: string, value: number, unit: string): LifeEntry[] => [
  { name, type: "number", value, unit },
];

// A fixed "today": 2026-06-10 (a Wednesday) noon PT.
const TODAY = new Date("2026-06-10T19:00:00.000Z"); // 12:00 PT

function cells() {
  return screen.getAllByTestId("calendar-cell");
}
function cell(dayKey: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-daykey="${dayKey}"]`);
  if (!el) throw new Error(`no calendar cell for ${dayKey}`);
  return el;
}

describe("TrackerCalendar", () => {
  it("renders weeks*7 day cells plus a 7-col DOW header, today marked", () => {
    const index = buildDayIndex([], PT);
    render(
      <TrackerCalendar subjectIds={["water"]} weeks={3} index={index} tz={PT} today={TODAY} onTapDay={vi.fn()} />,
    );
    expect(cells()).toHaveLength(21);
    // Today (2026-06-10) is marked and the last week is at the bottom.
    expect(cell("2026-06-10").getAttribute("data-today")).toBe("true");
  });

  it("renders the day-of-month number in each cell", () => {
    const index = buildDayIndex([], PT);
    render(
      <TrackerCalendar subjectIds={["water"]} weeks={2} index={index} tz={PT} today={TODAY} onTapDay={vi.fn()} />,
    );
    // Each cell shows its date number (6/10 → "10", 6/9 → "9").
    expect(cell("2026-06-10")).toHaveTextContent("10");
    expect(cell("2026-06-09")).toHaveTextContent("9");
    expect(cell("2026-06-01")).toHaveTextContent("1");
  });

  it("renders each cell's number from its tz-correct day-key, not the browser tz", () => {
    // Regression guard for B1: the day number MUST be derived from the cell's
    // dayKey (YYYY-MM-DD computed in the saved tz), not cell.date.getDate(). With
    // a saved tz (PT) west of common browser tzs, noon-in-PT (19:00Z) is the same
    // calendar day everywhere — but reading `cell.date.getDate()` in a browser tz
    // east of PT would render the NEXT day's number (off-by-one). Asserting the
    // text equals the key's day component is tz-agnostic and catches that lie
    // regardless of the process TZ the test happens to run under.
    const index = buildDayIndex([], PT);
    render(
      <TrackerCalendar subjectIds={["water"]} weeks={6} index={index} tz={PT} today={TODAY} monthRef={TODAY} onTapDay={vi.fn()} />,
    );
    for (const el of cells()) {
      const key = el.getAttribute("data-daykey")!; // YYYY-MM-DD
      const expected = String(Number(key.slice(8, 10))); // strip leading zero
      expect(el).toHaveTextContent(new RegExp(`^${expected}$`));
    }
  });

  it("without monthRef every cell is in-month (board strip unaffected)", () => {
    const index = buildDayIndex([], PT);
    render(
      <TrackerCalendar subjectIds={["water"]} weeks={3} index={index} tz={PT} today={TODAY} onTapDay={vi.fn()} />,
    );
    // No cell carries the out-of-month marker when monthRef is omitted.
    expect(document.querySelector('[data-in-month="false"]')).toBeNull();
  });

  it("with monthRef, cells outside that month are marked out-of-month", () => {
    const index = buildDayIndex([], PT);
    // 6-week grid anchored on today (June) with June as the reference month: the
    // top rows reach back into late May → those cells are out-of-month.
    render(
      <TrackerCalendar
        subjectIds={["water"]}
        weeks={6}
        index={index}
        tz={PT}
        today={TODAY}
        monthRef={TODAY}
        onTapDay={vi.fn()}
      />,
    );
    // A May day is out-of-month; a June day is in-month.
    expect(cell("2026-05-31").getAttribute("data-in-month")).toBe("false");
    expect(cell("2026-06-09").getAttribute("data-in-month")).toBeNull();
  });

  it("disables future days in the current week", () => {
    const index = buildDayIndex([], PT);
    render(
      <TrackerCalendar subjectIds={["water"]} weeks={2} index={index} tz={PT} today={TODAY} onTapDay={vi.fn()} />,
    );
    // Wed 6/10 is today; Thu 6/11..Sat 6/13 are future and disabled.
    expect(cell("2026-06-11")).toBeDisabled();
    expect(cell("2026-06-13")).toBeDisabled();
    expect(cell("2026-06-10")).not.toBeDisabled();
    expect(cell("2026-06-09")).not.toBeDisabled();
  });

  it("plain (no-goal) calendar colors logged days filled, others empty", () => {
    const index = buildDayIndex([ev("water", num("amount", 8, "oz"), "2026-06-09T18:00:00.000Z")], PT);
    render(
      <TrackerCalendar subjectIds={["water"]} weeks={2} index={index} tz={PT} today={TODAY} onTapDay={vi.fn()} />,
    );
    expect(cell("2026-06-09").getAttribute("data-kind")).toBe("filled");
    expect(cell("2026-06-08").getAttribute("data-kind")).toBe("empty");
  });

  it("at_least goal overlay colors a qualifying day 'met'", () => {
    const goal: LifeGoal = { id: "g", label: "Hydrate", scope: { thing: "water" }, kind: "at_least", metric: "sum", unit: "oz", target: 64, period: "day" };
    const index = buildDayIndex([ev("water", num("amount", 8, "oz"), "2026-06-09T18:00:00.000Z")], PT);
    render(
      <TrackerCalendar subjectIds={["water"]} goal={goal} weeks={2} index={index} tz={PT} today={TODAY} onTapDay={vi.fn()} />,
    );
    // Any qualifying day is "met" for ≥-kinds (even below target — the calendar
    // shows "logged that day"; per-day target meeting is goal-period business).
    expect(cell("2026-06-09").getAttribute("data-kind")).toBe("met");
  });

  it("at_most cap overlay colors an over-cap day 'over' and an under-cap day 'filled'", () => {
    const cap: LifeGoal = { id: "cap", label: "Drinks", scope: { thing: "drink" }, kind: "at_most", metric: "sum", unit: "drinks", target: 2, period: "day" };
    const index = buildDayIndex(
      [
        // 6/9: 3 drinks → over the daily cap of 2.
        ev("drink", num("drinks", 3, "drinks"), "2026-06-09T18:00:00.000Z"),
        // 6/8: 1 drink → logged but under cap.
        ev("drink", num("drinks", 1, "drinks"), "2026-06-08T18:00:00.000Z"),
      ],
      PT,
    );
    render(
      <TrackerCalendar subjectIds={["drink"]} goal={cap} weeks={2} index={index} tz={PT} today={TODAY} onTapDay={vi.fn()} />,
    );
    expect(cell("2026-06-09").getAttribute("data-kind")).toBe("over");
    expect(cell("2026-06-08").getAttribute("data-kind")).toBe("filled");
  });

  it("a WEEKLY at_most cap never colors a single day 'over' (breach is per-week, not per-day)", () => {
    // "≤ 3 drinks/week": a day with 3 drinks is NOT a per-day breach — comparing
    // one day's sum to the weekly target would mis-flag the cell. Logged days are
    // neutral "filled"; the weekly breach lives in the status row.
    const weeklyCap: LifeGoal = { id: "wcap", label: "Drinks/wk", scope: { thing: "drink" }, kind: "at_most", metric: "sum", unit: "drinks", target: 3, period: "week" };
    const index = buildDayIndex(
      [ev("drink", num("drinks", 3, "drinks"), "2026-06-09T18:00:00.000Z")],
      PT,
    );
    render(
      <TrackerCalendar subjectIds={["drink"]} goal={weeklyCap} weeks={2} index={index} tz={PT} today={TODAY} onTapDay={vi.fn()} />,
    );
    expect(cell("2026-06-09").getAttribute("data-kind")).toBe("filled");
  });

  it("tapping a populated non-future cell fires onTapDay with that day's events", async () => {
    const onTapDay = vi.fn();
    const event = ev("water", num("amount", 8, "oz"), "2026-06-09T18:00:00.000Z");
    const index = buildDayIndex([event], PT);
    render(
      <TrackerCalendar subjectIds={["water"]} weeks={2} index={index} tz={PT} today={TODAY} onTapDay={onTapDay} />,
    );
    await userEvent.click(cell("2026-06-09"));
    expect(onTapDay).toHaveBeenCalledTimes(1);
    const [date, events] = onTapDay.mock.calls[0];
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(event.id);
    // The passed date is local noon of the tapped day (PT noon === 19:00 UTC).
    expect(date.toISOString()).toBe("2026-06-09T19:00:00.000Z");
  });

  it("tapping an empty non-future cell fires onTapDay with no events", async () => {
    const onTapDay = vi.fn();
    const index = buildDayIndex([], PT);
    render(
      <TrackerCalendar subjectIds={["water"]} weeks={2} index={index} tz={PT} today={TODAY} onTapDay={onTapDay} />,
    );
    await userEvent.click(cell("2026-06-08"));
    expect(onTapDay).toHaveBeenCalledTimes(1);
    expect(onTapDay.mock.calls[0][1]).toEqual([]);
  });

  it("a future cell does not fire onTapDay", async () => {
    const onTapDay = vi.fn();
    const index = buildDayIndex([], PT);
    render(
      <TrackerCalendar subjectIds={["water"]} weeks={2} index={index} tz={PT} today={TODAY} onTapDay={onTapDay} />,
    );
    await userEvent.click(cell("2026-06-11"));
    expect(onTapDay).not.toHaveBeenCalled();
  });

  it("a long press fires onLongPressDay (not onTapDay) and a short tap the reverse", async () => {
    const onTapDay = vi.fn();
    const onLongPressDay = vi.fn();
    const index = buildDayIndex([], PT);
    render(
      <TrackerCalendar
        subjectIds={["water"]}
        weeks={2}
        index={index}
        tz={PT}
        today={TODAY}
        onTapDay={onTapDay}
        onLongPressDay={onLongPressDay}
      />,
    );
    // Long press: hold past the ~450ms threshold, then release → long-press only.
    const target = cell("2026-06-09");
    fireEvent.pointerDown(target, { clientX: 0, clientY: 0 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 520));
    });
    fireEvent.pointerUp(target, { clientX: 0, clientY: 0 });
    expect(onLongPressDay).toHaveBeenCalledTimes(1);
    expect(onTapDay).not.toHaveBeenCalled();

    // Short tap on another cell → onTapDay only.
    onTapDay.mockClear();
    onLongPressDay.mockClear();
    await userEvent.click(cell("2026-06-08"));
    expect(onTapDay).toHaveBeenCalledTimes(1);
    expect(onLongPressDay).not.toHaveBeenCalled();
  });
});
