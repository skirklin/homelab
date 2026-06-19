/**
 * In-process notification scheduler.
 *
 * This replaces the four k8s CronJobs that used to curl the /notifications/*
 * and /observer/generate endpoints (upkeep-notifications, life-reminders-check,
 * travel-tick, observer-weekly). They now run as croner jobs inside this same
 * Hono process, calling the lib functions DIRECTLY (no HTTP hop). The
 * /notifications/* HTTP endpoints still exist for manual triggering + tests.
 *
 * The PocketBase-maintenance CronJobs (pb-backup-daily, pb-backup-prune,
 * pod-events-prune) deliberately stay in infra/k8s/cronjobs.yaml — they hit PB
 * directly and must run even when this service is down.
 *
 * Each job:
 *   - uses the admin-authed PB client via getAdminPb() (the lib fns call it
 *     internally; getAdminPb caches + re-auths on token expiry, so a
 *     long-lived process never runs with a stale token);
 *   - runs with `protect: true` so an overrunning tick can't overlap itself;
 *   - is wrapped in try/catch so one failure never crashes the process.
 *
 * Catch-up: a k8s CronJob gets a retry window if the service is down at the
 * scheduled minute; an in-process timer does not. For the daily upkeep job —
 * whose lib fns are idempotent (per-user `last_task_notification` /
 * `last_deadline_notification` date guards) — we additionally fire once on
 * startup IF today's scheduled time has already passed. The idempotency makes a
 * redundant run a no-op, and the time-gate stops us from firing early. The
 * other jobs don't get catch-up: life-reminders/life-sample use tight ±windows
 * (catch-up inapplicable), travel-tick is hourly (self-covers within an hour),
 * and observer-weekly is NOT idempotent (every call hits Anthropic + creates a
 * record), so a catch-up run would duplicate observations.
 */
import { Cron } from "croner";
import { getAdminPb } from "../pb";
import { runUpkeepNotifications } from "./upkeep";
import { runDeadlineNotifications } from "./deadlines";
import { runLifeTrackerSampling, runLifeReminderCheck } from "./life";
import { runTravelNotificationsTick } from "./travel";
import { runObserverGeneration } from "../observer/generate";

const PACIFIC = "America/Los_Angeles";

let jobs: Cron[] = [];

/**
 * Run a job body with shared error isolation. One throw logs and is swallowed
 * so the scheduler (and process) survives.
 */
