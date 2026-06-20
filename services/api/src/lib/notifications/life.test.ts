/**
 * P0 isolation gap: the random-sampling cron must schedule each log's
 * check-ins in ITS OWNER's timezone, not a single global one. Before the fix
 * every log used the global `RANDOM_SAMPLES.timezone`, so a second user in a
 * different tz would get prompts at the system owner's local hours.
 *
 * These are unit tests over `runLifeTrackerSampling` with `getAdminPb` and
 * `sendPushToUser` mocked, plus a two-owner / two-tz fixture. We assert the
 * generated `sample_schedule` times each fall within the owner's LOCAL active
 * hours, which is only true if the per-owner tz is honored.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatInTimeZone } from "date-fns-tz";

// ─── Mocks (declared before importing the unit under test) ───────────────────

const sendPushToUser = vi.fn().mockResolvedValue({ sent: 1, expired: 0 });
vi.mock("../push", () => ({ sendPushToUser: (...a: unknown[]) => sendPushToUser(...a) }));

const getAdminPb = vi.fn();
vi.mock("../pb", () => ({ getAdminPb: () => getAdminPb() }));

import { runLifeTrackerSampling, runLifeReminderCheck, pushContentForTarget } from "./life";
import { RANDOM_SAMPLES } from "@homelab/backend";
import type { LifeView } from "@homelab/backend";

// ─── Fake PB ─────────────────────────────────────────────────────────────────

interface FakeLog {
  id: string;
  owner: string;
  random_sampling_enabled: boolean;
  sample_schedule: unknown;
  manifest?: { trackables: unknown[]; notifications?: unknown[] };
}

/**
 * A `manifest.notifications` carrying one `random` sampling notification — the
 * Phase-D source of truth for sampler opt-in (`random_sampling_enabled` gates
 * schedule generation; the notification is what `randomNotificationFor`
 * matches). Mirrors what the column→manifest migration materialized for a log
 * that had sampling on.
 */
function samplingManifest() {
  return {
    trackables: [],
    notifications: [
      {
        id: "sampling",
        target: "sampling",
        strategy: {
          kind: "random",
          timesPerDay: RANDOM_SAMPLES.timesPerDay,
          activeHours: RANDOM_SAMPLES.activeHours,
        },
      },
    ],
  };
}

