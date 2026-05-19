/**
 * Regression test for cross-tenant writes via `/data/*` routes.
 *
 * `hlk_` (and `mcpat_`) tokens authenticate in the middleware against
 * a SUPERUSER PocketBase client (services/api/src/middleware/auth.ts).
 * That client bypasses PB collection rules entirely. So the rule
 * tightening from migration 0024 protects the *direct PB API* — but
 * the API service's own `/data/*` routes pass through admin PB and
 * therefore still let any token holder write into any user's resource
 * unless the route itself checks `c.get("userId")`.
 *
 * This test demonstrates the cross-tenant write paths the security
 * audit flagged: POST /data/travel/trips with a victim's log id, and
 * PATCH /data/travel/trips/:id with a verbatim body that can also
 * reparent the trip into another log. The same pattern applies to
 * activities + itineraries — covered too.
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
let alicesLogId: string;

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

  // Mint an hlk_ API token via the API service (same path the UI uses).
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

  alice = await makeActor("alice");
  bob = await makeActor("bob");

  // Bob owns a travel_log with a trip, activity, and itinerary inside it.
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
    days: [],
  });
  bobsItineraryId = bobsItinerary.id;

  // Alice owns a separate log she could legitimately operate on.
  const alicePb = new PocketBase(PB_URL);
  alicePb.autoCancellation(false);
  alicePb.authStore.save(alice.userJwt, null);
  const alicesLog = await alicePb.collection("travel_logs").create({
    name: "Alice's log",
    owners: [alice.id],
  });
  alicesLogId = alicesLog.id;
});

describe("cross-tenant writes via /data/travel/* (admin-PB bypass)", () => {
  it("blocks Alice's hlk_ token from POSTing a trip into Bob's log", async () => {
    const { status } = await apiReq("/data/travel/trips", {
      method: "POST",
      token: alice.apiToken,
      body: { log: bobsLogId, destination: "phantom trip", status: "Booked" },
    });
    expect(status, "Alice was able to plant a trip in Bob's log").toBe(403);
  });

  it("blocks Alice's hlk_ token from PATCHing Bob's trip", async () => {
    const { status } = await apiReq(`/data/travel/trips/${bobsTripId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { destination: "hijacked" },
    });
    expect(status, "Alice was able to mutate Bob's trip").toBe(403);
  });

  it("blocks Alice's hlk_ token from PATCH-reparenting Bob's trip to her log", async () => {
    // The verbatim-body PATCH pre-fix accepted arbitrary fields, including
    // `log`, letting an attacker move a victim's trip into the attacker's
    // own log (effectively stealing it).
    const { status } = await apiReq(`/data/travel/trips/${bobsTripId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { log: alicesLogId },
    });
    expect(status, "Alice was able to reparent Bob's trip").toBe(403);
  });

  it("blocks Alice from POSTing an activity into Bob's log", async () => {
    const { status } = await apiReq("/data/travel/activities", {
      method: "POST",
      token: alice.apiToken,
      body: { log: bobsLogId, name: "phantom activity" },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from PATCHing Bob's activity", async () => {
    const { status } = await apiReq(`/data/travel/activities/${bobsActivityId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { name: "hijacked activity" },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from POSTing an itinerary into Bob's log", async () => {
    const { status } = await apiReq("/data/travel/itineraries", {
      method: "POST",
      token: alice.apiToken,
      body: { log: bobsLogId, trip_id: bobsTripId, name: "phantom" },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from PATCHing Bob's itinerary", async () => {
    const { status } = await apiReq(`/data/travel/itineraries/${bobsItineraryId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { name: "hijacked" },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from DELETEing Bob's trip", async () => {
    const { status } = await apiReq(`/data/travel/trips/${bobsTripId}`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status).toBe(403);
  });

  it("still lets Bob operate on his own log", async () => {
    const { status, data } = await apiReq("/data/travel/trips", {
      method: "POST",
      token: bob.apiToken,
      body: { log: bobsLogId, destination: "legit trip", status: "Booked" },
    });
    expect(status).toBeLessThan(400);
    expect((data as { destination: string }).destination).toBe("legit trip");
  });

  it("still lets Bob PATCH his own trip", async () => {
    // Use a freshly-created trip — earlier tests may have deleted bobsTripId.
    const created = await apiReq("/data/travel/trips", {
      method: "POST",
      token: bob.apiToken,
      body: { log: bobsLogId, destination: "patchable", status: "Booked" },
    });
    const id = (created.data as { id: string }).id;
    const { status } = await apiReq(`/data/travel/trips/${id}`, {
      method: "PATCH",
      token: bob.apiToken,
      body: { destination: "Bob's renamed trip" },
    });
    expect(status).toBeLessThan(400);
  });
});
