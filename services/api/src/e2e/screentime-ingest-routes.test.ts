/**
 * E2E test for the Phase-2b screen-time mapper POST /screentime/ingest
 * (served as /fn/screentime/ingest in prod). Confirms it's behind
 * authMiddleware, that an hlk_ API token identifies the caller, that each day
 * maps to one life_event with the right subject/minutes/apps, that the
 * trackable is auto-added, and — critically — that restatement is
 * upsert-REPLACE: identical re-posts are no-ops, a grown total updates in
 * place (not added), and no duplicate rows appear.
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
  entries: { name: string; type: string; value: number | string; unit?: string }[];
  labels: Record<string, string> | null;
  source_id?: string;
};

async function ingest(opts: { token?: string; body?: unknown }) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const resp = await app.request("/screentime/ingest", {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: resp.status, data: await resp.json().catch(() => null) };
}

async function ownLog() {
  const logs = await adminPb.collection("life_logs").getList(1, 1, {
    filter: adminPb.filter("owner = {:uid}", { uid: userId }),
  });
  return logs.items[0] ?? null;
}

async function screenTimeEvents(): Promise<LifeEvent[]> {
  const log = await ownLog();
  if (!log) return [];
  const rows = await adminPb.collection("life_events").getFullList({
    filter: adminPb.filter("log = {:log} && subject_id = 'screen_time'", { log: log.id }),
    sort: "-timestamp",
  });
  return rows as unknown as LifeEvent[];
}

function entryValue(e: LifeEvent, name: string): number | string | undefined {
  return e.entries.find((x) => x.name === name)?.value;
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword("test-admin@test.local", "testpassword1234");

  const email = `screentime-ingest-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: "Screen Time Ingest Test User",
  });
  userId = user.id;

  const userPb = new PocketBase(PB_URL);
  userPb.autoCancellation(false);
  await userPb.collection("users").authWithPassword(email, password);
  const tokenResp = await app.request("/auth/tokens", {
    method: "POST",
    headers: { Authorization: `Bearer ${userPb.authStore.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "screentime-ingest-test-token" }),
  });
  apiToken = ((await tokenResp.json()) as { token: string }).token;
});

const PAYLOAD = {
  timestamp: "2026-06-14T20:00:00Z",
  app_version: "0.1.0",
  device: "Pixel 8",
  source: "screen_time",
  screen_time: [
    {
      date: "2026-06-12",
      total_screen_time_minutes: 240,
      apps: [
        { package: "com.instagram.android", name: "Instagram", minutes: 90, last_used: "2026-06-12T22:00:00Z" },
        { package: "com.google.chrome", name: "Chrome", minutes: 60, last_used: "2026-06-12T21:00:00Z" },
      ],
    },
    {
      date: "2026-06-13",
      total_screen_time_minutes: 180,
      apps: [{ package: "com.slack", name: "Slack", minutes: 120, last_used: "2026-06-13T18:00:00Z" }],
    },
    {
      date: "2026-06-14",
      total_screen_time_minutes: 75,
      apps: [{ package: "com.spotify.music", name: "Spotify", minutes: 40, last_used: "2026-06-14T12:00:00Z" }],
    },
  ],
};

describe("POST /screentime/ingest (Phase-2b mapper)", () => {
  it("rejects unauthenticated requests", async () => {
    const { status } = await ingest({ body: { screen_time: [] } });
    expect(status).toBe(401);
  });

  it("maps each day to one screen_time event with minutes + apps + labels", async () => {
    const { status, data } = await ingest({ token: apiToken, body: PAYLOAD });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.user).toBe(userId);
    expect(data.written.created).toBe(3);
    expect(data.written.updated).toBe(0);

    const events = await screenTimeEvents();
    expect(events).toHaveLength(3);

    const byDate = new Map<string, LifeEvent>();
    for (const e of events) byDate.set(e.source_id!, e);

    const d12 = byDate.get("st:screen_time:2026-06-12")!;
    expect(d12).toBeTruthy();
    expect(entryValue(d12, "amount")).toBe(240);
    expect(d12.entries.find((x) => x.name === "amount")?.unit).toBe("min");
    expect(d12.labels).toMatchObject({ source: "screen_time", device: "Pixel 8" });

    // apps text entry parses back to the canonical {package,name,minutes} shape.
    const apps = JSON.parse(entryValue(d12, "apps") as string);
    expect(apps).toEqual([
      { package: "com.instagram.android", name: "Instagram", minutes: 90 },
      { package: "com.google.chrome", name: "Chrome", minutes: 60 },
    ]);

    // timestamp = noon of the local day. With the default tz (America/Los_Angeles,
    // PDT = UTC-7 in June) noon local = 19:00 UTC.
    expect(d12.timestamp).toBe("2026-06-12 19:00:00.000Z");
  });

  it("auto-adds the screen_time trackable to the manifest", async () => {
    const log = await ownLog();
    const manifest = log!.manifest as { trackables: { id: string; shape: string }[] };
    const st = manifest.trackables.find((t) => t.id === "screen_time");
    expect(st, "manifest missing screen_time trackable").toBeTruthy();
    expect(st!.shape).toBe("took");
  });

  it("is idempotent: re-posting identical data updates nothing and makes no dups", async () => {
    const before = await screenTimeEvents();
    const { status, data } = await ingest({ token: apiToken, body: PAYLOAD });
    expect(status).toBe(200);
    expect(data.written.created).toBe(0);
    expect(data.written.updated).toBe(0);
    expect(data.skipped).toBe(3); // all three days unchanged

    const after = await screenTimeEvents();
    expect(after).toHaveLength(before.length); // no new rows
    const beforeIds = new Set(before.map((e) => e.id));
    expect(after.every((e) => beforeIds.has(e.id))).toBe(true); // same rows
  });

  it("restatement REPLACES (not adds): a grown total updates one day in place", async () => {
    const grown = {
      ...PAYLOAD,
      screen_time: [
        // 2026-06-14's total grew from 75 → 130; other two days unchanged.
        {
          date: "2026-06-14",
          total_screen_time_minutes: 130,
          apps: [{ package: "com.spotify.music", name: "Spotify", minutes: 95 }],
        },
        PAYLOAD.screen_time[0],
        PAYLOAD.screen_time[1],
      ],
    };
    const { status, data } = await ingest({ token: apiToken, body: grown });
    expect(status).toBe(200);
    expect(data.written.created).toBe(0);
    expect(data.written.updated).toBe(1); // only 2026-06-14 changed
    expect(data.skipped).toBe(2); // the two unchanged days

    const events = await screenTimeEvents();
    const d14 = events.find((e) => e.source_id === "st:screen_time:2026-06-14")!;
    // REPLACE: stored value is the new total (130), NOT 75+130.
    expect(entryValue(d14, "amount")).toBe(130);
    const apps = JSON.parse(entryValue(d14, "apps") as string);
    expect(apps).toEqual([{ package: "com.spotify.music", name: "Spotify", minutes: 95 }]);

    // Still exactly 3 rows — replace, not insert.
    expect(events).toHaveLength(3);
  });

  it("skips days with no date and ignores an empty screen_time array", async () => {
    const { status, data } = await ingest({
      token: apiToken,
      body: {
        timestamp: "2026-06-15T00:00:00Z",
        device: "Pixel 8",
        source: "screen_time",
        screen_time: [{ total_screen_time_minutes: 50, apps: [] }], // no date → skip
      },
    });
    expect(status).toBe(200);
    expect(data.written.created).toBe(0);
    expect(data.skipped).toBe(1);

    const empty = await ingest({
      token: apiToken,
      body: { timestamp: "2026-06-15T00:00:00Z", source: "screen_time", screen_time: [] },
    });
    expect(empty.status).toBe(200);
    expect(empty.data.written.created).toBe(0);
    expect(empty.data.skipped).toBe(0);
  });
});
