import { describe, expect, it } from "vitest";
import {
  type Entry,
  type EventRow,
  extractRating,
  localDayKey,
  planCategorySplit,
  planSleepMerge,
  safeTz,
  sleepDurationMinutes,
  slugifyCategory,
} from "./life-rewrite";

const LA = "America/Los_Angeles";

function ev(partial: Partial<EventRow> & { id: string }): EventRow {
  return {
    subject_id: "sleep",
    timestamp: "2026-03-04 08:00:00.000Z",
    entries: [],
    labels: null,
    ...partial,
  };
}

function sleep(id: string, timestamp: string, minutes?: number, extra: Entry[] = []): EventRow {
  return ev({
    id,
    subject_id: "sleep",
    timestamp,
    entries: [
      ...(minutes !== undefined ? [{ name: "duration", type: "number", value: minutes, unit: "min" } as Entry] : []),
      ...extra,
    ],
  });
}

function quality(id: string, timestamp: string, rating: number, extra: Entry[] = []): EventRow {
  return ev({
    id,
    subject_id: "sleep_quality",
    timestamp,
    entries: [{ name: "rating", type: "number", value: rating, unit: "rating", scale: 5 }, ...extra],
  });
}

// ---------------------------------------------------------------------------
// Day bucketing
// ---------------------------------------------------------------------------

describe("localDayKey", () => {
  it("buckets by the LA calendar day, not UTC (winter, UTC-8)", () => {
    expect(localDayKey("2026-01-15 07:59:00.000Z", LA)).toBe("2026-01-14");
    expect(localDayKey("2026-01-15 08:01:00.000Z", LA)).toBe("2026-01-15");
  });

  it("handles DST (summer, UTC-7)", () => {
    expect(localDayKey("2026-07-15 06:59:00.000Z", LA)).toBe("2026-07-14");
    expect(localDayKey("2026-07-15 07:01:00.000Z", LA)).toBe("2026-07-15");
  });

  it("accepts ISO 'T' timestamps too", () => {
    expect(localDayKey("2026-01-15T08:01:00.000Z", LA)).toBe("2026-01-15");
  });

  it("respects other timezones", () => {
    expect(localDayKey("2026-01-15 23:30:00.000Z", "Europe/Berlin")).toBe("2026-01-16");
  });

  it("throws on garbage", () => {
    expect(() => localDayKey("not a date", LA)).toThrow(/Unparseable/);
  });
});

describe("safeTz", () => {
  it("passes valid IANA strings through", () => {
    expect(safeTz("Europe/Berlin")).toBe("Europe/Berlin");
  });
  it("falls back on garbage / missing", () => {
    expect(safeTz("Not/AZone")).toBe(LA);
    expect(safeTz(undefined)).toBe(LA);
    expect(safeTz("")).toBe(LA);
    expect(safeTz(42)).toBe(LA);
  });
});

// ---------------------------------------------------------------------------
// Script 1 helpers
// ---------------------------------------------------------------------------

describe("sleepDurationMinutes", () => {
  it("reads the duration entry", () => {
    expect(sleepDurationMinutes(sleep("a", "2026-03-04 08:00:00.000Z", 432))).toBe(432);
  });
  it("falls back to end_time - timestamp", () => {
    const e = ev({ id: "a", timestamp: "2026-03-04 06:00:00.000Z", end_time: "2026-03-04 07:30:00.000Z" });
    expect(sleepDurationMinutes(e)).toBe(90);
  });
  it("returns 0 with neither", () => {
    expect(sleepDurationMinutes(ev({ id: "a" }))).toBe(0);
  });
});

