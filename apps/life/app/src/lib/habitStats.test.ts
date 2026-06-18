/**
 * Stat helpers for the per-habit history screen. All math is tz-aware (PT) so a
 * late-evening event (next-day UTC) lands on the Pacific day, matching the
 * calendar coloring. Covers: per-month completion and per-year totals (incl.
 * empty history → 0 and an earliest-event-bounded window).
 */
import { describe, it, expect } from "vitest";
import type { LifeEvent, LifeEntry, LifeGoal } from "@homelab/backend";
import { buildDayIndex } from "./dayIndex";
import { monthStats, yearStats } from "./habitStats";

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
const ct = (): LifeEntry[] => [{ name: "count", type: "number", value: 1, unit: "ct" }];

// A fixed "today" = 2026-06-10 (Wednesday) 12:00 PT.
const TODAY = new Date("2026-06-10T19:00:00.000Z");

const flossDaily: LifeGoal = {
  id: "floss", label: "Floss", scope: { thing: "floss" },
  kind: "at_least", metric: "count", target: 1, period: "day",
};

describe("monthStats", () => {
  it("completed vs elapsed for the current (partial) month, with %", () => {
    // June; today 6/10 → 10 elapsed days. Logged 6/2, 6/5, 6/9 → 3 completed.
    const events = [
      ev("floss", ct(), "2026-06-02T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-05T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-09T17:00:00.000Z"),
    ];
    const index = buildDayIndex(events, PT);
    const m = monthStats(["floss"], flossDaily, index, events, PT, TODAY, TODAY);
    expect(m.elapsed).toBe(10);
    expect(m.completed).toBe(3);
    expect(m.pct).toBe(30);
  });

  it("a fully-elapsed past month counts all its days as elapsed", () => {
    // May has 31 days; reference a May date. Two logged May days.
    const mayRef = new Date("2026-05-20T19:00:00.000Z");
    const events = [
      ev("floss", ct(), "2026-05-03T17:00:00.000Z"),
      ev("floss", ct(), "2026-05-28T17:00:00.000Z"),
    ];
    const index = buildDayIndex(events, PT);
    const m = monthStats(["floss"], flossDaily, index, events, PT, mayRef, TODAY);
    expect(m.elapsed).toBe(31);
    expect(m.completed).toBe(2);
  });
});

describe("yearStats", () => {
  it("empty history → zeros", () => {
    const index = buildDayIndex([], PT);
    expect(yearStats(["floss"], flossDaily, index, [], PT, TODAY)).toEqual({
      completedDays: 0, elapsedDays: 0, pct: 0,
    });
  });

  it("bounds the window to the earliest event (no inflated denominator)", () => {
    // First event 6/8 → window is 6/8,6/9,6/10 = 3 elapsed days; all logged.
    const events = [
      ev("floss", ct(), "2026-06-08T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-09T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-10T17:00:00.000Z"),
    ];
    const index = buildDayIndex(events, PT);
    const y = yearStats(["floss"], flossDaily, index, events, PT, TODAY);
    expect(y.elapsedDays).toBe(3);
    expect(y.completedDays).toBe(3);
    expect(y.pct).toBe(100);
  });
});
