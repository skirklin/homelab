/**
 * analysis lib — the pure heart of Insights. These tests pin the correctness
 * properties the views depend on:
 *   - dailyValue's per-shape reduction (sum / mean-rating / count)
 *   - tz-correct series bucketing (a 23:00-local event lands in the right local
 *     day AND the right local week/month, not the UTC one)
 *   - Pearson r against hand-computed fixtures (perfect +1, perfect −1, ~0)
 *   - percentile ranks (ties, single value, empty)
 *   - period-over-period deltas (abs + pct, with the divide-by-zero guard)
 */
import { describe, it, expect } from "vitest";
import type { LifeEvent, LifeEntry, LifeManifestTrackable } from "@homelab/backend";
import { dayKey } from "@homelab/backend";
import { buildDayIndex } from "./dayIndex";

const dailyKey = (d: Date) => dayKey(d, PT);
import {
  dailyValue,
  series,
  percentileScale,
  correlate,
  periodCompare,
  bucketRange,
  type SeriesPoint,
} from "./analysis";

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
const num = (name: string, value: number, unit: string, scale?: number): LifeEntry[] => [
  { name, type: "number", value, unit, ...(scale ? { scale } : {}) },
];

// First arg names the subject for readability at call sites; only the unit
// feeds the trackable arg.
const took = (_subject: string, unit: string): Pick<LifeManifestTrackable, "shape" | "defaultUnit"> => ({
  shape: "took",
  defaultUnit: unit,
});
const did: Pick<LifeManifestTrackable, "shape" | "defaultUnit"> = { shape: "did" };
const rated: Pick<LifeManifestTrackable, "shape" | "defaultUnit"> = { shape: "rated" };
const happened: Pick<LifeManifestTrackable, "shape" | "defaultUnit"> = { shape: "happened" };

describe("dailyValue", () => {
  it("took/did sum the magnitude unit (oz for took, min for did)", () => {
    const idx = buildDayIndex(
      [
        ev("water", num("amount", 16, "oz"), "2026-06-10T16:00:00Z"),
        ev("water", num("amount", 24, "oz"), "2026-06-10T20:00:00Z"),
      ],
      PT,
    );
    expect(dailyValue(took("water", "oz"), idx.get("water")!.get("2026-06-10"))).toBe(40);

    const idx2 = buildDayIndex(
      [
        ev("run", num("duration", 30, "min"), "2026-06-10T16:00:00Z"),
        ev("run", num("duration", 20, "min"), "2026-06-10T22:00:00Z"),
      ],
      PT,
    );
    expect(dailyValue(did, idx2.get("run")!.get("2026-06-10"))).toBe(50);
  });

  it("rated returns the MEAN rating that day, not the sum", () => {
    const idx = buildDayIndex(
      [
        ev("mood", num("rating", 3, "rating", 5), "2026-06-10T15:00:00Z"),
        ev("mood", num("rating", 5, "rating", 5), "2026-06-10T23:00:00Z"),
      ],
      PT,
    );
    expect(dailyValue(rated, idx.get("mood")!.get("2026-06-10"))).toBe(4);
  });

  it("happened returns the event count", () => {
    const idx = buildDayIndex(
      [
        ev("smoke", num("count", 1, "ct"), "2026-06-10T15:00:00Z"),
        ev("smoke", num("count", 1, "ct"), "2026-06-10T18:00:00Z"),
        ev("smoke", num("count", 1, "ct"), "2026-06-10T20:00:00Z"),
      ],
      PT,
    );
    expect(dailyValue(happened, idx.get("smoke")!.get("2026-06-10"))).toBe(3);
  });

  it("returns null for a day with no events", () => {
    const idx = buildDayIndex([], PT);
    expect(dailyValue(took("water", "oz"), idx.get("water")?.get("2026-06-10"))).toBeNull();
  });

  it("falls back to the dominant unit when the declared unit is absent (legacy data)", () => {
    // A took row declared in "oz" but the only logged number is "drinks".
    const idx = buildDayIndex([ev("water", num("drinks", 2, "drinks"), "2026-06-10T18:00:00Z")], PT);
    expect(dailyValue(took("water", "oz"), idx.get("water")!.get("2026-06-10"))).toBe(2);
  });
});

