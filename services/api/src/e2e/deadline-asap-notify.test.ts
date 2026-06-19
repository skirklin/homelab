/**
 * The "asap" todo nag — coverage for UNDEADLINED one-shot todos in the daily
 * task-notification pass (runDeadlineNotifications).
 *
 * The bug: a one-shot todo with NO deadline mapped to urgency "later" and
 * matched neither notification path, so a real TODO could be silently forgotten
 * forever. The fix folds undeadlined one-shots into the same daily pass that
 * already handles dated deadlines (incl. overdue), as a single per-user morning
 * nag, idempotent via `last_deadline_notification`.
 *
 * This runs the REAL runDeadlineNotifications against the per-worktree test PB
 * (no real push — see the VAPID note below) and observes the side effects the
 * cron produces: the per-user `last_deadline_notification` stamp + the
 * notified/skipped return counts. Pins:
 *   - an undeadlined, incomplete, un-cleared one-shot → its creator is notified
 *   - a snoozed undeadlined one-shot → NOT notified
 *   - a completed / cleared one-shot → NOT notified
 *   - idempotency: a second run the same day is a no-op (stamp guard)
 *
 * Requires the per-worktree test env (infra/test-env.sh up).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";
import { getPbTestUrl } from "./pb-test-url";

// runDeadlineNotifications → push.ts reads VAPID keys at import-time and
// sendPushToUser validates key length before its zero-subscription early
// return. Generate a real, well-formed keypair; with no push_subscriptions the
// send is a network no-op but the cron still stamps the user, which is what we
// observe here. (Mirrors upkeep-notify-cascade.test.ts.)
vi.hoisted(async () => {
  const { default: webpush } = await import("web-push");
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
});

process.env.PB_URL = getPbTestUrl();
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const { runDeadlineNotifications } = await import("../lib/notifications/deadlines");

const PB_URL = getPbTestUrl();

let adminPb: PocketBase;

async function makeUser(suffix: string): Promise<{ id: string }> {
  const email = `${suffix}-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: suffix,
  });
  return { id: user.id };
}

async function makeList(ownerId: string): Promise<string> {
  const list = await adminPb.collection("task_lists").create({
    name: `asap-list-${randomBytes(3).toString("hex")}`,
    owners: [ownerId],
  });
  return list.id;
}

/** Create a one-shot task with a self-inclusive `path` (root path === id). */
async function makeOneShot(fields: {
  list: string;
  name: string;
  created_by: string;
  deadline?: string | null;
  completed?: boolean;
  cleared?: boolean;
  snoozed_until?: string | null;
}): Promise<{ id: string }> {
  const rec = await adminPb.collection("tasks").create({
    list: fields.list,
    name: fields.name,
    parent_id: "",
    assignees: [],
    created_by: fields.created_by,
    task_type: "one_shot",
    deadline: fields.deadline ?? null,
    completed: fields.completed ?? false,
    cleared: fields.cleared ?? false,
    snoozed_until: fields.snoozed_until ?? null,
  });
  await adminPb.collection("tasks").update(rec.id, { path: rec.id });
  return { id: rec.id };
}

/** Read the per-user idempotency stamp fresh from PB. */
async function lastNotif(userId: string): Promise<string> {
  const u = await adminPb.collection("users").getOne(userId);
  return (u.last_deadline_notification as string) || "";
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );
});

describe("runDeadlineNotifications — undeadlined (asap) todos", () => {
  it("notifies the creator of an undeadlined, incomplete, un-cleared one-shot", async () => {
    const user = await makeUser("asap-positive");
    const list = await makeList(user.id);
    await makeOneShot({
      list,
      name: "Renew passport",
      created_by: user.id,
      deadline: null, // undeadlined → asap
    });

    expect(await lastNotif(user.id)).toBe(""); // not yet stamped

    const result = await runDeadlineNotifications();
    expect(result.notified).toBeGreaterThanOrEqual(1);

    // The observable side effect: the user got stamped today.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const stamped = new Date(await lastNotif(user.id)).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    expect(stamped).toBe(today);
  });

  it("is idempotent: a second run the same day does not re-notify a stamped user", async () => {
    const user = await makeUser("asap-idempotent");
    const list = await makeList(user.id);
    await makeOneShot({ list, name: "Call the dentist", created_by: user.id, deadline: null });

    const first = await runDeadlineNotifications();
    expect(first.notified).toBeGreaterThanOrEqual(1);
    const firstStamp = await lastNotif(user.id);

    const second = await runDeadlineNotifications();
    // Second run finds the user already stamped today → skips them.
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    // Stamp unchanged (no re-write for this user).
    expect(await lastNotif(user.id)).toBe(firstStamp);
  });

  it("does NOT notify the creator when the only undeadlined one-shot is snoozed", async () => {
    const user = await makeUser("asap-snoozed");
    const list = await makeList(user.id);
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await makeOneShot({
      list,
      name: "Snoozed todo",
      created_by: user.id,
      deadline: null,
      snoozed_until: future,
    });

    await runDeadlineNotifications();
    expect(await lastNotif(user.id)).toBe(""); // never stamped → never notified
  });

  it("does NOT notify for a completed or cleared undeadlined one-shot", async () => {
    const completedUser = await makeUser("asap-completed");
    const completedList = await makeList(completedUser.id);
    await makeOneShot({
      list: completedList,
      name: "Done todo",
      created_by: completedUser.id,
      deadline: null,
      completed: true,
    });

    const clearedUser = await makeUser("asap-cleared");
    const clearedList = await makeList(clearedUser.id);
    await makeOneShot({
      list: clearedList,
      name: "Cleared todo",
      created_by: clearedUser.id,
      deadline: null,
      cleared: true,
    });

    await runDeadlineNotifications();
    expect(await lastNotif(completedUser.id)).toBe("");
    expect(await lastNotif(clearedUser.id)).toBe("");
  });
});
