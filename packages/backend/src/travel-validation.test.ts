import { describe, it, expect } from "vitest";
import {
  validateDay,
  parseTimeOfDay,
  type ValidationActivity,
  type ValidationSlot,
} from "./travel-validation";

function mkActivity(
  id: string,
  overrides: Partial<ValidationActivity> = {},
): ValidationActivity {
  return {
    id,
    name: `Activity ${id}`,
    lat: null,
    lng: null,
    durationEstimate: "",
    ...overrides,
  };
}

function mkMap(...activities: ValidationActivity[]): Map<string, ValidationActivity> {
  return new Map(activities.map((a) => [a.id, a]));
}

describe("parseTimeOfDay", () => {
  it("parses HH:mm into minutes from midnight", () => {
    expect(parseTimeOfDay("09:00")).toBe(540);
    expect(parseTimeOfDay("13:45")).toBe(13 * 60 + 45);
    expect(parseTimeOfDay("0:05")).toBe(5);
  });

  it("returns null for missing or bad input", () => {
    expect(parseTimeOfDay(undefined)).toBe(null);
    expect(parseTimeOfDay("")).toBe(null);
    expect(parseTimeOfDay("gibberish")).toBe(null);
    expect(parseTimeOfDay("25:00")).toBe(null);
    expect(parseTimeOfDay("12:70")).toBe(null);
  });

  it("parses 12-hour meridiem formats (production uses this)", () => {
    expect(parseTimeOfDay("8:00 AM")).toBe(8 * 60);
    expect(parseTimeOfDay("1:00 PM")).toBe(13 * 60);
    expect(parseTimeOfDay("12:00 PM")).toBe(12 * 60); // noon
    expect(parseTimeOfDay("12:00 AM")).toBe(0); // midnight
    expect(parseTimeOfDay("12:30am")).toBe(30);
    expect(parseTimeOfDay("11:59 PM")).toBe(23 * 60 + 59);
    expect(parseTimeOfDay("9 AM")).toBe(9 * 60); // no minutes
  });

  it("rejects invalid 12-hour values", () => {
    expect(parseTimeOfDay("13:00 PM")).toBe(null);
    expect(parseTimeOfDay("0:00 AM")).toBe(null);
    expect(parseTimeOfDay("8:70 AM")).toBe(null);
  });
});

