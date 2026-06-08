/**
 * One-shot todo deadline notifications.
 *
 * Modeled on runUpkeepNotifications (sibling upkeep.ts), but for one-shot
 * tasks with an explicit `deadline` + per-task `deadline_lead_days`. Evaluated
 * by the same daily task-notification cron — no new cron/endpoint.
 *
 * Recipients are resolved by an `inherit`-strategy cascade over the task's
 * ancestor chain (resolveNotifyRecipients, shared with upkeep.ts — see
 * recipients.ts) — NOT the old "union of all list owners" rule.
 */
import { getAdminPb } from "../pb";
import { sendPushToUser } from "../push";
import { DOMAIN } from "../../config";
import { todayPacific } from "./tz";
import {
  resolveNotifyRecipients,
  fetchAncestorsByPath,
  type NotifyNode,
} from "./recipients";

// Re-export so existing importers (tests) keep their import site.
export { resolveNotifyRecipients, type NotifyNode };

// Deadlines deep-link to the unified task outliner, which ONLY the home app
// serves (at kirkl.in/tasks). The standalone upkeep app has no /tasks route —
// it would match its `/:slug` catch-all and render a "list doesn't exist"
// dead-end. So prefer the home origin FIRST; an upkeep-only sub is the fallback.
const UPKEEP_ORIGINS = [`https://${DOMAIN}`, `https://upkeep.${DOMAIN}`];

/**
 * Origin-aware deep link for a deadline tap. The unified task outliner lives
 * ONLY on the home app (kirkl.in/tasks), so `/tasks` is correct on the home
 * origin but a dead-end on standalone upkeep (no such route). When a push is
 * delivered to an upkeep-only sub, land on `/` instead — the upkeep ListPicker,
 * which is usable (and non-regressive vs the old no-url → root behavior).
 * Passed to sendPushToUser as `buildUrl` (mirrors travel/life) so the emitted
 * url is SAME-ORIGIN relative for the origin that actually delivered the push.
 */
export function tasksUrl(origin: string): string {
  return origin.startsWith(`https://upkeep.`) ? "/" : "/tasks";
}

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
    expand: "list,list.owners",
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
  // proper-ancestor id referenced by any due task's `path` (shared helper).
  const ancestorsById = await fetchAncestorsByPath(pb, dueRaw as NotifyNode[]);

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
      buildUrl: (origin) => tasksUrl(origin),
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
