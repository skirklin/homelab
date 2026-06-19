/**
 * Shared per-user fan-out tail for the task crons, now backed by the ledger.
 *
 * Both task-notification crons (one-shot deadline/asap reminders in deadlines.ts
 * and recurring chore reminders in upkeep.ts) share the SAME delivery tail once
 * they've aggregated their due tasks per recipient:
 *
 *   1. fetch the recipient users (honoring the `1 = 0` empty-filter guard);
 *   2. skip a user whose `upkeep_notification_mode === "off"` (the binary
 *      opt-out — legacy `all`/`subscribed` both mean "on");
 *   3. delegate "send once per day, stamp only on success" to `notifyOnce`,
 *      which owns the day-math + the `notification_log` idempotency row.
 *
 * Previously this re-implemented the once-a-day stamp against per-user date
 * columns (`last_task_notification` / `last_deadline_notification`). Those are
 * retired in favor of the single `notification_log` ledger (see ledger.ts +
 * migration 20260619_200000); this helper is now just the cron-specific
 * fan-out (user lookup + off opt-out + per-user copy) wrapped around it.
 *
 * The per-cron aggregation (which tasks are due, who the resolved recipients
 * are, the title/body copy, the `data.type`) stays in each cron — only this
 * genuinely-shared tail is factored out. `buildPush` lets each caller own its
 * payload (copy + `data` + `buildUrl`) keyed off its own per-user task shape.
 */
import type PocketBase from "pocketbase";
import type { PushPayload } from "../push";
import { notifyOnce } from "./ledger";

export async function notifyUsersOnce<T>(opts: {
  pb: PocketBase;
  /** Resolved recipients → their per-user due-task aggregate (caller-shaped). */
  tasksByUser: Map<string, T[]>;
  /** Ledger channel for this cron, e.g. "upkeep" / "deadline" (the once-a-day key). */
  kind: string;
  /** Build the push payload from this user's aggregated tasks. */
  buildPush: (userTasks: T[]) => PushPayload;
  /** `preferredOrigins` for `sendPushToUser` (dedupe across multi-origin subs). */
  preferredOrigins: string[];
  /** Log tag, e.g. "deadlines" / "upkeep". */
  logPrefix: string;
}): Promise<{ notified: number; skipped: number }> {
  const { pb, tasksByUser, kind, buildPush, preferredOrigins, logPrefix } = opts;

  // Fetch user preferences (honor the global upkeep off opt-out).
  const userIds = [...tasksByUser.keys()];
  const users = await pb.collection("users").getFullList({
    filter: userIds.length > 0
      ? userIds.map((id) => pb.filter("id = {:id}", { id })).join(" || ")
      : "1 = 0",
    $autoCancel: false,
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  let notified = 0;
  let skipped = 0;

  for (const [userId, userTasks] of tasksByUser) {
    const user = userMap.get(userId);
    if (!user) {
      skipped++;
      continue;
    }

    // `upkeep_notification_mode` is a binary opt-out: only `off` mutes.
    const mode = (user.upkeep_notification_mode as string) || "subscribed";
    if (mode === "off") {
      skipped++;
      continue;
    }

    // Send once per day (ledger-backed): stamp only on a landed push; a
    // duplicate / undelivered result counts as skipped.
    const result = await notifyOnce(pb, {
      user: userId,
      kind,
      payload: buildPush(userTasks),
      preferredOrigins,
    });

    console.log(`[${logPrefix}] User ${userId}: ${result}`);

    if (result === "sent") {
      notified++;
    } else {
      skipped++;
    }
  }

  return { notified, skipped };
}