describe("validateDay", () => {
  it("returns no issues when slots have no start times", () => {
    const slots: ValidationSlot[] = [
      { activityId: "a" },
      { activityId: "b" },
    ];
    const map = mkMap(
      mkActivity("a", { durationEstimate: "2h" }),
      mkActivity("b", { durationEstimate: "1h" }),
    );
    expect(validateDay(slots, map)).toEqual([]);
  });

  it("flags overlapping activities", () => {
    const slots: ValidationSlot[] = [
      { activityId: "a", startTime: "09:00" },
      { activityId: "b", startTime: "10:00" },
    ];
    const map = mkMap(
      mkActivity("a", { name: "Museum", durationEstimate: "2h" }),    // 09:00–11:00
      mkActivity("b", { name: "Lunch", durationEstimate: "1h" }),     // 10:00–11:00
    );
    const issues = validateDay(slots, map);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("overlap");
    expect(issues[0].message).toContain("Museum");
    expect(issues[0].message).toContain("Lunch");
    expect(issues[0].slotIndices).toEqual([0, 1]);
  });

  it("does not flag activities that touch but don't overlap", () => {
    const slots: ValidationSlot[] = [
      { activityId: "a", startTime: "09:00" },
      { activityId: "b", startTime: "11:00" },
    ];
    const map = mkMap(
      mkActivity("a", { durationEstimate: "2h" }), // ends 11:00
      mkActivity("b", { durationEstimate: "1h" }), // starts 11:00
    );
    expect(validateDay(slots, map)).toEqual([]);
  });

  it("skips overlap check when duration is zero/unparseable", () => {
    const slots: ValidationSlot[] = [
      { activityId: "a", startTime: "09:00" },
      { activityId: "b", startTime: "09:30" },
    ];
    const map = mkMap(
      mkActivity("a", { durationEstimate: "" }),
      mkActivity("b", { durationEstimate: "gibberish" }),
    );
    expect(validateDay(slots, map).filter((i) => i.kind === "overlap")).toEqual([]);
  });

  it("flags out-of-order slots", () => {
    const slots: ValidationSlot[] = [
      { activityId: "a", startTime: "14:00" },
      { activityId: "b", startTime: "10:00" },
    ];
    const map = mkMap(
      mkActivity("a", { name: "Afternoon", durationEstimate: "1h" }),
      mkActivity("b", { name: "Morning", durationEstimate: "1h" }),
    );
    const issues = validateDay(slots, map);
    const ooo = issues.find((i) => i.kind === "out-of-order");
    expect(ooo).toBeTruthy();
    expect(ooo!.message).toContain("Morning");
    expect(ooo!.message).toContain("Afternoon");
  });

  it("flags drive-gap when travel exceeds scheduled gap", () => {
    // NYC -> Philly is ~80 miles (~2.6h at 30mph). 30-min gap isn't enough.
    const slots: ValidationSlot[] = [
      { activityId: "a", startTime: "09:00" },
      { activityId: "b", startTime: "11:30" },
    ];
    const map = mkMap(
      mkActivity("a", { name: "NYC Morning", durationEstimate: "2h", lat: 40.7128, lng: -74.006 }),
      mkActivity("b", { name: "Philly Lunch", durationEstimate: "1h", lat: 39.9526, lng: -75.1652 }),
    );
    const issues = validateDay(slots, map);
    const gap = issues.find((i) => i.kind === "drive-gap");
    expect(gap).toBeTruthy();
    expect(gap!.message).toContain("NYC Morning");
    expect(gap!.message).toContain("Philly Lunch");
  });

  it("does not flag drive-gap when scheduled gap is enough", () => {
    const slots: ValidationSlot[] = [
      { activityId: "a", startTime: "09:00" },
      { activityId: "b", startTime: "15:00" }, // 4h gap, plenty for 80mi
    ];
    const map = mkMap(
      mkActivity("a", { durationEstimate: "2h", lat: 40.7128, lng: -74.006 }),
      mkActivity("b", { durationEstimate: "1h", lat: 39.9526, lng: -75.1652 }),
    );
    expect(validateDay(slots, map).filter((i) => i.kind === "drive-gap")).toEqual([]);
  });

  it("skips drive-gap when coords are missing on either side", () => {
    const slots: ValidationSlot[] = [
      { activityId: "a", startTime: "09:00" },
      { activityId: "b", startTime: "09:30" },
    ];
    const map = mkMap(
      mkActivity("a", { durationEstimate: "2h", lat: null, lng: null }),
      mkActivity("b", { durationEstimate: "1h", lat: 39.9526, lng: -75.1652 }),
    );
    expect(validateDay(slots, map).filter((i) => i.kind === "drive-gap")).toEqual([]);
  });

  it("skips slots without startTime", () => {
    const slots: ValidationSlot[] = [
      { activityId: "a" },
      { activityId: "b", startTime: "10:00" },
    ];
    const map = mkMap(
      mkActivity("a", { durationEstimate: "2h" }),
      mkActivity("b", { durationEstimate: "1h" }),
    );
    expect(validateDay(slots, map)).toEqual([]);
  });

  it("skips activities missing from the map", () => {
    const slots: ValidationSlot[] = [
      { activityId: "missing", startTime: "09:00" },
      { activityId: "b", startTime: "10:00" },
    ];
    const map = mkMap(mkActivity("b", { durationEstimate: "1h" }));
    expect(validateDay(slots, map)).toEqual([]);
  });

  it("flags all three kinds when they coexist", () => {
    // a: 09:00–11:00 NYC (2h)
    // b: 13:00–14:00 Philly (out of order vs c at 09:30)
    // c: 09:30–10:30 NYC (overlaps a)
    // c -> b is NYC -> Philly with ~2.5h gap; 80mi needs ~2.6h -> drive-gap
    const slots: ValidationSlot[] = [
      { activityId: "a", startTime: "09:00" },
      { activityId: "b", startTime: "13:00" },
      { activityId: "c", startTime: "09:30" },
    ];
    const map = mkMap(
      mkActivity("a", { name: "A", durationEstimate: "2h", lat: 40.7128, lng: -74.006 }),
      mkActivity("b", { name: "B", durationEstimate: "1h", lat: 39.9526, lng: -75.1652 }),
      mkActivity("c", { name: "C", durationEstimate: "1h", lat: 40.7128, lng: -74.006 }),
    );
    const issues = validateDay(slots, map);
    const kinds = new Set(issues.map((i) => i.kind));
    expect(kinds.has("overlap")).toBe(true);
    expect(kinds.has("out-of-order")).toBe(true);
    expect(kinds.has("drive-gap")).toBe(true);
  });
});
