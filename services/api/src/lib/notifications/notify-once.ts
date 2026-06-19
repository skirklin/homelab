/**
 * Shared per-user fan-out + once-a-day idempotency tail for the task crons.
 *
 * Both task-notification crons (one-shot deadline/asap reminders in deadlines.ts
 * and recurring chore reminders in upkeep.ts) share the SAME delivery tail once
 * they've aggregated their due tasks per recipient:
 *
 *   1. fetch the recipient users (honoring the `1 = 0` empty-filter guard);
 *   2. skip a user whose `upkeep_notification_mode === "off"` (the binary
 *      opt-out — legacy `all`/`subscribed` both mean "on");
 *   3. skip a user already stamped for today on their per-cron `stampColumn`;
 *   4. `sendPushToUser` with the cron's own copy/data;
 *   5. stamp `stampColumn` with now — BUT only when the push actually landed
 *      (`result.sent > 0`).
 *
 * That last point reconciles a drift: deadlines.ts and upkeep.ts used to stamp
 * UNCONDITIONALLY, so a user whose push subscriptions were momentarily dead got
 * marked "notified" and suppressed for the rest of the day — the daily asap nag
 * silently ate a day. The life cron (life.ts) already stamps only on
 * `result.sent > 0`; this helper makes that the single, shared policy.
 *
 * The per-cron aggregation (which tasks are due, who the resolved recipients
 * are, the title/body copy, the `data.type`) stays in each cron — only this
 * genuinely-shared tail is factored out. `buildPush` lets each caller own its
 * payload (copy + `data` + `buildUrl`) keyed off its own per-user task shape.
 */
import type PocketBase from "pocketbase";
import { sendPushToUser, type PushPayload } from "../push";
import { todayPacific } from "./tz";

export async function notifyUsersOnce<T>(opts: {
  pb: PocketBase;
  /** Resolved recipients → their per-user due-task aggregate (caller-shaped). */
  tasksByUser: Map<string, T[]>;
  /** Per-cron idempotency stamp column on `users` (date-of-last-notify). */
  stampColumn: "last_deadline_notification" | "last_task_notification";
  /** Build the push payload from this user's aggregated tasks. */
  buildPush: (userTasks: T[]) => PushPayload;
  /** `preferredOrigins` for `sendPushToUser` (dedupe across multi-origin subs). */
  preferredOrigins: string[];
  /** Log tag, e.g. "deadlines" / "upkeep". */
  logPrefix: string;
}): Promise<{ notified: number; skipped: number }> {
  const { pb, tasksByUser, stampColumn, buildPush, preferredOrigins, logPrefix } = opts;
  const today = todayPacific();

  // Fetch user preferences (honor the global upkeep off opt-out + idempotency stamp).
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

    // Already notified today on this cron's stamp?
    if (user[stampColumn]) {
      const lastNotif = new Date(user[stampColumn]).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      if (lastNotif === today) {
        skipped++;
        continue;
      }
    }

    const result = await sendPushToUser(pb, userId, buildPush(userTasks), { preferredOrigins });

    console.log(`[${logPrefix}] User ${userId}: ${result.sent} sent, ${result.expired} expired, ${result.failed} failed`);

    // Stamp ONLY when a push actually landed (result.sent > 0). A user whose
    // subscriptions are momentarily dead must NOT be marked "notified" and
    // suppressed for the day — they'd silently lose the nag. Matches the life
    // cron's mark-after-success policy.
    if (result.sent > 0) {
      await pb.collection("users").update(userId, {
        [stampColumn]: new Date().toISOString(),
      }, { $autoCancel: false });
      notified++;
    } else {
      skipped++;
    }
  }

  return { notified, skipped };
}
