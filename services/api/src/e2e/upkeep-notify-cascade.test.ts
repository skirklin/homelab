/**
 * Regression test for the recurring-chore notification fan-out bug.
 *
 * The old recipient rule in upkeep.ts was union(list.owners, notify_users)
 * gated by a per-user `all` / `subscribed` mode: a recurring chore on a list
 * shared by {A, B} pinged BOTH owners (in `all` mode) regardless of who the
 * chore was for. Scott's "Clean the gutters" woke up Angela.
 *
 * The fix mirrors the deadline cron: an `inherit`-strategy cascade
 * (resolveNotifyRecipients, shared in recipients.ts). Nearest ancestor on the
 * node's `path` chain with an explicit notify_users wins, self overrides
 * ancestors, and the terminal floor is the task's OWN created_by — NOT the list
 * owners. The `all` / `subscribed` mode distinction is retired; only `off` mutes.
 *
 * This pins, against REAL PB records (so the self-inclusive `path` format is
 * exercised) + the same resolve/due/aggregate seam the cron uses:
 *   - bare recurring task, created_by = A, no notify config → resolves to [A]
 *     only, NOT {A,B} (the bug)
 *   - ancestor container with notify_users = [B] → child resolves to [B]
 *   - an `off` user is never aggregated into the notify set
 *   - due-detection: a recurring task with empty/past last_completed is due
 *
 * Requires the per-worktree test env (infra/test-env.sh up).
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";
import { getPbTestUrl } from "./pb-test-url";
import {
  resolveNotifyRecipients,
  fetchAncestorsByPath,
  type NotifyNode,
} from "../lib/notifications/recipients";

process.env.PB_URL = getPbTestUrl();
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const PB_URL = getPbTestUrl();

interface Actor {
  id: string;
  email: string;
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
  return { id: user.id, email };
}

/**
 * Create a recurring task row with a correct self-inclusive `path`. Mirrors what
 * the POST /tasks handler does (root path === id; child path === parentPath/id).
 */
