/**
 * Single sent-ledger for the per-day notification crons.
 *
 * Every "send this once per <window>" path used to carry its own idempotency
 * store (users.last_task_notification, users.last_deadline_notification,
 * life_logs.reminder_state, users.travel_notif_state) and re-implement the same
 * Pacific day-math + mark-after-success dance. `notifyOnce` makes that policy
 * LOCAL AND TOTAL: it owns the "have I already fired (user, kind, bucket)?"
 * check, the `sendPushToUser` call, and the "stamp ONLY when a push landed"
 * rule — backed by the `notification_log` collection's UNIQUE(user, kind,
 * bucket) index (migration 20260619_200000).
 *
 * IDEMPOTENCY MODEL
 *   - bucket is the window key — almost always `todayPacific()` (one nag/day).
 *   - kind is the logical channel; embed any per-subject discriminator in it
 *     (e.g. "travel_morning:<tripId>", "life_reminder:<notificationId>") so two
 *     subjects on the same day don't collide on one ledger row.
 *   - A row is created ONLY after `result.sent > 0`. A user whose subs are
 *     momentarily dead is NOT stamped, so the next run retries (matches the
 *     mark-after-success policy the crons already converged on).
 *   - The UNIQUE index is the race guard: if a concurrent run already wrote the
 *     row, our create throws and we report "duplicate" rather than double-send.
 *     (Single-replica today, but croner protect:true + this index mean the
 *     invariant holds even if that changes.)
 *
 * Returns:
 *   "sent"        — a push landed and a fresh ledger row was written.
 *   "duplicate"   — already sent for this (user, kind, bucket); nothing sent.
 *   "undelivered" — attempted, but 0 pushes landed (no subs / all failed); NOT
 *                   stamped, so it retries next run.
 */
import type PocketBase from "pocketbase";
import { sendPushToUser, type PushPayload } from "../push";
import { todayPacific } from "./tz";

export type NotifyOnceResult = "sent" | "duplicate" | "undelivered";

export interface NotifyOnceOpts {
  /** Recipient user id. */
  user: string;
  /** Logical channel + any per-subject discriminator, e.g. "travel_morning:<tripId>". */
  kind: string;
  /** Idempotency window key. Defaults to `todayPacific()` (one per Pacific day). */
  bucket?: string;
  /** The push to deliver. */
  payload: PushPayload;
  /** `preferredOrigins` for `sendPushToUser` (cross-origin sub dedupe). */
  preferredOrigins?: string[];
}

/**
 * Send a push to one user at most once per (kind, bucket).
 *
 * The pre-send read is a fast path; the UNIQUE index is the actual correctness
 * guard (so a concurrent run can't double-send). Day-math + mark-after-success
 * live here and nowhere else.
 */
export async function notifyOnce(
  pb: PocketBase,
  opts: NotifyOnceOpts,
): Promise<NotifyOnceResult> {
  const { user, kind, payload, preferredOrigins } = opts;
  const bucket = opts.bucket ?? todayPacific();

  // Already sent this window? (Fast path; the UNIQUE index below is the
  // authoritative race guard.)
  const existing = await pb.collection("notification_log").getList(1, 1, {
    filter: pb.filter("user = {:user} && kind = {:kind} && bucket = {:bucket}", {
      user,
      kind,
      bucket,
    }),
    $autoCancel: false,
  });
  if (existing.totalItems > 0) return "duplicate";

  const result = await sendPushToUser(pb, user, payload, {
    preferredOrigins: preferredOrigins ?? [],
  });

  // Stamp ONLY when a push actually landed. A dead-subscription tick must not
  // burn the window — it should retry next run.
  if (result.sent <= 0) return "undelivered";

  try {
    await pb.collection("notification_log").create(
      { user, kind, bucket, sent_at: new Date().toISOString() },
      { $autoCancel: false },
    );
  } catch {
    // UNIQUE violation: a concurrent run already stamped this (user, kind,
    // bucket). The push went out (we got here only on sent > 0); treat as a
    // duplicate so the caller's counters stay honest. The double-send window is
    // the tiny gap between our read and create, which protect:true closes for
    // the single-replica case.
    return "duplicate";
  }

  return "sent";
}