async function guard(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[scheduler/${label}] failed:`, err);
  }
}

/** The daily upkeep notification pass (both due-recurring + deadline lead-time). */
async function runUpkeepPass(): Promise<void> {
  const upkeep = await runUpkeepNotifications();
  const deadlines = await runDeadlineNotifications();
  console.log(
    `[scheduler/upkeep] done: ${upkeep.notified} task-notified, ${deadlines.notified} deadline-notified`,
  );
}

/**
 * Generate a weekly observation for every life-log owner, covering the past 7
 * days. Admin pb is scoped per-owner via `ownerId` so users' data never blends.
 */
export async function runObserverWeekly(): Promise<void> {
  const pb = await getAdminPb();
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  const logs = await pb.collection("life_logs").getFullList({ $autoCancel: false });
  // Owners who have explicitly disabled Coach (coach_enabled === false) opt out
  // of observation generation entirely — no Anthropic tokens spent. Default-true
  // semantics: only an explicit false skips, so legacy rows (undefined) and
  // enabled rows still generate. A user with multiple logs is opted out only if
  // every one of their logs has Coach off.
  const coachDisabled = new Set(
    logs
      .filter((l) => l.coach_enabled === false)
      .map((l) => (l.owner as string) || "")
      .filter(Boolean),
  );
  const coachEnabledOwners = new Set(
    logs
      .filter((l) => l.coach_enabled !== false)
      .map((l) => (l.owner as string) || "")
      .filter(Boolean),
  );
  const ownerIds = [...new Set(logs.map((l) => (l.owner as string) || "").filter(Boolean))];

  let generated = 0;
  let skipped = 0;
  let coachOff = 0;
  for (const ownerId of ownerIds) {
    try {
      // Skip owners who turned Coach off. (If they have multiple logs, keep
      // generating as long as ANY of their logs still has Coach enabled.)
      if (coachDisabled.has(ownerId) && !coachEnabledOwners.has(ownerId)) {
        coachOff++;
        continue;
      }
      // Skip owners with no life activity in the window: generating for an
      // inactive log just burns an Anthropic call and produces an empty
      // observation. Gate on the same life_events query assembleBundle uses
      // (log.owner + timestamp in window) so "has activity" means exactly what
      // the bundle would have fed the model. Kept in the scheduler only — the
      // manual /observer/generate route can still force a sparse-window run.
      const activity = await pb.collection("life_events").getList(1, 1, {
        filter: pb.filter(
          "log.owner = {:owner} && timestamp >= {:start} && timestamp <= {:end}",
          { owner: ownerId, start: windowStart.toISOString(), end: windowEnd.toISOString() },
        ),
        $autoCancel: false,
      });
      if (activity.totalItems === 0) {
        skipped++;
        continue;
      }
      await runObserverGeneration({ pb, ownerId, period: "weekly", windowStart, windowEnd });
      generated++;
    } catch (err) {
      console.error(`[scheduler/observer-weekly] owner ${ownerId} failed:`, err);
    }
  }
  console.log(
    `[scheduler/observer-weekly] done: ${generated} generated, ${skipped} skipped (no activity), ${coachOff} skipped (coach off), of ${ownerIds.length} owners`,
  );
}

export function startScheduler(): void {
  // life-reminders-check — every minute (was `* * * * *`). The lib fn decides
  // per-log whether the current minute matches the owner's morning/evening
  // reminder time (±1 min) in their tz; idempotent via last_*_reminder_sent.
  jobs.push(new Cron("* * * * *", { name: "life-reminders", protect: true }, () =>
    guard("life-reminders", async () => {
      const r = await runLifeReminderCheck();
      if (r.sent > 0) console.log(`[scheduler/life-reminders] ${r.sent} sent, ${r.skipped} skipped`);
    }),
  ));

  // life-sample — every 5 minutes. Pre-existing in-process job (never had a
  // CronJob); kept here so all scheduling lives in one place. Random-sample
  // check-ins; 15-min due window + per-log sentTimes guard.
  jobs.push(new Cron("*/5 * * * *", { name: "life-sample", protect: true }, () =>
    guard("life-sample", async () => {
      const r = await runLifeTrackerSampling();
      if (r.sent > 0) console.log(`[scheduler/life-sample] ${r.sent} sent, ${r.skipped} skipped`);
    }),
  ));

  // travel-tick — hourly (was `0 * * * *`). The lib fn decides whether each
  // active trip is at its local 7am (morning) or 8pm (evening) hour.
  jobs.push(new Cron("0 * * * *", { name: "travel-tick", protect: true }, () =>
    guard("travel-tick", async () => {
      const r = await runTravelNotificationsTick();
      const sent = r.morning.notified + r.evening.notified;
      if (sent > 0) console.log(`[scheduler/travel-tick] morning ${r.morning.notified}, evening ${r.evening.notified}`);
    }),
  ));

  // upkeep-notifications — 8 AM Pacific (was `0 8 * * *` tz=America/Los_Angeles).
  jobs.push(new Cron("0 8 * * *", { name: "upkeep", protect: true, timezone: PACIFIC }, () =>
    guard("upkeep", runUpkeepPass),
  ));

  // observer-weekly — Sunday 1 PM Pacific. Pinned to `0 13 * * 0`
  // tz=America/Los_Angeles (intentional fix: the old CronJob used bare-UTC
  // `0 20 * * 0`, which is correct only in PDT and slips an hour in PST). NOT
  // idempotent → no startup catch-up.
  jobs.push(new Cron("0 13 * * 0", { name: "observer-weekly", protect: true, timezone: PACIFIC }, () =>
    guard("observer-weekly", runObserverWeekly),
  ));

  // ── Startup catch-up (idempotent daily job only) ───────────────────────────
  // If 8 AM Pacific already passed today when we boot, the CronJob would have
  // fired and we'd have missed it — so run once now. The per-user date guards
  // make this a no-op if it already ran today, and the gate (today's fire is in
  // the past) ensures we never fire EARLY on a pre-8am restart.
  if (dailyFireAlreadyPassedToday("0 8 * * *", PACIFIC)) {
    console.log("[scheduler/upkeep] startup catch-up: 8am Pacific already passed today, running now");
    void guard("upkeep", runUpkeepPass);
  }

  console.log("[scheduler] started: life-reminders(1m), life-sample(5m), travel-tick(1h), upkeep(8am PT), observer-weekly(Sun 1pm PT)");
}

/**
 * True if today's scheduled fire of a once-daily `pattern` (in `tz`) is already
 * in the past. Pure time math, no persistence: croner's `nextRun()` is the next
 * future occurrence, so if it falls on a LATER `tz`-calendar day than today,
 * today's fire has already happened. Only valid for once-per-day patterns
 * (which is all we use it for).
 */
function dailyFireAlreadyPassedToday(pattern: string, tz: string): boolean {
  const probe = new Cron(pattern, { timezone: tz, paused: true });
  const next = probe.nextRun();
  probe.stop();
  if (!next) return false;
  const todayYmd = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const nextYmd = next.toLocaleDateString("en-CA", { timeZone: tz });
  return nextYmd !== todayYmd;
}

export function stopScheduler(): void {
  for (const j of jobs) j.stop();
  jobs = [];
}
