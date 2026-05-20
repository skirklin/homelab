import { describe, it, expect } from "vitest";
import {
  isTripActive,
  findTodayDay,
  scheduledEntriesForDay,
  findCurrentEntry,
  findNextEntry,
  formatCountdown,
  localYmd,
  type Activity,
  type ItineraryDay,
  type Itinerary,
  type Trip,
} from "./types";

// Note: `validateDay` and `parseTimeOfDay` tests live in
// `packages/backend/src/travel-validation.test.ts` — the canonical impl moved
// to @homelab/backend so the UI and MCP server share one source of truth.

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
    walkMiles: null,
    elevationGainFeet: null,
    difficulty: "",
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
