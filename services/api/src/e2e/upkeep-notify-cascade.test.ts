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
 * node's `path` chain with an explicit `assignees` set wins, self overrides
 * ancestors, and the terminal floor is the task's OWN created_by — NOT the list
 * owners. `assignees` (formerly `notify_users`) is the sole notification
 * driver. The `all` / `subscribed` mode distinction is retired; only `off` mutes.
 *
 * This pins, against REAL PB records (so the self-inclusive `path` format is
 * exercised) + the same resolve/due/aggregate seam the cron uses:
 *   - bare recurring task, created_by = A, no assignees → resolves to [A]
 *     only, NOT {A,B} (the bug)
 *   - ancestor container with assignees = [B] → child resolves to [B]
 *   - an `off` user is never aggregated into the notify set
 *   - due-detection: a recurring task with empty/past last_completed is due
 *
 * Requires the per-worktree test env (infra/test-env.sh up).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";
import { getPbTestUrl } from "./pb-test-url";
import {
  resolveNotifyRecipients,
  fetchAncestorsByPath,
  type NotifyNode,
} from "../lib/notifications/recipients";

// upkeep.ts → push.ts reads VAPID keys at import-time and `sendPushToUser`
// calls ensureVapid()/setVapidDetails() (which validates key length) before its
// zero-subscription early return. Generate a REAL, well-formed VAPID keypair —
// dummy strings fail web-push's 65-byte validation. With no push_subscriptions
// in the test PB, sendPushToUser still returns {sent:0} without touching the
// network, but the cron stamps the user, which is what these tests observe.
vi.hoisted(async () => {
  const { default: webpush } = await import("web-push");
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
});

process.env.PB_URL = getPbTestUrl();
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const { runUpkeepNotifications } = await import("../lib/notifications/upkeep");

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
  assignees?: string[];
  created_by?: string;
  frequency?: { value: number; unit: "days" | "weeks" | "months" };
  last_completed?: string | null;
}): Promise<NotifyNode & { id: string }> {
  const rec = await adminPb.collection("tasks").create({
    list: fields.list,
    name: fields.name,
    parent_id: fields.parent_id || "",
    assignees: fields.assignees || [],
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

  it("ancestor container with assignees=[B] → child recurring task resolves to [B]", async () => {
    const container = await makeRecurringTask({
      list: sharedListId,
      name: "Yard",
      created_by: userA.id,
      assignees: [userB.id],
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

  it("an `off` recipient is dropped even when explicitly named in assignees", async () => {
    const chore = await makeRecurringTask({
      list: sharedListId,
      name: "Water the plants",
      created_by: userA.id,
      assignees: [userB.id], // explicitly target B…
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

/**
 * Drives the REAL runUpkeepNotifications() against the test PB and asserts on
 * observable PB state — the `last_task_notification` stamp the cron writes on
 * every user it notifies. With no push_subscriptions in the test PB,
 * sendPushToUser is a no-op (returns {sent:0}), but the cron still stamps +
 * counts the user, so the stamp is the ground-truth signal of "who would be
 * notified." This is the case that actually exercises the union-retirement and
 * the in-cron `off` check (the helper-level tests above re-implement the cron's
 * logic inline; this one runs the cron itself).
 */
describe("upkeep recurring cron — runUpkeepNotifications drives PB state", () => {
  const todayLA = () =>
    new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  /** Pacific calendar day of a stamp, or null if unset. */
  const stampDay = (v: unknown): string | null =>
    v ? new Date(v as string).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) : null;

  /**
   * Neutralize every user in the PB by stamping last_task_notification = today
   * (so the cron's per-user-per-day idempotency check skips them), THEN clear
   * the stamp on just the users this case cares about. This makes the cron's
   * global {notified, skipped} counts deterministic regardless of tasks/users
   * left over from earlier describe blocks in this same file.
   */
  async function isolateUsers(clearIds: string[]): Promise<void> {
    const now = new Date().toISOString();
    const all = await adminPb.collection("users").getFullList({ $autoCancel: false });
    for (const u of all) {
      await adminPb.collection("users").update(u.id, { last_task_notification: now }, { $autoCancel: false });
    }
    for (const id of clearIds) {
      await adminPb.collection("users").update(id, { last_task_notification: null }, { $autoCancel: false });
    }
  }

  const stampOf = async (id: string): Promise<string | null> =>
    stampDay((await adminPb.collection("users").getOne(id)).last_task_notification);

  it("bare recurring chore created_by=A on a {A,B} list stamps A only, NOT B (union retired)", async () => {
    const a = await makeActor("cron-a");
    const b = await makeActor("cron-b");
    const list = await adminPb.collection("task_lists").create({
      name: "Cron shared list 1",
      owners: [a.id, b.id],
    });
    await makeRecurringTask({
      list: list.id,
      name: "Cron clean gutters",
      created_by: a.id, // no explicit assignees
      last_completed: null, // never done → due
    });

    await isolateUsers([a.id, b.id]);
    const { notified, skipped } = await runUpkeepNotifications();

    // A (the creator / resolved recipient) is stamped today; B is not.
    // The OLD union-mode code would have stamped B too.
    expect(await stampOf(a.id)).toBe(todayLA());
    expect(await stampOf(b.id)).toBe(null);

    // Counts: exactly one user newly notified (A); everyone else pre-stamped → skipped.
    expect(notified).toBe(1);
    expect(skipped).toBeGreaterThanOrEqual(0);
  });

  it("an `off` user who IS a resolved recipient is never stamped", async () => {
    const off = await makeActor("cron-off");
    const list = await adminPb.collection("task_lists").create({
      name: "Cron off list",
      owners: [off.id],
    });
    await makeRecurringTask({
      list: list.id,
      name: "Cron off chore",
      created_by: off.id, // resolves to the off user
      last_completed: null,
    });

    await isolateUsers([off.id]);
    // The user opts fully out → the cron must skip on the `off` check, not the stamp.
    await adminPb.collection("users").update(off.id, { upkeep_notification_mode: "off" }, { $autoCancel: false });

    const { notified } = await runUpkeepNotifications();

    expect(await stampOf(off.id)).toBe(null); // never stamped
    // The off user contributed 0 to notified (only other neutralized users exist).
    expect(notified).toBe(0);
  });

  it("ancestor container assignees=[B] over a task created_by=A stamps B, not A", async () => {
    const a = await makeActor("cron-anc-a");
    const b = await makeActor("cron-anc-b");
    const list = await adminPb.collection("task_lists").create({
      name: "Cron shared list 2",
      owners: [a.id, b.id],
    });
    const container = await makeRecurringTask({
      list: list.id,
      name: "Cron yard",
      created_by: a.id,
      assignees: [b.id], // container targets B
    });
    await makeRecurringTask({
      list: list.id,
      name: "Cron mow lawn",
      parent_id: container.id,
      created_by: a.id, // creator A, but inherits container's assignees=[B]
      last_completed: null,
    });

    await isolateUsers([a.id, b.id]);
    const { notified } = await runUpkeepNotifications();

    expect(await stampOf(b.id)).toBe(todayLA()); // inherited recipient
    expect(await stampOf(a.id)).toBe(null);      // creator NOT notified
    expect(notified).toBe(1);
  });
});
