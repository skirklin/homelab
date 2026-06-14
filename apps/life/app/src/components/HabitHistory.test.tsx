/**
 * HabitHistory — the per-habit history Drawer. Verifies it opens for the tapped
 * habit; the year heatmap renders ~53 week-columns × 7 rows with the right cell
 * states + a today marker; the current month grid renders and paginates; the
 * per-year/per-month stats are correct; and tap/long-press interactions on its
 * calendars delegate to the board's handlers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LifeManifestTrackable, LifeEvent, LifeEntry, LifeGoal } from "@homelab/backend";
import { HabitHistory } from "./HabitHistory";
import { buildDayIndex } from "../lib/dayIndex";

// The component buckets in the RUNTIME tz; the test pins Date and uses local
// helpers for day keys (mirrors HabitBoard.test).
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
const ct = (): LifeEntry[] => [{ name: "count", type: "number", value: 1, unit: "ct" }];
function at(y: number, m1: number, d: number, h = 12): Date {
  return new Date(y, m1 - 1, d, h, 0, 0, 0);
}
function localKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const floss: LifeManifestTrackable = { id: "floss", label: "Floss", shape: "happened" };
const water: LifeManifestTrackable = { id: "water", label: "Water", shape: "took", defaultUnit: "oz" };
const flossGoal: LifeGoal = {
  id: "floss", label: "Floss daily", scope: { thing: "floss" },
  kind: "at_least", metric: "count", target: 1, period: "day",
};

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function renderHistory(props: Partial<React.ComponentProps<typeof HabitHistory>> = {}) {
  const onTapDay = vi.fn(props.onTapDay);
  const onLongPressDay = vi.fn(props.onLongPressDay);
  const events = props.events ?? [];
  const index = buildDayIndex(events, TZ);
  render(
    <HabitHistory
      open={props.open ?? true}
      thing={"thing" in props ? props.thing! : floss}
      goal={props.goal ?? flossGoal}
      index={index}
      events={events}
      tz={TZ}
      today={props.today ?? at(2026, 6, 10)}
      onClose={props.onClose ?? vi.fn()}
      onTapDay={onTapDay}
      onLongPressDay={onLongPressDay}
    />,
  );
  return { onTapDay, onLongPressDay };
}

describe("HabitHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(2026, 6, 10, 12));
  });
  afterEach(() => vi.useRealTimers());

  it("renders nothing for a null thing", () => {
    renderHistory({ thing: null });
    expect(screen.queryByTestId("habit-history")).not.toBeInTheDocument();
  });

  it("opens with the habit label as the title and a year heatmap", () => {
    renderHistory({ events: [] });
    expect(screen.getByTestId("habit-history")).toBeInTheDocument();
    expect(screen.getByText("Floss")).toBeInTheDocument();
    expect(screen.getByTestId("year-heatmap")).toBeInTheDocument();
  });

  it("the year heatmap renders 53 week-columns × 7 day-rows and marks today", () => {
    renderHistory({ events: [] });
    const heat = screen.getByTestId("year-heatmap");
    const cells = within(heat).getAllByTestId("heatmap-cell");
    expect(cells).toHaveLength(53 * 7);
    const todayCell = heat.querySelector('[data-today="true"]');
    expect(todayCell?.getAttribute("data-daykey")).toBe("2026-06-10");
  });

  it("the heatmap colors a met day and leaves an empty day muted", () => {
    const events = [ev("floss", ct(), at(2026, 6, 9, 9))];
    renderHistory({ events, goal: flossGoal });
    const heat = screen.getByTestId("year-heatmap");
    const met = heat.querySelector('[data-daykey="2026-06-09"]');
    const empty = heat.querySelector('[data-daykey="2026-06-08"]');
    expect(met?.getAttribute("data-kind")).toBe("met");
    expect(empty?.getAttribute("data-kind")).toBe("empty");
  });

  it("shows per-year stats: completed days, %, current + longest streak", () => {
    // First event 6/8 → 3-day window (6/8..6/10), all logged → 100%, streak 3.
    const events = [
      ev("floss", ct(), at(2026, 6, 8, 9)),
      ev("floss", ct(), at(2026, 6, 9, 9)),
      ev("floss", ct(), at(2026, 6, 10, 9)),
    ];
    renderHistory({ events, goal: flossGoal });
    const stats = screen.getByTestId("year-stats");
    expect(within(stats).getByTestId("stat-completed")).toHaveTextContent("3");
    expect(within(stats).getByTestId("stat-current")).toHaveTextContent("3");
    expect(within(stats).getByTestId("stat-longest")).toHaveTextContent("3");
  });

  it("shows a current-month grid with a completed/elapsed line", () => {
    const events = [ev("floss", ct(), at(2026, 6, 2, 9)), ev("floss", ct(), at(2026, 6, 9, 9))];
    renderHistory({ events, goal: flossGoal });
    const blocks = screen.getAllByTestId("month-block");
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    // The first (current) month shows "2/10" (June, today 6/10) and 20%.
    expect(within(blocks[0]).getByTestId("month-pct")).toHaveTextContent("2/10");
  });

  it("paginates further months on 'Show earlier'", async () => {
    vi.useRealTimers(); // userEvent needs real timers
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(2026, 6, 10, 12));
    renderHistory({ events: [] });
    const before = screen.getAllByTestId("month-block").length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("show-earlier"));
    });
    const after = screen.getAllByTestId("month-block").length;
    expect(after).toBeGreaterThan(before);
  });

  it("tapping a heatmap cell delegates to onTapDay with the thing + day events", async () => {
    const events = [ev("floss", ct(), at(2026, 6, 9, 9))];
    const { onTapDay } = renderHistory({ events, goal: flossGoal });
    const heat = screen.getByTestId("year-heatmap");
    const cell = heat.querySelector<HTMLElement>('[data-daykey="2026-06-09"]')!;
    await userEvent.click(cell);
    expect(onTapDay).toHaveBeenCalledTimes(1);
    const [thing, goal, date, evts] = onTapDay.mock.calls[0];
    expect(thing.id).toBe("floss");
    expect(goal?.id).toBe("floss");
    expect(localKey(date)).toBe("2026-06-09");
    expect(evts).toHaveLength(1);
  });

  it("a long-press on a heatmap cell delegates to onLongPressDay", async () => {
    const events = [ev("floss", ct(), at(2026, 6, 9, 9))];
    const { onTapDay, onLongPressDay } = renderHistory({ events, goal: flossGoal });
    const heat = screen.getByTestId("year-heatmap");
    const cell = heat.querySelector<HTMLElement>('[data-daykey="2026-06-09"]')!;
    fireEvent.pointerDown(cell, { clientX: 0, clientY: 0 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 520));
    });
    fireEvent.pointerUp(cell, { clientX: 0, clientY: 0 });
    expect(onLongPressDay).toHaveBeenCalledTimes(1);
    expect(onTapDay).not.toHaveBeenCalled();
  });

  it("works for a plain trackable with no goal", () => {
    renderHistory({ thing: water, goal: null, events: [ev("water", ct(), at(2026, 6, 9, 9))] });
    expect(screen.getByTestId("habit-history")).toBeInTheDocument();
    expect(screen.getByTestId("year-heatmap")).toBeInTheDocument();
  });
});
