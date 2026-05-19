/**
 * Regression test for cross-tenant writes via `/data/tasks/*` and
 * `/data/life/entries/*` routes.
 *
 * Same admin-PB-bypass shape as cross-tenant-data-routes.test.ts (travel)
 * and cross-tenant-recipes-routes.test.ts (recipes). `hlk_`/`mcpat_`
 * tokens auth against a SUPERUSER PB client; that client ignores PB
 * collection rules entirely, so migration 0024's tightened child rules
 * don't help here — route-level checks are the only thing standing
 * between an attacker's token and a victim's task_list / life_log.
 *
 * Smoking guns these tests pin:
 *   - POST /data/tasks with body.list = victim's list  → cross-tenant create
 *   - PATCH /data/tasks/:id on a victim's task        → cross-tenant mutate
 *   - POST /data/tasks/:id/complete on victim         → tampers with victim's task_events
 *   - POST /data/tasks/:id/move with new_list = attacker's list → THEFT
 *   - POST /data/tasks/:id/{tags,snooze,unsnooze}     → cross-tenant mutate
 *   - DELETE /data/tasks/:id on victim's task         → cascade delete
 *   - POST /data/life/entries with body.log = victim  → cross-tenant create
 *   - PATCH/DELETE /data/life/entries/:id on victim   → cross-tenant mutate
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
let bobsListId: string;
let bobsRecurringTaskId: string;
let bobsOneShotTaskId: string;
let bobsLifeLogId: string;
let bobsLifeEntryId: string;
let alicesListId: string;
let alicesLifeLogId: string;

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

  alice = await makeActor("alice-tl");
  bob = await makeActor("bob-tl");

  // Bob owns a task_list with one recurring + one one_shot task,
  // and a life_log with one entry.
  const bobPb = new PocketBase(PB_URL);
  bobPb.autoCancellation(false);
  bobPb.authStore.save(bob.userJwt, null);

  const bobsList = await bobPb.collection("task_lists").create({
    name: "Bob's list",
    owners: [bob.id],
  });
  bobsListId = bobsList.id;

  const recurring = await bobPb.collection("tasks").create({
    list: bobsListId,
    name: "Bob's recurring task",
    task_type: "recurring",
    frequency: 7,
  });
  bobsRecurringTaskId = recurring.id;
  // Path is normally set by the API route; set it directly here.
  await adminPb.collection("tasks").update(bobsRecurringTaskId, { path: bobsRecurringTaskId });

  const oneShot = await bobPb.collection("tasks").create({
    list: bobsListId,
    name: "Bob's one_shot task",
    task_type: "one_shot",
  });
  bobsOneShotTaskId = oneShot.id;
  await adminPb.collection("tasks").update(bobsOneShotTaskId, { path: bobsOneShotTaskId });

  const bobsLifeLog = await bobPb.collection("life_logs").create({
    name: "Bob's life log",
    owners: [bob.id],
    manifest: { subjects: [] },
    sample_schedule: [],
  });
  bobsLifeLogId = bobsLifeLog.id;

  const bobsEntry = await bobPb.collection("life_events").create({
    log: bobsLifeLogId,
    subject_id: "mood",
    timestamp: new Date().toISOString(),
    created_by: bob.id,
    data: { value: 8, notes: "Bob's notes" },
  });
  bobsLifeEntryId = bobsEntry.id;

  // Alice's own list + life log for testing reparent attacks and to
  // verify Alice's own legitimate ops still work.
  const alicePb = new PocketBase(PB_URL);
  alicePb.autoCancellation(false);
  alicePb.authStore.save(alice.userJwt, null);

  const alicesList = await alicePb.collection("task_lists").create({
    name: "Alice's list",
    owners: [alice.id],
  });
  alicesListId = alicesList.id;

  const alicesLifeLog = await alicePb.collection("life_logs").create({
    name: "Alice's life log",
    owners: [alice.id],
    manifest: { subjects: [] },
    sample_schedule: [],
  });
  alicesLifeLogId = alicesLifeLog.id;
});

describe("cross-tenant writes via /data/tasks/* (admin-PB bypass)", () => {
  it("blocks Alice's hlk_ token from POSTing a task into Bob's list", async () => {
    const { status } = await apiReq("/data/tasks", {
      method: "POST",
      token: alice.apiToken,
      body: { list: bobsListId, name: "phantom task" },
    });
    expect(status, "Alice was able to plant a task in Bob's list").toBe(403);
  });

  it("blocks Alice from PATCHing Bob's task", async () => {
    const { status } = await apiReq(`/data/tasks/${bobsRecurringTaskId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { name: "hijacked task" },
    });
    expect(status, "Alice was able to mutate Bob's task").toBe(403);
  });

  it("blocks Alice from POST /tasks/:id/complete on Bob's recurring task", async () => {
    const { status } = await apiReq(`/data/tasks/${bobsRecurringTaskId}/complete`, {
      method: "POST",
      token: alice.apiToken,
    });
    expect(status, "Alice was able to complete Bob's task").toBe(403);
  });

  it("blocks Alice from POST /tasks/:id/complete on Bob's one_shot task", async () => {
    const { status } = await apiReq(`/data/tasks/${bobsOneShotTaskId}/complete`, {
      method: "POST",
      token: alice.apiToken,
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from POST /tasks/:id/move (theft: into Alice's list)", async () => {
    // Smoking gun for the REPARENT theft attack — pre-fix Alice's token
    // could move Bob's task into Alice's own list, stealing it.
    const { status } = await apiReq(`/data/tasks/${bobsRecurringTaskId}/move`, {
      method: "POST",
      token: alice.apiToken,
      body: { new_list: alicesListId },
    });
    expect(status, "Alice was able to STEAL Bob's task into her list").toBe(403);
  });

  it("blocks Alice from POST /tasks/:id/move (rearrange within Bob's list)", async () => {
    const { status } = await apiReq(`/data/tasks/${bobsRecurringTaskId}/move`, {
      method: "POST",
      token: alice.apiToken,
      body: { position: 99 },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from POST /tasks/:id/tags on Bob's task", async () => {
    const { status } = await apiReq(`/data/tasks/${bobsRecurringTaskId}/tags`, {
      method: "POST",
      token: alice.apiToken,
      body: { add: ["hijacked"] },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from POST /tasks/:id/snooze on Bob's task", async () => {
    const { status } = await apiReq(`/data/tasks/${bobsRecurringTaskId}/snooze`, {
      method: "POST",
      token: alice.apiToken,
      body: { until: "2099-01-01T00:00:00Z" },
    });
    expect(status).toBe(403);
  });

  it("blocks Alice from POST /tasks/:id/unsnooze on Bob's task", async () => {
    const { status } = await apiReq(`/data/tasks/${bobsRecurringTaskId}/unsnooze`, {
      method: "POST",
      token: alice.apiToken,
    });
    expect(status).toBe(403);
  });

  // Bob's-own legitimate operations still work
  it("still lets Bob POST a new task into his own list", async () => {
    const { status, data } = await apiReq("/data/tasks", {
      method: "POST",
      token: bob.apiToken,
      body: { list: bobsListId, name: "Bob's legit task" },
    });
    expect(status).toBeLessThan(400);
    expect((data as { id: string }).id).toBeTruthy();
  });

  it("still lets Bob PATCH his own task", async () => {
    const { status } = await apiReq(`/data/tasks/${bobsRecurringTaskId}`, {
      method: "PATCH",
      token: bob.apiToken,
      body: { name: "Bob's renamed task" },
    });
    expect(status).toBeLessThan(400);
  });

  it("still lets Bob complete his own recurring task", async () => {
    const { status } = await apiReq(`/data/tasks/${bobsRecurringTaskId}/complete`, {
      method: "POST",
      token: bob.apiToken,
    });
    expect(status).toBeLessThan(400);
  });

  it("still lets Bob tag his own task", async () => {
    const { status } = await apiReq(`/data/tasks/${bobsRecurringTaskId}/tags`, {
      method: "POST",
      token: bob.apiToken,
      body: { add: ["legit"] },
    });
    expect(status).toBeLessThan(400);
  });

  // DELETE attacks against fresh fixtures so cascades don't poison later tests
  it("blocks Alice from DELETEing Bob's task (fresh fixture)", async () => {
    const bobPb = new PocketBase(PB_URL);
    bobPb.autoCancellation(false);
    bobPb.authStore.save(bob.userJwt, null);
    const fresh = await bobPb.collection("tasks").create({
      list: bobsListId,
      name: "Bob's throwaway task",
      task_type: "one_shot",
    });
    await adminPb.collection("tasks").update(fresh.id, { path: fresh.id });

    const { status } = await apiReq(`/data/tasks/${fresh.id}`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status, "Alice was able to delete Bob's task").toBe(403);
    const stillThere = await adminPb.collection("tasks").getOne(fresh.id).catch(() => null);
    expect(stillThere, "Bob's task was deleted despite the 403").not.toBeNull();
  });

  it("still lets Bob delete his own task (fresh fixture)", async () => {
    const bobPb = new PocketBase(PB_URL);
    bobPb.autoCancellation(false);
    bobPb.authStore.save(bob.userJwt, null);
    const fresh = await bobPb.collection("tasks").create({
      list: bobsListId,
      name: "Bob's deletable task",
      task_type: "one_shot",
    });
    await adminPb.collection("tasks").update(fresh.id, { path: fresh.id });

    const { status } = await apiReq(`/data/tasks/${fresh.id}`, {
      method: "DELETE",
      token: bob.apiToken,
    });
    expect(status).toBeLessThan(400);
  });
});

describe("cross-tenant writes via /data/life/entries/* (admin-PB bypass)", () => {
  it("blocks Alice from POSTing a life entry into Bob's log", async () => {
    const { status } = await apiReq("/data/life/entries", {
      method: "POST",
      token: alice.apiToken,
      body: { log: bobsLifeLogId, widget_id: "mood", data: { value: 1 } },
    });
    expect(status, "Alice was able to plant a life entry in Bob's log").toBe(403);
  });

  it("blocks Alice from PATCHing Bob's life entry", async () => {
    const { status } = await apiReq(`/data/life/entries/${bobsLifeEntryId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { notes: "tampered" },
    });
    expect(status, "Alice was able to mutate Bob's life entry").toBe(403);
  });

  it("blocks Alice from DELETEing Bob's life entry (fresh fixture)", async () => {
    const bobPb = new PocketBase(PB_URL);
    bobPb.autoCancellation(false);
    bobPb.authStore.save(bob.userJwt, null);
    const fresh = await bobPb.collection("life_events").create({
      log: bobsLifeLogId,
      subject_id: "mood",
      timestamp: new Date().toISOString(),
      created_by: bob.id,
      data: { value: 5 },
    });

    const { status } = await apiReq(`/data/life/entries/${fresh.id}`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status, "Alice was able to delete Bob's life entry").toBe(403);
    const stillThere = await adminPb.collection("life_events").getOne(fresh.id).catch(() => null);
    expect(stillThere, "Bob's life entry was deleted despite the 403").not.toBeNull();
  });

  // Bob's-own legitimate operations still work
  it("still lets Bob POST a life entry into his own log", async () => {
    const { status, data } = await apiReq("/data/life/entries", {
      method: "POST",
      token: bob.apiToken,
      body: { log: bobsLifeLogId, widget_id: "mood", data: { value: 9 } },
    });
    expect(status).toBeLessThan(400);
    expect((data as { id: string }).id).toBeTruthy();
  });

  it("still lets Bob PATCH his own life entry", async () => {
    const { status } = await apiReq(`/data/life/entries/${bobsLifeEntryId}`, {
      method: "PATCH",
      token: bob.apiToken,
      body: { notes: "Bob's updated notes" },
    });
    expect(status).toBeLessThan(400);
  });
});
