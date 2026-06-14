import { describe, it, expect } from "vitest";
import type { LifeEvent, LifeEntry, LifeManifestTrackable, LifeGoal } from "@homelab/backend";
import { evaluateGoal } from "./goals";

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
/** A local-tz date at a given clock time, relative to a base day. */
function at(year: number, month1: number, day: number, hour = 12): Date {
  return new Date(year, month1 - 1, day, hour, 0, 0, 0);
}

const TRACKABLES: LifeManifestTrackable[] = [
  { id: "water", label: "Water", shape: "took", defaultUnit: "oz" },
  { id: "run", label: "Run", shape: "did", group: "exercise" },
  { id: "walk", label: "Walk", shape: "did", group: "exercise" },
  { id: "yoga", label: "Yoga", shape: "did", group: "exercise", hidden: true },
  { id: "floss", label: "Floss", shape: "happened" },
];

describe("evaluateGoal — metric: count (at_least, day)", () => {
  const goal: LifeGoal = { id: "floss-daily", label: "Floss", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 2, period: "day" };
  it("counts qualifying events in the day; unmet when short", () => {
    const ref = at(2026, 6, 10);
    const events = [ev("floss", num("count", 1, "ct"), at(2026, 6, 10, 8))];
    const p = evaluateGoal(goal, events, TRACKABLES, ref);
    expect(p.value).toBe(1);
    expect(p.met).toBe(false);
    expect(p.remaining).toBe(1);
  });
  it("met when count reaches target; excludes other days", () => {
    const ref = at(2026, 6, 10);
    const events = [
      ev("floss", num("count", 1, "ct"), at(2026, 6, 10, 8)),
      ev("floss", num("count", 1, "ct"), at(2026, 6, 10, 21)),
      ev("floss", num("count", 1, "ct"), at(2026, 6, 9, 8)), // prior day
    ];
    const p = evaluateGoal(goal, events, TRACKABLES, ref);
    expect(p.value).toBe(2);
    expect(p.met).toBe(true);
    expect(p.remaining).toBe(0);
  });
});

describe("evaluateGoal — metric: sum (at_least, day) name-agnostic by unit", () => {
  const goal: LifeGoal = { id: "hydrate", label: "Hydrate", scope: { thing: "water" }, kind: "at_least", metric: "sum", unit: "oz", target: 64, period: "day" };
  it("sums oz entries regardless of entry name", () => {
    const ref = at(2026, 6, 10);
    const events = [
      ev("water", num("amount", 16, "oz"), at(2026, 6, 10, 8)),
      ev("water", num("volume", 50, "oz"), at(2026, 6, 10, 14)), // legacy name
      ev("water", num("amount", 8, "ml"), at(2026, 6, 10, 18)), // wrong unit, ignored
    ];
    const p = evaluateGoal(goal, events, TRACKABLES, ref);
    expect(p.value).toBe(66);
    expect(p.met).toBe(true);
  });
});

describe("evaluateGoal — metric: days (frequency, week) + group scope", () => {
  const goal: LifeGoal = { id: "move", label: "Move", scope: { group: "exercise" }, kind: "frequency", metric: "days", target: 3, period: "week" };
  it("counts distinct days across group members in the Sun-start week", () => {
    // Week containing Wed 2026-06-10 is Sun 06-07 .. Sat 06-13.
    const ref = at(2026, 6, 10);
    const events = [
      ev("run", num("duration", 30, "min"), at(2026, 6, 8, 7)), // Mon
      ev("walk", num("duration", 20, "min"), at(2026, 6, 8, 18)), // same Mon — still 1 day
      ev("run", num("duration", 30, "min"), at(2026, 6, 10, 7)), // Wed
      ev("walk", num("duration", 20, "min"), at(2026, 6, 12, 7)), // Fri
    ];
    const p = evaluateGoal(goal, events, TRACKABLES, ref);
    expect(p.value).toBe(3); // Mon, Wed, Fri
    expect(p.met).toBe(true);
  });
  it("excludes hidden group members (yoga)", () => {
    const ref = at(2026, 6, 10);
    const events = [
      ev("yoga", num("duration", 30, "min"), at(2026, 6, 8, 7)),
      ev("yoga", num("duration", 30, "min"), at(2026, 6, 9, 7)),
    ];
    const p = evaluateGoal(goal, events, TRACKABLES, ref);
    expect(p.value).toBe(0);
  });
  it("excludes events from the adjacent week (boundary)", () => {
    const ref = at(2026, 6, 10);
    const events = [
      ev("run", num("duration", 30, "min"), at(2026, 6, 6, 7)), // Sat prior week
      ev("run", num("duration", 30, "min"), at(2026, 6, 14, 7)), // Sun next week
      ev("run", num("duration", 30, "min"), at(2026, 6, 10, 7)), // this week
    ];
    const p = evaluateGoal(goal, events, TRACKABLES, ref);
    expect(p.value).toBe(1);
  });
});

