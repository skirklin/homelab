/**
 * One-shot todo attention notifications (the daily "asap" nag).
 *
 * Modeled on runUpkeepNotifications (sibling upkeep.ts), but for one-shot
 * todos. Evaluated by the same daily task-notification cron — no new
 * cron/endpoint. Surfaces two kinds of one-shot:
 *   - DATED, within its `deadline_lead_days` lead window (incl. overdue: a
 *     negative daysUntil still satisfies `<= leadDays`); and
 *   - UNDEADLINED — a one-shot with no deadline at all. These used to map to
 *     urgency "later" and matched NO notification path, so a real todo could be
 *     forgotten forever. They're the "asap" bucket: nag daily until the user
 *     acts (do it, set a deadline, complete, clear, or snooze).
 * A single per-user push covers both kinds, idempotent via the
 * `notification_log` ledger (notifyUsersOnce → notifyOnce, kind:"deadline"):
 * one ledger row per (user, kind, day) gates re-sends, so a user gets one
 * morning nag, not two.
 *
 * Recipients are resolved by an `inherit`-strategy cascade over the task's
 * ancestor chain (resolveNotifyRecipients, shared with upkeep.ts — see
 * recipients.ts) — NOT the old "union of all list owners" rule.
 */
import { getAdminPb } from "../pb";
import { DOMAIN } from "../../config";
import { todayPacific } from "./tz";
import { notifyUsersOnce } from "./notify-once";
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

  // Every one-shot, incomplete, un-cleared todo. (Was gated on `deadline != ""`;
  // now we also surface UNDEADLINED todos — the "asap" bucket — so the deadline
  // is no longer part of the PB filter and the JS first-pass decides per task.)
  const tasks = await pb.collection("tasks").getFullList({
    filter: 'task_type = "one_shot" && completed = false && cleared = false',
    expand: "list,list.owners",
    $autoCancel: false,
  });

  // First pass: the todos that need attention today. A DATED todo qualifies
  // when it's within its lead window (overdue counts — negative daysUntil still
  // satisfies `<= leadDays`); an UNDEADLINED todo always qualifies (asap). Both
  // respect snooze.
  const dueRaw = tasks.filter((task) => {
    // Respect snooze first — applies to dated and undeadlined alike.
    if (task.snoozed_until) {
      const snoozeEnd = new Date(task.snoozed_until);
      if (snoozeEnd > new Date()) return false;
    }

    const hasDeadline = !!task.deadline;
    if (!hasDeadline) return true; // undeadlined one-shot → asap, always nag

    const deadline = new Date(task.deadline as string);
    if (isNaN(deadline.getTime())) return false;
    const leadDays = (task.deadline_lead_days as number) ?? 0;
    return daysUntil(deadline) <= leadDays;
  });

  // Recipients cascade up the ancestor chain (`inherit` strategy). Ancestors
  // (containers) are usually NOT in the due set above, so batch-fetch every
  // proper-ancestor id referenced by any due task's `path` (shared helper).
  const ancestorsById = await fetchAncestorsByPath(pb, dueRaw as NotifyNode[]);

  const dueTasks: { taskName: string; dated: boolean; recipientIds: string[] }[] = [];
  for (const task of dueRaw) {
    const listOwnerIds: string[] = task.expand?.list?.owners || [];
    const recipientIds = resolveNotifyRecipients(task as NotifyNode, ancestorsById, listOwnerIds);
    dueTasks.push({ taskName: task.name, dated: !!task.deadline, recipientIds });
  }

  console.log(`[deadlines] Found ${dueTasks.length} todos needing attention`);

  if (dueTasks.length === 0) return { notified: 0, skipped: 0 };

  // Aggregate per recipient. Track each todo's name + whether it's dated so the
  // single-todo copy can read "is due" (dated) vs "needs attention" (asap).
  const tasksByUser = new Map<string, { name: string; dated: boolean }[]>();
  for (const t of dueTasks) {
    for (const userId of t.recipientIds) {
      const list = tasksByUser.get(userId) || [];
      list.push({ name: t.taskName, dated: t.dated });
      tasksByUser.set(userId, list);
    }
  }

  // Fan out via the shared once-a-day tail (off opt-out, idempotency stamp,
  // mark-after-success). This cron owns only the per-user copy + data.
  const { notified, skipped } = await notifyUsersOnce({
    pb,
    tasksByUser,
    kind: "deadline",
    preferredOrigins: UPKEEP_ORIGINS,
    logPrefix: "deadlines",
    buildPush: (userTasks) => {
      // Copy: a single dated todo reads "{name} is due"; a single undeadlined
      // todo reads "{name} needs attention" (no date to cite). Any multiple
      // (dated, undeadlined, or mixed) collapses to "{count} todos need attention".
      const title = userTasks.length === 1
        ? (userTasks[0].dated ? `${userTasks[0].name} is due` : `${userTasks[0].name} needs attention`)
        : `${userTasks.length} todos need attention`;

      const names = userTasks.map((t) => t.name);
      const body = userTasks.length === 1
        ? "Tap to view details"
        : names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");

      return {
        title,
        body,
        buildUrl: (origin) => tasksUrl(origin),
        data: { type: "task_attention", taskCount: String(userTasks.length) },
      };
    },
  });

  console.log(`[deadlines] Done: ${notified} notified, ${skipped} skipped`);
  return { notified, skipped };
}
