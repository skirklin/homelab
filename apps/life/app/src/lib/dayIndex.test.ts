/**
 * dayIndex — one-pass tz-aware bucketing of events into local days. The key
 * correctness property is the tz boundary: an event logged in the evening
 * Pacific is the NEXT day in UTC, and it must bucket on the Pacific day so the
 * calendar agrees with the goal evaluator (which uses the same `dayKey`).
 */
import { describe, it, expect } from "vitest";
import type { LifeEvent, LifeEntry } from "@homelab/backend";
import { buildDayIndex, dayHas, daySum, dayEvents } from "./dayIndex";

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

describe("buildDayIndex", () => {
  it("buckets an evening-Pacific event onto its Pacific day, not the UTC day", () => {
    // 2026-06-10 18:00 PT === 2026-06-11 01:00 UTC. In PT this is June 10.
    const event = ev("water", num("amount", 16, "oz"), "2026-06-11T01:00:00.000Z");
    const index = buildDayIndex([event], PT);
    expect(dayHas(index, ["water"], "2026-06-10")).toBe(true);
    expect(dayHas(index, ["water"], "2026-06-11")).toBe(false);
  });

  it("sums number entries per unit within a day", () => {
    const index = buildDayIndex(
      [
        ev("water", num("amount", 16, "oz"), "2026-06-10T16:00:00.000Z"),
        ev("water", num("amount", 24, "oz"), "2026-06-10T20:00:00.000Z"),
        ev("water", num("drinks", 1, "drinks"), "2026-06-10T22:00:00.000Z"),
      ],
      PT,
    );
    expect(daySum(index, ["water"], "2026-06-10", "oz")).toBe(40);
    expect(daySum(index, ["water"], "2026-06-10", "drinks")).toBe(1);
    expect(daySum(index, ["water"], "2026-06-10", "min")).toBe(0);
  });

  it("excludes rating-unit entries from sums (they aren't quantities)", () => {
    const index = buildDayIndex(
      [ev("mood", [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }], "2026-06-10T18:00:00.000Z")],
      PT,
    );
    expect(daySum(index, ["mood"], "2026-06-10", "rating")).toBe(0);
    expect(dayHas(index, ["mood"], "2026-06-10")).toBe(true); // still "logged"
  });

  it("aggregates a group's subjects together via dayHas / daySum / dayEvents", () => {
    const index = buildDayIndex(
      [
        ev("run", num("duration", 30, "min"), "2026-06-10T15:00:00.000Z"),
        ev("walk", num("duration", 20, "min"), "2026-06-10T23:00:00.000Z"),
      ],
      PT,
    );
    const group = ["run", "walk"];
    expect(dayHas(index, group, "2026-06-10")).toBe(true);
    expect(daySum(index, group, "2026-06-10", "min")).toBe(50);
    expect(dayEvents(index, group, "2026-06-10")).toHaveLength(2);
  });

  it("dayEvents returns the day's events newest-first", () => {
    const index = buildDayIndex(
      [
        ev("water", num("amount", 8, "oz"), "2026-06-10T16:00:00.000Z"),
        ev("water", num("amount", 8, "oz"), "2026-06-10T20:00:00.000Z"),
      ],
      PT,
    );
    const list = dayEvents(index, ["water"], "2026-06-10");
    expect(list.map((e) => e.timestamp.getTime())).toEqual(
      [...list.map((e) => e.timestamp.getTime())].sort((a, b) => b - a),
    );
  });

  it("returns empty/zero for a day with nothing logged", () => {
    const index = buildDayIndex([ev("water", num("amount", 8, "oz"), "2026-06-10T18:00:00.000Z")], PT);
    expect(dayHas(index, ["water"], "2026-06-09")).toBe(false);
    expect(daySum(index, ["water"], "2026-06-09", "oz")).toBe(0);
    expect(dayEvents(index, ["water"], "2026-06-09")).toEqual([]);
  });
});
