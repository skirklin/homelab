import { describe, it, expect } from "vitest";
import {
  isTripActive,
  findTodayDay,
  scheduledEntriesForDay,
  findCurrentEntry,
  findNextEntry,
  formatCountdown,
  localYmd,
  utcYmd,
  type Activity,
  type ItineraryDay,
  type Itinerary,
  type Trip,
} from "./types";
import { tripFromBackend, tripToBackend, tripUpdatesToBackend } from "./adapters";

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

// Trip start/end dates are stored in PB as a `date` (a full UTC instant) but
// are semantically date-only. The canonical rule: a trip date resolves to the
// UTC date portion (YYYY-MM-DD) of the stored value, never a local-time
// reduction. This test suite pins the bug where a Pacific user saw a trip as
// already started ("day 2") the day before its start_date. It exercises the
// real bug path — backend string → tripFromBackend → isTripActive — and must
// be run with the process clock in a west-of-UTC zone (the gate sets
// TZ=America/Los_Angeles). The two storage shapes below both denote 2026-06-02:
//   - "2026-06-02T00:00:00.000Z"  (midnight UTC — picker-as-UTC writes)
//   - "2026-06-02T07:00:00.000Z"  (midnight Pacific stored as UTC)
describe("trip dates are UTC-date-only (Pacific bug regression)", () => {
  // `now` is a true instant reduced on the *local* wall-clock date, so we
  // construct it with the local-Date constructor to keep the test TZ-agnostic
  // (a UTC ISO literal would denote a different calendar day east of UTC). The
  // trip dates, by contrast, come through the adapter from stored ISO strings —
  // that is the real bug path being pinned.
  const local = (y: number, m: number, day: number, h = 0) => new Date(y, m - 1, day, h);
  // The day BEFORE the trip starts (trip starts 2026-06-02).
  const nowDayBefore = local(2026, 6, 1, 16);

  const mkBackendTrip = (start: string, end: string) => ({
    id: "z1ns765jyrtp7l5",
    name: "Mexico City",
    destination: "Mexico City",
    status: "Booked",
    region: "",
    startDate: start,
    endDate: end,
    sourceRefs: "",
    flagged: false,
    flagComment: "",
    log: "log1",
    created: "2026-05-01T00:00:00.000Z",
    updated: "2026-05-01T00:00:00.000Z",
  });

  for (const startShape of ["2026-06-02T00:00:00.000Z", "2026-06-02T07:00:00.000Z"]) {
    it(`is NOT active the day before start (stored ${startShape})`, () => {
      const trip = tripFromBackend(mkBackendTrip(startShape, "2026-06-07T07:00:00.000Z"));
      // The trip starts 2026-06-02; "now" is 2026-06-01 Pacific. Must be inactive.
      expect(isTripActive(trip, nowDayBefore)).toBe(false);
      // The adapter pins the trip date to the stored UTC day (local midnight),
      // so a display-side local reduction shows 06-02, not 06-01.
      expect(localYmd(trip.startDate!)).toBe("2026-06-02");
    });
  }

  it("is active on the first day", () => {
    const trip = tripFromBackend(mkBackendTrip("2026-06-02T00:00:00.000Z", "2026-06-07T07:00:00.000Z"));
    expect(isTripActive(trip, local(2026, 6, 2, 16))).toBe(true);
  });

  it("is active mid-range", () => {
    const trip = tripFromBackend(mkBackendTrip("2026-06-02T00:00:00.000Z", "2026-06-07T07:00:00.000Z"));
    expect(isTripActive(trip, local(2026, 6, 4, 13))).toBe(true);
  });

  it("is active on the last day, inactive the day after (ended yesterday)", () => {
    const trip = tripFromBackend(mkBackendTrip("2026-06-02T00:00:00.000Z", "2026-06-07T00:00:00.000Z"));
    expect(isTripActive(trip, local(2026, 6, 7, 16))).toBe(true); // last day
    expect(isTripActive(trip, local(2026, 6, 8, 13))).toBe(false); // ended yesterday
  });
});

// A read-then-write of an unchanged trip must not drift the stored calendar
// day in ANY zone. The read boundary (`tripDateFromBackend`) rebuilds the
// stored UTC day as local-midnight; the write boundary must be symmetric and
// re-serialize the UTC date portion — NOT `toISOString()`, which for an
// east-of-UTC process clock rolls local-midnight back to the previous UTC day
// (e.g. 2026-06-02 local-midnight in Sydney → 2026-06-01T14:00:00Z), corrupting
// the date on every save. Pinned because a prior fix normalized only the read
// side and left the write side as `toISOString()`, making the round-trip
// asymmetric east of UTC. Run under TZ=Australia/Sydney to exercise it.
describe("trip date read→write round-trip is identity in all zones", () => {
  const mkBackendTrip = (start: string, end: string) => ({
    id: "z1ns765jyrtp7l5",
    name: "Mexico City",
    destination: "Mexico City",
    status: "Booked",
    region: "",
    startDate: start,
    endDate: end,
    sourceRefs: "",
    flagged: false,
    flagComment: "",
    log: "log1",
    created: "2026-05-01T00:00:00.000Z",
    updated: "2026-05-01T00:00:00.000Z",
  });

  // Both storage shapes denote the same calendar days (2026-06-02 .. 06-07).
  for (const start of ["2026-06-02T00:00:00.000Z", "2026-06-02T07:00:00.000Z"]) {
    it(`tripToBackend preserves the calendar day (stored ${start})`, () => {
      const trip = tripFromBackend(mkBackendTrip(start, "2026-06-07T00:00:00.000Z"));
      const written = tripToBackend(trip);
      // The UTC date portion is the canonical trip date; it must round-trip.
      expect(written.startDate.slice(0, 10)).toBe("2026-06-02");
      expect(written.endDate.slice(0, 10)).toBe("2026-06-07");
      // And a second read of what we wrote must yield the same local-midnight day.
      const reread = tripFromBackend(mkBackendTrip(written.startDate, written.endDate));
      expect(localYmd(reread.startDate!)).toBe("2026-06-02");
      expect(localYmd(reread.endDate!)).toBe("2026-06-07");
    });

    it(`tripUpdatesToBackend preserves the calendar day (stored ${start})`, () => {
      const trip = tripFromBackend(mkBackendTrip(start, "2026-06-07T00:00:00.000Z"));
      const updates = tripUpdatesToBackend({ startDate: trip.startDate, endDate: trip.endDate });
      expect((updates.startDate as string).slice(0, 10)).toBe("2026-06-02");
      expect((updates.endDate as string).slice(0, 10)).toBe("2026-06-07");
    });
  }

  it("empty/null dates serialize to empty string", () => {
    const trip = tripFromBackend(mkBackendTrip("", ""));
    const written = tripToBackend(trip);
    expect(written.startDate).toBe("");
    expect(written.endDate).toBe("");
  });
});

describe("utcYmd", () => {
  it("formats a Date as YYYY-MM-DD in UTC", () => {
    // 2026-06-02 00:00 UTC — Pacific local would be 2026-06-01; UTC must win.
    expect(utcYmd(new Date("2026-06-02T00:00:00.000Z"))).toBe("2026-06-02");
    expect(utcYmd(new Date("2026-06-02T07:00:00.000Z"))).toBe("2026-06-02");
  });
});
