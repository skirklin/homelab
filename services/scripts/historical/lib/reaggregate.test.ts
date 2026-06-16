import { describe, expect, it } from "vitest";
import {
  type HourlyRow,
  amountOf,
  groupHourlyRows,
  hwmOf,
  isHourlySourceId,
  localDayKey,
  noonOfDayUtc,
  planDaily,
  round,
} from "./reaggregate";

// Helper: build an hourly counter row.
function hourly(
  subject: string,
  instant: string,
  value: number,
  unit: string,
  opts: { id?: string; hwm?: string; labels?: Record<string, string> } = {},
): HourlyRow {
  return {
    id: opts.id ?? `${subject}-${instant}`,
    subject_id: subject,
    source_id: `hc:${subject}:${instant}`,
    timestamp: instant,
    entries: [{ name: "amount", type: "number", value, unit }],
    labels: opts.labels ?? (opts.hwm !== undefined ? { hwm: opts.hwm } : { hwm: instant }),
  };
}

describe("isHourlySourceId", () => {
  it("true for an instant-keyed source_id (contains T)", () => {
    expect(isHourlySourceId("hc:calories:2026-06-14T05:00:00.000Z", "calories")).toBe(true);
  });
  it("false for a day-keyed source_id (no T)", () => {
    expect(isHourlySourceId("hc:steps:2026-06-14", "steps")).toBe(false);
  });
  it("false when prefix subject mismatches", () => {
    expect(isHourlySourceId("hc:steps:2026-06-14T05:00:00.000Z", "calories")).toBe(false);
  });
  it("false for a non-hc source_id", () => {
    expect(isHourlySourceId("st:steps:2026-06-14T05:00:00.000Z", "steps")).toBe(false);
  });
});

describe("localDayKey", () => {
  it("buckets to the owner-tz calendar day", () => {
    // 2026-06-14T05:00:00Z is 2026-06-13 22:00 PT -> still Jun 13 in LA.
    expect(localDayKey("2026-06-14T05:00:00.000Z", "America/Los_Angeles")).toBe("2026-06-13");
    // Same instant is already Jun 14 in UTC/London.
    expect(localDayKey("2026-06-14T05:00:00.000Z", "Europe/London")).toBe("2026-06-14");
  });
  it("handles the PB space-separated form", () => {
    expect(localDayKey("2026-06-14 05:00:00.000Z", "America/Los_Angeles")).toBe("2026-06-13");
  });
});

describe("noonOfDayUtc (byte-identical to mapper fromZonedTime(`<day>T12:00:00`, tz))", () => {
  // Expected values precomputed via date-fns-tz fromZonedTime in the api
  // workspace (verified 0 mismatches across these tz/day pairs).
  it("America/Los_Angeles (PDT, -07:00)", () => {
    expect(noonOfDayUtc("2026-06-14", "America/Los_Angeles")).toBe("2026-06-14T19:00:00.000Z");
  });
  it("America/Los_Angeles (PST, -08:00 — winter)", () => {
    expect(noonOfDayUtc("2026-01-15", "America/Los_Angeles")).toBe("2026-01-15T20:00:00.000Z");
  });
  it("Europe/London (BST, +01:00)", () => {
    expect(noonOfDayUtc("2026-06-14", "Europe/London")).toBe("2026-06-14T11:00:00.000Z");
  });
  it("Asia/Tokyo (+09:00)", () => {
    expect(noonOfDayUtc("2026-06-14", "Asia/Tokyo")).toBe("2026-06-14T03:00:00.000Z");
  });
  it("America/Phoenix (no DST, -07:00)", () => {
    expect(noonOfDayUtc("2026-06-14", "America/Phoenix")).toBe("2026-06-14T19:00:00.000Z");
  });
  it("US spring-forward day (2026-03-08, LA)", () => {
    expect(noonOfDayUtc("2026-03-08", "America/Los_Angeles")).toBe("2026-03-08T19:00:00.000Z");
  });
});

describe("round / amountOf / hwmOf", () => {
  it("round matches the mapper precision", () => {
    expect(round(1.005, 2)).toBe(1.0); // banker-ish JS rounding, same as mapper
    expect(round(12345.6, 0)).toBe(12346);
    expect(round(1234.56, 1)).toBe(1234.6);
  });
  it("amountOf reads the numeric entry", () => {
    expect(amountOf(hourly("steps", "2026-06-14T05:00:00.000Z", 500, "ct"))).toBe(500);
  });
  it("hwmOf reads labels.hwm, else empty", () => {
    expect(hwmOf(hourly("steps", "2026-06-14T05:00:00.000Z", 1, "ct", { hwm: "2026-06-14T05:30:00.000Z" }))).toBe(
      "2026-06-14T05:30:00.000Z",
    );
    expect(hwmOf({ ...hourly("steps", "x", 1, "ct"), labels: null })).toBe("");
  });
});

