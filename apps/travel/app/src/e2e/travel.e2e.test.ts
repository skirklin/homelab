/**
 * Integration tests for the Travel app using the @homelab/backend interface.
 *
 * Tests the PocketBase backend implementations against a real PocketBase instance.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initTestPocketBase,
  cleanupTestPocketBase,
  createTestUser,
  TestCleanup,
  type TestContext,
} from "@kirkl/shared/test-utils";
import { PocketBaseTravelBackend, PocketBaseUserBackend } from "@homelab/backend/pocketbase";
import {
  tripToBackend,
  tripUpdatesToBackend,
  activityToBackend,
  activityUpdatesToBackend,
} from "../adapters";
import type { Trip, Activity, Itinerary } from "../types";

let ctx: TestContext;
let travel: PocketBaseTravelBackend;
let userBackend: PocketBaseUserBackend;

beforeAll(async () => {
  ctx = await initTestPocketBase();
  travel = new PocketBaseTravelBackend(() => ctx.userPb);
  userBackend = new PocketBaseUserBackend(() => ctx.userPb);
});

afterAll(async () => {
  await cleanupTestPocketBase(ctx);
});

// ── Helpers ──────────────────────────────────────────────────

function makeTrip(overrides: Partial<Omit<Trip, "id">> = {}): Omit<Trip, "id"> {
  return {
    destination: "Tokyo, Japan",
    status: "Idea",
    region: "Asia",
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

function makeActivity(overrides: Partial<Omit<Activity, "id">> = {}): Omit<Activity, "id"> {
  return {
    name: "Test Activity",
    category: "Sightseeing",
    location: "Test Location",
    placeId: "",
    lat: null,
    lng: null,
    description: "",
    costNotes: "",
    durationEstimate: "2h",
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
    tripId: "",
    created: new Date(),
    updated: new Date(),
    ...overrides,
  };
}

function makeItinerary(tripId: string, overrides: Partial<Omit<Itinerary, "id">> = {}): Omit<Itinerary, "id"> {
  return {
    tripId,
    name: "Option A",
    isActive: true,
    days: [],
    created: new Date(),
    updated: new Date(),
    ...overrides,
  };
}

// ── createLog ────────────────────────────────────────────────

describe("createLog", () => {
  it("creates a travel log and saves a slug on the user", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    // Use the backend to create a log via getOrCreateLog
    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const record = await ctx.pb.collection("travel_logs").getOne(logId);
    expect(record.owners).toContain(user.id);

    const userRecord = await ctx.pb.collection("users").getOne(user.id);
    const slugs = userRecord.travel_slugs as Record<string, string>;
    expect(Object.values(slugs)).toContain(logId);

    await cleanup.cleanup();
  });

  it("slug is derived from the log name", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const slugs = await userBackend.getSlugs(user.id, "travel");
    expect(Object.values(slugs)).toContain(logId);

    await cleanup.cleanup();
  });
});

// ── getOrCreateUserLog ───────────────────────────────────────

describe("getOrCreateUserLog", () => {
  it("creates a log when user has none", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    expect(logId).toBeTruthy();
    const record = await ctx.pb.collection("travel_logs").getOne(logId);
    expect(record.owners).toContain(user.id);

    await cleanup.cleanup();
  });

  it("returns the existing log when user already has one", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const firstLogId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", firstLogId);

    const secondLogId = await travel.getOrCreateLog(user.id);
    expect(secondLogId).toBe(firstLogId);

    await cleanup.cleanup();
  });
});

// ── Trip CRUD ────────────────────────────────────────────────

describe("addTrip", () => {
  it("creates a trip linked to the log", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Paris, France", status: "Idea" })));
    cleanup.track("travel_trips", tripId);

    const record = await ctx.pb.collection("travel_trips").getOne(tripId);
    expect(record.destination).toBe("Paris, France");
    expect(record.status).toBe("Idea");
    expect(record.log).toBe(logId);

    await cleanup.cleanup();
  });

  it("stores start and end dates", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const start = new Date("2025-06-01");
    const end = new Date("2025-06-10");
    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Rome", startDate: start, endDate: end, status: "Booked" })));
    cleanup.track("travel_trips", tripId);

    const record = await ctx.pb.collection("travel_trips").getOne(tripId);
    expect(record.start_date).toBeTruthy();
    expect(record.end_date).toBeTruthy();
    expect(record.status).toBe("Booked");

    await cleanup.cleanup();
  });
});

describe("updateTrip", () => {
  it("updates trip fields", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Berlin" })));
    cleanup.track("travel_trips", tripId);

    await travel.updateTrip(tripId, tripUpdatesToBackend({ destination: "Munich", status: "Researching", notes: "Summer trip" }));

    const record = await ctx.pb.collection("travel_trips").getOne(tripId);
    expect(record.destination).toBe("Munich");
    expect(record.status).toBe("Researching");
    expect(record.notes).toBe("Summer trip");

    await cleanup.cleanup();
  });
});

describe("deleteTrip", () => {
  it("deletes a trip", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Delete Me" })));

    await travel.deleteTrip(tripId);

    try {
      await ctx.pb.collection("travel_trips").getOne(tripId);
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.status).toBe(404);
    }

    await cleanup.cleanup();
  });
});

describe("flagTrip", () => {
  it("flags a trip for review with a comment", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Unknown City" })));
    cleanup.track("travel_trips", tripId);

    await travel.flagTrip(tripId, true, "Needs source verification");

    const record = await ctx.pb.collection("travel_trips").getOne(tripId);
    expect(record.flagged_for_review).toBe(true);
    expect(record.review_comment).toBe("Needs source verification");

    await cleanup.cleanup();
  });

  it("unflags a trip", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Flagged City", flaggedForReview: true })));
    cleanup.track("travel_trips", tripId);

    await travel.flagTrip(tripId, false);

    const record = await ctx.pb.collection("travel_trips").getOne(tripId);
    expect(record.flagged_for_review).toBe(false);

    await cleanup.cleanup();
  });
});

// ── Activity CRUD ────────────────────────────────────────────

describe("addActivity", () => {
  it("creates an activity linked to the log", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Kyoto" })));
    cleanup.track("travel_trips", tripId);

    const activityId = await travel.addActivity(logId, activityToBackend(makeActivity({
      name: "Fushimi Inari",
      category: "Sightseeing",
      location: "Fushimi, Kyoto",
      tripId,
    })));
    cleanup.track("travel_activities", activityId);

    const record = await ctx.pb.collection("travel_activities").getOne(activityId);
    expect(record.name).toBe("Fushimi Inari");
    expect(record.category).toBe("Sightseeing");
    expect(record.log).toBe(logId);
    expect(record.trip_id).toBe(tripId);

    await cleanup.cleanup();
  });

  it("stores location coordinates", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Barcelona" })));
    cleanup.track("travel_trips", tripId);

    const activityId = await travel.addActivity(logId, activityToBackend(makeActivity({
      name: "Sagrada Familia",
      lat: 41.4036,
      lng: 2.1744,
      tripId,
    })));
    cleanup.track("travel_activities", activityId);

    const record = await ctx.pb.collection("travel_activities").getOne(activityId);
    expect(record.lat).toBeCloseTo(41.4036);
    expect(record.lng).toBeCloseTo(2.1744);

    await cleanup.cleanup();
  });
});

describe("updateActivity", () => {
  it("updates activity fields", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Amsterdam" })));
    cleanup.track("travel_trips", tripId);

    const activityId = await travel.addActivity(logId, activityToBackend(makeActivity({ name: "Canal Tour", tripId })));
    cleanup.track("travel_activities", activityId);

    await travel.updateActivity(activityId, activityUpdatesToBackend({
      name: "Rijksmuseum",
      category: "Culture",
      durationEstimate: "3h",
    }));

    const record = await ctx.pb.collection("travel_activities").getOne(activityId);
    expect(record.name).toBe("Rijksmuseum");
    expect(record.category).toBe("Culture");
    expect(record.duration_estimate).toBe("3h");

    await cleanup.cleanup();
  });
});

describe("deleteActivity", () => {
  it("deletes an activity", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Vienna" })));
    cleanup.track("travel_trips", tripId);

    const activityId = await travel.addActivity(logId, activityToBackend(makeActivity({ name: "Delete Me", tripId })));

    await travel.deleteActivity(activityId);

    try {
      await ctx.pb.collection("travel_activities").getOne(activityId);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.status).toBe(404);
    }

    await cleanup.cleanup();
  });
});

// ── Itinerary CRUD ───────────────────────────────────────────

describe("addItinerary", () => {
  it("creates an itinerary for a trip", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Prague" })));
    cleanup.track("travel_trips", tripId);

    const itin = makeItinerary(tripId, { name: "Actual", isActive: true });
    const itineraryId = await travel.addItinerary(logId, tripId, { name: itin.name, days: itin.days as any });
    cleanup.track("travel_itineraries", itineraryId);

    const record = await ctx.pb.collection("travel_itineraries").getOne(itineraryId);
    expect(record.trip_id).toBe(tripId);
    expect(record.name).toBe("Actual");
    expect(record.log).toBe(logId);

    await cleanup.cleanup();
  });
});

describe("setItineraryDays", () => {
  it("sets day-by-day slots on an itinerary", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Budapest" })));
    cleanup.track("travel_trips", tripId);

    const itin = makeItinerary(tripId);
    const itineraryId = await travel.addItinerary(logId, tripId, { name: itin.name, days: itin.days as any });
    cleanup.track("travel_itineraries", itineraryId);

    const days = [
      { label: "Day 1 — Arrival", slots: [{ activityId: "some-activity-id" }] },
      { label: "Day 2 — Sightseeing", slots: [] },
    ];

    await travel.setItineraryDays(itineraryId, days as any);

    const record = await ctx.pb.collection("travel_itineraries").getOne(itineraryId);
    expect(record.days).toHaveLength(2);
    expect(record.days[0].label).toBe("Day 1 — Arrival");

    await cleanup.cleanup();
  });
});

describe("updateItinerary", () => {
  it("updates an itinerary's name", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Warsaw" })));
    cleanup.track("travel_trips", tripId);

    const itin = makeItinerary(tripId, { isActive: true });
    const itineraryId = await travel.addItinerary(logId, tripId, { name: itin.name, days: itin.days as any });
    cleanup.track("travel_itineraries", itineraryId);

    await travel.updateItinerary(itineraryId, { name: "Updated Plan" });

    const record = await ctx.pb.collection("travel_itineraries").getOne(itineraryId);
    expect(record.name).toBe("Updated Plan");

    await cleanup.cleanup();
  });
});

describe("deleteItinerary", () => {
  it("deletes an itinerary", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Lisbon" })));
    cleanup.track("travel_trips", tripId);

    const itin = makeItinerary(tripId);
    const itineraryId = await travel.addItinerary(logId, tripId, { name: itin.name, days: itin.days as any });

    await travel.deleteItinerary(itineraryId);

    try {
      await ctx.pb.collection("travel_itineraries").getOne(itineraryId);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.status).toBe(404);
    }

    await cleanup.cleanup();
  });
});

// ── User profile (travel slugs) ──────────────────────────────

describe("getUserSlugs / setUserSlug", () => {
  it("returns empty object when user has no slugs", async () => {
    const user = await createTestUser(ctx);

    const slugs = await userBackend.getSlugs(user.id, "travel");
    expect(slugs).toEqual({});
  });

  it("sets a slug and reads it back", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    await userBackend.setSlug(user.id, "travel", "europe-2026", logId);

    const slugs = await userBackend.getSlugs(user.id, "travel");
    expect(slugs["europe-2026"]).toBe(logId);

    await cleanup.cleanup();
  });

  it("merges multiple slugs without overwriting existing ones", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const log1 = await ctx.pb.collection("travel_logs").create({
      name: "Log 1",
      owners: [user.id],
    });
    cleanup.track("travel_logs", log1.id);

    const log2 = await ctx.pb.collection("travel_logs").create({
      name: "Log 2",
      owners: [user.id],
    });
    cleanup.track("travel_logs", log2.id);

    await userBackend.setSlug(user.id, "travel", "first-log", log1.id);
    await userBackend.setSlug(user.id, "travel", "second-log", log2.id);

    const slugs = await userBackend.getSlugs(user.id, "travel");
    expect(slugs["first-log"]).toBe(log1.id);
    expect(slugs["second-log"]).toBe(log2.id);

    await cleanup.cleanup();
  });
});

// ── Activity reflection (verdict / personal notes / experiencedAt) ──

describe("activity reflection fields", () => {
  it("stores and reads back verdict + personal notes + experiencedAt", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Sedona" })));
    cleanup.track("travel_trips", tripId);

    const activityId = await travel.addActivity(logId, activityToBackend(makeActivity({ name: "Cathedral Rock", tripId })));
    cleanup.track("travel_activities", activityId);

    const experienced = new Date("2025-10-12T15:30:00Z");
    await travel.updateActivity(
      activityId,
      activityUpdatesToBackend({
        verdict: "loved",
        personalNotes: "Sunset spot was magical. Get there 90min early.",
        experiencedAt: experienced,
      }),
    );

    const record = await ctx.pb.collection("travel_activities").getOne(activityId);
    expect(record.verdict).toBe("loved");
    expect(record.personal_notes).toContain("magical");
    expect(record.experienced_at).toBeTruthy();

    await cleanup.cleanup();
  });

  it("clears verdict when set to null", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Moab" })));
    cleanup.track("travel_trips", tripId);

    const activityId = await travel.addActivity(logId, activityToBackend(makeActivity({ name: "Delicate Arch", tripId })));
    cleanup.track("travel_activities", activityId);

    await travel.updateActivity(activityId, activityUpdatesToBackend({ verdict: "meh" }));
    let r = await ctx.pb.collection("travel_activities").getOne(activityId);
    expect(r.verdict).toBe("meh");

    await travel.updateActivity(activityId, activityUpdatesToBackend({ verdict: null }));
    r = await ctx.pb.collection("travel_activities").getOne(activityId);
    expect(r.verdict || "").toBe("");

    await cleanup.cleanup();
  });

  it("does not touch personal_notes when only verdict changes", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Bryce" })));
    cleanup.track("travel_trips", tripId);

    const activityId = await travel.addActivity(logId, activityToBackend(makeActivity({ name: "Sunrise Point", tripId })));
    cleanup.track("travel_activities", activityId);

    await travel.updateActivity(activityId, activityUpdatesToBackend({
      verdict: "liked",
      personalNotes: "Cold and worth it.",
    }));

    // Subsequent verdict change without touching notes should leave them intact.
    await travel.updateActivity(activityId, activityUpdatesToBackend({ verdict: "loved" }));

    const r = await ctx.pb.collection("travel_activities").getOne(activityId);
    expect(r.verdict).toBe("loved");
    expect(r.personal_notes).toBe("Cold and worth it.");

    await cleanup.cleanup();
  });
});

// ── Day journal entries ──────────────────────────────────────

describe("upsertDayEntry / deleteDayEntry", () => {
  it("inserts a new entry on first call", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Petrified Forest" })));
    cleanup.track("travel_trips", tripId);

    const id = await travel.upsertDayEntry(logId, tripId, "2026-04-19", {
      text: "Painted Desert at golden hour was the best moment.",
      highlight: "Stopping at Newspaper Rock",
      mood: 5,
    });
    cleanup.track("travel_day_entries", id);

    const r = await ctx.pb.collection("travel_day_entries").getOne(id);
    expect(r.trip).toBe(tripId);
    expect(r.log).toBe(logId);
    expect(r.date).toBe("2026-04-19");
    expect(r.text).toContain("Painted Desert");
    expect(r.highlight).toBe("Stopping at Newspaper Rock");
    expect(r.mood).toBe(5);

    await cleanup.cleanup();
  });

  it("updates the existing entry on a second call (one entry per trip+date)", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Joshua Tree" })));
    cleanup.track("travel_trips", tripId);

    const id1 = await travel.upsertDayEntry(logId, tripId, "2026-04-20", { text: "Arrived late." });
    cleanup.track("travel_day_entries", id1);

    const id2 = await travel.upsertDayEntry(logId, tripId, "2026-04-20", {
      text: "Arrived late but caught moonrise.",
      highlight: "Joshua trees by moonlight",
    });

    expect(id2).toBe(id1);

    const r = await ctx.pb.collection("travel_day_entries").getOne(id1);
    expect(r.text).toContain("moonrise");
    expect(r.highlight).toBe("Joshua trees by moonlight");

    // No second row was created.
    const all = await ctx.pb.collection("travel_day_entries").getFullList({
      filter: ctx.pb.filter("trip = {:tripId}", { tripId }),
    });
    expect(all).toHaveLength(1);

    await cleanup.cleanup();
  });

  it("keeps separate entries for different dates on the same trip", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Big Bend" })));
    cleanup.track("travel_trips", tripId);

    const id1 = await travel.upsertDayEntry(logId, tripId, "2026-04-20", { text: "Day 1" });
    const id2 = await travel.upsertDayEntry(logId, tripId, "2026-04-21", { text: "Day 2" });
    cleanup.track("travel_day_entries", id1);
    cleanup.track("travel_day_entries", id2);

    expect(id1).not.toBe(id2);

    await cleanup.cleanup();
  });

  it("deletes a day entry", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Glacier" })));
    cleanup.track("travel_trips", tripId);

    const id = await travel.upsertDayEntry(logId, tripId, "2026-04-22", { text: "tmp" });

    await travel.deleteDayEntry(id);

    try {
      await ctx.pb.collection("travel_day_entries").getOne(id);
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.status).toBe(404);
    }

    await cleanup.cleanup();
  });

  it("cascades delete when the parent trip is deleted", async () => {
    const user = await createTestUser(ctx);
    const cleanup = new TestCleanup();
    cleanup.bind(ctx.pb);

    const logId = await travel.getOrCreateLog(user.id);
    cleanup.track("travel_logs", logId);

    const tripId = await travel.addTrip(logId, tripToBackend(makeTrip({ destination: "Yellowstone" })));

    const entryId = await travel.upsertDayEntry(logId, tripId, "2026-04-25", { text: "Geyser day" });
    expect(entryId).toBeTruthy();

    await travel.deleteTrip(tripId);

    try {
      await ctx.pb.collection("travel_day_entries").getOne(entryId);
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.status).toBe(404);
    }

    await cleanup.cleanup();
  });
});

// Checklist operations removed — travel checklists are now tasks tagged travel:<tripId>