describe("extractRating", () => {
  it("prefers the entry named rating", () => {
    expect(extractRating(quality("q", "2026-03-04 08:00:00.000Z", 4))).toBe(4);
  });
  it("falls back to a single numeric entry", () => {
    const e = ev({ id: "q", entries: [{ name: "value", type: "number", value: 3 }] });
    expect(extractRating(e)).toBe(3);
  });
  it("refuses ambiguous events (two numerics, none named rating)", () => {
    const e = ev({
      id: "q",
      entries: [
        { name: "a", type: "number", value: 3 },
        { name: "b", type: "number", value: 4 },
      ],
    });
    expect(extractRating(e)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Script 1 planner
// ---------------------------------------------------------------------------

describe("planSleepMerge", () => {
  it("attaches the rating to the day's only sleep event", () => {
    const s = sleep("s1", "2026-03-04 14:00:00.000Z", 432);
    const q = quality("q1", "2026-03-04 16:00:00.000Z", 4);
    const [a] = planSleepMerge([s, q], LA);
    expect(a).toMatchObject({ kind: "attach", sleepId: "s1", qualityId: "q1", rating: 4, day: "2026-03-04" });
    if (a.kind !== "attach") throw new Error("unreachable");
    expect(a.newEntries).toEqual([
      { name: "duration", type: "number", value: 432, unit: "min" },
      { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
    ]);
  });

  it("picks the longest sleep when there are naps", () => {
    const nap = sleep("nap", "2026-03-04 21:00:00.000Z", 45);
    const night = sleep("night", "2026-03-04 14:00:00.000Z", 410);
    const q = quality("q1", "2026-03-04 16:00:00.000Z", 5);
    const actions = planSleepMerge([nap, night, q], LA);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "attach", sleepId: "night" });
  });

  it("uses end_time spans when ranking duration", () => {
    const nap = sleep("nap", "2026-03-04 21:00:00.000Z", 60);
    const night = ev({
      id: "night",
      subject_id: "sleep",
      timestamp: "2026-03-04 13:00:00.000Z",
      end_time: "2026-03-04 20:00:00.000Z", // 420 min
    });
    const q = quality("q1", "2026-03-04 16:00:00.000Z", 3);
    expect(planSleepMerge([nap, night, q], LA)[0]).toMatchObject({ kind: "attach", sleepId: "night" });
  });

  it("conflicts instead of overwriting an existing rating", () => {
    const s = sleep("s1", "2026-03-04 14:00:00.000Z", 432, [
      { name: "rating", type: "number", value: 2, unit: "rating", scale: 5 },
    ]);
    const q = quality("q1", "2026-03-04 16:00:00.000Z", 4);
    expect(planSleepMerge([s, q], LA)[0]).toMatchObject({ kind: "conflict", qualityId: "q1", sleepId: "s1" });
  });

  it("plans delete-only when the target already carries the identical rating (interrupted run)", () => {
    const s = sleep("s1", "2026-03-04 14:00:00.000Z", 432, [
      { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
    ]);
    const q = quality("q1", "2026-03-04 16:00:00.000Z", 4);
    expect(planSleepMerge([s, q], LA)[0]).toMatchObject({ kind: "delete-only", qualityId: "q1", sleepId: "s1" });
  });

  it("creates a sleep event when the day has none", () => {
    const q = quality("q1", "2026-03-04 16:00:00.000Z", 3);
    const [a] = planSleepMerge([q], LA);
    expect(a).toMatchObject({ kind: "create", qualityId: "q1", rating: 3 });
    if (a.kind !== "create") throw new Error("unreachable");
    expect(a.event.timestamp).toBe("2026-03-04 16:00:00.000Z");
    expect(a.event.entries).toEqual([{ name: "rating", type: "number", value: 3, unit: "rating", scale: 5 }]);
    expect(a.event.entries.some((e) => e.name === "duration")).toBe(false);
  });

  it("a second same-day quality conflicts (against an attach or a planned create)", () => {
    // Against a real sleep:
    const s = sleep("s1", "2026-03-04 14:00:00.000Z", 432);
    const q1 = quality("q1", "2026-03-04 16:00:00.000Z", 4);
    const q2 = quality("q2", "2026-03-04 17:00:00.000Z", 2);
    const withSleep = planSleepMerge([s, q1, q2], LA);
    expect(withSleep.map((a) => a.kind)).toEqual(["attach", "conflict"]);
    // Against a planned create (no sleep at all):
    const created = planSleepMerge([q1, q2], LA);
    expect(created.map((a) => a.kind)).toEqual(["create", "conflict"]);
  });

  it("does not mix days: quality attaches only to same-local-day sleep", () => {
    // 06:00Z = 22:00 LA on Mar 3; 17:00Z = 09:00 LA on Mar 4.
    const s = sleep("s1", "2026-03-04 06:00:00.000Z", 432);
    const q = quality("q1", "2026-03-04 17:00:00.000Z", 4);
    const actions = planSleepMerge([s, q], LA);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "create", day: "2026-03-04" });
  });

  it("carries non-rating entries (notes) from the quality event", () => {
    const s = sleep("s1", "2026-03-04 14:00:00.000Z", 432);
    const q = quality("q1", "2026-03-04 16:00:00.000Z", 4, [{ name: "notes", type: "text", value: "restless" }]);
    const [a] = planSleepMerge([s, q], LA);
    if (a.kind !== "attach") throw new Error(`expected attach, got ${a.kind}`);
    expect(a.carried).toEqual(["notes"]);
    expect(a.newEntries).toContainEqual({ name: "notes", type: "text", value: "restless" });
  });

  it("conflicts when a carried entry name collides with one on the sleep event", () => {
    const s = sleep("s1", "2026-03-04 14:00:00.000Z", 432, [{ name: "notes", type: "text", value: "own notes" }]);
    const q = quality("q1", "2026-03-04 16:00:00.000Z", 4, [{ name: "notes", type: "text", value: "other notes" }]);
    expect(planSleepMerge([s, q], LA)[0]).toMatchObject({ kind: "conflict" });
  });

  it("skips quality events with no numeric rating", () => {
    const q = ev({
      id: "q1",
      subject_id: "sleep_quality",
      timestamp: "2026-03-04 16:00:00.000Z",
      entries: [{ name: "notes", type: "text", value: "??" }],
    });
    expect(planSleepMerge([q], LA)[0]).toMatchObject({ kind: "skip", qualityId: "q1" });
  });

  it("ignores unrelated subjects and days without qualities", () => {
    const s = sleep("s1", "2026-03-04 14:00:00.000Z", 432);
    const other = ev({ id: "x", subject_id: "mood", timestamp: "2026-03-04 16:00:00.000Z" });
    expect(planSleepMerge([s, other], LA)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Script 2
// ---------------------------------------------------------------------------

describe("slugifyCategory", () => {
  it("lowercases and dashes spaces", () => {
    expect(slugifyCategory("PT")).toBe("pt");
    expect(slugifyCategory("trip planning")).toBe("trip-planning");
  });
  it("trims and collapses whitespace runs", () => {
    expect(slugifyCategory(" Trail  Running ")).toBe("trail-running");
  });
});

describe("planCategorySplit", () => {
  const base = (overrides: Partial<EventRow>): EventRow =>
    ev({ id: "e1", subject_id: "exercise", timestamp: "2026-03-04 16:00:00.000Z", ...overrides });

  it("rewrites subject from labels.category, renames intensity, drops the category label", () => {
    const e = base({
      entries: [
        { name: "duration", type: "number", value: 30, unit: "min" },
        { name: "intensity", type: "number", value: 4, unit: "rating", scale: 5 },
      ],
      labels: { category: "PT", source: "manual" },
    });
    const a = planCategorySplit(e);
    expect(a).toMatchObject({ kind: "rewrite", newSubjectId: "pt", renamedIntensity: true });
    if (a.kind !== "rewrite") throw new Error("unreachable");
    expect(a.entries).toEqual([
      { name: "duration", type: "number", value: 30, unit: "min" },
      { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
    ]);
    expect(a.labels).toEqual({ source: "manual" }); // category gone, others kept
  });

  it("slugs multi-word categories", () => {
    const a = planCategorySplit(base({ subject_id: "focus", labels: { category: "trip planning" } }));
    expect(a).toMatchObject({ kind: "rewrite", oldSubjectId: "focus", newSubjectId: "trip-planning" });
  });

  it("nulls labels when category was the only key", () => {
    const a = planCategorySplit(base({ labels: { category: "PT" } }));
    if (a.kind !== "rewrite") throw new Error("unreachable");
    expect(a.labels).toBeNull();
  });

  it("leaves events without labels.category untouched", () => {
    expect(planCategorySplit(base({ labels: { source: "manual" } }))).toMatchObject({ kind: "missing-category" });
    expect(planCategorySplit(base({ labels: null }))).toMatchObject({ kind: "missing-category" });
    expect(planCategorySplit(base({ labels: { category: "   " } }))).toMatchObject({ kind: "missing-category" });
  });

  it("works without an intensity entry (no rename)", () => {
    const a = planCategorySplit(
      base({ entries: [{ name: "duration", type: "number", value: 25, unit: "min" }], labels: { category: "Reading" } }),
    );
    expect(a).toMatchObject({ kind: "rewrite", newSubjectId: "reading", renamedIntensity: false });
  });

  it("conflicts when both intensity and rating entries exist", () => {
    const a = planCategorySplit(
      base({
        entries: [
          { name: "intensity", type: "number", value: 4 },
          { name: "rating", type: "number", value: 5 },
        ],
        labels: { category: "PT" },
      }),
    );
    expect(a).toMatchObject({ kind: "conflict" });
  });
});
