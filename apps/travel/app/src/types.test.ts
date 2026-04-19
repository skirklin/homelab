import { describe, it, expect } from "vitest";
import { validateDay, parseTimeOfDay, type Activity, type ItinerarySlot } from "./types";

function mkActivity(id: string, overrides: Partial<Activity> = {}): Activity {
  return {
    id,
    name: `Activity ${id}`,
    category: "Sightseeing",
    location: "",
    placeId: "",
    lat: null,
    lng: null,
    description: "",
    costNotes: "",
    durationEstimate: "",
    confirmationCode: "",
    details: "",
    setting: "",
    bookingReqs: [],
    rating: null,
    ratingCount: null,
    photoRef: "",
    tripId: "trip1",
    created: new Date(),
    updated: new Date(),
    ...overrides,
  };
}

function mkMap(...activities: Activity[]): Map<string, Activity> {
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
    expect(parseTimeOfDay("9am")).toBe(null);
    expect(parseTimeOfDay("25:00")).toBe(null);
    expect(parseTimeOfDay("12:70")).toBe(null);
  });
});

describe("validateDay", () => {
  it("returns no issues when slots have no start times", () => {
    const slots: ItinerarySlot[] = [
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
    const slots: ItinerarySlot[] = [
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
    const slots: ItinerarySlot[] = [
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
    const slots: ItinerarySlot[] = [
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
    const slots: ItinerarySlot[] = [
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
    const slots: ItinerarySlot[] = [
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
    const slots: ItinerarySlot[] = [
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
    const slots: ItinerarySlot[] = [
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
    const slots: ItinerarySlot[] = [
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
    const slots: ItinerarySlot[] = [
      { activityId: "missing", startTime: "09:00" },
      { activityId: "b", startTime: "10:00" },
    ];
    const map = mkMap(mkActivity("b", { durationEstimate: "1h" }));
    expect(validateDay(slots, map)).toEqual([]);
  });

  it("flags all three kinds when they coexist", () => {
    // a: 09:00–11:00 NYC (2h)
    // b: 09:30–10:00 NYC (overlaps a, but 0-mile drive so no drive-gap between them)
    // c: 10:30 Philly (out of order vs b? no — but drive-gap from a: only 30min gap for long drive)
    // Here I'll construct a clear scenario: overlap + out-of-order + drive-gap
    const slots: ItinerarySlot[] = [
      { activityId: "a", startTime: "09:00" }, // NYC, 2h
      { activityId: "b", startTime: "13:00" }, // Philly, 1h - out of order with next
      { activityId: "c", startTime: "09:30" }, // NYC, 1h - overlaps a
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
    // a ends 11:00, next in time is c at 09:30 (overlap), then b at 13:00 after c ends at 10:30.
    // c -> b is NYC -> Philly with 2.5h gap, 80mi needs ~2.6h; should flag drive-gap
    expect(kinds.has("drive-gap")).toBe(true);
  });
});
