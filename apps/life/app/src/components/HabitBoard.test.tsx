/**
 * HabitBoard — the calendar-based Habits lens. Goals keep their at-a-glance
 * status (check / value-target / streak / + Log for unmet at_least; cap headroom
 * / over) with a goal-overlaid TrackerCalendar below; weekly goals add a
 * "this week N/target · last week M/target" line. A collapsible "All trackables"
 * expander lists every non-goal-primary trackable with a plain calendar.
 *
 * Tap-to-log backfills the TAPPED day: an empty day with a usable default logs a
 * default event timestamped to that day at local noon; group/rated/no-default
 * days open the shape sheet against that day; a populated day opens an edit
 * surface (one event → EventEditModal; several → a day modal).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LifeManifestTrackable, LifeEvent, LifeEntry, LifeGoal } from "@homelab/backend";

const addEvent = vi.fn().mockResolvedValue("evt1");
const deleteEvent = vi.fn().mockResolvedValue(undefined);
const updateEvent = vi.fn().mockResolvedValue(undefined);
const messageOpen = vi.fn();

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useFeedback: () => ({
      message: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), open: messageOpen, destroy: vi.fn() },
    }),
    useLifeBackend: () => ({ addEvent, deleteEvent, updateEvent }),
  };
});

import { HabitBoard } from "./HabitBoard";

let counter = 0;
function ev(subjectId: string, entries: LifeEntry[], when: Date): LifeEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    log: "log1",
    subjectId,
    timestamp: when,
    entries,
    createdBy: "u1",
    created: when.toISOString(),
    updated: when.toISOString(),
  };
}
const num = (name: string, value: number, unit: string): LifeEntry[] => [
  { name, type: "number", value, unit },
];
function at(year: number, month1: number, day: number, hour = 12): Date {
  return new Date(year, month1 - 1, day, hour, 0, 0, 0);
}
/** Local "YYYY-MM-DD" key for a Date (matches the runtime-tz day index). */
function localKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const TRACKABLES: LifeManifestTrackable[] = [
  { id: "water", label: "Water", shape: "took", defaultUnit: "oz", defaultAmount: 8 },
  { id: "floss", label: "Floss", shape: "happened" },
  { id: "run", label: "Run", shape: "did", group: "exercise", defaultDuration: 30 },
  { id: "walk", label: "Walk", shape: "did", group: "exercise", defaultDuration: 20 },
];

function renderBoard(props: Partial<React.ComponentProps<typeof HabitBoard>> = {}) {
  const onOpenShape = vi.fn(props.onOpenShape);
  render(
    <HabitBoard
      trackables={props.trackables ?? TRACKABLES}
      goals={props.goals ?? []}
      events={props.events ?? []}
      day={props.day ?? at(2026, 6, 10)}
      userId={props.userId ?? "u1"}
      logId={props.logId ?? "log1"}
      onOpenShape={onOpenShape}
    />,
  );
  return { onOpenShape };
}

