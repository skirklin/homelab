/**
 * One-shot todo deadline notifications.
 *
 * Modeled on runUpkeepNotifications (sibling upkeep.ts), but for one-shot
 * tasks with an explicit `deadline` + per-task `deadline_lead_days`. Evaluated
 * by the same daily task-notification cron — no new cron/endpoint. Recipients
 * are the union of the task's list owners and explicit notify_users: a personal
 * todo notifies its owner by default (unlike upkeep's subscribed/all modes).
 */
import { getAdminPb } from "../pb";
import { sendPushToUser } from "../push";
import { DOMAIN } from "../../config";
import { todayPacific } from "./tz";

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

  // Find due tasks: daysUntil <= lead_days (naturally includes overdue).
  const dueTasks: { taskName: string; recipientIds: string[] }[] = [];

  for (const task of tasks) {
    const deadline = new Date(task.deadline as string);
    if (isNaN(deadline.getTime())) continue;

    const leadDays = (task.deadline_lead_days as number) ?? 0;
    let isDue = daysUntil(deadline) <= leadDays;

    // Respect snooze
    if (isDue && task.snoozed_until) {
      const snoozeEnd = new Date(task.snoozed_until);
      if (snoozeEnd > new Date()) isDue = false;
    }

    if (!isDue) continue;

    const list = task.expand?.list;
    const listOwnerIds: string[] = list?.owners || [];
    const notifyUserIds: string[] = task.notify_users || [];
    const recipientIds = [...new Set([...listOwnerIds, ...notifyUserIds])];

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
