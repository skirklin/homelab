import { describe, it, expect } from "vitest";
import {
  validateDay,
  parseTimeOfDay,
  isTripActive,
  findTodayDay,
  scheduledEntriesForDay,
  findCurrentEntry,
  findNextEntry,
  formatCountdown,
  localYmd,
  type Activity,
  type ItinerarySlot,
  type ItineraryDay,
  type Itinerary,
  type Trip,
} from "./types";

function mkTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: "t1",
    destination: "Test",
    status: "Booked",
    region: "",
    startDate: null,
    endDate: null,
    notes: "",
    sourceRefs: "",
    flaggedForReview: false,
    reviewComment: "",
    created: new Date(),
    updated: new Date(),
    ...overrides,
  };
}

function mkDay(overrides: Partial<ItineraryDay> = {}): ItineraryDay {
  return { label: "Day", slots: [], ...overrides };
}

function mkItin(days: ItineraryDay[]): Itinerary {
  return {
    id: "i1",
    tripId: "t1",
    name: "Actual",
    isActive: true,
    days,
    created: new Date(),
    updated: new Date(),
  };
}

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

describe("isTripActive", () => {
  // Use local-timezone constructor everywhere so tests are TZ-agnostic
  // (new Date("2026-04-20") parses as UTC midnight, which flips days in
  //  west-of-UTC locales).
  const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
  const now = d(2026, 4, 20);
  it("is active when today is within the range", () => {
    expect(isTripActive(mkTrip({ startDate: d(2026, 4, 18), endDate: d(2026, 4, 25) }), now)).toBe(true);
  });
  it("is active on the first and last day (inclusive)", () => {
    expect(isTripActive(mkTrip({ startDate: d(2026, 4, 20), endDate: d(2026, 4, 20) }), now)).toBe(true);
    expect(isTripActive(mkTrip({ startDate: d(2026, 4, 20), endDate: d(2026, 4, 22) }), now)).toBe(true);
    expect(isTripActive(mkTrip({ startDate: d(2026, 4, 15), endDate: d(2026, 4, 20) }), now)).toBe(true);
  });
  it("is not active before or after", () => {
    expect(isTripActive(mkTrip({ startDate: d(2026, 4, 21), endDate: d(2026, 4, 25) }), now)).toBe(false);
    expect(isTripActive(mkTrip({ startDate: d(2026, 4, 10), endDate: d(2026, 4, 19) }), now)).toBe(false);
  });
  it("returns false when dates are missing", () => {
    expect(isTripActive(mkTrip({ startDate: null, endDate: d(2026, 4, 25) }), now)).toBe(false);
    expect(isTripActive(mkTrip({ startDate: d(2026, 4, 18), endDate: null }), now)).toBe(false);
  });
});

describe("findTodayDay", () => {
  const now = new Date(2026, 3, 20, 12, 0, 0);
  it("returns the day matching today with its index", () => {
    const itin = mkItin([
      mkDay({ date: "2026-04-19", label: "Day 1" }),
      mkDay({ date: "2026-04-20", label: "Day 2" }),
      mkDay({ date: "2026-04-21", label: "Day 3" }),
    ]);
    const found = findTodayDay(itin, now);
    expect(found?.index).toBe(1);
    expect(found?.day.label).toBe("Day 2");
  });
  it("returns null when today isn't on the itinerary", () => {
    const itin = mkItin([mkDay({ date: "2026-04-25", label: "Day" })]);
    expect(findTodayDay(itin, now)).toBe(null);
  });
  it("ignores days without dates (e.g. hypothetical itineraries)", () => {
    const itin = mkItin([mkDay({ label: "Maybe" }), mkDay({ date: "2026-04-20", label: "Real" })]);
    expect(findTodayDay(itin, now)?.day.label).toBe("Real");
  });
});

