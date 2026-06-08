/**
 * E2E tests for GET /travel/weather (public path: /fn/travel/weather).
 *
 * Auth + window-state coverage is hermetic (no network): it exercises the
 * ownership gate and the not_yet / unknown-dates / no_location branches against
 * a real PocketBase, all of which short-circuit before any Open-Meteo call.
 * Cases that need live Open-Meteo data (in-window forecast, past-trip actual
 * backfill) are opt-in via RUN_LIVE_WEATHER=1 so CI never flakes on an external
 * API.
 *
 * Note: a past trip no longer returns a `past` state — the endpoint now
 * backfills recorded actuals from Open-Meteo's archive and serves them as a
 * complete weather record. With no network it degrades to `available` + empty
 * forecast.
 *
 * Requires: PocketBase running (docker-compose.test.yml / test-env.sh up).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "crypto";
import PocketBase from "pocketbase";
import { getPbTestUrl } from "./pb-test-url";

process.env.PB_URL = getPbTestUrl();
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const { default: { app } } = await import("../test-app");

const PB_URL = getPbTestUrl();

let adminPb: PocketBase;
let userId: string;
let userToken: string;
let otherToken: string;
let otherApiToken: string;
let logId: string;

// Trip IDs by scenario
let inWindowTripId: string;
let notYetTripId: string;
let pastTripId: string;
let noDatesTripId: string;
let noLocationTripId: string;

// Activity IDs on the in-window trip, for the per-activity hourly tests.
let cdmxActivityId: string;     // geocoded, on inWindowTrip
let otherTripActivityId: string; // geocoded, on a DIFFERENT trip (not inWindow)

const cleanup: Array<{ collection: string; id: string }> = [];

function ymd(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

async function req(path: string, token: string) {
  const resp = await app.request(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );

  const mk = async (suffix: string) => {
    const email = `weather-${suffix}-${Date.now()}@example.com`;
    const password = "testpassword123";
    const u = await adminPb.collection("users").create({
      email, password, passwordConfirm: password, name: "Weather Test",
    });
    const pb = new PocketBase(PB_URL);
    pb.autoCancellation(false);
    await pb.collection("users").authWithPassword(email, password);
    cleanup.push({ collection: "users", id: u.id });
    return { id: u.id, token: pb.authStore.token };
  };

  const owner = await mk("owner");
  userId = owner.id;
  userToken = owner.token;
  const other = await mk("other");
  otherToken = other.token;

  // Mint an hlk_ API token for `other` — API tokens auth as a superuser PB
  // client, so PB rules don't pre-empt the route's ownership check. This is the
  // path that exercises the route's own 403 gate (a user JWT just 404s via PB).
  const tokenResp = await app.request("/auth/tokens", {
    method: "POST",
    headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "weather-other-token" }),
  });
  otherApiToken = ((await tokenResp.json()) as { token: string }).token;
  // The create endpoint returns the raw token but not the record id; look the
  // row up by its SHA-256 hash (how it's stored) so teardown can delete it.
  const tokenHash = createHash("sha256").update(otherApiToken).digest("hex");
  const tokenRec = await adminPb
    .collection("api_tokens")
    .getFirstListItem(`token_hash="${tokenHash}"`);
  cleanup.push({ collection: "api_tokens", id: tokenRec.id });

  const log = await adminPb.collection("travel_logs").create({
    name: "Weather Test Log", owners: [userId],
  });
  logId = log.id;
  cleanup.push({ collection: "travel_logs", id: logId });

  // In-window trip starting in 2 days, with a geocoded activity (CDMX) so the
  // coord resolves without a network geocode.
  const inWindow = await adminPb.collection("travel_trips").create({
    log: logId, destination: "Mexico City", status: "Booked",
    start_date: ymd(2), end_date: ymd(5),
  });
  inWindowTripId = inWindow.id;
  cleanup.push({ collection: "travel_trips", id: inWindowTripId });
  const act = await adminPb.collection("travel_activities").create({
    log: logId, trip_id: inWindowTripId, name: "Zócalo",
    category: "Sightseeing", location: "Mexico City", lat: 19.4326, lng: -99.1332,
  });
  cdmxActivityId = act.id;
  cleanup.push({ collection: "travel_activities", id: act.id });

  // Trip starting beyond the 16-day horizon.
  const notYet = await adminPb.collection("travel_trips").create({
    log: logId, destination: "Fairbanks", status: "Idea",
    start_date: ymd(40), end_date: ymd(45),
  });
  notYetTripId = notYet.id;
  cleanup.push({ collection: "travel_trips", id: notYetTripId });
  const otherAct = await adminPb.collection("travel_activities").create({
    log: logId, trip_id: notYetTripId, name: "Aurora viewing",
    category: "Sightseeing", location: "Fairbanks", lat: 64.84, lng: -147.72,
  });
  otherTripActivityId = otherAct.id;
  cleanup.push({ collection: "travel_activities", id: otherAct.id });

  // Trip already ended.
  const past = await adminPb.collection("travel_trips").create({
    log: logId, destination: "Lisbon", status: "Completed",
    start_date: ymd(-20), end_date: ymd(-15),
  });
  pastTripId = past.id;
  cleanup.push({ collection: "travel_trips", id: pastTripId });

  // Trip with no dates.
  const noDates = await adminPb.collection("travel_trips").create({
    log: logId, destination: "Somewhere", status: "Idea",
    start_date: "", end_date: "",
  });
  noDatesTripId = noDates.id;
  cleanup.push({ collection: "travel_trips", id: noDatesTripId });

  // In-window trip whose destination can't be geocoded and has no geocoded
  // activity → no_location.
  const noLoc = await adminPb.collection("travel_trips").create({
    log: logId, destination: "Xyzzyqwerasdf Nowhereville 99999", status: "Booked",
    start_date: ymd(3), end_date: ymd(4),
  });
  noLocationTripId = noLoc.id;
  cleanup.push({ collection: "travel_trips", id: noLocationTripId });
});

afterAll(async () => {
  if (!adminPb) return;
  for (const { collection, id } of cleanup.reverse()) {
    try { await adminPb.collection(collection).delete(id); } catch { /* gone */ }
  }
});

