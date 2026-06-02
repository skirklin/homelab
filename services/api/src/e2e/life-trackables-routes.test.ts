/**
 * E2E tests for the P4 life-trackable manifest routes (`/data/life/trackables/*`)
 * exercised through the same HTTP API the MCP tools call. Each request carries
 * an `hlk_` token (admin-PB auth), so the route layer is the only ownership
 * gate — these tests pin both the happy-path CRUD and the cross-user isolation
 * + immutability guarantees.
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

interface Actor {
  id: string;
  apiToken: string;
}

let adminPb: PocketBase;
let alice: Actor;
let bob: Actor;

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
  const tokenData = (await tokenResp.json()) as { token: string };
  return { id: user.id, apiToken: tokenData.token };
}

async function req(
  path: string,
  opts: { method?: string; token: string; body?: unknown },
): Promise<{ status: number; data: any }> {
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

const ids = (data: any): string[] => (data.trackables as Array<{ id: string }>).map((t) => t.id);

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword("test-admin@test.local", "testpassword1234");
  alice = await makeActor("alice-tk");
  bob = await makeActor("bob-tk");
});

describe("life trackables: add → list round-trip + uniqueness", () => {
  it("a fresh caller gets a seeded manifest (get-or-create)", async () => {
    const { status, data } = await req("/data/life/trackables", { token: alice.apiToken });
    expect(status).toBe(200);
    // default starter set seeded on first resolve
    expect(ids(data)).toContain("water");
    expect(ids(data)).toContain("mood");
  });

  it("adds a trackable and lists it back", async () => {
    const add = await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: {
        id: "chinese",
        label: "Chinese practice",
        group: "mind",
        fields: [
          { key: "minutes", type: "number", unit: "min", defaultValue: 20 },
          { key: "mode", type: "category", options: ["vocab", "listening", "reading"] },
        ],
      },
    });
    expect(add.status).toBe(201);
    expect(ids(add.data)).toContain("chinese");

    const list = await req("/data/life/trackables", { token: alice.apiToken });
    const chinese = (list.data.trackables as any[]).find((t) => t.id === "chinese");
    expect(chinese.fields).toHaveLength(2);
    expect(chinese.fields[1].options).toEqual(["vocab", "listening", "reading"]);
  });

  it("rejects a duplicate id with 409", async () => {
    const dup = await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "chinese", label: "Dup", fields: [{ key: "x", type: "number" }] },
    });
    expect(dup.status).toBe(409);
  });

  it("rejects a category field without options", async () => {
    const bad = await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "badcat", label: "Bad", fields: [{ key: "k", type: "category" }] },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.data.error)).toMatch(/options/);
  });

  it("rejects a non-slug id", async () => {
    const bad = await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "Bad Id", label: "x", fields: [{ key: "k", type: "number" }] },
    });
    expect(bad.status).toBe(400);
  });
});

describe("life trackables: update patches + immutability", () => {
  it("patches label/group/hidden", async () => {
    const upd = await req("/data/life/trackables/chinese", {
      method: "PATCH",
      token: alice.apiToken,
      body: { label: "中文", hidden: true, group: "language" },
    });
    expect(upd.status).toBe(200);
    const t = (upd.data.trackables as any[]).find((x) => x.id === "chinese");
    expect(t.label).toBe("中文");
    expect(t.hidden).toBe(true);
    expect(t.group).toBe("language");
  });

  it("allows appending a new field", async () => {
    const upd = await req("/data/life/trackables/chinese", {
      method: "PATCH",
      token: alice.apiToken,
      body: {
        fields: [
          { key: "minutes", type: "number", unit: "min", defaultValue: 20 },
          { key: "mode", type: "category", options: ["vocab", "listening", "reading"] },
          { key: "note", type: "text" },
        ],
      },
    });
    expect(upd.status).toBe(200);
    const t = (upd.data.trackables as any[]).find((x) => x.id === "chinese");
    expect(t.fields.map((f: any) => f.key)).toEqual(["minutes", "mode", "note"]);
  });

  it("rejects renaming the trackable id", async () => {
    const upd = await req("/data/life/trackables/chinese", {
      method: "PATCH",
      token: alice.apiToken,
      body: { id: "mandarin" },
    });
    expect(upd.status).toBe(400);
    expect(String(upd.data.error)).toMatch(/immutable/);
  });

  it("rejects removing an existing field key", async () => {
    const upd = await req("/data/life/trackables/chinese", {
      method: "PATCH",
      token: alice.apiToken,
      body: { fields: [{ key: "minutes", type: "number", unit: "min" }] },
    });
    expect(upd.status).toBe(400);
    expect(String(upd.data.error)).toMatch(/cannot be removed/);
  });

  it("rejects retyping an existing field key", async () => {
    const upd = await req("/data/life/trackables/chinese", {
      method: "PATCH",
      token: alice.apiToken,
      body: {
        fields: [
          { key: "minutes", type: "text" },
          { key: "mode", type: "category", options: ["vocab"] },
          { key: "note", type: "text" },
        ],
      },
    });
    expect(upd.status).toBe(400);
    expect(String(upd.data.error)).toMatch(/cannot change type/);
  });
});

describe("life trackables: remove is manifest-only (events untouched)", () => {
  it("a pre-existing life_event with the subject_id survives removal", async () => {
    // Add a trackable, log an event against it, then remove the trackable.
    await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "reading", label: "Reading", fields: [{ key: "minutes", type: "number", unit: "min" }] },
    });
    const log = await req("/data/life/log", { token: alice.apiToken });
    const ev = await req("/data/life/entries", {
      method: "POST",
      token: alice.apiToken,
      body: {
        log: log.data.id,
        subject_id: "reading",
        entries: [{ name: "minutes", type: "number", value: 30, unit: "min" }],
      },
    });
    expect(ev.status).toBe(201);
    const eventId = ev.data.id as string;

    const rm = await req("/data/life/trackables/reading", { method: "DELETE", token: alice.apiToken });
    expect(rm.status).toBe(200);
    expect(ids(rm.data)).not.toContain("reading");

    // Event still exists in PB.
    const stillThere = await adminPb.collection("life_events").getOne(eventId).catch(() => null);
    expect(stillThere, "removing the trackable must NOT delete its events").not.toBeNull();
    expect(stillThere!.subject_id).toBe("reading");

    // Re-adding the same id re-links: the historical event is still queryable.
    const readd = await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "reading", label: "Reading again", fields: [{ key: "minutes", type: "number", unit: "min" }] },
    });
    expect(readd.status).toBe(201);
    expect(ids(readd.data)).toContain("reading");
  });

  it("removing an absent trackable 404s", async () => {
    const rm = await req("/data/life/trackables/ghost", { method: "DELETE", token: alice.apiToken });
    expect(rm.status).toBe(404);
  });
});

describe("life trackables: reorder", () => {
  it("reorders to a given permutation", async () => {
    const before = await req("/data/life/trackables", { token: alice.apiToken });
    const order = ids(before.data).slice().reverse();
    const re = await req("/data/life/trackables/reorder", { method: "POST", token: alice.apiToken, body: { order } });
    expect(re.status).toBe(200);
    expect(ids(re.data)).toEqual(order);
  });

  it("rejects a non-permutation order", async () => {
    const re = await req("/data/life/trackables/reorder", { method: "POST", token: alice.apiToken, body: { order: ["water"] } });
    expect(re.status).toBe(400);
  });
});

describe("life trackables: pins are history-compatible + replayable", () => {
  it("a pinned payload replays into a valid life_event", async () => {
    await req("/data/life/trackables", {
      method: "POST",
      token: bob.apiToken,
      body: {
        id: "coffee",
        label: "Coffee",
        fields: [
          { key: "cups", type: "number", unit: "ct", defaultValue: 1 },
          { key: "kind", type: "category", options: ["drip", "espresso"] },
        ],
      },
    });
    const pin = {
      label: "Morning espresso",
      entries: [{ name: "cups", type: "number", value: 1, unit: "ct" }],
      labels: { kind: "espresso" },
    };
    const add = await req("/data/life/trackables/coffee/pins", { method: "PUT", token: bob.apiToken, body: { pinned: [pin] } });
    expect(add.status).toBe(200);
    expect(add.data.pinned).toHaveLength(1);

    // Replay the pin: add_life_entry with the pin's entries[].name = field.keys.
    const log = await req("/data/life/log", { token: bob.apiToken });
    const ev = await req("/data/life/entries", {
      method: "POST",
      token: bob.apiToken,
      body: { log: log.data.id, subject_id: "coffee", entries: pin.entries, labels: pin.labels },
    });
    expect(ev.status, "pin's entries[].name must be a valid, replayable event payload").toBe(201);
  });

  it("rejects a pin whose entry name is not a field key", async () => {
    const bad = await req("/data/life/trackables/coffee/pins", {
      method: "PUT",
      token: bob.apiToken,
      body: { pinned: [{ entries: [{ name: "ghost", type: "number", value: 1, unit: "ct" }] }] },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.data.error)).toMatch(/measurement field.key/);
  });

  it("rejects a pin entry whose shape contradicts the field (raw-HTTP path)", async () => {
    // `cups` is a number field; a number entry with no unit must be rejected by
    // the pure op even though raw HTTP callers bypass the MCP zod schema.
    const bad = await req("/data/life/trackables/coffee/pins", {
      method: "PUT",
      token: bob.apiToken,
      body: { pinned: [{ entries: [{ name: "cups", type: "number", value: 1 }] }] },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.data.error)).toMatch(/non-empty unit/);
  });
});

describe("life trackables: cross-user isolation", () => {
  it("Alice's add only touches Alice's manifest, never Bob's", async () => {
    await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "alice-only", label: "Alice only", fields: [{ key: "x", type: "number" }] },
    });
    const bobList = await req("/data/life/trackables", { token: bob.apiToken });
    expect(ids(bobList.data)).not.toContain("alice-only");
  });

  it("there is no log-id parameter — a caller can only ever mutate their own log", async () => {
    // Bob removes a trackable; it can only affect Bob's manifest. Alice keeps hers.
    const aliceBefore = await req("/data/life/trackables", { token: alice.apiToken });
    expect(ids(aliceBefore.data)).toContain("chinese");
    await req("/data/life/trackables/coffee", { method: "DELETE", token: bob.apiToken });
    const aliceAfter = await req("/data/life/trackables", { token: alice.apiToken });
    expect(ids(aliceAfter.data)).toContain("chinese");
    expect(ids(aliceAfter.data)).not.toContain("coffee"); // Alice never had coffee; Bob's removal is isolated
  });
});
