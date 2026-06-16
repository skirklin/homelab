/**
 * E2E test for the Phase-2 Health Connect mapper POST /health/ingest
 * (served as /fn/health/ingest in prod). Confirms it is behind authMiddleware,
 * that an hlk_ API token authenticates and identifies the caller, that records
 * map into life_events with the right subjects/units/conversions, that daily
 * counters bucket by local day (one event/day), and that re-posting the same
 * payload is a no-op (high-water-mark guard).
 *
 * Requires `pnpm test:env:up`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";
import { getPbTestUrl } from "./pb-test-url";

process.env.PB_URL = getPbTestUrl();
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const { default: { app } } = await import("../test-app");

const PB_URL = getPbTestUrl();

let adminPb: PocketBase;
let userId: string;
let apiToken: string;

type LifeEvent = {
  id: string;
  subject_id: string;
  timestamp: string;
  end_time: string | null;
  entries: { name: string; type: string; value: number; unit?: string }[];
  labels: Record<string, string> | null;
  source_id?: string;
};

async function ingest(opts: { token?: string; body?: unknown }) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const resp = await app.request("/health/ingest", {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: resp.status, data: await resp.json().catch(() => null) };
}

/** Read the caller's life log (as admin) → its events + manifest. */
async function ownLog() {
  const logs = await adminPb.collection("life_logs").getList(1, 1, {
    filter: adminPb.filter("owner = {:uid}", { uid: userId }),
  });
  return logs.items[0] ?? null;
}

async function ownEvents(): Promise<LifeEvent[]> {
  const log = await ownLog();
  if (!log) return [];
  const rows = await adminPb.collection("life_events").getFullList({
    filter: adminPb.filter("log = {:log}", { log: log.id }),
    sort: "-timestamp",
  });
  return rows as unknown as LifeEvent[];
}

function bySubject(events: LifeEvent[], subject: string): LifeEvent[] {
  return events.filter((e) => e.subject_id === subject);
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword("test-admin@test.local", "testpassword1234");

  const email = `health-ingest-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: "Health Ingest Test User",
  });
  userId = user.id;

  const userPb = new PocketBase(PB_URL);
  userPb.autoCancellation(false);
  await userPb.collection("users").authWithPassword(email, password);
  const tokenResp = await app.request("/auth/tokens", {
    method: "POST",
    headers: { Authorization: `Bearer ${userPb.authStore.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "health-ingest-test-token" }),
  });
  apiToken = ((await tokenResp.json()) as { token: string }).token;
});

// A representative multi-type payload. The three steps records span different
// hours but all fall on the SAME local day (07:00 / 07:01 / 08:30 PT, all
// 2026-06-14) so they collapse into ONE daily bucket totaling 410.
const PAYLOAD = {
  timestamp: "2026-06-14T20:00:00Z",
  app_version: "1.2.3",
  source: "health-connect",
  weight: [{ kilograms: 80, time: "2026-06-14T15:00:00Z" }],
  resting_heart_rate: [{ bpm: 58, time: "2026-06-14T15:00:00Z" }],
  body_fat: [{ percentage: 18.34, time: "2026-06-14T15:00:00Z" }],
  respiratory_rate: [{ rate: 14.27, time: "2026-06-14T15:00:00Z" }],
  // 14:00, 14:01, 15:30 UTC = 07:00 / 07:01 / 08:30 PT — all 2026-06-14 PT.
  steps: [
    { count: 100, start_time: "2026-06-14T14:00:00Z", end_time: "2026-06-14T14:01:00Z" },
    { count: 250, start_time: "2026-06-14T14:01:00Z", end_time: "2026-06-14T14:02:00Z" },
    { count: 60, start_time: "2026-06-14T15:30:00Z", end_time: "2026-06-14T15:31:00Z" },
  ],
  distance: [{ meters: 1609.344, start_time: "2026-06-14T14:00:00Z", end_time: "2026-06-14T14:05:00Z" }],
  total_calories: [{ calories: 123.456, start_time: "2026-06-14T14:00:00Z", end_time: "2026-06-14T14:05:00Z" }],
  sleep: [
    {
      session_end_time: "2026-06-14T13:00:00Z",
      duration_seconds: 27000, // 450 min
      stages: [{ stage: "light", start_time: "2026-06-14T05:30:00Z", end_time: "2026-06-14T06:30:00Z", duration_seconds: 3600 }],
    },
  ],
  exercise: [
    { type: "79", start_time: "2026-06-14T16:00:00Z", end_time: "2026-06-14T16:30:00Z", duration_seconds: 1800 },
  ],
  heart_rate: [{ bpm: 70, time: "2026-06-14T16:00:00Z" }], // must be ignored
};