describe("series — tz-correct bucketing", () => {
  it("buckets a 23:00-local event onto its local day, not the UTC next-day", () => {
    // 2026-06-10 23:00 PT === 2026-06-11 06:00 UTC.
    const idx = buildDayIndex([ev("water", num("amount", 16, "oz"), "2026-06-11T06:00:00Z")], PT);
    const pts = series(idx, took("water", "oz"), ["water"], "day", new Date("2026-06-10T12:00:00Z"), new Date("2026-06-12T12:00:00Z"), PT);
    expect(pts).toEqual([{ date: "2026-06-10", value: 16 }]);
  });

  it("rolls daily magnitudes up to a week bucket by SUM", () => {
    const idx = buildDayIndex(
      [
        ev("water", num("amount", 10, "oz"), "2026-06-08T18:00:00Z"), // Mon
        ev("water", num("amount", 20, "oz"), "2026-06-10T18:00:00Z"), // Wed
      ],
      PT,
    );
    // Week of Sun 2026-06-07.
    const pts = series(idx, took("water", "oz"), ["water"], "week", new Date("2026-06-07T12:00:00Z"), new Date("2026-06-13T12:00:00Z"), PT);
    expect(pts).toEqual([{ date: "2026-06-07", value: 30 }]);
  });

  it("rolls daily ratings up to a month bucket by MEAN", () => {
    const idx = buildDayIndex(
      [
        ev("mood", num("rating", 2, "rating", 5), "2026-06-02T18:00:00Z"),
        ev("mood", num("rating", 4, "rating", 5), "2026-06-20T18:00:00Z"),
      ],
      PT,
    );
    const pts = series(idx, rated, ["mood"], "month", new Date("2026-06-01T12:00:00Z"), new Date("2026-06-30T12:00:00Z"), PT);
    expect(pts).toEqual([{ date: "2026-06", value: 3 }]);
  });

  it("combines a group's subjects per day (sum magnitudes across the group)", () => {
    const idx = buildDayIndex(
      [
        ev("run", num("duration", 30, "min"), "2026-06-10T15:00:00Z"),
        ev("walk", num("duration", 20, "min"), "2026-06-10T23:00:00Z"),
      ],
      PT,
    );
    const pts = series(idx, did, ["run", "walk"], "day", new Date("2026-06-10T12:00:00Z"), new Date("2026-06-10T20:00:00Z"), PT);
    expect(pts).toEqual([{ date: "2026-06-10", value: 50 }]);
  });

  it("omits empty buckets rather than zero-filling", () => {
    const idx = buildDayIndex([ev("water", num("amount", 8, "oz"), "2026-06-10T18:00:00Z")], PT);
    const pts = series(idx, took("water", "oz"), ["water"], "day", new Date("2026-06-08T12:00:00Z"), new Date("2026-06-12T12:00:00Z"), PT);
    expect(pts).toEqual([{ date: "2026-06-10", value: 8 }]);
  });
});

describe("percentileScale", () => {
  it("maps the max to 1 and ranks ties to the upper position", () => {
    const scale = percentileScale([10, 20, 20, 40]);
    expect(scale(40)).toBe(1); // 4/4
    expect(scale(20)).toBe(0.75); // 3/4 (both 20s ≤ 20)
    expect(scale(10)).toBe(0.25); // 1/4
    expect(scale(5)).toBe(0); // below the floor
  });

  it("a single value maps to 1", () => {
    expect(percentileScale([7])(7)).toBe(1);
  });

  it("an empty distribution is a flat 0 scale", () => {
    expect(percentileScale([])(99)).toBe(0);
  });
});

describe("correlate — Pearson r", () => {
  const s = (vals: [string, number][]): SeriesPoint[] => vals.map(([date, value]) => ({ date, value }));

  it("perfect positive linear relationship → r = 1", () => {
    const a = s([["d1", 1], ["d2", 2], ["d3", 3], ["d4", 4]]);
    const b = s([["d1", 2], ["d2", 4], ["d3", 6], ["d4", 8]]); // y = 2x
    const { r, n } = correlate(a, b);
    expect(n).toBe(4);
    expect(r).toBeCloseTo(1, 10);
  });

  it("perfect negative linear relationship → r = −1", () => {
    const a = s([["d1", 1], ["d2", 2], ["d3", 3], ["d4", 4]]);
    const b = s([["d1", 8], ["d2", 6], ["d3", 4], ["d4", 2]]); // y = 10 − 2x
    const { r } = correlate(a, b);
    expect(r).toBeCloseTo(-1, 10);
  });

  it("hand-computed mixed fixture", () => {
    // x = [1,2,3,4,5], y = [2,1,4,3,6].
    // mean x = 3, mean y = 3.2.
    // cov   = Σ(dx·dy) = (-2)(-1.2)+(-1)(-2.2)+(0)(0.8)+(1)(-0.2)+(2)(2.8)
    //       = 2.4 + 2.2 + 0 − 0.2 + 5.6 = 10
    // varX  = 4+1+0+1+4 = 10
    // varY  = 1.44+4.84+0.64+0.04+7.84 = 14.8
    // r     = 10 / sqrt(10·14.8) = 10 / 12.1655… = 0.82199…
    const a = s([["d1", 1], ["d2", 2], ["d3", 3], ["d4", 4], ["d5", 5]]);
    const b = s([["d1", 2], ["d2", 1], ["d3", 4], ["d4", 3], ["d5", 6]]);
    const { r } = correlate(a, b);
    expect(r).toBeCloseTo(0.82199, 4);
  });

  it("near-zero correlation for an uncorrelated fixture", () => {
    // Symmetric V/inverted shape with zero net covariance.
    const a = s([["d1", 1], ["d2", 2], ["d3", 3], ["d4", 4], ["d5", 5]]);
    const b = s([["d1", 3], ["d2", 1], ["d3", 5], ["d4", 1], ["d5", 3]]);
    const { r } = correlate(a, b);
    expect(Math.abs(r!)).toBeLessThan(0.001);
  });

  it("inner-joins on date — only shared days count", () => {
    const a = s([["d1", 1], ["d2", 2], ["d3", 3], ["d4", 4]]);
    const b = s([["d2", 2], ["d3", 4], ["d4", 6], ["d5", 8]]);
    const { n, points } = correlate(a, b);
    expect(n).toBe(3); // d2, d3, d4
    expect(points.map((p) => p.date)).toEqual(["d2", "d3", "d4"]);
  });

  it("guards n < 3 (r undefined)", () => {
    const a = s([["d1", 1], ["d2", 2]]);
    const b = s([["d1", 2], ["d2", 4]]);
    expect(correlate(a, b)).toMatchObject({ r: null, n: 2 });
  });

  it("a flat (zero-variance) series can't correlate → r null", () => {
    const a = s([["d1", 5], ["d2", 5], ["d3", 5]]);
    const b = s([["d1", 1], ["d2", 2], ["d3", 3]]);
    expect(correlate(a, b).r).toBeNull();
  });
});