describe("scheduledEntriesForDay", () => {
  it("merges flights + slots and sorts by start time", () => {
    const day = mkDay({
      slots: [
        { activityId: "lunch", startTime: "12:00" },
        { activityId: "morning", startTime: "09:00" },
      ],
      flights: [{ activityId: "flight", startTime: "15:00" }],
    });
    const map = mkMap(
      mkActivity("morning", { durationEstimate: "2h" }),
      mkActivity("lunch", { durationEstimate: "1h" }),
      mkActivity("flight", { durationEstimate: "3h", category: "Flight" }),
    );
    const entries = scheduledEntriesForDay(day, map);
    expect(entries.map((e) => e.slot.activityId)).toEqual(["morning", "lunch", "flight"]);
    expect(entries[2].source).toBe("flights");
  });

  it("drops slots without start times or missing activities", () => {
    const day = mkDay({
      slots: [
        { activityId: "a", startTime: "09:00" },
        { activityId: "b" }, // no startTime
        { activityId: "missing", startTime: "10:00" }, // missing activity
      ],
    });
    const map = mkMap(mkActivity("a", { durationEstimate: "1h" }), mkActivity("b"));
    const entries = scheduledEntriesForDay(day, map);
    expect(entries).toHaveLength(1);
    expect(entries[0].slot.activityId).toBe("a");
  });
});

describe("findCurrentEntry", () => {
  const now = new Date(2026, 3, 20, 10, 0, 0);
  it("finds the entry whose [start, start+duration) covers now", () => {
    const day = mkDay({ slots: [{ activityId: "a", startTime: "09:00" }] });
    const map = mkMap(mkActivity("a", { durationEstimate: "2h", name: "Museum" }));
    const entries = scheduledEntriesForDay(day, map);
    expect(findCurrentEntry(entries, now)?.activity.name).toBe("Museum");
  });
  it("returns null when now is before all entries", () => {
    const day = mkDay({ slots: [{ activityId: "a", startTime: "14:00" }] });
    const map = mkMap(mkActivity("a", { durationEstimate: "1h" }));
    expect(findCurrentEntry(scheduledEntriesForDay(day, map), now)).toBe(null);
  });
  it("returns null when now is after all entries have ended", () => {
    const day = mkDay({ slots: [{ activityId: "a", startTime: "06:00" }] });
    const map = mkMap(mkActivity("a", { durationEstimate: "1h" })); // ends 07:00
    expect(findCurrentEntry(scheduledEntriesForDay(day, map), now)).toBe(null);
  });
  it("excludes zero-duration entries (can't define coverage)", () => {
    const day = mkDay({ slots: [{ activityId: "a", startTime: "09:00" }] });
    const map = mkMap(mkActivity("a", { durationEstimate: "" })); // unparseable
    expect(findCurrentEntry(scheduledEntriesForDay(day, map), now)).toBe(null);
  });
});

describe("findNextEntry", () => {
  const now = new Date(2026, 3, 20, 10, 0, 0);
  it("finds the soonest upcoming entry with minutes until", () => {
    const day = mkDay({
      slots: [
        { activityId: "a", startTime: "10:30" },
        { activityId: "b", startTime: "14:00" },
      ],
    });
    const map = mkMap(mkActivity("a", { durationEstimate: "1h" }), mkActivity("b", { durationEstimate: "2h" }));
    const next = findNextEntry(scheduledEntriesForDay(day, map), now);
    expect(next?.entry.slot.activityId).toBe("a");
    expect(next?.minutesUntil).toBe(30);
  });
  it("skips entries at or before now", () => {
    const day = mkDay({
      slots: [
        { activityId: "past", startTime: "09:00" },
        { activityId: "exact", startTime: "10:00" }, // exactly now — also skipped
        { activityId: "future", startTime: "11:00" },
      ],
    });
    const map = mkMap(
      mkActivity("past", { durationEstimate: "30m" }),
      mkActivity("exact", { durationEstimate: "30m" }),
      mkActivity("future", { durationEstimate: "30m" }),
    );
    const next = findNextEntry(scheduledEntriesForDay(day, map), now);
    expect(next?.entry.slot.activityId).toBe("future");
  });
});

describe("formatCountdown", () => {
  it("uses 'now' for zero or negative", () => {
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(-5)).toBe("now");
  });
  it("uses minutes under an hour", () => {
    expect(formatCountdown(35)).toBe("in 35 min");
  });
  it("uses whole hours when minutes are zero", () => {
    expect(formatCountdown(120)).toBe("in 2h");
  });
  it("includes hours and minutes otherwise", () => {
    expect(formatCountdown(135)).toBe("in 2h 15m");
  });
});

describe("localYmd", () => {
  it("formats a Date as YYYY-MM-DD in local time", () => {
    expect(localYmd(new Date(2026, 3, 20))).toBe("2026-04-20"); // month is 0-indexed
    expect(localYmd(new Date(2026, 11, 5))).toBe("2026-12-05");
  });
});
