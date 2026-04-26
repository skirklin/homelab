/**
 * Upkeep (household task) notification trigger.
 * Finds overdue tasks and notifies subscribed users via Web Push.
 */
import { getAdminPb } from "../pb";
import { sendPushToUser } from "../push";
import { DOMAIN } from "../../config";

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

function todayPacific(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

export async function runUpkeepNotifications(): Promise<{ notified: number; skipped: number }> {
  const pb = await getAdminPb();
  const today = todayPacific();

  console.log(`[upkeep] Starting notification check for ${today}`);

  // Fetch only recurring tasks (one-shot tasks don't have due dates)
  const tasks = await pb.collection("tasks").getFullList({
    filter: 'task_type = "recurring"',
    expand: "list,list.owners,notify_users",
    $autoCancel: false,
  });

  // Find due tasks
  const dueTasks: { taskName: string; listId: string; notifyUserIds: string[]; listOwnerIds: string[] }[] = [];

  for (const task of tasks) {
    const frequency = task.frequency as TaskFrequency | null;
    if (!frequency?.value || !frequency?.unit) continue;

    let isDue = false;
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

    if (!isDue) continue;

    const list = task.expand?.list;
    const listOwnerIds: string[] = list?.owners || [];
    const notifyUserIds: string[] = task.notify_users || [];

    dueTasks.push({
      taskName: task.name,
      listId: task.list,
      notifyUserIds,
      listOwnerIds,
    });
  }

  console.log(`[upkeep] Found ${dueTasks.length} due tasks`);

  if (dueTasks.length === 0) return { notified: 0, skipped: 0 };

  // Build per-user task lists based on notification mode
  // Collect all users who might need notifying
  const allUserIds = new Set<string>();
  for (const t of dueTasks) {
    for (const id of t.notifyUserIds) allUserIds.add(id);
    for (const id of t.listOwnerIds) allUserIds.add(id);
  }

  // Fetch user preferences
  const users = await pb.collection("users").getFullList({
    filter: allUserIds.size > 0
      ? [...allUserIds].map(id => pb.filter("id = {:id}", { id })).join(" || ")
      : "1 = 0",
    $autoCancel: false,
  });

  const userMap = new Map(users.map(u => [u.id, u]));

  let notified = 0;
  let skipped = 0;

  for (const [userId, user] of userMap) {
    const mode = (user.upkeep_notification_mode as string) || "subscribed";

    if (mode === "off") {
      skipped++;
      continue;
    }

    // Check if already notified today
    if (user.last_task_notification) {
      const lastNotif = new Date(user.last_task_notification).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      if (lastNotif === today) {
        skipped++;
        continue;
      }
    }

    // Determine which tasks this user should hear about
    let userTasks: string[];
    if (mode === "all") {
      // All due tasks in lists they own
      userTasks = dueTasks
        .filter(t => t.listOwnerIds.includes(userId))
        .map(t => t.taskName);
    } else {
      // "subscribed" — only tasks they explicitly subscribed to
      userTasks = dueTasks
        .filter(t => t.notifyUserIds.includes(userId))
        .map(t => t.taskName);
    }

    if (userTasks.length === 0) continue;

    const title = userTasks.length === 1
      ? `${userTasks[0]} needs doing`
      : `${userTasks.length} household tasks need doing`;

    const body = userTasks.length === 1
      ? "Tap to view details"
      : userTasks.slice(0, 3).join(", ") + (userTasks.length > 3 ? ` and ${userTasks.length - 3} more` : "");

    const result = await sendPushToUser(pb, userId, {
      title,
      body,
      data: { type: "household_task_due", taskCount: String(userTasks.length) },
    }, { preferredOrigins: UPKEEP_ORIGINS });

    console.log(`[upkeep] User ${userId}: ${result.sent} sent, ${result.expired} expired`);

    // Mark as notified today
    await pb.collection("users").update(userId, {
      last_task_notification: new Date().toISOString(),
    }, { $autoCancel: false });

    notified++;
  }

  console.log(`[upkeep] Done: ${notified} notified, ${skipped} skipped`);
  return { notified, skipped };
}
