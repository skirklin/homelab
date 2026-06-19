/**
 * The life notification resolve — manifest-only.
 *
 * Each `life_logs` row's notifications live entirely in
 * `manifest.notifications[]`. The cron (`life.ts`) resolves a log to its
 * notification list and dispatches per `strategy.kind`.
 *
 * History: Phase B4 introduced a data-driven notification model with a
 * transition-safe fallback that reconstructed notifications from the legacy
 * `*_reminder_time` columns (`buildNotificationsFromColumns`). Phase D
 * materialized every existing log's `manifest.notifications` from those
 * columns and then DROPPED the columns, so the fallback is gone — the manifest
 * is now the sole source of truth. The old column-reconstruction survives only
 * in the historical migration (services/scripts/historical/lib/reminder-migration.ts)
 * for forensic value.
 */
import type { LifeNotification } from "@homelab/backend";

/**
 * The minimal shape of a raw `life_logs` PB record this module reads. Its JSON
 * `manifest` column is already parsed to an object by the JS SDK, so
 * `manifest.notifications` is a real array or `undefined`.
 */
export interface ResolvableLog {
  manifest?: { notifications?: LifeNotification[] | null } | null;
}

/**
 * The single resolve point for a log's notifications: the array stored on
 * `manifest.notifications`, or `[]` when it is unset/garbage. Every existing
 * log was materialized with a real array by the Phase D migration, so a
 * missing array only happens for a brand-new log (seeded `[]` — see
 * life-manifest-default.ts) or a corrupt row, both of which correctly resolve
 * to "no notifications".
 */
export function resolveNotifications(log: ResolvableLog): LifeNotification[] {
  const fromManifest = log.manifest?.notifications;
  return Array.isArray(fromManifest) ? fromManifest : [];
}

/** A notification is enabled unless its `enabled` flag is explicitly false. */
export function isEnabled(n: LifeNotification): boolean {
  return n.enabled !== false;
}
