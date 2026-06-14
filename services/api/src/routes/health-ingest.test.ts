/**
 * Focused unit tests for the pure pieces of the Health Connect mapper:
 * unit conversions and the local-hour bucketing + high-water-mark guard.
 * No PB / network — these exercise the math the mapper depends on.
 */
import { describe, it, expect } from "vitest";
import { kgToLb, metersToMiles, round, bucketHourly, groupHourly, foldGroup } from "./health-ingest";

const TZ = "America/Los_Angeles"; // UTC-7 in June (PDT)

describe("conversions", () => {
  it("kg → lb (1 dp)", () => {
    expect(kgToLb(80)).toBe(176.4);
    expect(kgToLb(72.57)).toBe(160); // 159.99… → 160.0 at 1 dp
  });

  it("m → mi (2 dp)", () => {
    expect(metersToMiles(1609.344)).toBe(1);
    expect(metersToMiles(5000)).toBe(3.11);
    expect(metersToMiles(0)).toBe(0);
  });

  it("round", () => {
    expect(round(14.27, 1)).toBe(14.3);
    expect(round(123.456, 1)).toBe(123.5);
    expect(round(350.0)).toBe(350);
  });
});

describe("bucketHourly", () => {
  const stepCount = (r: Record<string, unknown>) => (typeof r.count === "number" ? r.count : null);

  it("buckets records by their local-hour-start", () => {
    // 14:00 & 14:30 UTC = 07:xx PDT (same hour); 15:30 UTC = 08:30 PDT.
    const records = [
      { count: 100, start_time: "2026-06-14T14:00:00Z", end_time: "2026-06-14T14:01:00Z" },
      { count: 250, start_time: "2026-06-14T14:30:00Z", end_time: "2026-06-14T14:31:00Z" },
      { count: 60, start_time: "2026-06-14T15:30:00Z", end_time: "2026-06-14T15:31:00Z" },
    ];
    const buckets = bucketHourly(records, TZ, stepCount);
    expect(buckets.size).toBe(2);
    expect(buckets.get("2026-06-14T07:00:00")!.sum).toBe(350);
    expect(buckets.get("2026-06-14T08:00:00")!.sum).toBe(60);
    // hwm is the max end_time in the bucket.
    expect(buckets.get("2026-06-14T07:00:00")!.hwm).toBe("2026-06-14T14:31:00.000Z");
  });

  it("skips records whose end_time is at or before sinceHwm (re-post guard)", () => {
    const records = [
      { count: 100, start_time: "2026-06-14T14:00:00Z", end_time: "2026-06-14T14:01:00Z" },
      { count: 250, start_time: "2026-06-14T14:30:00Z", end_time: "2026-06-14T14:31:00Z" },
    ];
    // Stored hwm already covers the first record → only the second is folded in.
    const buckets = bucketHourly(records, TZ, stepCount, "2026-06-14T14:01:00Z");
    expect(buckets.size).toBe(1);
    expect(buckets.get("2026-06-14T07:00:00")!.sum).toBe(250);
    expect(buckets.get("2026-06-14T07:00:00")!.hwm).toBe("2026-06-14T14:31:00.000Z");
  });

  it("returns an empty map when every record is already counted", () => {
    const records = [
      { count: 100, start_time: "2026-06-14T14:00:00Z", end_time: "2026-06-14T14:01:00Z" },
    ];
    const buckets = bucketHourly(records, TZ, stepCount, "2026-06-14T14:01:00Z");
    expect(buckets.size).toBe(0);
  });

  it("normalizes mixed ISO formats so the hwm compare is order-safe", () => {
    const records = [
      // Stored hwm below is "...14:01:00Z"; this record ends at the same instant
      // but written as "+00:00" — must still be recognized as already-counted.
      { count: 100, start_time: "2026-06-14T14:00:00+00:00", end_time: "2026-06-14T14:01:00+00:00" },
      // This one ends later (with millis) → folded in.
      { count: 250, start_time: "2026-06-14T14:30:00Z", end_time: "2026-06-14T14:31:00.000Z" },
    ];
    const buckets = bucketHourly(records, TZ, stepCount, "2026-06-14T14:01:00Z");
    expect(buckets.get("2026-06-14T07:00:00")!.sum).toBe(250);
  });

  it("drops records with non-finite values (NaN/Infinity)", () => {
    const records = [
      { count: Number.NaN, start_time: "2026-06-14T14:00:00Z", end_time: "2026-06-14T14:01:00Z" },
      { count: Infinity, start_time: "2026-06-14T14:02:00Z", end_time: "2026-06-14T14:03:00Z" },
      { count: 5, start_time: "2026-06-14T14:04:00Z", end_time: "2026-06-14T14:05:00Z" },
    ];
    const buckets = bucketHourly(records, TZ, stepCount);
    expect(buckets.get("2026-06-14T07:00:00")!.sum).toBe(5);
  });

  it("skips records with no value or no start_time", () => {
    const records = [
      { count: 100, start_time: "2026-06-14T14:00:00Z", end_time: "2026-06-14T14:01:00Z" },
      { start_time: "2026-06-14T14:05:00Z", end_time: "2026-06-14T14:06:00Z" }, // no count
      { count: 50 }, // no start_time
    ];
    const buckets = bucketHourly(records, TZ, stepCount);
    expect(buckets.size).toBe(1);
    expect(buckets.get("2026-06-14T07:00:00")!.sum).toBe(100);
  });

  it("skips records whose start_time is unparseable (never reaches formatInTimeZone)", () => {
    const records = [
      { count: 100, start_time: "not-a-date", end_time: "2026-06-14T14:01:00Z" },
      { count: 5, start_time: "2026-06-14T14:04:00Z", end_time: "2026-06-14T14:05:00Z" },
    ];
    const buckets = bucketHourly(records, TZ, stepCount);
    expect(buckets.size).toBe(1);
    expect(buckets.get("2026-06-14T07:00:00")!.sum).toBe(5);
  });
});

