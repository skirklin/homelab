/**
 * Evening-reminder suppression is PER-USER.
 *
 * Day journaling moved from the retired travel_day_entries collection (one
 * shared UNIQUE(trip,date) row) to travel_notes (one row PER AUTHOR per
 * trip-day, no unique index). The suppression set must therefore be keyed by
 * the note's author, not just ${tripId}|${date} — otherwise, on a SHARED trip,
 * one co-owner journaling silently suppresses the "How was today?" reminder for
 * every other co-owner who hasn't journaled yet.
 *
 * These are unit tests over `runTravelNotificationsTick` with `getAdminPb` and
 * `sendPushToUser` mocked. The fake PB returns canned rows per collection
 * (filters are ignored — the fixtures control which rows exist), so we drive
 * `now` to 20:00 in the owners' tz and assert who does / doesn't get pushed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatInTimeZone } from "date-fns-tz";

// ─── Mocks (declared before importing the unit under test) ───────────────────

const sendPushToUser = vi.fn().mockResolvedValue({ sent: 1, expired: 0 });
vi.mock("../push", () => ({ sendPushToUser: (...a: unknown[]) => sendPushToUser(...a) }));

const getAdminPb = vi.fn();
vi.mock("../pb", () => ({ getAdminPb: () => getAdminPb() }));

import { runTravelNotificationsTick } from "./travel";

// ─── Fixture constants ───────────────────────────────────────────────────────

const TZ = "America/Los_Angeles";
const TRIP_ID = "trip_shared_1";
// An instant that is 20:00 (EVENING_HOUR) PT on 2026-06-08, the trip's middle day.
// 2026-06-08 is PDT (UTC-7), so 20:00 PT === 03:00 UTC on 2026-06-09.
const NOW = new Date("2026-06-09T03:00:00.000Z");
const TODAY = "2026-06-08"; // ymd of NOW in TZ

beforeEach(() => {
  vi.clearAllMocks();
  // Sanity-pin the fixture instant: it must be exactly the evening hour in TZ
  // and resolve to TODAY, or every test below is vacuous.
  expect(formatInTimeZone(NOW, TZ, "H")).toBe("20");
  expect(formatInTimeZone(NOW, TZ, "yyyy-MM-dd")).toBe(TODAY);
});

// ─── Fake PB ─────────────────────────────────────────────────────────────────

interface DayNote {
  subject_type: string;
  subject_id: string;
  created_by: string;
  entries: Array<{ name?: string; value?: unknown }>;
}

/**
 * @param owners user ids that co-own the trip (drives evening reminders)
 * @param dayNotes travel_notes rows the suppression query will see
 */
function makeFakePb(opts: { owners: string[]; dayNotes: DayNote[] }) {
  const userUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  // Per-user mutable travel_notif_state so the dedup read/write round-trips.
  const notifState: Record<string, unknown> = {};

  const pb = {
    filter: (expr: string, _params?: Record<string, unknown>) => expr,
    collection(name: string) {
      switch (name) {
        case "travel_trips":
          return {
            getFullList: async () => [
              {
                id: TRIP_ID,
                destination: "Mexico City",
                name: "Mexico City",
                start_date: "2026-06-06 00:00:00.000Z",
                end_date: "2026-06-10 00:00:00.000Z",
                expand: { log: { owners: opts.owners } },
              },
            ],
          };
        case "travel_activities":
          return { getFullList: async () => [] };
        case "travel_itineraries":
          return { getFullList: async () => [] };
        case "travel_notes":
          return { getFullList: async () => opts.dayNotes };
        case "users":
          return {
            getOne: async (id: string) => ({
              id,
              timezone: TZ,
              travel_notif_state: notifState[id],
            }),
            update: async (id: string, data: Record<string, unknown>) => {
              userUpdates.push({ id, data });
              if ("travel_notif_state" in data) notifState[id] = data.travel_notif_state;
              return data;
            },
          };
        default:
          throw new Error(`unexpected collection ${name}`);
      }
    },
  };
  return { pb, userUpdates };
}

/** Set of user ids that received an evening reminder push. */
function eveningPushedUsers(): Set<string> {
  const ids = new Set<string>();
  for (const call of sendPushToUser.mock.calls) {
    const [, userId, payload] = call;
    if (payload?.data?.type === "travel_evening") ids.add(userId as string);
  }
  return ids;
}

function filledNote(author: string): DayNote {
  return {
    subject_type: "day",
    subject_id: `${TRIP_ID}:${TODAY}`,
    created_by: author,
    entries: [{ name: "text", value: "Best tacos of my life." }],
  };
}

describe("runTravelNotificationsTick — evening suppression is per-user", () => {
  it("a filled day-note suppresses that user's evening reminder", async () => {
    const { pb } = makeFakePb({ owners: ["userA"], dayNotes: [filledNote("userA")] });
    getAdminPb.mockResolvedValue(pb);

    const res = await runTravelNotificationsTick(NOW);

    expect(res.evening.notified).toBe(0);
    expect(res.evening.skipped).toBe(1);
    expect(eveningPushedUsers().has("userA")).toBe(false);
  });

  it("an EMPTY day-note does NOT suppress", async () => {
    const empty: DayNote = {
      subject_type: "day",
      subject_id: `${TRIP_ID}:${TODAY}`,
      created_by: "userA",
      entries: [{ name: "text", value: "   " }], // whitespace-only → not filled
    };
    const { pb } = makeFakePb({ owners: ["userA"], dayNotes: [empty] });
    getAdminPb.mockResolvedValue(pb);

    const res = await runTravelNotificationsTick(NOW);

    expect(res.evening.notified).toBe(1);
    expect(eveningPushedUsers().has("userA")).toBe(true);
  });

  // The bug this fix closes: on a SHARED trip, user A journaling must not mute
  // user B's reminder. Against the pre-fix (unkeyed ${tripId}|${date}) set this
  // assertion FAILS — B is suppressed by A's note.
  it("user A's day-note does NOT suppress user B's reminder", async () => {
    const { pb } = makeFakePb({
      owners: ["userA", "userB"],
      dayNotes: [filledNote("userA")],
    });
    getAdminPb.mockResolvedValue(pb);

    const res = await runTravelNotificationsTick(NOW);

    const pushed = eveningPushedUsers();
    // A journaled → suppressed; B did not → still reminded.
    expect(pushed.has("userA")).toBe(false);
    expect(pushed.has("userB")).toBe(true);
    expect(res.evening.notified).toBe(1);
    expect(res.evening.skipped).toBe(1);
  });

  it("an unattributed (created_by=='') day-note suppresses no one", async () => {
    const orphan: DayNote = {
      subject_type: "day",
      subject_id: `${TRIP_ID}:${TODAY}`,
      created_by: "",
      entries: [{ name: "text", value: "Backfilled, no author." }],
    };
    const { pb } = makeFakePb({
      owners: ["userA", "userB"],
      dayNotes: [orphan],
    });
    getAdminPb.mockResolvedValue(pb);

    const res = await runTravelNotificationsTick(NOW);

    const pushed = eveningPushedUsers();
    expect(pushed.has("userA")).toBe(true);
    expect(pushed.has("userB")).toBe(true);
    expect(res.evening.notified).toBe(2);
  });
});