/** Find a calendar cell by its local day key, scoped to a container. */
function cellIn(container: HTMLElement, key: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-daykey="${key}"]`);
  if (!el) throw new Error(`no calendar cell for ${key} in container`);
  return el;
}

const hydrate: LifeGoal = { id: "hydrate", label: "Hydrate", scope: { thing: "water" }, kind: "at_least", metric: "sum", unit: "oz", target: 64, period: "day" };
const flossDaily: LifeGoal = { id: "floss-daily", label: "Floss", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 1, period: "day" };
const drinkCap: LifeGoal = { id: "cap", label: "Drink cap", scope: { thing: "water" }, kind: "at_most", metric: "sum", unit: "drinks", target: 2, period: "day" };
const moveWeekly: LifeGoal = { id: "move", label: "Move", scope: { group: "exercise" }, kind: "frequency", metric: "days", target: 3, period: "week" };

describe("HabitBoard", () => {
  beforeEach(() => {
    addEvent.mockClear();
    messageOpen.mockClear();
  });

  it("shows the empty state pointing at Claude when there are no goals or trackables", () => {
    renderBoard({ goals: [], trackables: [] });
    expect(screen.getByTestId("habit-board-empty")).toHaveTextContent(/Claude/i);
  });

  it("hides hidden goals from the goals section", () => {
    // Only a hidden goal + a long-tail trackable: no goal rows render.
    renderBoard({ goals: [{ ...flossDaily, hidden: true }], trackables: [TRACKABLES[1]] });
    expect(screen.getByTestId("habit-board-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("habit-row")).not.toBeInTheDocument();
  });

  it("renders an unmet at_least daily goal with a tap-to-log button and a calendar", () => {
    renderBoard({ goals: [flossDaily], events: [] });
    const row = screen.getByTestId("habit-row");
    expect(within(row).getByTestId("habit-progress")).toHaveTextContent("0/1");
    expect(within(row).getByTestId("habit-log")).toBeInTheDocument();
    expect(within(row).getByTestId("tracker-calendar")).toBeInTheDocument();
  });

  it("status-row + Log appends the thing's default event to the viewed day", async () => {
    renderBoard({ goals: [flossDaily], events: [], day: at(2026, 6, 10) });
    await userEvent.click(screen.getByTestId("habit-log"));
    expect(addEvent).toHaveBeenCalledTimes(1);
    const [logId, subjectId, entries, , opts] = addEvent.mock.calls[0];
    expect(logId).toBe("log1");
    expect(subjectId).toBe("floss");
    expect(entries).toEqual([{ name: "count", type: "number", value: 1, unit: "ct" }]);
    // Logged to the viewed day at local noon.
    expect(localKey(opts.timestamp)).toBe("2026-06-10");
    expect(opts.timestamp.getHours()).toBe(12);
  });

  it("a met at_least goal shows no log button and a check", () => {
    renderBoard({
      goals: [hydrate],
      events: [ev("water", num("amount", 64, "oz"), at(2026, 6, 10, 9))],
    });
    const row = screen.getByTestId("habit-row");
    expect(within(row).getByTestId("habit-progress")).toHaveTextContent("64 oz/64 oz");
    expect(within(row).queryByTestId("habit-log")).not.toBeInTheDocument();
  });

  it("at_most cap shows headroom when under and is read-only", () => {
    renderBoard({
      goals: [drinkCap],
      events: [ev("water", num("drinks", 1, "drinks"), at(2026, 6, 10, 20))],
    });
    const row = screen.getByTestId("habit-row");
    expect(within(row).getByTestId("habit-progress")).toHaveTextContent("1 drinks/2 drinks");
    expect(within(row).queryByTestId("habit-log")).not.toBeInTheDocument();
    expect(row).toHaveTextContent(/left/);
  });

  it("at_most cap shows an over state when broken", () => {
    renderBoard({
      goals: [drinkCap],
      events: [
        ev("water", num("drinks", 2, "drinks"), at(2026, 6, 10, 19)),
        ev("water", num("drinks", 2, "drinks"), at(2026, 6, 10, 22)),
      ],
    });
    const row = screen.getByTestId("habit-row");
    expect(within(row).getByTestId("habit-progress")).toHaveTextContent("4 drinks/2 drinks");
    expect(row).toHaveTextContent(/over cap/);
  });

  it("weekly goal shows value/target and a this-week/last-week context line", () => {
    renderBoard({
      goals: [moveWeekly],
      events: [
        // This week (Sun 6/7..Sat 6/13): Mon + Wed = 2 days.
        ev("run", num("duration", 30, "min"), at(2026, 6, 8, 7)),
        ev("walk", num("duration", 20, "min"), at(2026, 6, 10, 7)),
        // Last week (Sun 5/31..Sat 6/6): one day.
        ev("run", num("duration", 30, "min"), at(2026, 6, 3, 7)),
      ],
      day: at(2026, 6, 10),
    });
    const row = screen.getByTestId("habit-row");
    expect(within(row).getByTestId("habit-progress")).toHaveTextContent("2/3");
    const ctx = within(row).getByTestId("habit-week-context");
    expect(ctx).toHaveTextContent("this week 2/3");
    expect(ctx).toHaveTextContent("last week 1/3");
  });

  it("calendar overlay: a goal-met day is colored 'met'", () => {
    renderBoard({
      goals: [flossDaily],
      events: [ev("floss", num("count", 1, "ct"), at(2026, 6, 9, 9))],
      day: at(2026, 6, 10),
    });
    const row = screen.getByTestId("habit-row");
    expect(cellIn(row, "2026-06-09").getAttribute("data-kind")).toBe("met");
    expect(cellIn(row, "2026-06-08").getAttribute("data-kind")).toBe("empty");
  });

  it("calendar overlay: an at_most over-cap day is colored 'over'", () => {
    renderBoard({
      goals: [drinkCap],
      events: [ev("water", num("drinks", 3, "drinks"), at(2026, 6, 9, 19))],
      day: at(2026, 6, 10),
    });
    const row = screen.getByTestId("habit-row");
    expect(cellIn(row, "2026-06-09").getAttribute("data-kind")).toBe("over");
  });

  it("backfill: tapping an empty past cell logs a default event dated to that day", async () => {
    renderBoard({ goals: [flossDaily], events: [], day: at(2026, 6, 10) });
    const row = screen.getByTestId("habit-row");
    await userEvent.click(cellIn(row, "2026-06-08"));
    expect(addEvent).toHaveBeenCalledTimes(1);
    const [, subjectId, entries, , opts] = addEvent.mock.calls[0];
    expect(subjectId).toBe("floss");
    expect(entries).toEqual([{ name: "count", type: "number", value: 1, unit: "ct" }]);
    expect(localKey(opts.timestamp)).toBe("2026-06-08"); // dated to the TAPPED day
  });

  it("backfill: a populated past cell opens the single-event edit modal", async () => {
    renderBoard({
      goals: [flossDaily],
      events: [ev("floss", num("count", 1, "ct"), at(2026, 6, 8, 9))],
      day: at(2026, 6, 10),
    });
    const row = screen.getByTestId("habit-row");
    await userEvent.click(cellIn(row, "2026-06-08"));
    expect(addEvent).not.toHaveBeenCalled();
    expect(screen.getByTestId("event-edit-modal")).toBeInTheDocument();
  });

  it("backfill: a day with several events opens the day-events modal", async () => {
    renderBoard({
      goals: [flossDaily],
      events: [
        ev("floss", num("count", 1, "ct"), at(2026, 6, 8, 9)),
        ev("floss", num("count", 1, "ct"), at(2026, 6, 8, 21)),
      ],
      day: at(2026, 6, 10),
    });
    const row = screen.getByTestId("habit-row");
    await userEvent.click(cellIn(row, "2026-06-08"));
    expect(addEvent).not.toHaveBeenCalled();
    const modal = screen.getByTestId("day-events-modal");
    expect(within(modal).getAllByTestId("entry-row")).toHaveLength(2);
  });

  it("backfill: group scope opens the shape sheet against the tapped day", async () => {
    const moveDaily: LifeGoal = { id: "move-d", label: "Move", scope: { group: "exercise" }, kind: "at_least", metric: "count", target: 1, period: "day" };
    const { onOpenShape } = renderBoard({ goals: [moveDaily], events: [], day: at(2026, 6, 10) });
    const row = screen.getByTestId("habit-row");
    await userEvent.click(cellIn(row, "2026-06-08"));
    expect(addEvent).not.toHaveBeenCalled();
    expect(onOpenShape).toHaveBeenCalledTimes(1);
    const [shape, backfillDay] = onOpenShape.mock.calls[0];
    expect(shape).toBe("did"); // exercise members are `did`
    expect(backfillDay && localKey(backfillDay)).toBe("2026-06-08");
  });

  it("backfill: a sum/unit mismatch opens the sheet against the tapped day, no no-op log", async () => {
    const drinksGoal: LifeGoal = { id: "drinks", label: "Drinks", scope: { thing: "water" }, kind: "at_least", metric: "sum", unit: "drinks", target: 3, period: "day" };
    const { onOpenShape } = renderBoard({ goals: [drinksGoal], events: [], day: at(2026, 6, 10) });
    const row = screen.getByTestId("habit-row");
    await userEvent.click(cellIn(row, "2026-06-08"));
    expect(addEvent).not.toHaveBeenCalled();
    const [shape, backfillDay] = onOpenShape.mock.calls[0];
    expect(shape).toBe("took"); // water is a `took` shape
    expect(backfillDay && localKey(backfillDay)).toBe("2026-06-08");
  });

  it("backfill: a future cell is inert (no log, no sheet)", async () => {
    const { onOpenShape } = renderBoard({ goals: [flossDaily], events: [], day: at(2026, 6, 10) });
    const row = screen.getByTestId("habit-row");
    await userEvent.click(cellIn(row, "2026-06-12")); // future
    expect(addEvent).not.toHaveBeenCalled();
    expect(onOpenShape).not.toHaveBeenCalled();
  });

  it("long tail: non-goal trackables appear in the expander, goal primaries don't", async () => {
    // hydrate's primary is `water`; floss/run/walk are the long tail.
    renderBoard({ goals: [hydrate], events: [] });
    const expander = screen.getByTestId("long-tail-expander");
    expect(expander).toHaveTextContent("All trackables (3)"); // floss, run, walk
    expect(screen.queryByTestId("long-tail-list")).not.toBeInTheDocument(); // collapsed
    await userEvent.click(expander);
    const list = screen.getByTestId("long-tail-list");
    const rows = within(list).getAllByTestId("trackable-row");
    expect(rows).toHaveLength(3);
    expect(list).toHaveTextContent("Floss");
    expect(list).not.toHaveTextContent("Water"); // water is the goal's primary
  });

  it("is date-aware: a past viewed day evaluates that day's events", () => {
    const events = [ev("floss", num("count", 1, "ct"), at(2026, 6, 9, 9))];
    renderBoard({ goals: [flossDaily], events, day: at(2026, 6, 9) });
    const row = screen.getByTestId("habit-row");
    expect(within(row).getByTestId("habit-progress")).toHaveTextContent("1/1");
    expect(within(row).queryByTestId("habit-log")).not.toBeInTheDocument();
  });
});