describe("GET /travel/weather", () => {
  it("400s when tripId is missing", async () => {
    const { status, data } = await req("/travel/weather", userToken);
    expect(status).toBe(400);
    expect(data.error).toMatch(/tripId/);
  });

  it("404s for an unknown trip", async () => {
    const { status } = await req("/travel/weather?tripId=doesnotexist000", userToken);
    expect(status).toBe(404);
  });

  it("denies a non-owner via user JWT (PB rules → 404)", async () => {
    const { status } = await req(`/travel/weather?tripId=${inWindowTripId}`, otherToken);
    // A user-scoped PB client can't even read the trip → PB returns 404 before
    // the route's ownership gate. 404 is the correct denial here.
    expect(status).toBe(404);
  });

  it("403s a non-owner holding an API token (route ownership gate)", async () => {
    // API tokens auth as a superuser PB client, so the trip is readable and the
    // route's userOwnsTravelLog gate is what denies — 403.
    const { status } = await req(`/travel/weather?tripId=${inWindowTripId}`, otherApiToken);
    expect(status).toBe(403);
  });

  it("returns not_yet for a trip beyond the 16-day horizon", async () => {
    const { status, data } = await req(`/travel/weather?tripId=${notYetTripId}`, userToken);
    expect(status).toBe(200);
    expect(data.state).toBe("not_yet");
    expect(data.availableFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.forecast).toEqual([]);
    expect(data.packingHints).toEqual([]);
  });

  // A past trip now backfills recorded actuals from Open-Meteo's archive and
  // serves them — it no longer short-circuits to a `past` state. Needs network
  // (geocode + archive fetch), so opt-in like the in-window forecast case.
  it.runIf(process.env.RUN_LIVE_WEATHER === "1")(
    "backfills actuals for a completed trip (live Open-Meteo archive)",
    async () => {
      const { status, data } = await req(`/travel/weather?tripId=${pastTripId}`, userToken);
      expect(status).toBe(200);
      expect(data.state).toBe("available");
      expect(Array.isArray(data.forecast)).toBe(true);
      expect(data.forecast.length).toBeGreaterThan(0);
      // Past days are tagged as recorded actuals.
      expect(data.forecast.every((d: { source: string }) => d.source === "actual")).toBe(true);
    },
  );

  it("returns unknown_dates for a trip without dates", async () => {
    const { status, data } = await req(`/travel/weather?tripId=${noDatesTripId}`, userToken);
    expect(status).toBe(200);
    expect(data.state).toBe("unknown_dates");
  });

  it("returns no_location when no coord can be resolved", async () => {
    const { status, data } = await req(`/travel/weather?tripId=${noLocationTripId}`, userToken);
    expect(status).toBe(200);
    expect(data.state).toBe("no_location");
  });

  // Live Open-Meteo call — opt-in so CI never depends on an external API.
  it.runIf(process.env.RUN_LIVE_WEATHER === "1")(
    "returns a populated forecast for an in-window trip (live Open-Meteo)",
    async () => {
      const { status, data } = await req(`/travel/weather?tripId=${inWindowTripId}`, userToken);
      expect(status).toBe(200);
      expect(data.state).toBe("available");
      expect(data.location.source).toBe("activity");
      expect(Array.isArray(data.forecast)).toBe(true);
      expect(data.forecast.length).toBeGreaterThan(0);
      expect(data.forecast[0]).toHaveProperty("tempMaxF");
      expect(data.forecast[0]).toHaveProperty("precipProbabilityMax");
      expect(data.forecast[0]).toHaveProperty("weatherCode");
      expect(data.forecast[0].source).toBe("forecast");
      expect(Array.isArray(data.packingHints)).toBe(true);
    },
  );
});