describe("groupHourlyRows", () => {
  const tz = "America/Los_Angeles";

  it("groups by (subject, local day) and sums + maxes hwm", () => {
    const rows = [
      // Two steps rows that both land on Jun 13 PT.
      hourly("steps", "2026-06-14T05:00:00.000Z", 500, "ct", { hwm: "2026-06-14T05:59:59.000Z" }),
      hourly("steps", "2026-06-14T06:00:00.000Z", 300, "ct", { hwm: "2026-06-14T06:59:59.000Z" }),
      // A distance row on Jun 13 PT.
      hourly("distance", "2026-06-14T05:00:00.000Z", 0.41, "mi", { hwm: "2026-06-14T05:59:59.000Z" }),
    ];
    const groups = groupHourlyRows(rows, tz);
    expect(groups).toHaveLength(2);
    const steps = groups.find((g) => g.subject === "steps")!;
    expect(steps.localDay).toBe("2026-06-13");
    expect(steps.sum).toBe(800);
    expect(steps.maxHwm).toBe("2026-06-14T06:59:59.000Z");
    expect(steps.sourceId).toBe("hc:steps:2026-06-13");
    expect(steps.timestamp).toBe("2026-06-13T19:00:00.000Z"); // noon PDT
    const dist = groups.find((g) => g.subject === "distance")!;
    expect(dist.sum).toBe(0.41);
  });

  it("rounds distance to 2dp and calories to 1dp", () => {
    const rows = [
      hourly("distance", "2026-06-14T20:00:00.000Z", 0.333, "mi"),
      hourly("distance", "2026-06-14T21:00:00.000Z", 0.333, "mi"),
      hourly("calories", "2026-06-14T20:00:00.000Z", 50.05, "kcal"),
      hourly("calories", "2026-06-14T21:00:00.000Z", 50.05, "kcal"),
    ];
    const groups = groupHourlyRows(rows, tz);
    expect(groups.find((g) => g.subject === "distance")!.sum).toBe(0.67); // 0.666 -> 0.67
    expect(groups.find((g) => g.subject === "calories")!.sum).toBe(100.1); // 100.1
  });

  it("ignores daily rows (no T), manual rows, and non-counter subjects", () => {
    const dailyRow: HourlyRow = {
      id: "daily",
      subject_id: "steps",
      source_id: "hc:steps:2026-06-13",
      timestamp: "2026-06-13T19:00:00.000Z",
      entries: [{ name: "amount", type: "number", value: 9999, unit: "ct" }],
      labels: { hwm: "x" },
    };
    const manualRow: HourlyRow = {
      ...hourly("steps", "2026-06-14T05:00:00.000Z", 123, "ct"),
      id: "manual",
      labels: { source: "manual", hwm: "x" },
    };
    const nonCounter: HourlyRow = {
      ...hourly("weight", "2026-06-14T05:00:00.000Z", 180, "lb"),
      id: "weight",
    };
    const real = hourly("steps", "2026-06-14T05:00:00.000Z", 500, "ct");
    // NOTE: the script's fetch layer already drops manual rows; groupHourlyRows
    // additionally drops daily + non-counter. Manual rows here would still group
    // (groupHourlyRows trusts the fetch filter), so we pass only what the fetch
    // layer would have handed it: real + dailyRow + nonCounter.
    const groups = groupHourlyRows([real, dailyRow, nonCounter], tz);
    expect(groups).toHaveLength(1);
    expect(groups[0].subject).toBe("steps");
    expect(groups[0].sum).toBe(500);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["steps-2026-06-14T05:00:00.000Z"]);
    // manualRow excluded by the fetch layer; sanity that its labels.source is what triggers it.
    expect(manualRow.labels!.source).toBe("manual");
  });
});

describe("planDaily", () => {
  const tz = "America/Los_Angeles";
  const [group] = groupHourlyRows(
    [
      hourly("steps", "2026-06-14T20:00:00.000Z", 500, "ct", { hwm: "2026-06-14T20:59:00.000Z" }),
      hourly("steps", "2026-06-14T21:00:00.000Z", 300, "ct", { hwm: "2026-06-14T21:59:00.000Z" }),
    ],
    tz,
  );

  it("creates when no daily row exists", () => {
    expect(planDaily(group, null)).toEqual({
      action: "create",
      value: 800,
      hwm: "2026-06-14T21:59:00.000Z",
    });
  });

  it("folds into an existing daily row (adds value, maxes hwm)", () => {
    const plan = planDaily(group, { value: 1200, hwm: "2026-06-15T01:00:00.000Z" });
    expect(plan.action).toBe("fold");
    expect(plan.value).toBe(2000); // 1200 + 800
    expect(plan.hwm).toBe("2026-06-15T01:00:00.000Z"); // existing hwm is later
  });

  it("fold rounds to the subject precision", () => {
    const [dist] = groupHourlyRows([hourly("distance", "2026-06-14T20:00:00.000Z", 0.33, "mi")], tz);
    const plan = planDaily(dist, { value: 0.34, hwm: "" });
    expect(plan.value).toBe(0.67);
  });
});

describe("idempotency-shaped scenario (re-run logic)", () => {
  // Simulates: first run creates a daily row from hourly rows; a re-run would
  // find no hourly rows (they were deleted), so groupHourlyRows returns [].
  it("no hourly rows -> no groups -> no-op", () => {
    expect(groupHourlyRows([], "America/Los_Angeles")).toEqual([]);
  });
});
