/**
 * Phase B4 — the data-driven notification resolve.
 *
 * The life notification cron (`life.ts`) used to hardcode three fixed session
 * reminders (morning/evening/weekly) read straight off the `*_reminder_time`
 * columns, plus a separately-gated random sampler. B4 turns that into a single
 * data-driven model: each log resolves to a list of `LifeNotification`s and the
 * cron dispatches per `strategy.kind`.
 *
 * The resolve is SAFETY-FIRST: it must produce byte-identical send decisions to
 * the pre-B4 cron for every existing user, WITHOUT a data migration. Existing
 * users have NO `manifest.notifications` set, so they take the
 * `buildNotificationsFromColumns` path which reconstructs today's exact
 * behavior from the legacy columns. Angela (`manifest.notifications = []`) takes
 * the verbatim-`[]` path → zero notifications.
 */
import type { LifeNotification } from "@homelab/backend";
import { RANDOM_SAMPLES } from "@homelab/backend";

/**
 * The minimal shape of a raw `life_logs` PB record this module reads. The cron
 * passes the admin-PB `RecordModel` straight through; its JSON `manifest`
 * column is already parsed to an object by the JS SDK (HTTP transport), so
 * `manifest.notifications` is a real array or `undefined`.
 */
export interface ResolvableLog {
  manifest?: { notifications?: LifeNotification[] | null } | null;
  morning_reminder_time?: string | null;
  evening_reminder_time?: string | null;
  weekly_reminder_time?: string | null;
  random_sampling_enabled?: boolean;
}

/**
 * The column-derived notification ids. These are STABLE and load-bearing: the
 * transition-safe idempotency in the cron treats `reminder_state[id]` OR the
 * legacy `last_{morning,evening,weekly}_reminder_sent` column as "sent today",
 * keyed off exactly these ids. Do NOT rename without the matching legacy-column
 * map in `life.ts`.
 */
export const MORNING_REMINDER_ID = "morning-reminder";
export const EVENING_REMINDER_ID = "evening-reminder";
export const WEEKLY_REMINDER_ID = "weekly-reminder";
export const SAMPLING_ID = "sampling";

/**
 * The legacy `last_*_reminder_sent` column that backs each column-derived id,
 * for the transition-safe double-fire guard. Only the three fixed reminders
 * have a legacy column; the sampler has always used `sample_schedule`.
 */
export const LEGACY_SENT_COLUMN: Record<string, string> = {
  [MORNING_REMINDER_ID]: "last_morning_reminder_sent",
  [EVENING_REMINDER_ID]: "last_evening_reminder_sent",
  [WEEKLY_REMINDER_ID]: "last_weekly_reminder_sent",
};

/**
 * Reconstruct the pre-B4 notification behavior from the legacy columns — the
 * fallback used whenever a log has NO `manifest.notifications`. Byte-faithful to
 * the old cron:
 *
 *   - a non-empty `*_reminder_time` column ⇒ a `fixed` notification at that time
 *     (morning/evening daily; weekly = Sunday-only `weekday:0`, `subsumes` the
 *     evening reminder so the Sunday-evening double-nudge is suppressed exactly
 *     as before);
 *   - an empty column ⇒ NO notification ⇒ no reminder (today's behavior: an
 *     unset `*_reminder_time` simply never fires);
 *   - `random_sampling_enabled` ⇒ a `random` notification from `RANDOM_SAMPLES`
 *     (the sampler's own gate stays in place, so this is purely additive).
 *
 * The weekly notification ALWAYS lists `subsumes:["evening-reminder"]`, but it
 * only actually suppresses the evening reminder on the day it is itself
 * scheduled to fire (Sunday) — the cron checks "is M scheduled-to-fire today"
 * before honoring its `subsumes`. So on Mon–Sat the evening reminder fires
 * normally; on Sunday the weekly is scheduled and subsumes evening → evening
 * skips. This is identical to the old `EEEE === "Sunday"` evening-skip branch.
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

  // The weekly notification serves TWO roles: (1) fire the Sunday weekly review
  // at `weekly_reminder_time`, and (2) subsume the evening reminder on Sunday.
  // The pre-B4 cron suppressed the evening reminder on Sunday UNCONDITIONALLY —
  // even for a log with an evening time but NO weekly time. To stay byte-
  // identical we emit a weekly notification whenever EITHER the weekly time OR
  // the evening time is set:
  //   - weekly time set    → it's scheduled Sunday and pushes at that time.
  //   - weekly time empty  → `time: ""` is day-scheduled Sunday (so it still
  //     subsumes evening) but `withinWindow("", ...)` is always false, so it
  //     never delivers a push. This reproduces "evening never fires Sunday"
  //     without inventing a phantom weekly push.
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
 * The single resolve point for a log's notifications:
 *
 *   manifest.notifications ?? buildNotificationsFromColumns(log)
 *
 * A set `manifest.notifications` (including an explicit `[]`, e.g. Angela) is
 * used verbatim. `undefined`/`null` falls back to the column-derived
 * reconstruction. This preserves today's behavior for every existing user (who
 * has no manifest.notifications) with no data migration.
 *
 * ⚠️ PHASE D ID-SCHEME LANDMINE — the fallback intentionally reconstructs from
 * the legacy columns (`buildNotificationsFromColumns`), NOT from
 * `DEFAULT_NOTIFICATIONS`, so it stays byte-identical to the pre-B4 cron AND so
 * it emits the column-derived `*-reminder` ids (`morning-reminder` /
 * `evening-reminder` / `weekly-reminder`) with each log's REAL column times.
 * Those `*-reminder` ids are what `reminder_state[id]` keys on and what the
 * transition-safe double-fire guard maps through `LEGACY_SENT_COLUMN`. When
 * Phase D seeds/migrates `manifest.notifications` from the columns it MUST keep
 * the `*-reminder` ids and copy the real column times — `DEFAULT_NOTIFICATIONS`
 * (in `life-view-defaults.ts`) uses BARE ids (`morning`/`evening`/`weekly`) +
 * placeholder times and is only the new-user/editor default. Seeding the bare
 * ids would make the legacy guard stop matching and reminders could double-fire
 * on the seed day. (Cross-refs: `LifeManifest.notifications` doc in
 * `packages/backend/src/types/life.ts`; `DEFAULT_NOTIFICATIONS` in
 * `packages/backend/src/life-view-defaults.ts`.)
 */
export function resolveNotifications(log: ResolvableLog): LifeNotification[] {
  const fromManifest = log.manifest?.notifications;
  if (Array.isArray(fromManifest)) return fromManifest;
  return buildNotificationsFromColumns(log);
}

/** A notification is enabled unless its `enabled` flag is explicitly false. */
export function isEnabled(n: LifeNotification): boolean {
  return n.enabled !== false;
}
