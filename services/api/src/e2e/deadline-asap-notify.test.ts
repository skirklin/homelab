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
 * cron produces: a `notification_log` ledger row (kind="deadline") + the
 * notified/skipped return counts. Pins:
 *   - an undeadlined, incomplete, un-cleared one-shot → its creator is notified
 *   - a snoozed undeadlined one-shot → NOT notified
 *   - a completed / cleared one-shot → NOT notified
 *   - idempotency: a second run the same day is a no-op (ledger guard)
 *
 * Requires the per-worktree test env (infra/test-env.sh up).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";
import { getPbTestUrl } from "./pb-test-url";

// The cron now writes a `notification_log` ledger row (via notifyOnce) ONLY
// when a push actually landed (result.sent > 0) — a user with momentarily-dead
// subscriptions must not be marked "notified" and suppressed (reconciled with
// the life cron). So the ledger row can't double as the "who was selected"
// signal unless a delivery succeeds. These tests verify SELECTION
// (aggregation/snooze/cleared/opt-out), not push transport, so mock the push
// layer to report one successful send.
const sendPushToUser = vi.fn().mockResolvedValue({ sent: 1, expired: 0, failed: 0 });
vi.mock("../lib/push", () => ({
  sendPushToUser: (...a: unknown[]) => sendPushToUser(...a),
}));

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
  parent_id?: string;
  deadline?: string | null;
  completed?: boolean;
  cleared?: boolean;
  snoozed_until?: string | null;
}): Promise<{ id: string }> {
  const rec = await adminPb.collection("tasks").create({
    list: fields.list,
    name: fields.name,
    parent_id: fields.parent_id || "",
    assignees: [],
    created_by: fields.created_by,
    task_type: "one_shot",
    deadline: fields.deadline ?? null,
    completed: fields.completed ?? false,
    cleared: fields.cleared ?? false,
    snoozed_until: fields.snoozed_until ?? null,
  });
  let path = rec.id;
  if (fields.parent_id) {
    const parent = await adminPb.collection("tasks").getOne(fields.parent_id);
    path = `${parent.path}/${rec.id}`;
  }
  await adminPb.collection("tasks").update(rec.id, { path });
  return { id: rec.id };
}

const todayPacific = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

/**
 * True iff the deadline cron stamped a ledger row for this user today. The
 * deadline cron writes notification_log{ user, kind:"deadline", bucket:<PT day> }
 * on a successful send — the go-forward idempotency signal (replaces the old
 * users.last_deadline_notification stamp).
 */
async function wasNotifiedToday(userId: string): Promise<boolean> {
  const rows = await adminPb.collection("notification_log").getFullList({
    filter: adminPb.filter("user = {:u} && kind = {:k} && bucket = {:b}", {
      u: userId,
      k: "deadline",
      b: todayPacific(),
    }),
  });
  return rows.length > 0;
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

    expect(await wasNotifiedToday(user.id)).toBe(false); // not yet stamped

    const result = await runDeadlineNotifications();
    expect(result.notified).toBeGreaterThanOrEqual(1);

    // The observable side effect: a ledger row for today.
    expect(await wasNotifiedToday(user.id)).toBe(true);
  });

  it("is idempotent: a second run the same day does not re-notify a stamped user", async () => {
    const user = await makeUser("asap-idempotent");
    const list = await makeList(user.id);
    await makeOneShot({ list, name: "Call the dentist", created_by: user.id, deadline: null });

    const first = await runDeadlineNotifications();
    expect(first.notified).toBeGreaterThanOrEqual(1);
    expect(await wasNotifiedToday(user.id)).toBe(true);

    const second = await runDeadlineNotifications();
    // Second run finds the user already in the ledger today → skips them.
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    // Exactly one ledger row for this user today (no duplicate write).
    const rows = await adminPb.collection("notification_log").getFullList({
      filter: adminPb.filter("user = {:u} && kind = {:k} && bucket = {:b}", {
        u: user.id, k: "deadline", b: todayPacific(),
      }),
    });
    expect(rows).toHaveLength(1);
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
    expect(await wasNotifiedToday(user.id)).toBe(false); // never stamped → never notified
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
    expect(await wasNotifiedToday(completedUser.id)).toBe(false);
    expect(await wasNotifiedToday(clearedUser.id)).toBe(false);
  });

  it("does NOT notify for a GROUP one-shot (has a child); its LEAF child DOES notify", async () => {
    // A undeadlined one-shot PARENT would qualify as "asap" under the old
    // filter, but it's a container — only the actionable LEAF child should nag.
    const parentUser = await makeUser("asap-group-parent");
    const parentList = await makeList(parentUser.id);
    const parent = await makeOneShot({
      list: parentList,
      name: "Plan the trip",
      created_by: parentUser.id,
      deadline: null, // would be asap if it were a leaf
    });

    const childUser = await makeUser("asap-group-child");
    const child = await makeOneShot({
      list: parentList,
      name: "Book flights",
      created_by: childUser.id,
      parent_id: parent.id,
      deadline: null, // qualifying leaf
    });
    void child;

    await runDeadlineNotifications();

    // The container's creator is never nagged; the leaf child's creator is.
    expect(await wasNotifiedToday(parentUser.id)).toBe(false);
    expect(await wasNotifiedToday(childUser.id)).toBe(true);
  });

  it("does NOT notify a one-shot parent whose only child is COMPLETED (structural leaf-ness)", async () => {
    // Leaf-ness is structural: having ANY child — even a completed one —
    // makes the parent a group. The completed child itself never nags.
    const user = await makeUser("asap-group-completed-child");
    const list = await makeList(user.id);
    const parent = await makeOneShot({
      list,
      name: "Organize garage",
      created_by: user.id,
      deadline: null,
    });
    await makeOneShot({
      list,
      name: "Buy shelving",
      created_by: user.id,
      parent_id: parent.id,
      deadline: null,
      completed: true, // child is done, but parent still has a child → group
    });

    await runDeadlineNotifications();
    expect(await wasNotifiedToday(user.id)).toBe(false);
  });
});
