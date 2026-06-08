/**
 * Regression test for the trip-prep deadline-reminder fan-out bug.
 *
 * The old recipient rule in deadlines.ts was union(list.owners, notify_users):
 * a one_shot task on a list shared by {A, B} pinged BOTH A and B on its
 * deadline, regardless of who the task was for. Scott's "Buy flight tickets"
 * woke up Angela.
 *
 * The fix is an `inherit`-strategy cascade (resolveNotifyRecipients): nearest
 * ancestor on the node's `path` chain with an explicit notify_users wins, self
 * overrides ancestors, and the terminal floor is the task's OWN created_by —
 * NOT the list owners. This test pins:
 *   - bare task, created_by = A, no notify config anywhere → [A] only (the bug)
 *   - task whose ancestor container has notify_users = [B]  → [B]
 *   - task with its own notify_users = [A]                  → [A] (override)
 *   - POST /tasks persists notify_users + stamps created_by (was dropped)
 *
 * Builds real PB records so the `path` format (self-inclusive, "/"-joined ids)
 * is exercised end-to-end, then resolves via the same helper the cron uses.
 *
 * Requires the per-worktree test env (infra/test-env.sh up).
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";
import { getPbTestUrl } from "./pb-test-url";
import {
  resolveNotifyRecipients,
  type NotifyNode,
} from "../lib/notifications/deadlines";

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
let userA: Actor;
let userB: Actor;
let sharedListId: string;

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

  return {
    id: user.id,
    email,
    userJwt: userPb.authStore.token,
    apiToken: tokenData.token,
  };
}

/**
 * Create a task row with a correct self-inclusive `path`. Mirrors what the
 * POST /tasks handler does (root path === id; child path === parentPath/id).
 */
async function makeTask(fields: {
  list: string;
  name: string;
  parent_id?: string;
  notify_users?: string[];
  created_by?: string;
  task_type?: string;
  deadline?: string;
  deadline_lead_days?: number;
}): Promise<NotifyNode & { id: string }> {
  const rec = await adminPb.collection("tasks").create({
    list: fields.list,
    name: fields.name,
    parent_id: fields.parent_id || "",
    notify_users: fields.notify_users || [],
    created_by: fields.created_by || "",
    task_type: fields.task_type || "one_shot",
    deadline: fields.deadline || null,
    deadline_lead_days: fields.deadline_lead_days ?? null,
  });
  let path = rec.id;
  if (fields.parent_id) {
    const parent = await adminPb.collection("tasks").getOne(fields.parent_id);
    path = `${parent.path}/${rec.id}`;
  }
  const updated = await adminPb.collection("tasks").update(rec.id, { path });
  return updated as unknown as NotifyNode & { id: string };
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );

  userA = await makeActor("notify-a");
  userB = await makeActor("notify-b");

  // A list owned by BOTH A and B — the shared-list shape that triggered the bug.
  const list = await adminPb.collection("task_lists").create({
    name: "Shared trip list",
    owners: [userA.id, userB.id],
  });
  sharedListId = list.id;
});

describe("resolveNotifyRecipients — inherit cascade", () => {
  it("bare task created_by=A, no notify config → [A] only, NOT {A,B}", async () => {
    const task = await makeTask({
      list: sharedListId,
      name: "Buy flight tickets",
      created_by: userA.id,
      deadline: new Date().toISOString(),
      deadline_lead_days: 7,
    });

    const recipients = resolveNotifyRecipients(
      task,
      new Map(),
      [userA.id, userB.id], // list owners — must NOT be the floor
    );

    expect(recipients).toEqual([userA.id]);
    expect(recipients).not.toContain(userB.id);
  });

  it("ancestor container with notify_users=[B] → child resolves to [B]", async () => {
    const container = await makeTask({
      list: sharedListId,
      name: "Trips/Paris",
      created_by: userA.id,
      notify_users: [userB.id],
    });
    const child = await makeTask({
      list: sharedListId,
      name: "Book Louvre tickets",
      parent_id: container.id,
      created_by: userA.id, // creator is A, but the container says notify B
      deadline: new Date().toISOString(),
      deadline_lead_days: 7,
    });

    const ancestorsById = new Map<string, NotifyNode>([[container.id, container]]);
    const recipients = resolveNotifyRecipients(child, ancestorsById, [userA.id, userB.id]);

    expect(recipients).toEqual([userB.id]);
  });

  it("task's own notify_users=[A] overrides an ancestor's [B]", async () => {
    const container = await makeTask({
      list: sharedListId,
      name: "Trips/Tokyo",
      created_by: userA.id,
      notify_users: [userB.id],
    });
    const child = await makeTask({
      list: sharedListId,
      name: "Personal errand",
      parent_id: container.id,
      created_by: userB.id,
      notify_users: [userA.id], // self overrides ancestor
      deadline: new Date().toISOString(),
      deadline_lead_days: 7,
    });

    const ancestorsById = new Map<string, NotifyNode>([[container.id, container]]);
    const recipients = resolveNotifyRecipients(child, ancestorsById, [userA.id, userB.id]);

    expect(recipients).toEqual([userA.id]);
  });

  it("legacy task: no notify config AND no created_by → falls back to list owners", () => {
    const legacy: NotifyNode = { path: "legacyid", notify_users: [], created_by: "" };
    const recipients = resolveNotifyRecipients(legacy, new Map(), [userA.id, userB.id]);
    expect(new Set(recipients)).toEqual(new Set([userA.id, userB.id]));
  });
});

describe("POST /tasks create path", () => {
  it("persists an explicit notify_users and stamps created_by from auth", async () => {
    const resp = await app.request("/data/tasks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userA.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        list: sharedListId,
        name: "Created via API",
        notify_users: [userB.id],
        deadline: new Date().toISOString(),
        deadline_lead_days: 3,
      }),
    });
    expect(resp.status).toBe(201);
    const { id } = (await resp.json()) as { id: string };

    const row = await adminPb.collection("tasks").getOne(id);
    expect(row.notify_users).toEqual([userB.id]);
    // created_by stamped from the authenticated caller (A), not client body.
    expect(row.created_by).toBe(userA.id);
  });
});
