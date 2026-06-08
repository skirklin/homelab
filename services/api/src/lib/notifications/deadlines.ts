/**
 * One-shot todo deadline notifications.
 *
 * Modeled on runUpkeepNotifications (sibling upkeep.ts), but for one-shot
 * tasks with an explicit `deadline` + per-task `deadline_lead_days`. Evaluated
 * by the same daily task-notification cron — no new cron/endpoint.
 *
 * Recipients are resolved by an `inherit`-strategy cascade over the task's
 * ancestor chain (see resolveNotifyRecipients) — NOT the old "union of all
 * list owners" rule. That union pinged every owner of a shared list regardless
 * of who the task was for (e.g. Angela got Scott's trip-prep reminders). The
 * cascade walks the node's `path` chain: the nearest ancestor with an explicit
 * `notify_users` wins, the node's own value overrides ancestors, and the
 * terminal floor is the task's own `created_by` (a single user) — deliberately
 * NOT the root list owners, which is what re-introduced the bug.
 */
import { getAdminPb } from "../pb";
import { sendPushToUser } from "../push";
import { DOMAIN } from "../../config";
import { todayPacific } from "./tz";

/** Minimal shape of a task record needed to resolve its notify recipients. */
export interface NotifyNode {
  notify_users?: string[] | null;
  /** Materialized ancestor-id chain, `/`-separated, SELF-INCLUSIVE (last
   *  segment is the node's own id). Root node → path === own id. */
  path?: string | null;
  /** Single-user relation (maxSelect:1) → string id, or "" / undefined. */
  created_by?: string | null;
}

/**
 * Resolve the notify-recipient set for one due task via the `inherit` cascade.
 *
 * @param task          the due task record
 * @param ancestorsById ancestor task records keyed by id (need NOT include the
 *                      task itself; only proper ancestors are consulted). Only
 *                      `notify_users` is read off them.
 * @param listOwners    fallback ONLY for legacy tasks with no chain config and
 *                      no `created_by` (predating created_by stamping).
 *
 * Resolution order (CSS-cascade `inherit`):
 *   1. nearest node on the root→self chain (self first, then closest ancestor,
 *      …) with a NON-EMPTY explicit `notify_users` wins;
 *   2. else the task's own `created_by` (single user) — the floor that fixes
 *      the bug: an un-configured task notifies its creator, not all owners;
 *   3. else (legacy: no created_by either) the list owners, to preserve old
 *      behavior rather than silently notifying nobody.
 */
export function resolveNotifyRecipients(
  task: NotifyNode,
  ancestorsById: Map<string, NotifyNode>,
  listOwners: string[],
): string[] {
  const nonEmpty = (v?: string[] | null): string[] | null =>
    Array.isArray(v) && v.length > 0 ? v : null;

  // Self overrides ancestors.
  const own = nonEmpty(task.notify_users);
  if (own) return [...new Set(own)];

  // Walk ancestors nearest → farthest. `path` is root→…→self, so proper
  // ancestor ids are every segment except the last (self). Reverse to get
  // nearest-first.
  const segments = (task.path || "").split("/").filter(Boolean);
  const ancestorIds = segments.slice(0, -1).reverse();
  for (const id of ancestorIds) {
    const anc = ancestorsById.get(id);
    const v = anc && nonEmpty(anc.notify_users);
    if (v) return [...new Set(v)];
  }

  // Terminal floor: the task's creator (single user).
  if (task.created_by) return [task.created_by];

  // Legacy floor: tasks predating created_by stamping fall back to owners
  // rather than notifying nobody.
  return [...new Set(listOwners)];
}

// Same origins as upkeep — deadlines surface in the same app(s).
const UPKEEP_ORIGINS = [`https://upkeep.${DOMAIN}`, `https://${DOMAIN}`];

/**
 * Whole-day diff between today and the deadline, both anchored to the Pacific
 * calendar day. Negative = overdue. The pod runs in UTC, so naive local-midnight
 * truncation would read a day off near a UTC boundary vs the browser (which
 * computes urgency in Pacific) — normalize via the same en-CA/LA pattern as
 * todayPacific() so the notifier and UI agree.
 */
function daysUntil(deadline: Date): number {
  const pacificDay = (d: Date) => new Date(d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }));
  return Math.floor((pacificDay(deadline).getTime() - pacificDay(new Date()).getTime()) / (1000 * 60 * 60 * 24));
}

