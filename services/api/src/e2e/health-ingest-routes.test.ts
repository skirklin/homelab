/**
 * E2E test for the TEMPORARY Phase-1 capture endpoint POST /health/ingest
 * (served as /fn/health/ingest in prod). Confirms it is behind authMiddleware,
 * that an hlk_ API token authenticates and identifies the caller, and that the
 * response summary counts each present array (absent arrays omitted) and lists
 * the top-level payload keys.
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

async function req(opts: { token?: string; body?: unknown }) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const resp = await app.request("/health/ingest", {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: resp.status, data: await resp.json().catch(() => null) };
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

describe("POST /health/ingest (Phase-1 capture)", () => {
  it("rejects unauthenticated requests", async () => {
    const { status } = await req({ body: { timestamp: "2026-06-14T00:00:00Z" } });
    expect(status).toBe(401);
  });

  it("accepts an hlk_ token and summarizes the payload", async () => {
    const { status, data } = await req({
      token: apiToken,
      body: {
        timestamp: "2026-06-14T00:00:00Z",
        app_version: "1.2.3",
        source: "health-connect",
        steps: [{ count: 1000 }, { count: 2000 }],
        sleep: [{ start: "x", end: "y" }],
        heart_rate: [], // present but empty → counts as 0
        // distance / weight / etc. intentionally absent
      },
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.user).toBe(userId);
    expect(data.received).toEqual({ steps: 2, sleep: 1, heart_rate: 0 });
    // Non-array top-level fields are not counted but are reported in payload_keys.
    expect(data.received).not.toHaveProperty("timestamp");
    expect(data.payload_keys).toEqual([
      "timestamp",
      "app_version",
      "source",
      "steps",
      "sleep",
      "heart_rate",
    ]);
  });

  it("returns an empty summary when no arrays are present", async () => {
    const { status, data } = await req({
      token: apiToken,
      body: { timestamp: "2026-06-14T00:00:00Z", source: "health-connect" },
    });
    expect(status).toBe(200);
    expect(data.received).toEqual({});
    expect(data.payload_keys).toEqual(["timestamp", "source"]);
  });
});