describe("groupHourly + foldGroup (single-pass aggregation)", () => {
  const stepCount = (r: Record<string, unknown>) => (typeof r.count === "number" ? r.count : null);

  it("groups by local hour once and folds the full sum (sinceHwm='')", () => {
    const records = [
      { count: 100, start_time: "2026-06-14T14:00:00Z", end_time: "2026-06-14T14:01:00Z" },
      { count: 250, start_time: "2026-06-14T14:30:00Z", end_time: "2026-06-14T14:31:00Z" },
      { count: 60, start_time: "2026-06-14T15:30:00Z", end_time: "2026-06-14T15:31:00Z" },
    ];
    const { groups, skipped } = groupHourly(records, TZ, stepCount);
    expect(skipped).toBe(0);
    expect(groups.size).toBe(2);
    const seven = foldGroup(groups.get("2026-06-14T07:00:00")!);
    expect(seven.sum).toBe(350);
    expect(seven.hwm).toBe("2026-06-14T14:31:00.000Z");
    expect(foldGroup(groups.get("2026-06-14T08:00:00")!).sum).toBe(60);
  });

  it("foldGroup counts only records strictly past sinceHwm (the conflict-fold path)", () => {
    const records = [
      { count: 100, start_time: "2026-06-14T14:00:00Z", end_time: "2026-06-14T14:01:00Z" },
      { count: 250, start_time: "2026-06-14T14:30:00Z", end_time: "2026-06-14T14:31:00Z" },
    ];
    const { groups } = groupHourly(records, TZ, stepCount);
    const group = groups.get("2026-06-14T07:00:00")!;
    // Stored hwm already covers the first record → only the second folds in.
    const delta = foldGroup(group, "2026-06-14T14:01:00Z");
    expect(delta.sum).toBe(250);
    expect(delta.hwm).toBe("2026-06-14T14:31:00.000Z");
    // Everything already counted → empty delta, hwm unchanged (skip signal).
    const none = foldGroup(group, "2026-06-14T14:31:00.000Z");
    expect(none.sum).toBe(0);
    expect(none.hwm).toBe("2026-06-14T14:31:00.000Z");
  });

  it("counts unparseable start_time/end_time as skipped (not a 500)", () => {
    const records = [
      { count: 100, start_time: "not-a-date", end_time: "2026-06-14T14:01:00Z" },
      { count: 200, start_time: "2026-06-14T14:00:00Z", end_time: "garbage" },
      { count: 5, start_time: "2026-06-14T14:04:00Z", end_time: "2026-06-14T14:05:00Z" },
    ];
    const { groups, skipped } = groupHourly(records, TZ, stepCount);
    expect(skipped).toBe(2); // both malformed records counted
    expect(groups.size).toBe(1);
    expect(foldGroup(groups.get("2026-06-14T07:00:00")!).sum).toBe(5);
  });

  it("drops no-value / no-start records silently (not counted as malformed)", () => {
    const records = [
      { count: 100, start_time: "2026-06-14T14:00:00Z", end_time: "2026-06-14T14:01:00Z" },
      { start_time: "2026-06-14T14:05:00Z", end_time: "2026-06-14T14:06:00Z" }, // no count
      { count: 50 }, // no start_time
    ];
    const { groups, skipped } = groupHourly(records, TZ, stepCount);
    expect(skipped).toBe(0);
    expect(groups.size).toBe(1);
    expect(foldGroup(groups.get("2026-06-14T07:00:00")!).sum).toBe(100);
  });
});
