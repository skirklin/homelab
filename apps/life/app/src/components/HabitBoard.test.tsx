/**
 * HabitBoard — the goal review lens. Renders daily at_least goals (check +
 * value/target + tap-to-log when unmet), daily at_most caps (read-only headroom
 * / over state), and weekly goals (value/target + day pips). Tap-to-log replays
 * a thing's default payload; group scope opens the shape sheet. Empty state
 * points the user at Claude.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LifeManifestTrackable, LifeEvent, LifeEntry, LifeGoal } from "@homelab/backend";

const addEvent = vi.fn().mockResolvedValue("evt1");
const deleteEvent = vi.fn().mockResolvedValue(undefined);
const messageOpen = vi.fn();

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useFeedback: () => ({
      message: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), open: messageOpen, destroy: vi.fn() },
    }),
    useLifeBackend: () => ({ addEvent, deleteEvent }),
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

const TRACKABLES: LifeManifestTrackable[] = [
  { id: "water", label: "Water", shape: "took", defaultUnit: "oz", defaultAmount: 8 },
  { id: "floss", label: "Floss", shape: "happened" },
  { id: "run", label: "Run", shape: "did", group: "exercise", defaultDuration: 30 },
  { id: "walk", label: "Walk", shape: "did", group: "exercise", defaultDuration: 20 },
];

function renderBoard(props: Partial<React.ComponentProps<typeof HabitBoard>> = {}) {
  const onOpenShape = props.onOpenShape ?? vi.fn();
  render(
    <HabitBoard
      trackables={props.trackables ?? TRACKABLES}
      goals={props.goals ?? []}
      events={props.events ?? []}
      day={props.day ?? at(2026, 6, 10)}
      userId={props.userId ?? "u1"}
      logId={props.logId ?? "log1"}
      timestamp={props.timestamp}
      onOpenShape={onOpenShape}
    />,
  );
  return { onOpenShape };
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

  it("shows the empty state pointing at Claude when there are no goals", () => {
    renderBoard({ goals: [] });
    expect(screen.getByTestId("habit-board-empty")).toHaveTextContent(/Claude/i);
  });

  it("hides hidden goals", () => {
    renderBoard({ goals: [{ ...flossDaily, hidden: true }] });
    expect(screen.getByTestId("habit-board-empty")).toBeInTheDocument();
  });

  it("renders an unmet at_least daily goal with a tap-to-log button", () => {
    renderBoard({ goals: [flossDaily], events: [] });
    const row = screen.getByTestId("habit-row");
    expect(within(row).getByTestId("habit-progress")).toHaveTextContent("0/1");
    expect(within(row).getByTestId("habit-log")).toBeInTheDocument();
  });

  it("tap-to-log appends the thing's default event (happened → count 1)", async () => {
    renderBoard({ goals: [flossDaily], events: [], timestamp: at(2026, 6, 10) });
    await userEvent.click(screen.getByTestId("habit-log"));
    expect(addEvent).toHaveBeenCalledTimes(1);
    const [logId, subjectId, entries] = addEvent.mock.calls[0];
    expect(logId).toBe("log1");
    expect(subjectId).toBe("floss");
    expect(entries).toEqual([{ name: "count", type: "number", value: 1, unit: "ct" }]);
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

  it("weekly goal shows value/target and 7 day pips", () => {
    renderBoard({
      goals: [moveWeekly],
      events: [
        ev("run", num("duration", 30, "min"), at(2026, 6, 8, 7)), // Mon
        ev("walk", num("duration", 20, "min"), at(2026, 6, 10, 7)), // Wed
      ],
    });
    const row = screen.getByTestId("habit-row");
    expect(within(row).getByTestId("habit-progress")).toHaveTextContent("2/3");
    expect(within(row).getByTestId("habit-pips").children).toHaveLength(7);
  });

  it("group-scope tap-to-log opens the shape sheet instead of logging", async () => {
    // A group can't pick one thing; make a daily group goal so a log button shows.
    const moveDaily: LifeGoal = { id: "move-d", label: "Move", scope: { group: "exercise" }, kind: "at_least", metric: "count", target: 1, period: "day" };
    const { onOpenShape } = renderBoard({ goals: [moveDaily], events: [] });
    await userEvent.click(screen.getByTestId("habit-log"));
    expect(addEvent).not.toHaveBeenCalled();
    expect(onOpenShape).toHaveBeenCalledWith("did"); // exercise members are `did`
  });

  it("is date-aware: a past day evaluates that day's events", () => {
    // Goal met on the 9th but not the 10th — viewing the 9th shows it met.
    const events = [ev("floss", num("count", 1, "ct"), at(2026, 6, 9, 9))];
    renderBoard({ goals: [flossDaily], events, day: at(2026, 6, 9) });
    const row = screen.getByTestId("habit-row");
    expect(within(row).getByTestId("habit-progress")).toHaveTextContent("1/1");
    expect(within(row).queryByTestId("habit-log")).not.toBeInTheDocument();
  });
});