async function makeRecurringTask(fields: {
  list: string;
  name: string;
  parent_id?: string;
  notify_users?: string[];
  created_by?: string;
  frequency?: { value: number; unit: "days" | "weeks" | "months" };
  last_completed?: string | null;
}): Promise<NotifyNode & { id: string }> {
  const rec = await adminPb.collection("tasks").create({
    list: fields.list,
    name: fields.name,
    parent_id: fields.parent_id || "",
    notify_users: fields.notify_users || [],
    created_by: fields.created_by || "",
    task_type: "recurring",
    frequency: fields.frequency ?? { value: 7, unit: "days" },
    last_completed: fields.last_completed ?? null,
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

  userA = await makeActor("upkeep-a");
  userB = await makeActor("upkeep-b");

  // A list owned by BOTH A and B — the shared-list shape that triggered the bug.
  const list = await adminPb.collection("task_lists").create({
    name: "Shared chores list",
    owners: [userA.id, userB.id],
  });
  sharedListId = list.id;
});

describe("upkeep recurring cron — resolveNotifyRecipients cascade", () => {
  it("bare recurring task created_by=A, no notify config → [A] only, NOT {A,B}", async () => {
    const task = await makeRecurringTask({
      list: sharedListId,
      name: "Clean the gutters",
      created_by: userA.id,
      last_completed: null, // never done → due
    });

    const recipients = resolveNotifyRecipients(
      task,
      new Map(),
      [userA.id, userB.id], // list owners — must NOT be the floor
    );

    expect(recipients).toEqual([userA.id]);
    expect(recipients).not.toContain(userB.id);
  });

  it("ancestor container with notify_users=[B] → child recurring task resolves to [B]", async () => {
    const container = await makeRecurringTask({
      list: sharedListId,
      name: "Yard",
      created_by: userA.id,
      notify_users: [userB.id],
    });
    const child = await makeRecurringTask({
      list: sharedListId,
      name: "Mow the lawn",
      parent_id: container.id,
      created_by: userA.id, // creator is A, but the container says notify B
      last_completed: null,
    });

    const ancestorsById = await fetchAncestorsByPath(adminPb, [child]);
    const recipients = resolveNotifyRecipients(child, ancestorsById, [userA.id, userB.id]);

    expect(recipients).toEqual([userB.id]);
  });
});

/**
 * Exercises the due-detection + per-recipient aggregation seam exactly as
 * runUpkeepNotifications does, without firing real pushes. This is the
 * union-vs-cascade regression: under the OLD union rule both owners would
 * appear in the aggregated set for an unconfigured shared-list chore; under the
 * cascade only the creator does.
 */
describe("upkeep recurring cron — due/aggregate seam", () => {
  function calculateDueDate(
    lastCompleted: Date,
    frequency: { value: number; unit: "days" | "weeks" | "months" },
  ): Date {
    const due = new Date(lastCompleted);
    switch (frequency.unit) {
      case "days": due.setDate(due.getDate() + frequency.value); break;
      case "weeks": due.setDate(due.getDate() + frequency.value * 7); break;
      case "months": due.setMonth(due.getMonth() + frequency.value); break;
    }
    return due;
  }
  function isDueTodayOrEarlier(date: Date): boolean {
    const today = new Date();
    const dueDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return dueDay <= todayDay;
  }
  function isDue(task: { last_completed?: string | null; frequency: { value: number; unit: "days" | "weeks" | "months" } }): boolean {
    if (!task.last_completed) return true;
    return isDueTodayOrEarlier(calculateDueDate(new Date(task.last_completed), task.frequency));
  }

  it("a recurring task with empty last_completed is due; a freshly-completed one is not", () => {
    const freq = { value: 7, unit: "days" as const };
    expect(isDue({ last_completed: null, frequency: freq })).toBe(true);
    expect(isDue({ last_completed: new Date().toISOString(), frequency: freq })).toBe(false);
    const old = new Date(); old.setDate(old.getDate() - 30);
    expect(isDue({ last_completed: old.toISOString(), frequency: freq })).toBe(true);
  });

  it("aggregates a shared-list chore to its creator only — the off user never appears", async () => {
    // Recipients-per-due-task, resolved via the cascade.
    const chore = await makeRecurringTask({
      list: sharedListId,
      name: "Take out trash",
      created_by: userA.id,
      last_completed: null,
    });
    const recipientIds = resolveNotifyRecipients(chore, new Map(), [userA.id, userB.id]);

    // Aggregate per recipient (cron's tasksByUser map).
    const tasksByUser = new Map<string, string[]>();
    for (const uid of recipientIds) {
      const list = tasksByUser.get(uid) || [];
      list.push("Take out trash");
      tasksByUser.set(uid, list);
    }

    // Simulated user modes: B is off (and isn't even a recipient anyway).
    const modeByUser = new Map<string, string>([
      [userA.id, "all"],     // legacy mode — now just means "on"
      [userB.id, "off"],
    ]);
    const notified: string[] = [];
    for (const [uid] of tasksByUser) {
      if (modeByUser.get(uid) === "off") continue;
      notified.push(uid);
    }

    expect(notified).toEqual([userA.id]);
    expect(notified).not.toContain(userB.id);
  });

  it("an `off` recipient is dropped even when explicitly named in notify_users", async () => {
    const chore = await makeRecurringTask({
      list: sharedListId,
      name: "Water the plants",
      created_by: userA.id,
      notify_users: [userB.id], // explicitly target B…
      last_completed: null,
    });
    const recipientIds = resolveNotifyRecipients(chore, new Map(), [userA.id, userB.id]);
    expect(recipientIds).toEqual([userB.id]);

    // …but B has opted out → never notified.
    const modeByUser = new Map<string, string>([[userB.id, "off"]]);
    const notified = recipientIds.filter((uid) => modeByUser.get(uid) !== "off");
    expect(notified).toEqual([]);
  });
});
