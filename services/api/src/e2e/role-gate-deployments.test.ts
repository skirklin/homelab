/**
 * Regression test for the role-based write gate on /data/deployments
 * and /data/pod_events.
 *
 * These collections are NOT tenant-scoped (deployment history and k8s
 * Events are infrastructure-wide / global), so the per-user ownership
 * pattern from recipes/travel doesn't apply. Instead the route layer
 * gates writes on `api_tokens.roles` including `"infra"`.
 *
 * Pre-fix: any hlk_ token (e.g. a user-minted Settings token) could
 * POST a deployment record with a forged git_sha and have it show up
 * in the monitor frontend, or DELETE arbitrary pod_events rows.
 *
 * Post-fix: those writes/deletes return 403 unless the caller's token
 * record has `roles: ["infra"]`.
 *
 * Requires `pnpm test:env:up`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { createHash, randomBytes } from "crypto";
import { getPbTestUrl } from "./pb-test-url";

process.env.PB_URL = getPbTestUrl();
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const { default: { app } } = await import("../test-app");

const PB_URL = getPbTestUrl();

interface Actor {
  id: string;
  email: string;
  userJwt: string;
  apiToken: string;
}

let adminPb: PocketBase;
let alice: Actor;
let infraToken: string;
let seededPodEventId: string;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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

/**
 * Mint a token directly via admin-PB and stamp it with `roles: ["infra"]`.
 * Mirrors the rollout path where the operator manually patches the existing
 * HOMELAB_API_TOKEN record after this migration ships.
 */
async function makeInfraToken(userId: string): Promise<string> {
  const raw = "hlk_" + randomBytes(32).toString("base64url");
  await adminPb.collection("api_tokens").create({
    user: userId,
    name: "infra-test-token",
    token_hash: hashToken(raw),
    token_prefix: raw.slice(0, 12) + "...",
    last_used: null,
    expires_at: null,
    roles: ["infra"],
  });
  return raw;
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
  // The infra token is bound to a real user too (the schema requires it),
  // but the role — not the user — is what authorizes the call.
  infraToken = await makeInfraToken(alice.id);

  // Seed a pod_event for DELETE tests so we have something to (try to) clobber.
  const ev = await adminPb.collection("pod_events").create({
    uid: `seed-${randomBytes(4).toString("hex")}`,
    namespace: "homelab",
    involved_kind: "Pod",
    involved_name: "seed-victim",
    type: "Normal",
    reason: "Seed",
    message: "seed event for retention DELETE test",
    source: "test",
    count: 1,
    first_seen: new Date(Date.now() - 86_400_000).toISOString(),
    last_seen: new Date(Date.now() - 86_400_000).toISOString(),
  });
  seededPodEventId = ev.id;
});

describe("role-gated writes on /data/deployments (infra-only)", () => {
  it("blocks Alice's normal hlk_ token from POSTing a deployment", async () => {
    const { status } = await apiReq("/data/deployments", {
      method: "POST",
      token: alice.apiToken,
      body: {
        git_sha: "deadbeefcafe",
        git_subject: "forged by alice",
        status: "success",
        deployer: "attacker@evil.example",
      },
    });
    expect(
      status,
      "Alice was able to plant a fake deployment record",
    ).toBe(403);
  });

  it("blocks Alice from DELETEing a deployment record", async () => {
    // Seed something to try to delete so we can distinguish 403 from 404.
    const real = await adminPb.collection("deployments").create({
      git_sha: "real-sha",
      status: "success",
    });
    const { status } = await apiReq(`/data/deployments/${real.id}`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status).toBe(403);
    // And the row should still be there.
    const stillThere = await adminPb.collection("deployments").getOne(real.id);
    expect(stillThere.id).toBe(real.id);
  });

  it("allows the infra-role token to POST a deployment", async () => {
    const { status, data } = await apiReq("/data/deployments", {
      method: "POST",
      token: infraToken,
      body: {
        git_sha: "legitsha1234",
        git_subject: "legit deploy",
        status: "success",
        deployer: "ci@kirkl.in",
      },
    });
    expect(status).toBe(201);
    expect((data as { id: string }).id).toMatch(/.+/);
  });

  it("allows the infra-role token to DELETE a deployment", async () => {
    const created = await adminPb.collection("deployments").create({
      git_sha: "tombstone-sha",
      status: "success",
    });
    const { status } = await apiReq(`/data/deployments/${created.id}`, {
      method: "DELETE",
      token: infraToken,
    });
    expect(status).toBe(200);
  });
});

describe("role-gated writes on /data/pod_events (infra-only)", () => {
  it("blocks Alice's normal hlk_ token from POSTing a pod_event", async () => {
    const { status } = await apiReq("/data/pod_events", {
      method: "POST",
      token: alice.apiToken,
      body: {
        uid: `forged-${randomBytes(4).toString("hex")}`,
        namespace: "homelab",
        involved_kind: "Pod",
        involved_name: "fake-victim",
        type: "Warning",
        reason: "Forged",
        message: "alice was here",
      },
    });
    expect(
      status,
      "Alice was able to plant a fake pod_event",
    ).toBe(403);
  });

  it("blocks Alice from DELETEing pod_events by retention sweep", async () => {
    const before = new Date(Date.now() + 86_400_000).toISOString();
    const { status } = await apiReq(
      `/data/pod_events?before=${encodeURIComponent(before)}`,
      { method: "DELETE", token: alice.apiToken },
    );
    expect(status).toBe(403);
    // Seeded row should still be present.
    const stillThere = await adminPb.collection("pod_events").getOne(seededPodEventId);
    expect(stillThere.id).toBe(seededPodEventId);
  });

  it("allows the infra-role token to POST a pod_event", async () => {
    const { status, data } = await apiReq("/data/pod_events", {
      method: "POST",
      token: infraToken,
      body: {
        uid: `legit-${randomBytes(4).toString("hex")}`,
        namespace: "homelab",
        involved_kind: "Pod",
        involved_name: "legit",
        type: "Normal",
        reason: "Created",
        message: "watcher reporting in",
      },
    });
    expect(status).toBe(201);
    expect((data as { action: string }).action).toBe("created");
  });

  it("allows the infra-role token to DELETE pod_events older than `before`", async () => {
    // Seed one we want to delete with a `last_seen` strictly before `before`.
    const target = await adminPb.collection("pod_events").create({
      uid: `expire-${randomBytes(4).toString("hex")}`,
      namespace: "homelab",
      involved_kind: "Pod",
      involved_name: "expired",
      type: "Normal",
      reason: "Old",
      message: "stale event",
      source: "test",
      count: 1,
      first_seen: new Date(Date.now() - 172_800_000).toISOString(),
      last_seen: new Date(Date.now() - 172_800_000).toISOString(),
    });
    const before = new Date(Date.now() - 3600_000).toISOString();
    const { status, data } = await apiReq(
      `/data/pod_events?before=${encodeURIComponent(before)}`,
      { method: "DELETE", token: infraToken },
    );
    expect(status).toBe(200);
    expect((data as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);
    await expect(
      adminPb.collection("pod_events").getOne(target.id),
    ).rejects.toThrow();
  });
});

describe("read paths remain unchanged (audit only flagged writes)", () => {
  it("Alice can GET /data/deployments (read is not role-gated)", async () => {
    const { status } = await apiReq("/data/deployments", {
      token: alice.apiToken,
    });
    expect(status).toBe(200);
  });

  it("Alice can GET /data/pod_events (read is not role-gated)", async () => {
    const { status } = await apiReq("/data/pod_events", {
      token: alice.apiToken,
    });
    expect(status).toBe(200);
  });
});
