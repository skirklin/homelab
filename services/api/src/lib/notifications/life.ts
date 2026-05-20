/**
 * Life Tracker random sampling notification trigger.
 * Generates random sample times daily and sends push notifications when they're due.
 */
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import type { SampleSchedule } from "@homelab/backend";
import { getAdminPb } from "../pb";
import { sendPushToUser } from "../push";
import { DOMAIN } from "../../config";
import { safeTz } from "./tz";

// Life is reachable both as a subdomain (life.kirkl.in) and as a module under
// the home shell (kirkl.in/life). preferredOrigins picks one per user so we
// don't double-push to the same device.
const LIFE_SUBDOMAIN_BASE = `https://life.${DOMAIN}`;
const LIFE_ORIGINS = [LIFE_SUBDOMAIN_BASE, `https://${DOMAIN}`];

// Used when a log's RandomSamplesConfig is missing/garbage timezone. Differs
// from travel's "America/Denver" default — for random sampling we want
// deterministic times for users without a tz preference, not the
// system-owner's clock.
const FALLBACK_TZ = "UTC";

interface SampleQuestion {
  id: string;
  type: "rating" | "text" | "number";
  label: string;
  max?: number;
}

interface RandomSamplesConfig {
  enabled: boolean;
  timesPerDay: number;
  activeHours: [number, number];
  timezone?: string;
  questions: SampleQuestion[];
}

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

  for (const logDoc of logs) {
    const manifest = logDoc.manifest as { randomSamples?: RandomSamplesConfig } | null;
    const config = manifest?.randomSamples;
    if (!config?.enabled || !config.timesPerDay || config.timesPerDay < 1) continue;

    if (!Array.isArray(config.activeHours) || config.activeHours.length !== 2 ||
        config.activeHours[0] >= config.activeHours[1]) continue;

    const timezone = safeTz(config.timezone, FALLBACK_TZ);
    const today = getDateStringInTimezone(nowDate, timezone);

    let schedule = logDoc.sample_schedule as SampleSchedule | null;

    // Generate new schedule for today if needed
    if (!schedule || schedule.date !== today) {
      const times = generateSampleTimes(config.timesPerDay, config.activeHours, today, timezone);
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

    // Mark as sent before sending (single replica, no race)
    schedule.sentTimes = [...schedule.sentTimes, timeToSend];
    await pb.collection("life_logs").update(logDoc.id, {
      sample_schedule: schedule,
    }, { $autoCancel: false });

    // Send to all owners
    const ownerIds: string[] = logDoc.owners || [];
    const title = "Life Tracker Check-in";
    const body = config.questions.length === 1
      ? config.questions[0].label
      : `Answer ${config.questions.length} quick questions`;

    const quickRating = config.questions.length === 1 && config.questions[0].type === "rating"
      ? config.questions[0] : null;

    for (const ownerId of ownerIds) {
      const result = await sendPushToUser(pb, ownerId, {
        title,
        body,
        data: {
          type: "life_tracker_sample",
          logId: logDoc.id,
          ...(quickRating && {
            quickRatingId: quickRating.id,
            quickRatingMax: String(quickRating.max || 5),
          }),
        },
      }, { preferredOrigins: LIFE_ORIGINS });
      console.log(`[life] Log ${logDoc.id} → user ${ownerId}: ${result.sent} sent`);
    }

    totalSent++;
  }

  return { sent: totalSent, skipped: totalSkipped };
}

// ---------------------------------------------------------------------------
// Morning / evening session reminders
// ---------------------------------------------------------------------------

// Greetings shown as the push body. Kept in sync with the SESSIONS entries in
// apps/life/app/src/manifest.ts. Duplicated here rather than imported because
// the api service doesn't depend on the life app and the strings rarely move.
const SESSION_REMINDERS = {
  morning: {
    title: "Morning check-in",
    body: "Good morning. A few questions before the day gets going.",
    url: `${LIFE_SUBDOMAIN_BASE}/morning`,
  },
  evening: {
    title: "Evening wind-down",
    body: "Wind-down time. Three quick reflections.",
    url: `${LIFE_SUBDOMAIN_BASE}/evening`,
  },
} as const;

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

interface ReminderKind {
  field: "morning_reminder_time" | "evening_reminder_time";
  sentField: "last_morning_reminder_sent" | "last_evening_reminder_sent";
  kind: "morning" | "evening";
}

const REMINDER_KINDS: ReminderKind[] = [
  {
    field: "morning_reminder_time",
    sentField: "last_morning_reminder_sent",
    kind: "morning",
  },
  {
    field: "evening_reminder_time",
    sentField: "last_evening_reminder_sent",
    kind: "evening",
  },
];

/**
 * Per-minute cron tick. Fires the morning or evening session reminder to
 * each log's owners when their local wall-clock time matches the configured
 * "HH:MM" (within ±1 min). Idempotent via last_{morning,evening}_reminder_sent
 * = "YYYY-MM-DD" in the user's tz.
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

  const userTzCache = new Map<string, string>();
  async function tzForUser(userId: string): Promise<string> {
    const hit = userTzCache.get(userId);
    if (hit) return hit;
    try {
      const u = await pb.collection("users").getOne(userId, { $autoCancel: false });
      const tz = safeTz(u.timezone, FALLBACK_TZ);
      userTzCache.set(userId, tz);
      return tz;
    } catch {
      userTzCache.set(userId, "UTC");
      return "UTC";
    }
  }

  for (const logDoc of logs) {
    for (const kind of REMINDER_KINDS) {
      const target = (logDoc[kind.field] as string | undefined) || "";
      if (!target) continue;
      checked++;

      const ownerIds: string[] = logDoc.owners || [];
      if (ownerIds.length === 0) {
        skipped++;
        continue;
      }

      // Use the first owner's timezone for the reminder. Multi-owner logs are
      // a future concern; for now there's one user per log.
      const tz = await tzForUser(ownerIds[0]);
      const currentHHmm = formatInTimeZone(now, tz, "HH:mm");
      const todayYmd = formatInTimeZone(now, tz, "yyyy-MM-dd");

      if (!withinWindow(target, currentHHmm, 1)) {
        skipped++;
        continue;
      }

      const lastSent = (logDoc[kind.sentField] as string | undefined) || "";
      if (lastSent === todayYmd) {
        skipped++;
        continue;
      }

      // Mark as sent BEFORE pushing — a failed send means no retry today,
      // which is preferable to firing twice.
      await pb.collection("life_logs").update(
        logDoc.id,
        { [kind.sentField]: todayYmd },
        { $autoCancel: false },
      );

      const payload = SESSION_REMINDERS[kind.kind];
      for (const ownerId of ownerIds) {
        try {
          const result = await sendPushToUser(pb, ownerId, {
            title: payload.title,
            body: payload.body,
            url: payload.url,
            data: { type: `life_${kind.kind}_reminder`, logId: logDoc.id },
          }, { preferredOrigins: LIFE_ORIGINS });
          console.log(`[life-reminder/${kind.kind}] log ${logDoc.id} → user ${ownerId} (${tz}): ${result.sent} sent, ${result.expired} expired`);
        } catch (err) {
          console.error(`[life-reminder/${kind.kind}] log ${logDoc.id} → user ${ownerId}:`, err);
        }
      }
      sent++;
    }
  }

  return { checked, sent, skipped };
}
