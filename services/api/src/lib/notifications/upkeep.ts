/**
 * Upkeep (household task) notification trigger.
 *
 * Finds due recurring tasks and notifies their RESOLVED cascade recipients via
 * Web Push — the same `inherit`-strategy cascade the deadline cron uses
 * (resolveNotifyRecipients, see recipients.ts). A chore notifies its own
 * assignees / nearest-ancestor assignees / else its `created_by` — NOT
 * every owner of the list. The legacy union(list.owners, notify_users) rule
 * pinged both members of a shared list regardless of who the chore was for.
 *
 * The per-user `upkeep_notification_mode` is now a binary opt-out: only `off`
 * is honored (fully mutes a user). The legacy `all` / `subscribed` distinction
 * is gone — any non-`off` value means "notify me about chores I'm a resolved
 * recipient of."
 */
import { getAdminPb } from "../pb";
import { DOMAIN } from "../../config";
import { todayPacific } from "./tz";
import { notifyUsersOnce } from "./notify-once";
import {
  resolveNotifyRecipients,
  fetchAncestorsByPath,
  fetchParentIds,
  type NotifyNode,
} from "./recipients";

// Upkeep is reachable at upkeep.<domain> and as a module under <domain>/upkeep.
// Prefer the standalone subdomain (more recent enable flow); fall back to root.
const UPKEEP_ORIGINS = [`https://upkeep.${DOMAIN}`, `https://${DOMAIN}`];

interface TaskFrequency {
  value: number;
  unit: "days" | "weeks" | "months";
}

function calculateDueDate(lastCompleted: Date, frequency: TaskFrequency): Date {
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

export async function runUpkeepNotifications(): Promise<{ notified: number; skipped: number }> {
  const pb = await getAdminPb();
  const today = todayPacific();

  console.log(`[upkeep] Starting notification check for ${today}`);

  // Fetch only recurring tasks (one-shot tasks don't have due dates)
  const tasks = await pb.collection("tasks").getFullList({
    filter: 'task_type = "recurring"',
    expand: "list,list.owners",
    $autoCancel: false,
  });

  // First pass: filter to the recurring tasks that are actually due today.
  const dueRaw = tasks.filter((task) => {
    const frequency = task.frequency as TaskFrequency | null;
    if (!frequency?.value || !frequency?.unit) return false;

    let isDue: boolean;
    if (!task.last_completed) {
      isDue = true;
    } else {
      const dueDate = calculateDueDate(new Date(task.last_completed), frequency);
      isDue = isDueTodayOrEarlier(dueDate);
    }

    // Respect snooze
    if (isDue && task.snoozed_until) {
      const snoozeEnd = new Date(task.snoozed_until);
      if (snoozeEnd > new Date()) isDue = false;
    }

    return isDue;
  });

  // Notifications target only LEAF chores, never group/container nodes. A
  // recurring container that is "due" would otherwise nag for the group itself.
  // Subtract every task that is some other task's parent (any task_type /
  // completion state — structural leaf-ness).
  const parentIds = await fetchParentIds(pb);
  const dueLeaves = dueRaw.filter((t) => !parentIds.has(t.id));

  // Recipients cascade up the ancestor chain (`inherit` strategy), same as the
  // deadline cron. Batch-fetch every proper-ancestor referenced by a due task.
  const ancestorsById = await fetchAncestorsByPath(pb, dueLeaves as NotifyNode[]);

  const dueTasks: { taskName: string; recipientIds: string[] }[] = [];
  for (const task of dueLeaves) {
    const listOwnerIds: string[] = task.expand?.list?.owners || [];
    const recipientIds = resolveNotifyRecipients(task as NotifyNode, ancestorsById, listOwnerIds);
    dueTasks.push({ taskName: task.name, recipientIds });
  }

  console.log(`[upkeep] Found ${dueTasks.length} due tasks`);

  if (dueTasks.length === 0) return { notified: 0, skipped: 0 };

  // Aggregate per resolved recipient.
  const tasksByUser = new Map<string, string[]>();
  for (const t of dueTasks) {
    for (const userId of t.recipientIds) {
      const list = tasksByUser.get(userId) || [];
      list.push(t.taskName);
      tasksByUser.set(userId, list);
    }
  }

  // Fan out via the shared once-a-day tail (off opt-out, idempotency stamp,
  // mark-after-success). This cron owns only the per-user copy + data.
  const { notified, skipped } = await notifyUsersOnce({
    pb,
    tasksByUser,
    kind: "upkeep",
    preferredOrigins: UPKEEP_ORIGINS,
    logPrefix: "upkeep",
    buildPush: (userTasks) => {
      const title = userTasks.length === 1
        ? `${userTasks[0]} needs doing`
        : `${userTasks.length} household tasks need doing`;

      const body = userTasks.length === 1
        ? "Tap to view details"
        : userTasks.slice(0, 3).join(", ") + (userTasks.length > 3 ? ` and ${userTasks.length - 3} more` : "");

      return {
        title,
        body,
        data: { type: "household_task_due", taskCount: String(userTasks.length) },
      };
    },
  });

  console.log(`[upkeep] Done: ${notified} notified, ${skipped} skipped`);
  return { notified, skipped };
}
