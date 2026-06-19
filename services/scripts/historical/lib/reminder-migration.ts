/**
 * Phase D, part 3 — pure planner for the one-shot migration that copies each
 * life log's legacy `*_reminder_time` columns into `manifest.notifications[]`,
 * making the per-user notification manifest the source of truth.
 *
 * Everything here is pure (no PocketBase, no I/O) so it can be unit-tested
 * directly — see reminder-migration.test.ts. The driver
 * (migrate-reminder-columns-to-notifications.ts) owns auth + fetch + apply.
 *
 * SAFETY ARGUMENT (the whole point): the cron's `resolveNotifications(log)`
 * returns `manifest.notifications` verbatim when it's an array, else falls back
 * to `buildNotificationsFromColumns(log)`. By materializing exactly
 * `buildNotificationsFromColumns(log)` into the manifest, the resolved
 * notifications are byte-identical to today's column fallback → ZERO change in
 * send decisions. We reuse `buildNotificationsFromColumns` VERBATIM (imported
 * from the api service) so the `*-reminder` id scheme + real column times +
 * `subsumes`/`weekday` are preserved and the `reminder_state` double-fire guard
 * keeps matching. Seeding `DEFAULT_NOTIFICATIONS` (bare ids + placeholder times)
 * instead would break that guard — see the landmine doc in
 * services/api/src/lib/notifications/life-notifications.ts.
 */
import type { LifeNotification } from "@homelab/backend";
import {
  buildNotificationsFromColumns,
  type ResolvableLog,
} from "../../../api/src/lib/notifications/life-notifications";

/**
 * The raw `life_logs` PB record this planner reads (snake_case columns, JSON
 * `manifest` already parsed to an object by the JS SDK). Extends the cron's
 * `ResolvableLog` (its column + manifest.notifications fields) with the record
 * `id` and the rest of the manifest we must preserve byte-for-byte.
 */
export interface RawLifeLog extends ResolvableLog {
  id: string;
  /**
   * The full manifest JSON. We only inspect `.notifications` for the
   * already-migrated skip; every other key is preserved verbatim.
   */
  manifest?: ({ notifications?: LifeNotification[] | null } & Record<string, unknown>) | null;
}

/** A planned write: set `manifest` on `logId` to `nextManifest`. */
export interface MigrateWrite {
  kind: "migrate";
  logId: string;
  nextManifest: Record<string, unknown>;
  /** The notifications materialized into the manifest (for reporting). */
  notifications: LifeNotification[];
}

/** A log left untouched, with why. */
export interface SkipWrite {
  kind: "skip";
  logId: string;
  reason: string;
}

export type ReminderMigrationAction = MigrateWrite | SkipWrite;

/**
 * Plan the column→manifest migration for every log.
 *
 *   - `manifest.notifications` already an array (incl. an explicit `[]`,
 *     e.g. Angela) → SKIP (idempotent: a second --apply is a no-op).
 *   - else → migrate: `notifications = buildNotificationsFromColumns(log)`,
 *     `nextManifest = { ...(manifest ?? { trackables: [] }), notifications }`.
 *     Every other manifest key (trackables/goals/views/…) is preserved
 *     byte-for-byte; we do NOT seed/alter them.
 *
 * A log with empty columns + sampling off plans a migrate writing
 * `notifications: []` — byte-identical send behavior (that user already gets
 * no reminders; `[]` yields the same zero notifications), and it materializes
 * the manifest as source of truth so the cron stops column-falling-back.
 */
export function planReminderMigration(logs: RawLifeLog[]): ReminderMigrationAction[] {
  return logs.map((log) => {
    const existing = log.manifest ?? null;
    if (Array.isArray(existing?.notifications)) {
      return {
        kind: "skip",
        logId: log.id,
        reason: `already migrated (manifest.notifications is an array of ${existing!.notifications!.length})`,
      };
    }

    const notifications = buildNotificationsFromColumns(log);
    const base: Record<string, unknown> = existing ?? { trackables: [] };
    const nextManifest = { ...base, notifications };
    return { kind: "migrate", logId: log.id, nextManifest, notifications };
  });
}
