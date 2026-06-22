/**
 * E2E tests for the life-goal routes (`/data/life/goals/*`) exercised through
 * the same HTTP API the MCP tools call. Pins happy-path CRUD, the validation
 * rules (frequency⇒days, sum⇒unit, duplicate id), the STRUCTURAL immutability
 * of id/scope/kind/metric (the route can't forward them, so a patch carrying
 * them is a no-op — not a 400), cross-user isolation, and the progress
 * evaluator (which shares the pure evaluateGoal with the dashboard).
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
    headers: { Authorization: `Bearer ${userPb.authStore.token}`, "Content-Type": "application/json" },
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
    headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: resp.status, data: await resp.json().catch(() => null) };
}

const goalIds = (data: any): string[] => (data.goals as Array<{ id: string }>).map((g) => g.id);

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword("test-admin@test.local", "testpassword1234");
  alice = await makeActor("alice-goal");
  bob = await makeActor("bob-goal");
});

describe("life goals: CRUD round-trip", () => {
  it("a fresh caller has no goals", async () => {
    const { status, data } = await req("/data/life/goals", { token: alice.apiToken });
    expect(status).toBe(200);
    expect(data.goals).toEqual([]);
  });

  it("adds a goal and lists it back", async () => {
    const add = await req("/data/life/goals", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "hydrate", label: "Hydrate", scope: { thing: "water" }, kind: "at_least", metric: "sum", unit: "oz", target: 64, period: "day" },
    });
    expect(add.status).toBe(201);
    expect(goalIds(add.data)).toContain("hydrate");
    const list = await req("/data/life/goals", { token: alice.apiToken });
    expect((list.data.goals as any[]).find((g) => g.id === "hydrate")).toMatchObject({
      kind: "at_least", metric: "sum", unit: "oz", target: 64, period: "day",
    });
  });

  it("rejects a duplicate id with 409", async () => {
    const dup = await req("/data/life/goals", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "hydrate", label: "Dup", scope: { thing: "water" }, kind: "at_least", metric: "count", target: 1, period: "day" },
    });
    expect(dup.status).toBe(409);
  });

  it("rejects sum without a unit (400)", async () => {
    const bad = await req("/data/life/goals", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "nounit", label: "No unit", scope: { thing: "water" }, kind: "at_least", metric: "sum", target: 10, period: "day" },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.data.error)).toMatch(/unit/i);
  });

  it("rejects frequency with a non-days metric (400)", async () => {
    const bad = await req("/data/life/goals", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "freqbad", label: "Bad freq", scope: { group: "exercise" }, kind: "frequency", metric: "count", target: 3, period: "week" },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.data.error)).toMatch(/days/i);
  });

  it("patches the mutable fields and keeps id immutable", async () => {
    const patch = await req("/data/life/goals/hydrate", {
      method: "PATCH",
      token: alice.apiToken,
      body: { target: 80, period: "week" },
    });
    expect(patch.status).toBe(200);
    expect((patch.data.goals as any[]).find((g) => g.id === "hydrate")).toMatchObject({ target: 80, period: "week" });
  });

  it("ignores scope/kind/metric in a patch — immutability is structural", async () => {
    // The route's patch type is the goal's PAYLOAD keyspace, so it cannot
    // forward id/scope/kind/metric at all — a client passing them is a no-op,
    // not a rejection (the old 400 immutability throw is gone). The identity
    // stays exactly as created.
    const scope = await req("/data/life/goals/hydrate", { method: "PATCH", token: alice.apiToken, body: { scope: { thing: "coffee" } } });
    expect(scope.status).toBe(200);
    const kind = await req("/data/life/goals/hydrate", { method: "PATCH", token: alice.apiToken, body: { kind: "at_most" } });
    expect(kind.status).toBe(200);
    const metric = await req("/data/life/goals/hydrate", { method: "PATCH", token: alice.apiToken, body: { metric: "count" } });
    expect(metric.status).toBe(200);
    // Identity unchanged despite the ignored fields.
    expect((metric.data.goals as any[]).find((g) => g.id === "hydrate")).toMatchObject({
      scope: { thing: "water" }, kind: "at_least", metric: "sum",
    });
  });

  it("removes a goal (404 to patch afterward)", async () => {
    const del = await req("/data/life/goals/hydrate", { method: "DELETE", token: alice.apiToken });
    expect(del.status).toBe(200);
    expect(goalIds(del.data)).not.toContain("hydrate");
    const after = await req("/data/life/goals/hydrate", { method: "PATCH", token: alice.apiToken, body: { target: 1 } });
    expect(after.status).toBe(404);
  });
});

describe("life goals: a goal-write through the route preserves sibling keys", () => {
  // Locks the shared applyManifestMutation path on a GOALS route (the trackable
  // route already has this guard). Seed an explicit `views: []` on the log, add
  // a goal through the real route, confirm `views` is STILL [] — not dropped to
  // undefined (→ DEFAULT_VIEWS), not reverted. `[]` is load-bearing.
  it("a POST /life/goals leaves an explicit views [] intact", async () => {
    const carol = await makeActor("carol-goal");
    await req("/data/life/goals", { token: carol.apiToken }); // get-or-create the log

    const logs = await adminPb.collection("life_logs").getList(1, 1, {
      filter: adminPb.filter("owner = {:uid}", { uid: carol.id }),
      sort: "created",
    });
    const log = logs.items[0];
    await adminPb.collection("life_logs").update(log.id, {
      manifest: { ...(log.manifest as Record<string, unknown>), views: [] },
    });

    const add = await req("/data/life/goals", {
      method: "POST",
      token: carol.apiToken,
      body: { id: "carol-goal", label: "Carol", scope: { thing: "water" }, kind: "at_least", metric: "count", target: 1, period: "day" },
    });
    expect(add.status).toBe(201);

    const after = await adminPb.collection("life_logs").getOne(log.id);
    const manifest = after.manifest as any;
    expect(manifest.goals.map((g: any) => g.id)).toContain("carol-goal");
    expect(manifest.views, "views: [] must survive the goals RMW").toEqual([]);
  });
});

describe("life goals: cross-user isolation", () => {
  it("bob cannot see or touch alice's goals", async () => {
    await req("/data/life/goals", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "alice-only", label: "Alice", scope: { thing: "water" }, kind: "at_least", metric: "count", target: 1, period: "day" },
    });
    const bobList = await req("/data/life/goals", { token: bob.apiToken });
    expect(goalIds(bobList.data)).not.toContain("alice-only");
    // bob patching alice's goal id hits bob's own (absent) goal → 404
    const bobPatch = await req("/data/life/goals/alice-only", { method: "PATCH", token: bob.apiToken, body: { target: 9 } });
    expect(bobPatch.status).toBe(404);
  });
});

describe("life goals: progress evaluation", () => {
  it("evaluates a goal against the caller's own events", async () => {
    // Resolve alice's log + add a goal + two qualifying water events today.
    const list = await req("/data/life/goals", { token: alice.apiToken });
    const logId = list.data.log as string;
    await req("/data/life/goals", {
      method: "POST",
      token: alice.apiToken,
      body: { id: "water-prog", label: "Water", scope: { thing: "water" }, kind: "at_least", metric: "sum", unit: "oz", target: 64, period: "day" },
    });
    const now = new Date();
    for (const oz of [40, 30]) {
      const add = await req("/data/life/entries", {
        method: "POST",
        token: alice.apiToken,
        body: { log: logId, subject_id: "water", entries: [{ name: "amount", type: "number", value: oz, unit: "oz" }], timestamp: now.toISOString() },
      });
      expect(add.status).toBe(201);
    }
    const prog = await req("/data/life/goals/progress", { token: alice.apiToken });
    expect(prog.status).toBe(200);
    const water = (prog.data.progress as any[]).find((p) => p.id === "water-prog");
    expect(water).toMatchObject({ value: 70, target: 64, met: true, remaining: 0 });
  });

  it("rejects a malformed date (400)", async () => {
    const bad = await req("/data/life/goals/progress?date=not-a-date", { token: alice.apiToken });
    expect(bad.status).toBe(400);
  });

  it("a beyond-horizon old event does not change value or streak (fetch windowing)", async () => {
    // The route windows the events fetch to the loosest streak horizon. An event
    // far older than MAX_STREAK_LOOKBACK periods can't affect any goal's current
    // value or streak — windowing it out must produce IDENTICAL output. We prove
    // this end-to-end: a daily count goal, one qualifying event today, and one
    // ~3 years ago (well past the 366-day day-goal horizon). Value must be 1 and
    // streak 1 (today only) — the ancient event neither inflates nor extends.
    const fred = await makeActor("fred-goal");
    const list = await req("/data/life/goals", { token: fred.apiToken });
    const logId = list.data.log as string;
    await req("/data/life/goals", {
      method: "POST",
      token: fred.apiToken,
      body: { id: "floss-prog", label: "Floss", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 1, period: "day" },
    });
    const ref = new Date();
    const ancient = new Date(ref.getTime() - 3 * 365 * 86400000); // ~3y ago
    for (const ts of [ref, ancient]) {
      const add = await req("/data/life/entries", {
        method: "POST",
        token: fred.apiToken,
        body: { log: logId, subject_id: "floss", entries: [{ name: "count", type: "number", value: 1, unit: "ct" }], timestamp: ts.toISOString() },
      });
      expect(add.status).toBe(201);
    }
    const prog = await req(`/data/life/goals/progress?date=${encodeURIComponent(ref.toISOString())}`, { token: fred.apiToken });
    expect(prog.status).toBe(200);
    const floss = (prog.data.progress as any[]).find((p) => p.id === "floss-prog");
    expect(floss).toMatchObject({ value: 1, met: true, streak: 1 });
  });
});

describe("life goals: reorder", () => {
  it("reorders goals to a given permutation, manifest-only", async () => {
    // A dedicated actor with a known three-goal set, so the permutation is
    // self-contained regardless of what other suites added to alice/bob.
    const carol = await makeActor("carol-goal");
    const seed = [
      { id: "g-a", label: "A", scope: { thing: "water" }, kind: "at_least", metric: "count", target: 1, period: "day" },
      { id: "g-b", label: "B", scope: { thing: "water" }, kind: "at_most", metric: "count", target: 3, period: "day" },
      { id: "g-c", label: "C", scope: { group: "exercise" }, kind: "frequency", metric: "days", target: 2, period: "week" },
    ];
    for (const g of seed) {
      const add = await req("/data/life/goals", { method: "POST", token: carol.apiToken, body: g });
      expect(add.status).toBe(201);
    }
    const order = ["g-c", "g-a", "g-b"];
    const re = await req("/data/life/goals/reorder", { method: "POST", token: carol.apiToken, body: { order } });
    expect(re.status).toBe(200);
    expect(goalIds(re.data)).toEqual(order);
    // Persisted: a fresh GET reflects the new order.
    const list = await req("/data/life/goals", { token: carol.apiToken });
    expect(goalIds(list.data)).toEqual(order);
  });

  it("reorders a goal set that includes a HIDDEN goal", async () => {
    // The habit board renders only visible goals but persists a full
    // permutation of ALL goals (hidden included). Seed a set with a hidden
    // goal and confirm a full-permutation reorder round-trips — the dashboard's
    // visible-id reorder must splice hidden ids back in before calling this.
    const erin = await makeActor("erin-goal");
    const seed = [
      { id: "h-a", label: "A", scope: { thing: "water" }, kind: "at_least", metric: "count", target: 1, period: "day" },
      { id: "h-b", label: "B", scope: { thing: "water" }, kind: "at_most", metric: "count", target: 3, period: "day", hidden: true },
      { id: "h-c", label: "C", scope: { group: "exercise" }, kind: "frequency", metric: "days", target: 2, period: "week" },
    ];
    for (const g of seed) {
      const add = await req("/data/life/goals", { method: "POST", token: erin.apiToken, body: g });
      expect(add.status).toBe(201);
    }
    const order = ["h-c", "h-b", "h-a"];
    const re = await req("/data/life/goals/reorder", { method: "POST", token: erin.apiToken, body: { order } });
    expect(re.status).toBe(200);
    expect(goalIds(re.data)).toEqual(order);
    // The hidden goal kept its hidden flag through the reorder.
    const hb = (re.data.goals as Array<{ id: string; hidden?: boolean }>).find((g) => g.id === "h-b");
    expect(hb?.hidden).toBe(true);
    const list = await req("/data/life/goals", { token: erin.apiToken });
    expect(goalIds(list.data)).toEqual(order);
  });

  it("rejects a non-permutation order (400)", async () => {
    const dave = await makeActor("dave-goal");
    await req("/data/life/goals", {
      method: "POST",
      token: dave.apiToken,
      body: { id: "only", label: "Only", scope: { thing: "water" }, kind: "at_least", metric: "count", target: 1, period: "day" },
    });
    const re = await req("/data/life/goals/reorder", { method: "POST", token: dave.apiToken, body: { order: ["only", "ghost"] } });
    expect(re.status).toBe(400);
  });
});
