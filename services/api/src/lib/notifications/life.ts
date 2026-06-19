/**
 * Life notification cron — data-driven (Phase B4 + Phase D).
 *
 * Each `life_logs` row resolves to a list of `LifeNotification`s
 * (`resolveNotifications`: `manifest.notifications`, or `[]` when unset) and the
 * cron dispatches per `strategy.kind`:
 *
 *   - `fixed`  — a wall-clock reminder (daily, or weekly pinned to a weekday)
 *                that opens its target View. `subsumes` suppresses other
 *                notifications on the day it fires (weekly subsumes evening on
 *                Sunday). Handled here in `runLifeReminderCheck` (per-minute).
 *   - `random` — random sampling check-ins. The existing `runLifeTrackerSampling`
 *                state machine (per-5-min) is reused verbatim, now additionally
 *                gated on a `random` notification being present in the resolve.
 *
 * Phase D retired the legacy `*_reminder_time` columns: every existing log's
 * `manifest.notifications` was materialized from them first, so the manifest is
 * now the sole source of truth and the resolve no longer falls back to columns.
 */
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import type { SampleSchedule, LifeView, LifeNotification, LifeNotifyStrategy } from "@homelab/backend";
import { RANDOM_SAMPLES, DEFAULT_VIEWS } from "@homelab/backend";
import { getAdminPb } from "../pb";
import { sendPushToUser } from "../push";
import { DOMAIN } from "../../config";
import { makeUserTzResolver, safeTz } from "./tz";
import { notifyOnce } from "./ledger";
import { resolveNotifications, isEnabled } from "./life-notifications";

// Life is now standalone at life.kirkl.in (the old kirkl.in/life module was
// removed) — both session wizards and the sampling UI mount at root there, so
// deep links are root-relative paths. `https://kirkl.in` is kept as a lower-
// priority fallback so any LEGACY subscription registered back when life was
// embedded under kirkl.in/life still receives reminders (otherwise it matches
// neither the preferred list nor the empty-origin legacy fallback and silently
// drops). The relative `/morning` path resolves fine on either origin.
const LIFE_ORIGINS = [`https://life.${DOMAIN}`, `https://${DOMAIN}`];

/**
 * Origin-aware deep link for a target View. Life is standalone-only, so the
 * path is just root-relative (`/<view>`); the service worker resolves it
 * against the delivery origin. Same shape as travel's tripUrl/dayUrl — passed
 * to sendPushToUser as `buildUrl` so the emitted url is SAME-ORIGIN relative
 * (never an absolute https://life.kirkl.in URL, which would cold-load an empty
 * per-origin authStore = forced sign-out). The morning/evening/weekly target
 * ids match today's `sessionUrl(kind)` exactly, so existing reminders deep-link
 * to the same `/morning` `/evening` `/weekly` URLs.
 */
export function viewUrl(target: string): string {
  return `/${target}`;
}

// Used when RANDOM_SAMPLES.timezone is missing/garbage. Differs from travel's
// "America/Denver" default — for random sampling we want deterministic times
// for users without a tz preference, not the system-owner's clock.
const FALLBACK_TZ = "UTC";

