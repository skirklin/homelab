/**
 * Stat helpers for the per-habit history screen. All math is tz-aware (PT) so a
 * late-evening event (next-day UTC) lands on the Pacific day, matching the
 * calendar coloring. Covers: longest/current streak (incl. a broken streak and
 * empty history → 0), per-month completion, per-year totals, and a tz-boundary
 * event.
 */
import { describe, it, expect } from "vitest";
import type { LifeEvent, LifeEntry, LifeGoal } from "@homelab/backend";
import { buildDayIndex } from "./dayIndex";
import { computeStreaks, monthStats, yearStats } from "./habitStats";

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
const oz = (v: number): LifeEntry[] => [{ name: "amount", type: "number", value: v, unit: "oz" }];

// A fixed "today" = 2026-06-10 (Wednesday) 12:00 PT.
const TODAY = new Date("2026-06-10T19:00:00.000Z");

const flossDaily: LifeGoal = {
  id: "floss", label: "Floss", scope: { thing: "floss" },
  kind: "at_least", metric: "count", target: 1, period: "day",
};

describe("computeStreaks (daily)", () => {
  it("empty history → current 0, longest 0", () => {
    const index = buildDayIndex([], PT);
    expect(computeStreaks(["floss"], flossDaily, index, [], PT, TODAY)).toEqual({ current: 0, longest: 0 });
  });

  it("a clean run to today is both the current and longest streak", () => {
    // 6/8, 6/9, 6/10 logged → 3-day run ending today.
    const events = [
      ev("floss", ct(), "2026-06-08T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-09T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-10T17:00:00.000Z"),
    ];
    const index = buildDayIndex(events, PT);
    expect(computeStreaks(["floss"], flossDaily, index, events, PT, TODAY)).toEqual({ current: 3, longest: 3 });
  });

  it("a broken streak: longest is the best run, current is the trailing run", () => {
    // Logged 6/4,6/5,6/6,6/7 (4-run), GAP 6/8, then 6/9,6/10 (2-run ending today).
    const events = [
      ev("floss", ct(), "2026-06-04T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-05T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-06T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-07T17:00:00.000Z"),
      // gap on 6/8
      ev("floss", ct(), "2026-06-09T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-10T17:00:00.000Z"),
    ];
    const index = buildDayIndex(events, PT);
    expect(computeStreaks(["floss"], flossDaily, index, events, PT, TODAY)).toEqual({ current: 2, longest: 4 });
  });

  it("a missed today zeroes the current streak but keeps longest", () => {
    // Logged 6/7,6/8,6/9 (3-run), nothing today (6/10) → current 0, longest 3.
    const events = [
      ev("floss", ct(), "2026-06-07T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-08T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-09T17:00:00.000Z"),
    ];
    const index = buildDayIndex(events, PT);
    expect(computeStreaks(["floss"], flossDaily, index, events, PT, TODAY)).toEqual({ current: 0, longest: 3 });
  });

  it("respects the tz boundary: a 11pm-PT event counts on the Pacific day, not the UTC next day", () => {
    // 2026-06-09 23:30 PT === 2026-06-10 06:30 UTC. As a Pacific day it's 6/9;
    // combined with a 6/10 event it forms a 2-run ending today.
    const events = [
      ev("floss", ct(), "2026-06-10T06:30:00.000Z"), // 6/9 23:30 PT
      ev("floss", ct(), "2026-06-10T17:00:00.000Z"), // 6/10 10:00 PT
    ];
    const index = buildDayIndex(events, PT);
    expect(computeStreaks(["floss"], flossDaily, index, events, PT, TODAY)).toEqual({ current: 2, longest: 2 });
  });

  it("a plain trackable (no goal) counts any logged day", () => {
    const events = [
      ev("walk", oz(0), "2026-06-09T17:00:00.000Z"),
      ev("walk", oz(0), "2026-06-10T17:00:00.000Z"),
    ];
    const index = buildDayIndex(events, PT);
    expect(computeStreaks(["walk"], null, index, events, PT, TODAY)).toEqual({ current: 2, longest: 2 });
  });

  it("a habit far older than the walk cap (~1100 days) still reports the current streak", () => {
    // Regression: the forward walk used to hit MAX_PERIODS before reaching today
    // for a habit whose earliest event is >1100 days back, truncating `current`
    // to 0 and `longest` along with it. With the START clamped, the recent run is
    // preserved. Earliest = 2023-01-01 (~1255 days before 2026-06-10), plus a
    // clean 3-day run ending today.
    const events = [
      ev("floss", ct(), "2023-01-01T17:00:00.000Z"), // ancient first event
      ev("floss", ct(), "2026-06-08T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-09T17:00:00.000Z"),
      ev("floss", ct(), "2026-06-10T17:00:00.000Z"),
    ];
    const index = buildDayIndex(events, PT);
    const s = computeStreaks(["floss"], flossDaily, index, events, PT, TODAY);
    expect(s.current).toBe(3);
    expect(s.longest).toBeGreaterThanOrEqual(s.current);
    expect(s.current).not.toBe(0);
  });

  it("a future-dated only event yields {current:0, longest:0}, not longest:1", () => {
    // Regression: `met` was evaluated for the first period before the
    // `cursor > today` break check, so a single future event inflated longest to 1.
    const events = [ev("floss", ct(), "2026-06-20T17:00:00.000Z")]; // 10 days after today
    const index = buildDayIndex(events, PT);
    expect(computeStreaks(["floss"], flossDaily, index, events, PT, TODAY)).toEqual({
      current: 0,
      longest: 0,
    });
  });
});

describe("computeStreaks (weekly)", () => {
  const moveWeekly: LifeGoal = {
    id: "move", label: "Move", scope: { thing: "run" },
    kind: "frequency", metric: "days", target: 2, period: "week",
  };

  it("counts consecutive MET weeks", () => {
    // Week of 5/31–6/6: run on Mon(6/1) + Wed(6/3) = 2 days → met.
    // Week of 6/7–6/13: run on Mon(6/8) + Tue(6/9) = 2 days → met.
    const events = [
      ev("run", ct(), "2026-06-01T17:00:00.000Z"),
      ev("run", ct(), "2026-06-03T17:00:00.000Z"),
      ev("run", ct(), "2026-06-08T17:00:00.000Z"),
      ev("run", ct(), "2026-06-09T17:00:00.000Z"),
    ];
    const index = buildDayIndex(events, PT);
    const s = computeStreaks(["run"], moveWeekly, index, events, PT, TODAY);
    expect(s).toEqual({ current: 2, longest: 2 });
  });

  it("an under-target week breaks the weekly streak", () => {
    // Prior week only 1 run (< target 2) → not met; current week 2 → met.
    const events = [
      ev("run", ct(), "2026-06-01T17:00:00.000Z"), // prior week: 1 day only
      ev("run", ct(), "2026-06-08T17:00:00.000Z"),
      ev("run", ct(), "2026-06-09T17:00:00.000Z"),
    ];
    const index = buildDayIndex(events, PT);
    const s = computeStreaks(["run"], moveWeekly, index, events, PT, TODAY);
    expect(s.current).toBe(1);
    expect(s.longest).toBe(1);
  });
});

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
      completedDays: 0, elapsedDays: 0, pct: 0, current: 0, longest: 0,
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
    expect(y.current).toBe(3);
    expect(y.longest).toBe(3);
  });
});