export async function runDeadlineNotifications(): Promise<{ notified: number; skipped: number }> {
  const pb = await getAdminPb();
  const today = todayPacific();

  console.log(`[deadlines] Starting notification check for ${today}`);

  // Only one-shot, incomplete, un-cleared tasks that actually have a deadline.
  const tasks = await pb.collection("tasks").getFullList({
    filter: 'task_type = "one_shot" && completed = false && cleared = false && deadline != ""',
    expand: "list,list.owners,notify_users",
    $autoCancel: false,
  });

  // First pass: filter to the tasks that are actually due today.
  const dueRaw = tasks.filter((task) => {
    const deadline = new Date(task.deadline as string);
    if (isNaN(deadline.getTime())) return false;

    const leadDays = (task.deadline_lead_days as number) ?? 0;
    if (daysUntil(deadline) > leadDays) return false;

    // Respect snooze
    if (task.snoozed_until) {
      const snoozeEnd = new Date(task.snoozed_until);
      if (snoozeEnd > new Date()) return false;
    }
    return true;
  });

  // Recipients cascade up the ancestor chain (`inherit` strategy). Ancestors
  // (containers) are usually NOT in the due set above, so batch-fetch every
  // proper-ancestor id referenced by any due task's `path` and read their
  // `notify_users`. One getFullList instead of N+1 per task.
  const ancestorIds = new Set<string>();
  for (const task of dueRaw) {
    const segments = ((task.path as string) || "").split("/").filter(Boolean);
    for (const id of segments.slice(0, -1)) ancestorIds.add(id);
  }
  const ancestorsById = new Map<string, NotifyNode>();
  if (ancestorIds.size > 0) {
    const ancestors = await pb.collection("tasks").getFullList({
      filter: [...ancestorIds].map((id) => pb.filter("id = {:id}", { id })).join(" || "),
      fields: "id,notify_users",
      $autoCancel: false,
    });
    for (const a of ancestors) ancestorsById.set(a.id, a as NotifyNode);
  }

  const dueTasks: { taskName: string; recipientIds: string[] }[] = [];
  for (const task of dueRaw) {
    const listOwnerIds: string[] = task.expand?.list?.owners || [];
    const recipientIds = resolveNotifyRecipients(task as NotifyNode, ancestorsById, listOwnerIds);
    dueTasks.push({ taskName: task.name, recipientIds });
  }

  console.log(`[deadlines] Found ${dueTasks.length} due tasks`);

  if (dueTasks.length === 0) return { notified: 0, skipped: 0 };

  // Aggregate per recipient.
  const tasksByUser = new Map<string, string[]>();
  for (const t of dueTasks) {
    for (const userId of t.recipientIds) {
      const list = tasksByUser.get(userId) || [];
      list.push(t.taskName);
      tasksByUser.set(userId, list);
    }
  }

  // Fetch user preferences (honor the global upkeep off opt-out + idempotency stamp).
  const userIds = [...tasksByUser.keys()];
  const users = await pb.collection("users").getFullList({
    filter: userIds.length > 0
      ? userIds.map(id => pb.filter("id = {:id}", { id })).join(" || ")
      : "1 = 0",
    $autoCancel: false,
  });
  const userMap = new Map(users.map(u => [u.id, u]));

  let notified = 0;
  let skipped = 0;

  for (const [userId, userTasks] of tasksByUser) {
    const user = userMap.get(userId);
    if (!user) {
      skipped++;
      continue;
    }

    const mode = (user.upkeep_notification_mode as string) || "subscribed";
    if (mode === "off") {
      skipped++;
      continue;
    }

    // Already notified today? (separate stamp from last_task_notification)
    if (user.last_deadline_notification) {
      const lastNotif = new Date(user.last_deadline_notification).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      if (lastNotif === today) {
        skipped++;
        continue;
      }
    }

    const title = userTasks.length === 1
      ? `${userTasks[0]} is due`
      : `${userTasks.length} todos due soon`;

    const body = userTasks.length === 1
      ? "Tap to view details"
      : userTasks.slice(0, 3).join(", ") + (userTasks.length > 3 ? ` and ${userTasks.length - 3} more` : "");

    const result = await sendPushToUser(pb, userId, {
      title,
      body,
      data: { type: "task_deadline_due", taskCount: String(userTasks.length) },
    }, { preferredOrigins: UPKEEP_ORIGINS });

    console.log(`[deadlines] User ${userId}: ${result.sent} sent, ${result.expired} expired`);

    await pb.collection("users").update(userId, {
      last_deadline_notification: new Date().toISOString(),
    }, { $autoCancel: false });

    notified++;
  }

  console.log(`[deadlines] Done: ${notified} notified, ${skipped} skipped`);
  return { notified, skipped };
}
