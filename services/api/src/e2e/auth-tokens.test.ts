/**
 * Integration tests for the API token system.
 * Tests the full flow: create → list → use → revoke.
 *
 * Uses Hono's testClient — no need to start a separate server.
 * Requires: PocketBase running on localhost:8091 (docker-compose.test.yml)
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { createHash, randomBytes } from "crypto";
import { testClient } from "hono/testing";

// Build the Hono app the same way index.ts does, but with test PB URL
process.env.PB_URL = "http://127.0.0.1:8091";
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

// Dynamic import so env vars are set first
const { default: { app } } = await import("../test-app");

const PB_URL = "http://127.0.0.1:8091";

let adminPb: PocketBase;
let userId: string;
let userToken: string;

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword("test-admin@test.local", "testpassword1234");

  const email = `test-${Date.now()}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: "Test User",
  });
  userId = user.id;

  const userPb = new PocketBase(PB_URL);
  userPb.autoCancellation(false);
  await userPb.collection("users").authWithPassword(email, password);
  userToken = userPb.authStore.token;
});

async function apiReq(path: string, opts: { method?: string; token: string; body?: unknown }): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": "application/json",
  };
  const resp = await app.request(path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: resp.status, data: await resp.json() };
}

describe("API Token System", () => {
  let createdToken: string;

  it("creates a token with PB user auth", async () => {
    const { status, data } = await apiReq("/auth/tokens", {
      method: "POST",
      token: userToken,
      body: { name: "Test Token" },
    });

    expect(status).toBe(200);
    expect(data.token).toMatch(/^hlk_/);
    expect(data.name).toBe("Test Token");
    expect(data.prefix).toMatch(/^hlk_/);
    createdToken = data.token;
  });

  it("lists tokens (no raw token exposed)", async () => {
    console.log("ENV:", process.env.PB_URL, process.env.PB_ADMIN_EMAIL);
    const { status, data } = await apiReq("/auth/tokens", { token: userToken });
    console.log("LIST STATUS:", status, "DATA:", JSON.stringify(data).slice(0, 300));

    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    for (const t of data) {
      expect(t.token).toBeUndefined();
      expect(t.token_hash).toBeUndefined();
      expect(t.prefix).toMatch(/^hlk_/);
    }
  });

  it("authenticates with an API token", async () => {
    const { status, data } = await apiReq("/data/boxes", { token: createdToken });
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });

  it("rejects invalid tokens", async () => {
    const { status } = await apiReq("/data/boxes", { token: "hlk_invalid" });
    expect(status).toBe(401);
  });

  it("rejects expired tokens", async () => {
    const token = "hlk_" + randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    await adminPb.collection("api_tokens").create({
      user: userId,
      name: "Expired",
      token_hash: hash,
      token_prefix: "hlk_expir...",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const { status } = await apiReq("/data/boxes", { token });
    expect(status).toBe(401);
  });

  it("revokes a token", async () => {
    // Create one
    const create = await apiReq("/auth/tokens", {
      method: "POST",
      token: userToken,
      body: { name: "To Revoke" },
    });
    const revokeToken = create.data.token;

    // Verify it works
    expect((await apiReq("/data/boxes", { token: revokeToken })).status).toBe(200);

    // Find and revoke
    const list = await apiReq("/auth/tokens", { token: userToken });
    const record = list.data.find((t: { name: string }) => t.name === "To Revoke");
    const del = await apiReq(`/auth/tokens/${record.id}`, { method: "DELETE", token: userToken });
    expect(del.status).toBe(200);

    // Verify revoked
    expect((await apiReq("/data/boxes", { token: revokeToken })).status).toBe(401);
  });

  it("cannot create tokens using an API token", async () => {
    const { status } = await apiReq("/auth/tokens", {
      method: "POST",
      token: createdToken,
      body: { name: "Should Fail" },
    });
    expect(status).toBe(403);
  });
});