describe("GET /travel/weather/hourly (per-activity)", () => {
  function inWindowDate(): string {
    // The in-window trip starts in 2 days; ask for a date inside its span so we
    // stay under the forecast horizon (not_yet guard) even without network.
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 3);
    return d.toISOString().slice(0, 10);
  }

  it("400s when tripId is missing", async () => {
    const { status } = await req(`/travel/weather/hourly?date=${inWindowDate()}&activityIds=x`, userToken);
    expect(status).toBe(400);
  });

  it("400s for a malformed date", async () => {
    const { status } = await req(`/travel/weather/hourly?tripId=${inWindowTripId}&date=nope&activityIds=x`, userToken);
    expect(status).toBe(400);
  });

  it("403s a non-owner holding an API token", async () => {
    const { status } = await req(
      `/travel/weather/hourly?tripId=${inWindowTripId}&date=${inWindowDate()}&activityIds=${cdmxActivityId}`,
      otherApiToken,
    );
    expect(status).toBe(403);
  });

  it("returns an empty byActivity for an empty activityIds list", async () => {
    const { status, data } = await req(
      `/travel/weather/hourly?tripId=${inWindowTripId}&date=${inWindowDate()}&activityIds=`,
      userToken,
    );
    expect(status).toBe(200);
    expect(data.byActivity).toEqual({});
  });

  it("keys byActivity by in-trip activities and omits ones from another trip", async () => {
    // No network is required to exercise resolution + grouping: each coord
    // degrades to an empty hours[] on Open-Meteo failure, but the activity key
    // is still present. The other-trip activity must NOT appear.
    const ids = `${cdmxActivityId},${otherTripActivityId}`;
    const { status, data } = await req(
      `/travel/weather/hourly?tripId=${inWindowTripId}&date=${inWindowDate()}&activityIds=${ids}`,
      userToken,
    );
    expect(status).toBe(200);
    expect(Object.keys(data.byActivity)).toEqual([cdmxActivityId]);
    expect(Array.isArray(data.byActivity[cdmxActivityId])).toBe(true);
    expect(data.byActivity).not.toHaveProperty(otherTripActivityId);
  });
});