describe("evaluateGoal — kind: at_most (cap)", () => {
  const goal: LifeGoal = { id: "limit-drinks", label: "Limit drinks", scope: { thing: "water" }, kind: "at_most", metric: "sum", unit: "drinks", target: 2, period: "day" };
  it("met when at/under cap; remaining is headroom", () => {
    const ref = at(2026, 6, 10);
    const under = evaluateGoal(goal, [ev("water", num("drinks", 1, "drinks"), at(2026, 6, 10, 20))], TRACKABLES, ref);
    expect(under.met).toBe(true);
    expect(under.remaining).toBe(1); // one more allowed
  });
  it("not met (over cap); remaining clamps to 0", () => {
    const ref = at(2026, 6, 10);
    const over = evaluateGoal(goal, [
      ev("water", num("drinks", 2, "drinks"), at(2026, 6, 10, 19)),
      ev("water", num("drinks", 2, "drinks"), at(2026, 6, 10, 22)),
    ], TRACKABLES, ref);
    expect(over.value).toBe(4);
    expect(over.met).toBe(false);
    expect(over.remaining).toBe(0);
  });
});

describe("evaluateGoal — streak", () => {
  const goal: LifeGoal = { id: "floss-daily", label: "Floss", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 1, period: "day" };
  function flossOn(day: number): LifeEvent {
    return ev("floss", num("count", 1, "ct"), at(2026, 6, day, 9));
  }
  it("counts consecutive met days ending at ref", () => {
    const ref = at(2026, 6, 10);
    const events = [flossOn(10), flossOn(9), flossOn(8)];
    const p = evaluateGoal(goal, events, TRACKABLES, ref);
    expect(p.streak).toBe(3);
  });
  it("breaks the streak on a missed day", () => {
    const ref = at(2026, 6, 10);
    // 10 met, 9 met, 8 MISSED, 7 met → streak should be 2 (10, 9), not 4.
    const events = [flossOn(10), flossOn(9), flossOn(7)];
    const p = evaluateGoal(goal, events, TRACKABLES, ref);
    expect(p.streak).toBe(2);
  });
  it("streak is 0 when the current period is not met", () => {
    const ref = at(2026, 6, 10);
    const events = [flossOn(9), flossOn(8)]; // nothing today
    const p = evaluateGoal(goal, events, TRACKABLES, ref);
    expect(p.met).toBe(false);
    expect(p.streak).toBe(0);
  });
  it("weekly streak counts consecutive met weeks", () => {
    const wGoal: LifeGoal = { id: "w", label: "Weekly floss", scope: { thing: "floss" }, kind: "frequency", metric: "days", target: 1, period: "week" };
    const ref = at(2026, 6, 10); // week Sun 06-07..Sat 06-13
    // prior week = May 31..Jun 6 (06-03); week before = May 24..May 30 (05-28).
    const events = [
      flossOn(10),
      ev("floss", num("count", 1, "ct"), at(2026, 6, 3, 9)),
      ev("floss", num("count", 1, "ct"), at(2026, 5, 28, 9)),
    ];
    const p = evaluateGoal(wGoal, events, TRACKABLES, ref);
    expect(p.streak).toBe(3);
  });
  it("weekly streak breaks on a skipped week", () => {
    const wGoal: LifeGoal = { id: "w2", label: "Weekly floss", scope: { thing: "floss" }, kind: "frequency", metric: "days", target: 1, period: "week" };
    const ref = at(2026, 6, 10);
    // this week + week-before (skipping the immediately-prior week) → streak 1.
    const events = [flossOn(10), ev("floss", num("count", 1, "ct"), at(2026, 5, 28, 9))];
    const p = evaluateGoal(wGoal, events, TRACKABLES, ref);
    expect(p.streak).toBe(1);
  });
});