describe("bucketRange — drill-down spans", () => {
  it("a day key spans exactly that local day", () => {
    const { from, to } = bucketRange("2026-06-10", "day", PT);
    expect(dailyKey(from)).toBe("2026-06-10");
    expect(from.getTime()).toBe(to.getTime());
  });

  it("a week key (Sunday start) spans seven local days", () => {
    const { from, to } = bucketRange("2026-06-07", "week", PT); // Sun
    expect(dailyKey(from)).toBe("2026-06-07");
    expect(dailyKey(to)).toBe("2026-06-13"); // Sat
  });

  it("a month key spans the whole month", () => {
    const { from, to } = bucketRange("2026-06", "month", PT);
    expect(dailyKey(from)).toBe("2026-06-01");
    expect(dailyKey(to)).toBe("2026-06-30");
  });

  it("handles the December → January month rollover", () => {
    const { from, to } = bucketRange("2026-12", "month", PT);
    expect(dailyKey(from)).toBe("2026-12-01");
    expect(dailyKey(to)).toBe("2026-12-31");
  });
});

describe("periodCompare", () => {
  it("computes current vs previous week with abs + pct delta", () => {
    const idx = buildDayIndex(
      [
        // Previous week (Sun 2026-06-07 … Sat 06-13): 10 oz.
        ev("water", num("amount", 10, "oz"), "2026-06-10T18:00:00Z"),
        // Current week (Sun 2026-06-14 …): 15 oz.
        ev("water", num("amount", 15, "oz"), "2026-06-16T18:00:00Z"),
      ],
      PT,
    );
    const today = new Date("2026-06-16T18:00:00Z");
    const cmp = periodCompare(idx, took("water", "oz"), ["water"], "week", PT, today);
    expect(cmp.current).toBe(15);
    expect(cmp.previous).toBe(10);
    expect(cmp.deltaAbs).toBe(5);
    expect(cmp.deltaPct).toBe(50);
  });

  it("returns null pct when the previous period was empty (no divide-by-zero)", () => {
    const idx = buildDayIndex([ev("water", num("amount", 12, "oz"), "2026-06-16T18:00:00Z")], PT);
    const cmp = periodCompare(idx, took("water", "oz"), ["water"], "week", PT, new Date("2026-06-16T18:00:00Z"));
    expect(cmp.current).toBe(12);
    expect(cmp.previous).toBe(0);
    expect(cmp.deltaPct).toBeNull();
  });

  it("compares months and averages ratings within each", () => {
    const idx = buildDayIndex(
      [
        ev("mood", num("rating", 2, "rating", 5), "2026-05-10T18:00:00Z"),
        ev("mood", num("rating", 4, "rating", 5), "2026-05-20T18:00:00Z"), // May mean 3
        ev("mood", num("rating", 5, "rating", 5), "2026-06-05T18:00:00Z"), // Jun mean 5
      ],
      PT,
    );
    const cmp = periodCompare(idx, rated, ["mood"], "month", PT, new Date("2026-06-16T18:00:00Z"));
    expect(cmp.current).toBe(5);
    expect(cmp.previous).toBe(3);
    expect(cmp.deltaAbs).toBe(2);
  });
});
