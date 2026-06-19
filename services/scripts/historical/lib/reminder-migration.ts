/**
 * Phase D, part 3 — pure planner for the one-shot migration that materializes
 * each life log's `manifest.notifications[]` (from the legacy `*_reminder_time`
 * columns) AND `manifest.views[]` (from `DEFAULT_VIEWS`), making the per-user
 * manifest the source of truth for BOTH keys. This guarantees the in-app
 * View/Notification editor (Phase D2) always edits persisted arrays — editing a
 * resolved-but-unpersisted default fallback would throw `*_not_found`.
 *
 * Everything here is pure (no PocketBase, no I/O) so it can be unit-tested
 * directly — see reminder-migration.test.ts. The driver
 * (migrate-reminder-columns-to-notifications.ts) owns auth + fetch + apply.
 *
 * SAFETY ARGUMENT (the whole point):
 *
 *   notifications — the cron's `resolveNotifications(log)` returns
 *   `manifest.notifications` verbatim when it's an array, else falls back to
 *   `buildNotificationsFromColumns(log)`. By materializing exactly
 *   `buildNotificationsFromColumns(log)` into the manifest, the resolved
 *   notifications are byte-identical to today's column fallback → ZERO change in
 *   send decisions. We reuse `buildNotificationsFromColumns` VERBATIM (imported
 *   from the api service) so the `*-reminder` id scheme + real column times +
 *   `subsumes`/`weekday` are preserved and the `reminder_state` double-fire
 *   guard keeps matching. Seeding `DEFAULT_NOTIFICATIONS` (bare ids +
 *   placeholder times) instead would break that guard — see the landmine doc in
 *   services/api/src/lib/notifications/life-notifications.ts.
 *
 *   views — `useViews()` (and the cron's view-title lookup) resolves an
 *   `undefined` `manifest.views` to `DEFAULT_VIEWS`. DEFAULT_VIEWS ids are
 *   `morning`/`evening`/`weekly` — they match `labels.view` and have NO
 *   reminder_state coupling, so materializing them VERBATIM is behavior-
 *   preserving (it's exactly what the fallback already returns). The landmine is
 *   notifications-only; views carry no double-fire guard.
 */
import { DEFAULT_VIEWS, RANDOM_SAMPLES, type LifeNotification, type LifeView } from "@homelab/backend";

// ---------------------------------------------------------------------------
// Column → notifications reconstruction (relocated from the api service)
//
// This logic used to live in services/api/src/lib/notifications/life-notifications.ts
// as the cron's `undefined`-manifest fallback. Phase D dropped the legacy
// `*_reminder_time` columns and simplified the cron to manifest-only, so the
// api service no longer needs it. It survives HERE — verbatim, behavior
// unchanged — only because this historical migration still references it (it
// is the exact thing the migration materialized into each log's manifest).
// Forensic value only; not on any live path.
// ---------------------------------------------------------------------------

/**
 * The minimal shape of a raw `life_logs` PB record this reconstruction reads.
 * The JS SDK parses the JSON `manifest` column to an object, so
 * `manifest.notifications` is a real array or `undefined`.
 */
export interface ResolvableLog {
  manifest?: { notifications?: LifeNotification[] | null } | null;
  morning_reminder_time?: string | null;
  evening_reminder_time?: string | null;
  weekly_reminder_time?: string | null;
  random_sampling_enabled?: boolean;
}

/** The column-derived notification ids (the `*-reminder` id scheme). */
export const MORNING_REMINDER_ID = "morning-reminder";
export const EVENING_REMINDER_ID = "evening-reminder";
export const WEEKLY_REMINDER_ID = "weekly-reminder";
export const SAMPLING_ID = "sampling";

/**
 * Reconstruct the pre-B4 notification behavior from the legacy columns. This
 * is what the migration materialized into `manifest.notifications[]`, byte-
 * faithful to the old cron:
 *
 *   - a non-empty `*_reminder_time` column ⇒ a `fixed` notification at that time
 *     (morning/evening daily; weekly = Sunday-only `weekday:0`, `subsumes` the
 *     evening reminder so the Sunday-evening double-nudge is suppressed);
 *   - an empty column ⇒ NO notification ⇒ no reminder;
 *   - `random_sampling_enabled` ⇒ a `random` notification from `RANDOM_SAMPLES`.
 *
 * The weekly notification ALWAYS lists `subsumes:["evening-reminder"]` but only
 * suppresses evening on the day it is itself scheduled (Sunday). When the
 * weekly time is empty it is still day-scheduled Sunday (so it subsumes
 * evening) but `time: ""` never delivers a push — reproducing "evening never
 * fires Sunday" without inventing a phantom weekly push.
 */
