/**
 * Regression test for cross-tenant writes via the surgical itinerary
 * mutation ops at `/data/travel/itineraries/:id/days/...`.
 *
 * Commit 347d9ad locked down the create/update/delete surface of
 * `/data/travel/{trips,activities,itineraries}` against `hlk_` /
 * `mcpat_` token holders writing into another user's log. That pass
 * did NOT cover the 13 surgical day/slot/flight ops that all sit
 * downstream of an itinerary `:id`. Those routes used admin PB without
 * checking that the caller owned the parent travel_log, leaving the
 * same admin-PB-bypass open: Alice could POST a slot into Bob's
 * itinerary day and the write would land because PB collection rules
 * are skipped on the admin client.
 *
 * The geocode route at `/data/travel/activities/:id/geocode` MUTATES
 * the activity (writes `place_id` / `lat` / `lng` / `flight_info`)
 * and was also missing an ownership check.
 *
 * This test exercises representative routes from each family:
 *   - slots (POST add, PATCH update)
 *   - days  (POST add, PUT replace)
 *   - flights (POST add)
 *   - activity geocode (POST)
 * plus positive-path Bob-on-his-own coverage for slot + day add.
 *
 * Requires `pnpm test:env:up`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";

process.env.PB_URL = "http://127.0.0.1:8091";
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const { default: { app } } = await import("../test-app");

const PB_URL = "http://127.0.0.1:8091";

interface Actor {
  id: string;
  email: string;
  userJwt: string;
  apiToken: string;
}

let adminPb: PocketBase;
let alice: Actor;
let bob: Actor;
let bobsLogId: string;
let bobsTripId: string;
let bobsActivityId: string;
let bobsItineraryId: string;

async function makeActor(suffix: string): Promise<Actor> {
  const email = `${suffix}-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: suffix,
  });
  const userPb = new PocketBase(PB_URL);
  userPb.autoCancellation(false);
  await userPb.collection("users").authWithPassword(email, password);

  const tokenResp = await app.request("/auth/tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${userPb.authStore.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: `${suffix}-test-token` }),
  });
  const tokenData = await tokenResp.json() as { token: string };

  return {
    id: user.id,
    email,
    userJwt: userPb.authStore.token,
    apiToken: tokenData.token,
  };
}

async function apiReq(
  path: string,
  opts: { method?: string; token: string; body?: unknown },
): Promise<{ status: number; data: unknown }> {
  const resp = await app.request(path, {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: resp.status, data: await resp.json().catch(() => null) };
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );

  alice = await makeActor("alice-itin");
  bob = await makeActor("bob-itin");

  // Bob owns a log, trip, activity, and an itinerary with ONE day that has
  // one slot and one flight. That lets us exercise add/patch/replace ops
  // against pre-existing indices.
  const bobPb = new PocketBase(PB_URL);
  bobPb.autoCancellation(false);
  bobPb.authStore.save(bob.userJwt, null);

  const bobsLog = await bobPb.collection("travel_logs").create({
    name: "Bob's log",
    owners: [bob.id],
  });
  bobsLogId = bobsLog.id;

  const bobsTrip = await bobPb.collection("travel_trips").create({
    log: bobsLogId,
    destination: "Bob's trip",
    status: "Booked",
  });
  bobsTripId = bobsTrip.id;

  const bobsActivity = await bobPb.collection("travel_activities").create({
    log: bobsLogId,
    name: "Bob's activity",
    trip_id: bobsTripId,
  });
  bobsActivityId = bobsActivity.id;

  const bobsItinerary = await bobPb.collection("travel_itineraries").create({
    log: bobsLogId,
    trip_id: bobsTripId,
    name: "Bob's itinerary",
    days: [
      {
        label: "Day 1",
        slots: [{ activityId: bobsActivityId }],
        flights: [{ activityId: bobsActivityId }],
      },
    ],
  });
  bobsItineraryId = bobsItinerary.id;
});

describe("cross-tenant writes via surgical itinerary ops (admin-PB bypass)", () => {
  // ── slots ────────────────────────────────────────────────────
  it("blocks Alice's hlk_ token from POSTing a slot into Bob's itinerary day", async () => {
    const { status } = await apiReq(
      `/data/travel/itineraries/${bobsItineraryId}/days/0/slots`,
      {
        method: "POST",
        token: alice.apiToken,
        body: { activity_id: bobsActivityId, notes: "phantom slot" },
      },
    );
    expect(status, "Alice was able to insert a slot into Bob's itinerary").toBe(403);
  });

  it("blocks Alice from PATCHing a slot in Bob's itinerary", async () => {
    const { status } = await apiReq(
      `/data/travel/itineraries/${bobsItineraryId}/days/0/slots/0`,
      {
        method: "PATCH",
        token: alice.apiToken,
        body: { notes: "hijacked" },
      },
    );
    expect(status, "Alice was able to mutate Bob's slot").toBe(403);
  });

  // ── days ─────────────────────────────────────────────────────
  it("blocks Alice from POSTing a new day into Bob's itinerary", async () => {
    const { status } = await apiReq(
      `/data/travel/itineraries/${bobsItineraryId}/days`,
      {
        method: "POST",
        token: alice.apiToken,
        body: { label: "phantom day" },
      },
    );
    expect(status, "Alice was able to add a day to Bob's itinerary").toBe(403);
  });

  it("blocks Alice from PUT-replacing the days array on Bob's itinerary", async () => {
    const { status } = await apiReq(
      `/data/travel/itineraries/${bobsItineraryId}/days`,
      {
        method: "PUT",
        token: alice.apiToken,
        body: { days: [] },
      },
    );
    expect(status, "Alice was able to wipe Bob's itinerary days").toBe(403);
  });

  // ── flights ──────────────────────────────────────────────────
  it("blocks Alice from POSTing a flight into Bob's itinerary day", async () => {
    const { status } = await apiReq(
      `/data/travel/itineraries/${bobsItineraryId}/days/0/flights`,
      {
        method: "POST",
        token: alice.apiToken,
        body: { activity_id: bobsActivityId },
      },
    );
    expect(status).toBe(403);
  });

  // ── activity geocode (mutates activity) ─────────────────────
  it("blocks Alice from POST /activities/:id/geocode on Bob's activity", async () => {
    const { status } = await apiReq(
      `/data/travel/activities/${bobsActivityId}/geocode`,
      {
        method: "POST",
        token: alice.apiToken,
        body: { searchQuery: "anywhere" },
      },
    );
    // 403 from our ownership check; 500 (api key missing) would also
    // signal the geocode actually ran, which is the failure we're
    // catching — assert strictly on 403.
    expect(status, "Alice was able to trigger geocode on Bob's activity").toBe(403);
  });

  // ── positive paths — Bob on his own itinerary ──────────────
  it("lets Bob POST a slot into his own itinerary", async () => {
    const { status, data } = await apiReq(
      `/data/travel/itineraries/${bobsItineraryId}/days/0/slots`,
      {
        method: "POST",
        token: bob.apiToken,
        body: { activity_id: bobsActivityId, notes: "Bob's slot" },
      },
    );
    expect(status).toBeLessThan(400);
    expect((data as { day_index: number }).day_index).toBe(0);
  });

  it("lets Bob POST a new day into his own itinerary", async () => {
    const { status, data } = await apiReq(
      `/data/travel/itineraries/${bobsItineraryId}/days`,
      {
        method: "POST",
        token: bob.apiToken,
        body: { label: "Bob's day 2" },
      },
    );
    expect(status).toBeLessThan(400);
    expect((data as { days_count: number }).days_count).toBeGreaterThanOrEqual(2);
  });
});
