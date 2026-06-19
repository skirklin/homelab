/**
 * E2E tests for the life-trackable vocabulary routes (`/data/life/trackables/*`)
 * exercised through the same HTTP API the MCP tools call. Each request carries
 * an `hlk_` token (admin-PB auth), so the route layer is the only ownership
 * gate — these tests pin both the happy-path CRUD and the cross-user isolation
 * + the STRUCTURAL immutability of id AND shape (the route can't forward them,
 * so a patch carrying them is a no-op — not a 400).
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
    // default starter set seeded on first resolve — one trackable per shape
    expect(ids(data)).toContain("water");
    expect(ids(data)).toContain("mood");
    const shapes = (data.trackables as any[]).map((t) => t.shape);
    expect(new Set(shapes)).toEqual(new Set(["took", "did", "happened", "rated"]));
  });

  it("adds a vocab row and lists it back", async () => {
    const add = await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: {
        id: "chinese",
        label: "Chinese practice",
        shape: "did",
        group: "focus",
        defaultDuration: 20,
      },
    });
    expect(add.status).toBe(201);
    expect(ids(add.data)).toContain("chinese");

    const list = await req("/data/life/trackables", { token: alice.apiToken });
    const chinese = (list.data.trackables as any[]).find((t) => t.id === "chinese");
    expect(chinese).toMatchObject({ shape: "did", group: "focus", defaultDuration: 20 });
  });

  it("rejects a duplicate id with 409", async () => {
    const dup = await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "chinese", label: "Dup", shape: "did" },
    });
    expect(dup.status).toBe(409);
  });

  it("rejects an unknown shape", async () => {
    const bad = await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "badshape", label: "Bad", shape: "consumed" },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.data.error)).toMatch(/shape/);
  });

  it("rejects a missing shape", async () => {
    const bad = await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "noshape", label: "No shape" },
    });
    expect(bad.status).toBe(400);
  });

  it("rejects a non-slug id", async () => {
    const bad = await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "Bad Id", label: "x", shape: "took" },
    });
    expect(bad.status).toBe(400);
  });

  it("accepts the reflective `noted` shape and round-trips prompt/hint/placeholder/refs", async () => {
    const add = await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: {
        id: "intention_followup",
        label: "Intention follow-up",
        shape: "noted",
        prompt: "How did {intention} go?",
        hint: "Be honest.",
        placeholder: "How did it turn out? Honest beats tidy.",
        refs: [{ token: "intention", fromTrackable: "daily_intention", within: "day", entry: "note" }],
      },
    });
    expect(add.status).toBe(201);

    const list = await req("/data/life/trackables", { token: alice.apiToken });
    const t = (list.data.trackables as any[]).find((x) => x.id === "intention_followup");
    expect(t).toMatchObject({
      shape: "noted",
      prompt: "How did {intention} go?",
      hint: "Be honest.",
      placeholder: "How did it turn out? Honest beats tidy.",
      refs: [{ token: "intention", fromTrackable: "daily_intention", within: "day", entry: "note" }],
    });
  });
});

describe("life trackables: a manifest mutation preserves sibling keys (views/notifications round-trip)", () => {
  // S2 regression guard. The pure manifest ops were dropping sibling manifest
  // keys, AND the route's manifestFromValue used to read only trackables+goals
  // — so a read-modify-write through the trackable routes silently reverted an
  // explicit `manifest.views: []` (Angela) back to undefined → DEFAULT_VIEWS.
  // This exercises the REAL write path end-to-end: seed `views: []` +
  // `notifications: []` directly on the log, confirm the route's RMW keeps them
  // as `[]` (NOT defaulted, NOT dropped). `[]` is load-bearing.
  it("an addTrackable through the route leaves an explicit views/notifications [] intact", async () => {
    // Carol starts fresh, then we stamp explicit-empty views/notifications onto
    // her log directly (no route authors views in B1 — it's data-model only).
    const carol = await makeActor("carol-tk");
    await req("/data/life/trackables", { token: carol.apiToken }); // get-or-create the log

    const logs = await adminPb.collection("life_logs").getList(1, 1, {
      filter: adminPb.filter("owner = {:uid}", { uid: carol.id }),
      sort: "created",
    });
    const log = logs.items[0];
    const seeded = { ...(log.manifest as Record<string, unknown>), views: [], notifications: [] };
    await adminPb.collection("life_logs").update(log.id, { manifest: seeded });

    // Read back the raw record: views/notifications are explicitly [] (not defaulted).
    const before = await adminPb.collection("life_logs").getOne(log.id);
    expect((before.manifest as any).views).toEqual([]);
    expect((before.manifest as any).notifications).toEqual([]);

    // Mutate the manifest through the real route (read-modify-write).
    const add = await req("/data/life/trackables", {
      method: "POST",
      token: carol.apiToken,
      body: { id: "carol_thing", label: "Carol thing", shape: "happened" },
    });
    expect(add.status).toBe(201);

    // Re-read the raw record: the trackable landed AND views/notifications are
    // STILL [] — not dropped to undefined, not reverted to a default.
    const after = await adminPb.collection("life_logs").getOne(log.id);
    const manifest = after.manifest as any;
    expect(manifest.trackables.map((t: any) => t.id)).toContain("carol_thing");
    expect(manifest.views, "views: [] must survive the RMW").toEqual([]);
    expect(manifest.notifications, "notifications: [] must survive the RMW").toEqual([]);
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

  it("patches and clears prefill defaults", async () => {
    const upd = await req("/data/life/trackables/chinese", {
      method: "PATCH",
      token: alice.apiToken,
      body: { defaultDuration: 25, ratingLabel: "focus" },
    });
    expect(upd.status).toBe(200);
    let t = (upd.data.trackables as any[]).find((x) => x.id === "chinese");
    expect(t.defaultDuration).toBe(25);
    expect(t.ratingLabel).toBe("focus");

    const clr = await req("/data/life/trackables/chinese", {
      method: "PATCH",
      token: alice.apiToken,
      body: { ratingLabel: null },
    });
    t = (clr.data.trackables as any[]).find((x) => x.id === "chinese");
    expect(t.ratingLabel).toBeUndefined();
  });

  it("ignores a trackable id in a patch — immutability is structural", async () => {
    // The route's patch type is the trackable's PAYLOAD keyspace, so it cannot
    // forward `id` — a client passing it is a no-op, not a 400. The identity
    // (id + shape) stays exactly as created.
    const upd = await req("/data/life/trackables/chinese", {
      method: "PATCH",
      token: alice.apiToken,
      body: { id: "mandarin" },
    });
    expect(upd.status).toBe(200);
    expect((upd.data.trackables as any[]).map((t) => t.id)).toContain("chinese");
    expect((upd.data.trackables as any[]).map((t) => t.id)).not.toContain("mandarin");
  });

  it("ignores a shape change in a patch — immutability is structural", async () => {
    // `shape` is likewise unnameable in the payload patch — passing it is a
    // no-op, not a 400. The shape stays "did".
    const upd = await req("/data/life/trackables/chinese", {
      method: "PATCH",
      token: alice.apiToken,
      body: { shape: "took" },
    });
    expect(upd.status).toBe(200);
    expect((upd.data.trackables as any[]).find((x) => x.id === "chinese")).toMatchObject({ shape: "did" });
  });
});

describe("life trackables: remove is manifest-only (events untouched)", () => {
  it("a pre-existing life_event with the subject_id survives removal", async () => {
    // Add a trackable, log an event against it, then remove the trackable.
    await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "reading", label: "Reading", shape: "did", defaultDuration: 30 },
    });
    const log = await req("/data/life/log", { token: alice.apiToken });
    const ev = await req("/data/life/entries", {
      method: "POST",
      token: alice.apiToken,
      body: {
        log: log.data.id,
        subject_id: "reading",
        entries: [{ name: "duration", type: "number", value: 30, unit: "min" }],
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
      body: { id: "reading", label: "Reading again", shape: "did" },
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
      body: { id: "coffee", label: "Coffee", shape: "took", defaultUnit: "oz", defaultAmount: 8 },
    });
    const pin = {
      label: "Big mug",
      entries: [{ name: "amount", type: "number", value: 16, unit: "oz" }],
    };
    const add = await req("/data/life/trackables/coffee/pins", { method: "PUT", token: bob.apiToken, body: { pinned: [pin] } });
    expect(add.status).toBe(200);
    expect(add.data.pinned).toHaveLength(1);

    // Replay the pin: add_life_entry with the pin's exact entries[].
    const log = await req("/data/life/log", { token: bob.apiToken });
    const ev = await req("/data/life/entries", {
      method: "POST",
      token: bob.apiToken,
      body: { log: log.data.id, subject_id: "coffee", entries: pin.entries },
    });
    expect(ev.status, "a pin's entries[] must be a valid, replayable event payload").toBe(201);
  });

  it("accepts a legacy pin with historical entry names + category labels", async () => {
    // History-era pins (name 'volume', labels.category) must keep validating —
    // readers are name-agnostic and labels carry through verbatim.
    const legacy = {
      label: "8 oz drip",
      entries: [{ name: "volume", type: "number", value: 8, unit: "oz" }],
      labels: { category: "drip" },
    };
    const put = await req("/data/life/trackables/coffee/pins", { method: "PUT", token: bob.apiToken, body: { pinned: [legacy] } });
    expect(put.status).toBe(200);
    expect(put.data.pinned[0].labels).toEqual({ category: "drip" });
  });

  it("rejects a pin entry with no unit (raw-HTTP path, bypasses MCP zod)", async () => {
    const bad = await req("/data/life/trackables/coffee/pins", {
      method: "PUT",
      token: bob.apiToken,
      body: { pinned: [{ entries: [{ name: "amount", type: "number", value: 1 }] }] },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.data.error)).toMatch(/non-empty unit/);
  });

  it("rejects a text pin entry (pins replay measurements only)", async () => {
    const bad = await req("/data/life/trackables/coffee/pins", {
      method: "PUT",
      token: bob.apiToken,
      body: { pinned: [{ entries: [{ name: "notes", type: "text", value: "yum" }] }] },
    });
    expect(bad.status).toBe(400);
  });
});

describe("life trackables: cross-user isolation", () => {
  it("Alice's add only touches Alice's manifest, never Bob's", async () => {
    await req("/data/life/trackables", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "alice-only", label: "Alice only", shape: "happened" },
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