export function buildNotificationsFromColumns(log: ResolvableLog): LifeNotification[] {
  const out: LifeNotification[] = [];

  const morning = (log.morning_reminder_time || "").trim();
  if (morning) {
    out.push({
      id: MORNING_REMINDER_ID,
      target: "morning",
      strategy: { kind: "fixed", cadence: "daily", time: morning },
    });
  }

  const evening = (log.evening_reminder_time || "").trim();
  if (evening) {
    out.push({
      id: EVENING_REMINDER_ID,
      target: "evening",
      strategy: { kind: "fixed", cadence: "daily", time: evening },
    });
  }

  const weekly = (log.weekly_reminder_time || "").trim();
  if (weekly || evening) {
    out.push({
      id: WEEKLY_REMINDER_ID,
      target: "weekly",
      strategy: {
        kind: "fixed",
        cadence: "weekly",
        time: weekly,
        weekday: 0,
        subsumes: [EVENING_REMINDER_ID],
      },
    });
  }

  if (log.random_sampling_enabled) {
    out.push({
      id: SAMPLING_ID,
      target: "sampling",
      strategy: {
        kind: "random",
        timesPerDay: RANDOM_SAMPLES.timesPerDay,
        activeHours: RANDOM_SAMPLES.activeHours as [number, number],
      },
    });
  }

  return out;
}

/**
 * The raw `life_logs` PB record this planner reads (snake_case columns, JSON
 * `manifest` already parsed to an object by the JS SDK). Extends the cron's
 * `ResolvableLog` (its column + manifest.notifications fields) with the record
 * `id` and the rest of the manifest we must preserve byte-for-byte.
 */
export interface RawLifeLog extends ResolvableLog {
  id: string;
  /**
   * The full manifest JSON. We only inspect `.notifications` / `.views` to
   * decide which keys (if any) need materializing; every other key is preserved
   * verbatim. A key that is already an array (incl. an explicit `[]`) is never
   * overwritten.
   */
  manifest?:
    | ({
        notifications?: LifeNotification[] | null;
        views?: LifeView[] | null;
      } & Record<string, unknown>)
    | null;
}

/** A planned write: set `manifest` on `logId` to `nextManifest`. */
export interface MigrateWrite {
  kind: "migrate";
  logId: string;
  nextManifest: Record<string, unknown>;
  /**
   * The notifications materialized into the manifest, or `null` when
   * notifications were already an array (only views needed materializing).
   * For reporting.
   */
  notifications: LifeNotification[] | null;
  /**
   * The views materialized into the manifest, or `null` when views were already
   * an array (only notifications needed materializing). For reporting.
   */
  views: LifeView[] | null;
}

/** A log left untouched, with why. */
export interface SkipWrite {
  kind: "skip";
  logId: string;
  reason: string;
}

export type ReminderMigrationAction = MigrateWrite | SkipWrite;

/**
 * Plan the manifest materialization for every log. A log is migrated when
 * EITHER `manifest.notifications` OR `manifest.views` is not already an array;
 * each key is handled independently:
 *
 *   - `manifest.notifications` not an array → set
 *     `notifications = buildNotificationsFromColumns(log)` (`*-reminder` ids +
 *     real column times — the landmine guard).
 *   - `manifest.views` not an array → set `views = DEFAULT_VIEWS` (behavior-
 *     preserving: exactly what `useViews()` resolves an `undefined` views to).
 *   - A key ALREADY an array (incl. an explicit `[]`, e.g. Angela) is preserved
 *     verbatim — never overwritten.
 *   - BOTH keys already arrays → SKIP (no write; idempotent re-run no-op).
 *   - Only one undefined → write only the missing key; the other key + all
 *     sibling keys (trackables/goals/…) are preserved byte-for-byte.
 *
 * `nextManifest = { ...(manifest ?? { trackables: [] }), ...(notifications if
 * added), ...(views if added) }`.
 *
 * A log with empty columns + sampling off materializes `notifications: []` —
 * byte-identical send behavior (that user already gets no reminders; `[]`
 * yields the same zero notifications), and it makes the manifest the source of
 * truth so the cron stops column-falling-back.
 */
export function planReminderMigration(logs: RawLifeLog[]): ReminderMigrationAction[] {
  return logs.map((log) => {
    const existing = log.manifest ?? null;
    const needsNotifications = !Array.isArray(existing?.notifications);
    const needsViews = !Array.isArray(existing?.views);

    if (!needsNotifications && !needsViews) {
      return {
        kind: "skip",
        logId: log.id,
        reason:
          `already migrated (manifest.notifications is an array of ${existing!.notifications!.length}, ` +
          `manifest.views is an array of ${existing!.views!.length})`,
      };
    }

    const notifications = needsNotifications ? buildNotificationsFromColumns(log) : null;
    const views = needsViews ? DEFAULT_VIEWS : null;
    const base: Record<string, unknown> = existing ?? { trackables: [] };
    const nextManifest: Record<string, unknown> = {
      ...base,
      ...(notifications !== null ? { notifications } : {}),
      ...(views !== null ? { views } : {}),
    };
    return { kind: "migrate", logId: log.id, nextManifest, notifications, views };
  });
}