function getDateStringInTimezone(date: Date, timezone: string): string {
  const zonedDate = toZonedTime(date, timezone);
  const year = zonedDate.getFullYear();
  const month = String(zonedDate.getMonth() + 1).padStart(2, "0");
  const day = String(zonedDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function generateSampleTimes(
  timesPerDay: number,
  activeHours: [number, number],
  dateString: string,
  timezone: string,
): number[] {
  const [startHour, endHour] = activeHours;
  const dateMatch = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return [];

  const [, yearStr, monthStr, dayStr] = dateMatch;
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  const totalMinutes = (endHour - startHour) * 60;
  const interval = totalMinutes / timesPerDay;
  const times: number[] = [];

  for (let i = 0; i < timesPerDay; i++) {
    const baseMinute = startHour * 60 + interval * i + interval / 2;
    const jitter = (Math.random() - 0.5) * interval * 0.5;
    const minute = Math.max(startHour * 60, Math.min(endHour * 60, baseMinute + jitter));

    const hour = Math.floor(minute / 60);
    const min = Math.round(minute % 60);

    const localDate = new Date(year, month - 1, day, hour, min, 0);
    const utcDate = fromZonedTime(localDate, timezone);
    times.push(utcDate.getTime());
  }

  return times.sort((a, b) => a - b);
}

/**
 * Return the resolved `random` notification for a log, or null. Used as an
 * additional gate on the sampler so sampling is a notification STRATEGY, not a
 * standalone feature. A log opts into sampling by listing a `random`
 * notification in `manifest.notifications` (alongside the `random_sampling_enabled`
 * flag, which gates schedule generation). A log without one (e.g. Angela's `[]`)
 * never samples.
 */
function randomNotificationFor(
  log: Record<string, unknown>,
): (LifeNotifyStrategy & { kind: "random" }) | null {
  for (const n of resolveNotifications(log as never)) {
    if (isEnabled(n) && n.strategy.kind === "random") return n.strategy;
  }
  return null;
}

export async function runLifeTrackerSampling(): Promise<{ sent: number; skipped: number }> {
  const pb = await getAdminPb();
  const now = Date.now();
  const nowDate = new Date();

  // PocketBase can't filter on nested JSON, so fetch all and filter in code
  const logs = await pb.collection("life_logs").getFullList({
    $autoCancel: false,
  });

  let totalSent = 0;
  let totalSkipped = 0;

  // Two layers of gating:
  //   1. `RANDOM_SAMPLES.enabled` — system-wide kill switch from @homelab/backend.
  //      If sampling is globally disabled or misconfigured we skip the whole tick.
  //   2. A resolved `random` notification per log — a log opts in by listing a
  //      `{kind:"random"}` notification in `manifest.notifications`. (Logs that
  //      had `random_sampling_enabled` set were materialized with exactly such a
  //      notification by the Phase D column→manifest migration.) Per-log check
  //      happens inside the loop below.
  const config = RANDOM_SAMPLES;
  if (!config.enabled || !config.timesPerDay || config.timesPerDay < 1) {
    return { sent: 0, skipped: logs.length };
  }
  if (!Array.isArray(config.activeHours) || config.activeHours.length !== 2 ||
      config.activeHours[0] >= config.activeHours[1]) {
    return { sent: 0, skipped: logs.length };
  }

  // Per-owner tz resolution, mirroring runLifeReminderCheck's `tzForUser`.
  // Each log's check-ins must fire in ITS OWNER's timezone, not a global one,
  // so a second user's prompts land in their local active hours (P0 isolation
  // gap — apps/life/ROADMAP.md). Owner tz wins; fall back to the system-wide
  // config tz, then UTC.
  const configTz = safeTz(config.timezone, FALLBACK_TZ);
  const tzForOwner = makeUserTzResolver(pb, configTz);

  for (const logDoc of logs) {
    // Per-log gate. An enabled `random` notification must be present in the
    // log's resolved `manifest.notifications`. Must come before schedule
    // generation so ungated logs don't accumulate `sample_schedule` writes.
    const randomStrategy = randomNotificationFor(logDoc);
    if (!randomStrategy) {
      totalSkipped++;
      continue;
    }

    // The strategy carries its own timesPerDay/activeHours. Validate the
    // strategy's hours the same way as the global config (a malformed
    // manifest-set strategy is skipped, not crashed).
    const timesPerDay = randomStrategy.timesPerDay;
    const activeHours = randomStrategy.activeHours;
    if (!timesPerDay || timesPerDay < 1 ||
        !Array.isArray(activeHours) || activeHours.length !== 2 || activeHours[0] >= activeHours[1]) {
      totalSkipped++;
      continue;
    }

    // life_logs is single-owner (migration 0028) — `owner` is the user id
    // string (empty if unset). Resolve the schedule's tz from the owner so
    // each user's prompts fire in their own local active hours.
    const ownerId: string = (logDoc.owner as string) || "";
    const timezone = await tzForOwner(ownerId);
    const today = getDateStringInTimezone(nowDate, timezone);

    let schedule = logDoc.sample_schedule as SampleSchedule | null;

    // Generate new schedule for today if needed
    if (!schedule || schedule.date !== today) {
      const times = generateSampleTimes(timesPerDay, activeHours, today, timezone);
      schedule = { date: today, times, sentTimes: [] };
      await pb.collection("life_logs").update(logDoc.id, {
        sample_schedule: schedule,
      }, { $autoCancel: false });
      console.log(`[life] Generated ${times.length} sample times for log ${logDoc.id} (${today})`);
    }

    // Find pending times (due within last 15 minutes, not yet sent)
    const maxAgeMs = 15 * 60 * 1000;
    const pendingTimes = schedule.times.filter(
      t => t <= now && t > now - maxAgeMs && !schedule!.sentTimes.includes(t),
    );

    // Mark old unsent times as sent (prevent catch-up floods)
    const oldTimes = schedule.times.filter(
      t => t <= now - maxAgeMs && !schedule!.sentTimes.includes(t),
    );

    if (oldTimes.length > 0) {
      schedule.sentTimes = [...schedule.sentTimes, ...oldTimes];
      await pb.collection("life_logs").update(logDoc.id, {
        sample_schedule: schedule,
      }, { $autoCancel: false });
    }

    if (pendingTimes.length === 0) {
      totalSkipped++;
      continue;
    }

    // Send max 1 per run per log
    const timeToSend = pendingTimes[0];

    const title = "Life Tracker Check-in";
    const body = config.questions.length === 1
      ? config.questions[0].label
      : `Answer ${config.questions.length} quick questions`;

    // If there's exactly one question, render the push notification with
    // 1-5 quick-action buttons via the service worker. Post-collapse all
    // sample questions point at rating trackables (1-5 picker), so the max
    // is fixed at 5 — no per-question max field needed. The service worker
    // (apps/*/public/push-sw.js) reads `quickRatingId` as the subject_id to
    // write the resulting value event against.
    const quickRating = config.questions.length === 1 ? config.questions[0] : null;

    // Mark this time into sentTimes only AFTER a delivery landed, mirroring
    // runLifeReminderCheck. The old code marked before sending ("single
    // replica, no race"); the no-race part still holds (croner protect:true),
    // but marking before send burned the slot on a no-delivery tick (no subs /
    // all failed / no owner) with no retry. Now an undelivered slot stays
    // pending so the next within-window tick (~15-min window) retries it. Each
    // times[] entry is independent, so this doesn't affect multi-sample-per-day
    // semantics. The oldTimes flood-guard above is unchanged — those are
    // intentionally suppressed regardless of delivery.
    let delivered = false;
    if (ownerId) {
      const result = await sendPushToUser(pb, ownerId, {
        title,
        body,
        data: {
          type: "life_tracker_sample",
          logId: logDoc.id,
          ...(quickRating && {
            quickRatingId: quickRating.trackableId,
            quickRatingMax: "5",
          }),
        },
      }, { preferredOrigins: LIFE_ORIGINS });
      console.log(`[life] Log ${logDoc.id} → user ${ownerId}: ${result.sent} sent, ${result.expired} expired, ${result.failed} failed`);
      delivered = result.sent > 0;
    }

    if (delivered) {
      schedule.sentTimes = [...schedule.sentTimes, timeToSend];
      await pb.collection("life_logs").update(logDoc.id, {
        sample_schedule: schedule,
      }, { $autoCancel: false });
      totalSent++;
    } else {
      console.warn(`[life] Log ${logDoc.id} sample 0 delivered — not marking, will retry within window`);
      totalSkipped++;
    }
  }

  return { sent: totalSent, skipped: totalSkipped };
}

// ---------------------------------------------------------------------------
// Fixed-strategy session reminders (morning / evening / weekly + any
// manifest-defined fixed notification)
// ---------------------------------------------------------------------------

// Push body/title for the column-derived session reminders, kept byte-faithful
// to the pre-B4 cron so existing users' pushes are unchanged. The DEFAULT_VIEWS
// greetings already match these bodies, but the TITLES differ ("Morning" vs
// "Morning check-in"), so for the three legacy targets we keep these exact
// strings. Any other target falls back to the resolved View's title/greeting.
const LEGACY_REMINDER_CONTENT: Record<string, { title: string; body: string }> = {
  morning: {
    title: "Morning check-in",
    body: "Good morning. A few questions before the day gets going.",
  },
  evening: {
    title: "Evening wind-down",
    body: "Wind-down time. A few quick reflections.",
  },
  weekly: {
    title: "Weekly review",
    body: "Time to look back on the week.",
  },
};

/**
 * Resolve the push title/body for a fixed notification. Precedence:
 *   1. the notification's OWN `title`/`body` (custom copy), when set;
 *   2. the byte-faithful legacy strings for morning/evening/weekly targets (so
 *      existing reminders without custom copy are unchanged);
 *   3. the target View's `title` + `greeting` (`manifest.views ?? DEFAULT_VIEWS`);
 *   4. a generic `{title:"Reminder", body:"Time to check in."}` fallback.
 *
 * A notification that sets ONLY `title` (or only `body`) still inherits the
 * other field from the legacy/view-derived copy — the custom value wins
 * field-by-field, so a partial override never blanks the other field.
 */
export function pushContentForTarget(
  notif: { target: string; title?: string; body?: string },
  views: LifeView[] | undefined,
): { title: string; body: string } {
  const derived =
    LEGACY_REMINDER_CONTENT[notif.target] ??
    (() => {
      const view = views?.find((v) => v.id === notif.target);
      return {
        title: view?.title || "Reminder",
        body: view?.greeting || "Time to check in.",
      };
    })();
  return {
    title: notif.title || derived.title,
    body: notif.body || derived.body,
  };
}

/**
 * Returns true if `target` ("HH:MM") matches `current` ("HH:MM") within a
 * ±windowMin window. Both inputs are interpreted as wall-clock times on the
 * same day; the comparison wraps midnight (23:59 vs 00:00 within window).
 */
function withinWindow(target: string, current: string, windowMin: number): boolean {
  const toMin = (s: string): number | null => {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mn = parseInt(m[2], 10);
    if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
    return h * 60 + mn;
  };
  const t = toMin(target);
  const c = toMin(current);
  if (t === null || c === null) return false;
  const dayMin = 24 * 60;
  let diff = Math.abs(t - c);
  if (diff > dayMin / 2) diff = dayMin - diff;
  return diff <= windowMin;
}

/**
 * Map JS `Date.getDay()`-style weekday (0=Sun..6=Sat) from a tz-rendered day
 * name. date-fns-tz's `EEEE` token gives the English day name regardless of
 * locale config, which we map to 0..6.
 */
const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
};

/**
 * Is a `fixed` notification scheduled to fire TODAY (in `tz`)? "Today" gates on
 * cadence: daily fires every day; weekly fires only on `weekday` (0=Sun). This
 * is the day-level predicate — the ±1min time match is checked separately. It's
 * also what `subsumes` consults: a notification only suppresses others on a day
 * it is itself scheduled.
 */
function fixedScheduledToday(
  strategy: LifeNotifyStrategy & { kind: "fixed" },
  weekdayIdx: number,
): boolean {
  if (strategy.cadence === "weekly") {
    return weekdayIdx === (strategy.weekday ?? 0);
  }
  return true;
}

/**
 * Per-minute cron tick. For each log, resolves its notifications and fires any
 * `fixed` one whose owner-local wall-clock matches `strategy.time` (±1 min),
 * unless it's subsumed by another notification scheduled to fire today.
 *
 * Idempotency: a notification counts as already-sent-today iff
 * `reminder_state[id] === today`. (Pre-Phase-D this also OR'd the legacy
 * `last_*_reminder_sent` columns; those columns are dropped — reminder_state is
 * now the sole idempotency store.)
 *
 * Mark-after-success is preserved: `reminder_state[id]` is written only when a
 * push actually landed (result.sent > 0), so a no-delivery tick retries within
 * the ±1min window.
 */
export async function runLifeReminderCheck(
  now: Date = new Date(),
): Promise<{ checked: number; sent: number; skipped: number }> {
  const pb = await getAdminPb();

  // PB can't filter `field != null && field != ""` over JSON or empty strings
  // uniformly; pull all logs and let JS decide. Volume is tiny (single-user
  // for now; one row per life log).
  const logs = await pb.collection("life_logs").getFullList({
    $autoCancel: false,
  });

  let checked = 0;
  let sent = 0;
  let skipped = 0;

  const tzForUser = makeUserTzResolver(pb, FALLBACK_TZ);

  for (const logDoc of logs) {
    const notifications = resolveNotifications(logDoc as never);
    // Only fixed notifications fire here; random is handled by the sampler.
    const fixedNotifs = notifications.filter(
      (n): n is LifeNotification & { strategy: LifeNotifyStrategy & { kind: "fixed" } } =>
        isEnabled(n) && n.strategy.kind === "fixed",
    );
    if (fixedNotifs.length === 0) continue;

    const ownerId: string = (logDoc.owner as string) || "";

    // Per-owner tz, resolved once per log (every fixed notification on a log
    // shares the owner's clock).
    const tz = ownerId ? await tzForUser(ownerId) : FALLBACK_TZ;
    const currentHHmm = formatInTimeZone(now, tz, "HH:mm");
    const todayYmd = formatInTimeZone(now, tz, "yyyy-MM-dd");
    const weekdayIdx = WEEKDAY_INDEX[formatInTimeZone(now, tz, "EEEE")] ?? 0;

    // Which notifications are scheduled to fire today (used by `subsumes`).
    const scheduledTodayIds = new Set(
      fixedNotifs.filter((n) => fixedScheduledToday(n.strategy, weekdayIdx)).map((n) => n.id),
    );
    // A notification is subsumed today iff some notification scheduled to fire
    // today lists its id in `subsumes`. (Weekly subsumes evening on Sunday.)
    const subsumedIds = new Set<string>();
    for (const n of fixedNotifs) {
      if (!scheduledTodayIds.has(n.id)) continue;
      for (const victim of n.strategy.subsumes ?? []) subsumedIds.add(victim);
    }

    // Resolve the log's Views once for push title/body (manifest.views ??
    // DEFAULT_VIEWS), mirroring resolveNotifications' fallback shape.
    const manifestViews = (logDoc.manifest as { views?: LifeView[] | null } | null | undefined)?.views;
    const views = Array.isArray(manifestViews) ? manifestViews : DEFAULT_VIEWS;

    for (const n of fixedNotifs) {
      const strategy = n.strategy;
      checked++;

      if (!ownerId) {
        skipped++;
        continue;
      }
      // Weekly cadence: only its weekday.
      if (!fixedScheduledToday(strategy, weekdayIdx)) {
        skipped++;
        continue;
      }
      // Subsumed today (e.g. evening on Sunday): skip.
      if (subsumedIds.has(n.id)) {
        skipped++;
        continue;
      }
      if (!withinWindow(strategy.time, currentHHmm, 1)) {
        skipped++;
        continue;
      }

      // Once-per-owner-local-day idempotency via the shared ledger. `notifyOnce`
      // owns the check + send + mark-after-success: it stamps a notification_log
      // row keyed (user, "life_reminder:<id>", todayYmd) ONLY when a push lands,
      // so a no-delivery tick retries within the ±1min window. The bucket is the
      // OWNER-LOCAL day (todayYmd, not todayPacific) so a non-Pacific owner's
      // reminder is one-per-their-day. (Replaces the per-log reminder_state map.)
      const content = pushContentForTarget(n, views);
      try {
        const result = await notifyOnce(pb, {
          user: ownerId,
          kind: `life_reminder:${n.id}`,
          bucket: todayYmd,
          payload: {
            title: content.title,
            body: content.body,
            buildUrl: () => viewUrl(n.target),
            // One stable `life_reminder` type for every target (morning/evening/
            // weekly/any View); the SW deep-links via `data.url` (buildUrl), so it
            // never needed the per-target string. `target` rides along for
            // analytics/debugging. (Was the dynamic, un-registrable
            // `life_${target}_reminder`, which the SW silently dropped to its
            // generic url branch.)
            data: { type: "life_reminder", target: n.target, logId: logDoc.id },
          },
          preferredOrigins: LIFE_ORIGINS,
        });
        console.log(`[life-reminder/${n.id}] log ${logDoc.id} → user ${ownerId} (${tz}): ${result}`);
        if (result === "sent") {
          sent++;
        } else if (result === "undelivered") {
          console.warn(`[life-reminder/${n.id}] 0 delivered — not marking, will retry within window`);
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`[life-reminder/${n.id}] log ${logDoc.id} → user ${ownerId}:`, err);
      }
    }
  }

  return { checked, sent, skipped };
}