describe("POST /health/ingest (Phase-2 mapper)", () => {
  it("rejects unauthenticated requests", async () => {
    const { status } = await ingest({ body: { timestamp: "2026-06-14T00:00:00Z" } });
    expect(status).toBe(401);
  });

  it("maps records into life_events with correct subjects/units/conversions", async () => {
    const { status, data } = await ingest({ token: apiToken, body: PAYLOAD });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.user).toBe(userId);

    const events = await ownEvents();

    // heart_rate is ignored entirely.
    expect(bySubject(events, "heart_rate")).toHaveLength(0);

    // weight: 80 kg → 176.4 lb
    const weight = bySubject(events, "weight");
    expect(weight).toHaveLength(1);
    expect(weight[0].entries[0]).toMatchObject({ name: "amount", value: 176.4, unit: "lb" });
    expect(weight[0].source_id).toBe("hc:weight:2026-06-14T15:00:00Z");

    // resting hr passthrough
    expect(bySubject(events, "resting_hr")[0].entries[0]).toMatchObject({ value: 58, unit: "bpm" });
    // respiratory rate rounded to 1 dp
    expect(bySubject(events, "respiratory_rate")[0].entries[0]).toMatchObject({ value: 14.3, unit: "br/min" });
    // body fat rounded to 1 dp
    expect(bySubject(events, "body_fat")[0].entries[0]).toMatchObject({ value: 18.3, unit: "%" });

    // sleep: 450 min, end_time set, timestamp = first stage start
    const sleep = bySubject(events, "sleep");
    expect(sleep).toHaveLength(1);
    expect(sleep[0].entries[0]).toMatchObject({ name: "duration", value: 450, unit: "min" });
    expect(sleep[0].end_time).toBe("2026-06-14 13:00:00.000Z");
    expect(sleep[0].timestamp).toBe("2026-06-14 05:30:00.000Z");

    // exercise: 30 min, category mapped from enum "79" → Running
    const exercise = bySubject(events, "exercise");
    expect(exercise).toHaveLength(1);
    expect(exercise[0].entries[0]).toMatchObject({ name: "duration", value: 30, unit: "min" });
    expect(exercise[0].labels).toMatchObject({ category: "Running" });
    expect(exercise[0].end_time).toBe("2026-06-14 16:30:00.000Z");

    // steps: ONE daily bucket for 2026-06-14 PT = 100 + 250 + 60 = 410
    const steps = bySubject(events, "steps");
    expect(steps).toHaveLength(1);
    expect(steps[0].entries[0]).toMatchObject({ value: 410, unit: "ct" });
    // source_id keyed on the owner-tz local day, timestamp = noon of that day PT.
    expect(steps[0].source_id).toBe("hc:steps:2026-06-14");
    expect(steps[0].timestamp).toBe("2026-06-14 19:00:00.000Z"); // noon PT = 19:00 UTC (PDT)
    // hwm label stamped
    expect(steps[0].labels?.hwm).toBeTruthy();

    // distance: 1609.344 m → 1 mi
    const distance = bySubject(events, "distance");
    expect(distance).toHaveLength(1);
    expect(distance[0].entries[0]).toMatchObject({ value: 1, unit: "mi" });

    // calories: 123.456 → 123.5 kcal
    const calories = bySubject(events, "calories");
    expect(calories).toHaveLength(1);
    expect(calories[0].entries[0]).toMatchObject({ value: 123.5, unit: "kcal" });
  });

  it("auto-adds the trackables to the manifest", async () => {
    const log = await ownLog();
    const manifest = log!.manifest as { trackables: { id: string; shape: string }[] };
    const ids = new Set(manifest.trackables.map((t) => t.id));
    for (const id of ["weight", "resting_hr", "respiratory_rate", "body_fat", "steps", "distance", "calories", "sleep", "exercise"]) {
      expect(ids.has(id), `manifest missing trackable ${id}`).toBe(true);
    }
  });

  it("skips a malformed counter record (unparseable start_time) without 500ing", async () => {
    const before = await ownEvents();
    const beforeCount = before.length;
    const { status, data } = await ingest({
      token: apiToken,
      body: {
        timestamp: "2026-06-15T00:00:00Z",
        source: "health-connect",
        // One unparseable start_time (must be skipped, not crash) + one valid
        // record on a brand-new local day (must be written).
        steps: [
          { count: 999, start_time: "not-a-date", end_time: "2026-06-15T01:01:00Z" },
          { count: 42, start_time: "2026-06-15T18:00:00Z", end_time: "2026-06-15T18:05:00Z" },
        ],
      },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    // The malformed record is counted as skipped; the valid one writes a steps row.
    expect(data.skipped).toBeGreaterThan(0);
    expect(data.written.steps).toBe(1);

    const after = await ownEvents();
    expect(after.length).toBe(beforeCount + 1);
    // The written value reflects ONLY the valid record (42), not the malformed one.
    const newRow = after.find((e) => !before.some((b) => b.id === e.id));
    expect(newRow!.subject_id).toBe("steps");
    expect(newRow!.entries[0].value).toBe(42);
  });

  it("is idempotent: re-posting the same payload creates no duplicates and does not double counters", async () => {
    const before = await ownEvents();
    const beforeCount = before.length;
    const stepsBefore = bySubject(before, "steps")
      .map((s) => s.entries[0].value)
      .sort((a, b) => a - b);

    const { status, data } = await ingest({ token: apiToken, body: PAYLOAD });
    expect(status).toBe(200);
    // Everything already present → all skipped, nothing written.
    expect(Object.keys(data.written)).toHaveLength(0);
    expect(data.skipped).toBeGreaterThan(0);

    const after = await ownEvents();
    expect(after.length).toBe(beforeCount); // no new rows

    const stepsAfter = bySubject(after, "steps")
      .map((s) => s.entries[0].value)
      .sort((a, b) => a - b);
    expect(stepsAfter).toEqual(stepsBefore); // counters did NOT double
  });

  it("accumulates a later record on the same local day into the SAME day event (no new row)", async () => {
    // The 2026-06-14 PT steps day already holds 410 (from PAYLOAD). A delta-sync
    // adding a brand-new record (past the stored hwm) in a different hour of the
    // SAME local day must fold into that one row, not create a second event.
    const before = await ownEvents();
    const dayRow = bySubject(before, "steps").find((s) => s.source_id === "hc:steps:2026-06-14");
    expect(dayRow).toBeTruthy();
    expect(dayRow!.entries[0].value).toBe(410);
    const beforeCount = before.length;

    const { status, data } = await ingest({
      token: apiToken,
      body: {
        timestamp: "2026-06-14T23:00:00Z",
        source: "health-connect",
        // 22:00 UTC = 15:00 PT, still 2026-06-14 PT, end_time past the prior hwm.
        steps: [{ count: 90, start_time: "2026-06-14T22:00:00Z", end_time: "2026-06-14T22:05:00Z" }],
      },
    });
    expect(status).toBe(200);
    expect(data.written.steps).toBe(1); // an UPDATE to the existing day row

    const after = await ownEvents();
    expect(after.length).toBe(beforeCount); // folded in, no new row
    const updated = bySubject(after, "steps").find((s) => s.source_id === "hc:steps:2026-06-14");
    expect(updated!.entries[0].value).toBe(500); // 410 + 90
  });
});