function makeFakePb(opts: {
  logs: FakeLog[];
  usersTz: Record<string, string | undefined>;
}) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const pb = {
    collection(name: string) {
      if (name === "life_logs") {
        return {
          getFullList: async () => opts.logs,
          update: async (id: string, data: Record<string, unknown>) => {
            updates.push({ id, data });
            // Reflect the write back onto the in-memory log so the cron's
            // subsequent reads (schedule already-for-today) see it.
            const log = opts.logs.find((l) => l.id === id);
            if (log && "sample_schedule" in data) log.sample_schedule = data.sample_schedule;
            return data;
          },
        };
      }
      if (name === "users") {
        return {
          getOne: async (id: string) => {
            if (!(id in opts.usersTz)) throw new Error("no such user");
            return { id, timezone: opts.usersTz[id] };
          },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };
  return { pb, updates };
}

/** Pull the schedule written for a given log id from the captured updates. */
function scheduleFor(updates: Array<{ id: string; data: Record<string, unknown> }>, logId: string) {
  const rows = updates.filter((u) => u.id === logId && u.data.sample_schedule);
  return rows.length ? (rows[rows.length - 1].data.sample_schedule as { date: string; times: number[] }) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  // RANDOM_SAMPLES is enabled with activeHours [9,22] and a global tz of
  // America/Los_Angeles in the committed config — good for the test.
  expect(RANDOM_SAMPLES.enabled).toBe(true);
});

describe("runLifeTrackerSampling — per-owner timezone (P0)", () => {
  it("schedules each log's times within its OWN owner's local active hours", async () => {
    const [startHour, endHour] = RANDOM_SAMPLES.activeHours;
    const logs: FakeLog[] = [
      { id: "logA", owner: "userA", random_sampling_enabled: true, sample_schedule: null, manifest: samplingManifest() },
      { id: "logB", owner: "userB", random_sampling_enabled: true, sample_schedule: null, manifest: samplingManifest() },
    ];
    const { pb, updates } = makeFakePb({
      logs,
      usersTz: { userA: "America/Los_Angeles", userB: "Asia/Tokyo" },
    });
    getAdminPb.mockResolvedValue(pb);

    await runLifeTrackerSampling();

    const schedA = scheduleFor(updates, "logA");
    const schedB = scheduleFor(updates, "logB");
    expect(schedA).not.toBeNull();
    expect(schedB).not.toBeNull();
    expect(schedA!.times.length).toBe(RANDOM_SAMPLES.timesPerDay);
    expect(schedB!.times.length).toBe(RANDOM_SAMPLES.timesPerDay);

    // Every scheduled instant, rendered in the owner's tz, must fall inside
    // [startHour, endHour]. If the cron used a single global tz this fails for
    // the Tokyo owner (whose UTC instants would land outside Tokyo daytime).
    for (const t of schedA!.times) {
      const hour = Number(formatInTimeZone(new Date(t), "America/Los_Angeles", "H"));
      expect(hour).toBeGreaterThanOrEqual(startHour);
      expect(hour).toBeLessThanOrEqual(endHour);
    }
    for (const t of schedB!.times) {
      const hour = Number(formatInTimeZone(new Date(t), "Asia/Tokyo", "H"));
      expect(hour).toBeGreaterThanOrEqual(startHour);
      expect(hour).toBeLessThanOrEqual(endHour);
    }
  });

  it("Tokyo and LA owners get DIFFERENT UTC instants (proves no global-tz collapse)", async () => {
    const logs: FakeLog[] = [
      { id: "logA", owner: "userA", random_sampling_enabled: true, sample_schedule: null, manifest: samplingManifest() },
      { id: "logB", owner: "userB", random_sampling_enabled: true, sample_schedule: null, manifest: samplingManifest() },
    ];
    const { pb, updates } = makeFakePb({
      logs,
      usersTz: { userA: "America/Los_Angeles", userB: "Asia/Tokyo" },
    });
    getAdminPb.mockResolvedValue(pb);

    await runLifeTrackerSampling();

    const a = scheduleFor(updates, "logA")!;
    const b = scheduleFor(updates, "logB")!;
    // The same local wall-clock window in two tz that differ by ~16-17h must
    // yield disjoint UTC instant ranges. Compare the medians defensively.
    const medA = [...a.times].sort((x, y) => x - y)[Math.floor(a.times.length / 2)];
    const medB = [...b.times].sort((x, y) => x - y)[Math.floor(b.times.length / 2)];
    expect(Math.abs(medA - medB)).toBeGreaterThan(6 * 60 * 60 * 1000);
  });

  it("falls back to the global config tz when the owner has no timezone set", async () => {
    const [startHour, endHour] = RANDOM_SAMPLES.activeHours;
    const globalTz = RANDOM_SAMPLES.timezone || "UTC";
    const logs: FakeLog[] = [
      { id: "logC", owner: "userC", random_sampling_enabled: true, sample_schedule: null, manifest: samplingManifest() },
    ];
    const { pb, updates } = makeFakePb({ logs, usersTz: { userC: undefined } });
    getAdminPb.mockResolvedValue(pb);

    await runLifeTrackerSampling();

    const sched = scheduleFor(updates, "logC")!;
    for (const t of sched.times) {
      const hour = Number(formatInTimeZone(new Date(t), globalTz, "H"));
      expect(hour).toBeGreaterThanOrEqual(startHour);
      expect(hour).toBeLessThanOrEqual(endHour);
    }
  });

  it("skips a log with no `random` notification in its manifest (no schedule write)", async () => {
    // No `random` notification (and an empty manifest) → not opted into
    // sampling → no schedule generated. (Post-Phase-D the opt-in lives in
    // manifest.notifications, not the bare random_sampling_enabled flag.)
    const logs: FakeLog[] = [
      { id: "logOff", owner: "userA", random_sampling_enabled: false, sample_schedule: null, manifest: { trackables: [], notifications: [] } },
    ];
    const { pb, updates } = makeFakePb({ logs, usersTz: { userA: "America/Los_Angeles" } });
    getAdminPb.mockResolvedValue(pb);

    const res = await runLifeTrackerSampling();
    expect(res.sent).toBe(0);
    expect(scheduleFor(updates, "logOff")).toBeNull();
  });
});

// ─── runLifeReminderCheck: mark-after-successful-delivery ────────────────────
//
// The reminder loop must record a sent-ledger row only when a push actually
// landed (result.sent > 0). A tick that delivers nothing (no live subs / all
// failed) or throws must NOT mark the day, so the next within-window tick
// retries. (croner protect:true makes the old mark-before-send double-fire
// guard moot.) The idempotency store is now the shared `notification_log`
// ledger (via notifyOnce): one row per (user, "life_reminder:<id>", ownerYmd).
// (Replaces the per-log `reminder_state` JSON map — migration 20260619_200000.)
// Notifications come from `manifest.notifications` only; the fixed session-
// reminder ids are `morning-reminder` / `evening-reminder` / `weekly-reminder`.

interface ReminderLog {
  id: string;
  owner: string;
  manifest?: { trackables: unknown[]; notifications?: unknown[] };
}

/** A `manifest.notifications` carrying one fixed daily reminder at `time`. */
function dailyReminderManifest(id: string, target: string, time: string) {
  return {
    trackables: [],
    notifications: [{ id, target, strategy: { kind: "fixed", cadence: "daily", time } }],
  };
}

/** A `manifest.notifications` carrying one fixed weekly (Sunday) reminder. */
function weeklyReminderManifest(id: string, target: string, time: string) {
  return {
    trackables: [],
    notifications: [
      { id, target, strategy: { kind: "fixed", cadence: "weekly", time, weekday: 0 } },
    ],
  };
}

/** Pull the ledger rows created for a given notification id (kind suffix). */
function ledgerCreatesFor(
  creates: Array<Record<string, unknown>>,
  notificationId: string,
) {
  return creates.filter((c) => c.kind === `life_reminder:${notificationId}`);
}

/**
 * @param sent ledger rows already present (idempotency seed). Each entry's
 *   `(kind, bucket)` is matched against notifyOnce's getList filter.
 */
function makeReminderPb(opts: {
  logs: ReminderLog[];
  usersTz: Record<string, string | undefined>;
  sent?: Array<{ kind: string; bucket: string }>;
}) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const ledgerCreates: Array<Record<string, unknown>> = [];
  const seeded = opts.sent ?? [];
  const pb = {
    // notifyOnce uses pb.filter to build the dedup filter; capture the params so
    // the fake getList can honor the (kind, bucket) lookup.
    filter: (_expr: string, params?: Record<string, unknown>) => JSON.stringify(params ?? {}),
    collection(name: string) {
      if (name === "life_logs") {
        return {
          getFullList: async () => opts.logs,
          update: async (id: string, data: Record<string, unknown>) => {
            updates.push({ id, data });
            const log = opts.logs.find((l) => l.id === id) as Record<string, unknown> | undefined;
            if (log) Object.assign(log, data);
            return data;
          },
        };
      }
      if (name === "users") {
        return {
          getOne: async (id: string) => {
            if (!(id in opts.usersTz)) throw new Error("no such user");
            return { id, timezone: opts.usersTz[id] };
          },
        };
      }
      if (name === "notification_log") {
        return {
          getList: async (_p: number, _pp: number, q: { filter: string }) => {
            const params = JSON.parse(q.filter) as { kind?: string; bucket?: string };
            const hit = seeded.some(
              (s) => s.kind === params.kind && s.bucket === params.bucket,
            ) || ledgerCreates.some(
              (c) => c.kind === params.kind && c.bucket === params.bucket,
            );
            return { totalItems: hit ? 1 : 0, items: [] };
          },
          create: async (data: Record<string, unknown>) => {
            ledgerCreates.push(data);
            return data;
          },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };
  return { pb, updates, ledgerCreates };
}

describe("runLifeReminderCheck — mark only after successful delivery", () => {
  // A Monday so the morning reminder fires and the Sunday-only weekly/evening
  // suppression rules don't interfere. 2026-06-08 is a Monday; pick 08:00 UTC.
  const MONDAY_0800Z = new Date("2026-06-08T08:00:00Z");

  it("does NOT write a ledger row when delivery is 0", async () => {
    sendPushToUser.mockResolvedValue({ sent: 0, expired: 0, failed: 1 });
    const logs: ReminderLog[] = [
      { id: "log1", owner: "userA", manifest: dailyReminderManifest("morning-reminder", "morning", "08:00") },
    ];
    const { pb, ledgerCreates } = makeReminderPb({ logs, usersTz: { userA: "UTC" } });
    getAdminPb.mockResolvedValue(pb);

    const res = await runLifeReminderCheck(MONDAY_0800Z);

    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(ledgerCreatesFor(ledgerCreates, "morning-reminder")).toHaveLength(0);
    expect(res.sent).toBe(0);
  });

  it("does NOT mark when the send throws", async () => {
    sendPushToUser.mockRejectedValue(new Error("push backend down"));
    const logs: ReminderLog[] = [
      { id: "log1", owner: "userA", manifest: dailyReminderManifest("morning-reminder", "morning", "08:00") },
    ];
    const { pb, ledgerCreates } = makeReminderPb({ logs, usersTz: { userA: "UTC" } });
    getAdminPb.mockResolvedValue(pb);

    const res = await runLifeReminderCheck(MONDAY_0800Z);

    expect(ledgerCreatesFor(ledgerCreates, "morning-reminder")).toHaveLength(0);
    expect(res.sent).toBe(0);
  });

  it("DOES write a ledger row when delivery succeeds (manifest.notifications drives the send)", async () => {
    sendPushToUser.mockResolvedValue({ sent: 1, expired: 0, failed: 0 });
    const logs: ReminderLog[] = [
      { id: "log1", owner: "userA", manifest: dailyReminderManifest("morning-reminder", "morning", "08:00") },
    ];
    const { pb, ledgerCreates } = makeReminderPb({ logs, usersTz: { userA: "UTC" } });
    getAdminPb.mockResolvedValue(pb);

    const res = await runLifeReminderCheck(MONDAY_0800Z);

    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const creates = ledgerCreatesFor(ledgerCreates, "morning-reminder");
    expect(creates).toHaveLength(1);
    // bucket is the OWNER-LOCAL day (UTC owner here → same as the UTC instant).
    expect(creates[0].bucket).toBe("2026-06-08");
    expect(creates[0].user).toBe("userA");
    expect(res.sent).toBe(1);
  });

  it("an existing ledger row for today suppresses a second send (idempotent within the day)", async () => {
    sendPushToUser.mockResolvedValue({ sent: 1, expired: 0, failed: 0 });
    const logs: ReminderLog[] = [
      { id: "log1", owner: "userA", manifest: dailyReminderManifest("morning-reminder", "morning", "08:00") },
    ];
    const { pb } = makeReminderPb({
      logs,
      usersTz: { userA: "UTC" },
      // Already delivered today → must not re-send.
      sent: [{ kind: "life_reminder:morning-reminder", bucket: "2026-06-08" }],
    });
    getAdminPb.mockResolvedValue(pb);

    const res = await runLifeReminderCheck(MONDAY_0800Z);

    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(res.sent).toBe(0);
  });

  it("uses the notification's CUSTOM title/body when set", async () => {
    sendPushToUser.mockResolvedValue({ sent: 1, expired: 0, failed: 0 });
    const logs = [
      {
        id: "logCustom",
        owner: "userA",
        manifest: {
          trackables: [],
          // No legacy column; a manifest notification carrying custom copy and
          // a habit-board target.
          notifications: [
            {
              id: "evening-habits",
              target: "today",
              strategy: { kind: "fixed", cadence: "daily", time: "08:00" },
              enabled: true,
              title: "Check your habits",
              body: "Tap to tick them off.",
            },
          ],
        },
      } as unknown as ReminderLog,
    ];
    const { pb } = makeReminderPb({ logs, usersTz: { userA: "UTC" } });
    getAdminPb.mockResolvedValue(pb);

    await runLifeReminderCheck(MONDAY_0800Z);

    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const pushArg = sendPushToUser.mock.calls[0][2] as { title: string; body: string; buildUrl: () => string };
    expect(pushArg.title).toBe("Check your habits");
    expect(pushArg.body).toBe("Tap to tick them off.");
    // target "today" → /today (lands on the habit board, no SW/route change).
    expect(pushArg.buildUrl()).toBe("/today");
  });

  it("weekly reminder: marks only on sent>0 (Sunday)", async () => {
    // 2026-06-07 is a Sunday; 08:00 UTC matches the weekly target.
    const SUNDAY_0800Z = new Date("2026-06-07T08:00:00Z");

    // Failure path: no mark.
    sendPushToUser.mockResolvedValue({ sent: 0, expired: 0, failed: 1 });
    let logs: ReminderLog[] = [
      { id: "logW", owner: "userA", manifest: weeklyReminderManifest("weekly-reminder", "weekly", "08:00") },
    ];
    let env = makeReminderPb({ logs, usersTz: { userA: "UTC" } });
    getAdminPb.mockResolvedValue(env.pb);
    await runLifeReminderCheck(SUNDAY_0800Z);
    expect(ledgerCreatesFor(env.ledgerCreates, "weekly-reminder")).toHaveLength(0);

    // Success path: mark.
    sendPushToUser.mockResolvedValue({ sent: 2, expired: 0, failed: 0 });
    logs = [
      { id: "logW", owner: "userA", manifest: weeklyReminderManifest("weekly-reminder", "weekly", "08:00") },
    ];
    env = makeReminderPb({ logs, usersTz: { userA: "UTC" } });
    getAdminPb.mockResolvedValue(env.pb);
    await runLifeReminderCheck(SUNDAY_0800Z);
    const creates = ledgerCreatesFor(env.ledgerCreates, "weekly-reminder");
    expect(creates).toHaveLength(1);
    expect(creates[0].bucket).toBe("2026-06-07");
  });

  it("weekly reminder subsumes the same-time evening reminder on Sunday (only weekly fires)", async () => {
    // 2026-06-07 is a Sunday; both reminders target 08:00 UTC. The weekly
    // reminder lists "evening-reminder" in `subsumes`, so on the day it's
    // scheduled (Sunday) the evening daily reminder must be suppressed — exactly
    // one push fires (the weekly), and only the weekly stamps the ledger row.
    const SUNDAY_0800Z = new Date("2026-06-07T08:00:00Z");
    sendPushToUser.mockResolvedValue({ sent: 1, expired: 0, failed: 0 });

    const logs: ReminderLog[] = [
      {
        id: "logSun",
        owner: "userA",
        manifest: {
          trackables: [],
          notifications: [
            {
              id: "weekly-reminder",
              target: "weekly",
              strategy: { kind: "fixed", cadence: "weekly", time: "08:00", weekday: 0, subsumes: ["evening-reminder"] },
            },
            {
              id: "evening-reminder",
              target: "evening",
              strategy: { kind: "fixed", cadence: "daily", time: "08:00" },
            },
          ],
        },
      },
    ];
    const { pb, ledgerCreates } = makeReminderPb({ logs, usersTz: { userA: "UTC" } });
    getAdminPb.mockResolvedValue(pb);

    const res = await runLifeReminderCheck(SUNDAY_0800Z);

    // Only the weekly fired; the evening was subsumed.
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const pushData = sendPushToUser.mock.calls[0][2] as { data: { type: string; target: string } };
    // One stable `life_reminder` type now; the target rides in data.target.
    expect(pushData.data.type).toBe("life_reminder");
    expect(pushData.data.target).toBe("weekly");
    expect(res.sent).toBe(1);
    expect(ledgerCreatesFor(ledgerCreates, "weekly-reminder")).toHaveLength(1);
    expect(ledgerCreatesFor(ledgerCreates, "evening-reminder")).toHaveLength(0);
  });
});

// ─── pushContentForTarget: custom-copy precedence + byte-identical fallback ──
//
// Custom title/body, when present, override the derived copy field-by-field.
// When absent, the function returns EXACTLY the legacy/view/generic copy it did
// before (so existing reminders are byte-unchanged).

describe("pushContentForTarget — custom copy vs. derived fallback", () => {
  const VIEWS: LifeView[] = [
    { id: "custom-view", title: "My View", greeting: "Hello there", items: [] },
  ];

  it("prefers the notification's own title/body when set", () => {
    expect(pushContentForTarget({ target: "morning", title: "Tick habits", body: "30s, promise" }, VIEWS)).toEqual({
      title: "Tick habits",
      body: "30s, promise",
    });
  });

  it("falls back to the byte-identical legacy copy for morning/evening/weekly when no custom copy", () => {
    expect(pushContentForTarget({ target: "morning" }, VIEWS)).toEqual({
      title: "Morning check-in",
      body: "Good morning. A few questions before the day gets going.",
    });
    expect(pushContentForTarget({ target: "evening" }, VIEWS)).toEqual({
      title: "Evening wind-down",
      body: "Wind-down time. A few quick reflections.",
    });
    expect(pushContentForTarget({ target: "weekly" }, VIEWS)).toEqual({
      title: "Weekly review",
      body: "Time to look back on the week.",
    });
  });

  it("falls back to the target View's title/greeting for a non-legacy target", () => {
    expect(pushContentForTarget({ target: "custom-view" }, VIEWS)).toEqual({
      title: "My View",
      body: "Hello there",
    });
  });

  it("falls back to the generic copy for an unknown target", () => {
    expect(pushContentForTarget({ target: "today" }, VIEWS)).toEqual({
      title: "Reminder",
      body: "Time to check in.",
    });
  });

  it("applies a PARTIAL override field-by-field (custom title, derived body)", () => {
    expect(pushContentForTarget({ target: "morning", title: "Just the title" }, VIEWS)).toEqual({
      title: "Just the title",
      body: "Good morning. A few questions before the day gets going.",
    });
  });
});
