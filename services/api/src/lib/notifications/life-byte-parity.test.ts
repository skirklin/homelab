/**
 * Phase B4 MERGE GATE — byte-parity between the NEW data-driven notification
 * cron and the OLD (pre-B4) one.
 *
 * The redesign makes the cron read `manifest.notifications ?? columns` and
 * dispatch per strategy. It MUST produce byte-identical SEND DECISIONS for
 * every existing user, who has no `manifest.notifications` and so takes the
 * column-derived path. To prove that non-circularly, the OLD decision logic is
 * FROZEN here as a reference implementation (a copy of the pre-B4
 * `runLifeReminderCheck` / `runLifeTrackerSampling` decision rules) and we
 * simulate a full week of per-minute ticks, asserting the new cron's sends
 * match the reference tick-for-tick.
 *
 * Three configs are covered:
 *   (a) Scott — morning 06:00 / evening 21:00 / weekly Sun 18:00, sampling off:
 *       same minutes fire, evening skips Sunday, weekly only Sunday, one send
 *       per day per reminder, retry on a no-delivery tick.
 *   (b) a `random_sampling_enabled` config — identical sampling schedule/sends.
 *   (c) Angela — `manifest.notifications = []`: zero sends.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

// ─── Mocks (declared before importing the unit under test) ───────────────────

const sendPushToUser = vi.fn().mockResolvedValue({ sent: 1, expired: 0, failed: 0 });
vi.mock("../push", () => ({ sendPushToUser: (...a: unknown[]) => sendPushToUser(...a) }));

const getAdminPb = vi.fn();
vi.mock("../pb", () => ({ getAdminPb: () => getAdminPb() }));

import { runLifeReminderCheck, runLifeTrackerSampling } from "./life";
import { RANDOM_SAMPLES } from "@homelab/backend";

// ─────────────────────────────────────────────────────────────────────────────
// FROZEN reference: the pre-B4 fixed-reminder decision logic, copied verbatim
// from the old `runLifeReminderCheck` (life.ts before B4). Pure — no PB, no
// push; just "does THIS minute, for THIS log, fire reminder X?" with the
// idempotency the old code had (a Set of `${kind}:${ymd}` already-sent keys,
// mutated on each decided send, mirroring last_*_reminder_sent).
// ─────────────────────────────────────────────────────────────────────────────

interface RefLog {
  id: string;
  owner: string;
  morning_reminder_time?: string;
  evening_reminder_time?: string;
  weekly_reminder_time?: string;
}

function refWithinWindow(target: string, current: string, windowMin: number): boolean {
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

type SendRecord = { logId: string; kind: string; ymd: string };

/**
 * Run the FROZEN old fixed-reminder logic across a tick stream. `delivered` is
 * the per-tick delivery outcome callback so we can model no-delivery retries
 * exactly as both crons would (mark only on success). Returns the ordered list
 * of decided sends.
 */
function refFixedSends(
  logs: RefLog[],
  ticks: Date[],
  tzForOwner: (owner: string) => string,
  delivered: (rec: SendRecord) => boolean,
): SendRecord[] {
  const out: SendRecord[] = [];
  // mirror last_{morning,evening,weekly}_reminder_sent: key "logId:kind" → ymd
  const lastSent = new Map<string, string>();
  const mark = (logId: string, kind: string, ymd: string) => lastSent.set(`${logId}:${kind}`, ymd);
  const sentToday = (logId: string, kind: string, ymd: string) => lastSent.get(`${logId}:${kind}`) === ymd;

  for (const now of ticks) {
    for (const log of logs) {
      const owner = log.owner || "";
      const tz = owner ? tzForOwner(owner) : "UTC";
      const hhmm = formatInTimeZone(now, tz, "HH:mm");
      const ymd = formatInTimeZone(now, tz, "yyyy-MM-dd");
      const isSunday = formatInTimeZone(now, tz, "EEEE") === "Sunday";

      // morning / evening
      for (const k of ["morning", "evening"] as const) {
        const target = (k === "morning" ? log.morning_reminder_time : log.evening_reminder_time) || "";
        if (!target) continue;
        if (!owner) continue;
        if (k === "evening" && isSunday) continue; // weekly subsumes evening on Sunday
        if (!refWithinWindow(target, hhmm, 1)) continue;
        if (sentToday(log.id, k, ymd)) continue;
        const rec = { logId: log.id, kind: k, ymd };
        if (delivered(rec)) {
          out.push(rec);
          mark(log.id, k, ymd);
        }
      }

      // weekly — Sunday only
      const weekly = log.weekly_reminder_time || "";
      if (weekly && owner && isSunday && refWithinWindow(weekly, hhmm, 1) && !sentToday(log.id, "weekly", ymd)) {
        const rec = { logId: log.id, kind: "weekly", ymd };
        if (delivered(rec)) {
          out.push(rec);
          mark(log.id, "weekly", ymd);
        }
      }
    }
  }
  return out;
}

// ─── Fake PB for the NEW cron ────────────────────────────────────────────────

interface FakeLog extends Record<string, unknown> {
  id: string;
  owner: string;
}

function makeFakePb(opts: { logs: FakeLog[]; usersTz: Record<string, string | undefined> }) {
  const pb = {
    collection(name: string) {
      if (name === "life_logs") {
        return {
          getFullList: async () => opts.logs,
          update: async (id: string, data: Record<string, unknown>) => {
            const log = opts.logs.find((l) => l.id === id);
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
      throw new Error(`unexpected collection ${name}`);
    },
  };
  return pb;
}

/**
 * Drive the NEW cron across the tick stream. The push mock's `sent` value is
 * derived from the SAME `delivered` callback (keyed by the per-tick send the
 * cron is about to make), so the new cron's mark-after-success retry behavior
 * is exercised identically to the reference. Captures each successful send as
 * { logId, kind, ymd } from the push `data.type`.
 */
async function newFixedSends(
  logs: FakeLog[],
  ticks: Date[],
  usersTz: Record<string, string | undefined>,
  delivered: (rec: SendRecord) => boolean,
): Promise<SendRecord[]> {
  const out: SendRecord[] = [];
  for (const now of ticks) {
    const pb = makeFakePb({ logs, usersTz });
    getAdminPb.mockResolvedValue(pb);
    sendPushToUser.mockImplementation(async (_pb: unknown, _owner: string, payload: { data?: { type?: string; logId?: string } }) => {
      // data.type is `life_<target>_reminder`; target == kind for the legacy three.
      const type = payload.data?.type || "";
      const m = type.match(/^life_(.+)_reminder$/);
      const kind = m ? m[1] : "?";
      const logId = payload.data?.logId || "?";
      const tz = usersTz[logs.find((l) => l.id === logId)?.owner || ""] || "UTC";
      const ymd = formatInTimeZone(now, tz, "yyyy-MM-dd");
      const rec = { logId, kind, ymd };
      if (delivered(rec)) {
        out.push(rec);
        return { sent: 1, expired: 0, failed: 0 };
      }
      return { sent: 0, expired: 0, failed: 1 };
    });
    await runLifeReminderCheck(now);
  }
  return out;
}

// ─── Tick stream: a full week of per-minute ticks in a fixed tz ──────────────

const TZ = "America/Los_Angeles";

/** Every minute from `startLocal` for `days` days, anchored in `tz`. */
function weekOfMinutes(startYmd: string, days: number, tz: string): Date[] {
  const ticks: Date[] = [];
  // Local midnight of startYmd in tz → first tick.
  const [y, mo, d] = startYmd.split("-").map((s) => parseInt(s, 10));
  const startUtc = fromZonedTime(new Date(y, mo - 1, d, 0, 0, 0), tz).getTime();
  const total = days * 24 * 60;
  for (let i = 0; i < total; i++) {
    ticks.push(new Date(startUtc + i * 60_000));
  }
  return ticks;
}

// 2026-06-07 is a Sunday → start on a Sunday so the week covers exactly one of
// each weekday and the Sunday weekly/evening-suppression rules are exercised.
const WEEK_START = "2026-06-07";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("B4 byte-parity — fixed reminders (Scott's config)", () => {
  const SCOTT: FakeLog = {
    id: "scott-log",
    owner: "scott",
    morning_reminder_time: "06:00",
    evening_reminder_time: "21:00",
    weekly_reminder_time: "18:00",
    // no manifest → column-derived path
  };
  const usersTz = { scott: TZ };
  const tzForOwner = () => TZ;
  const ticks = weekOfMinutes(WEEK_START, 7, TZ);

  it("new cron's sends are identical to the frozen old cron (all delivered)", async () => {
    const allDelivered = () => true;
    const ref = refFixedSends([{ ...SCOTT }], ticks, tzForOwner, allDelivered);
    const got = await newFixedSends([{ ...SCOTT }], ticks, usersTz, allDelivered);
    expect(got).toEqual(ref);
  });

  it("evening fires Mon–Sat, skips Sunday; weekly fires only Sunday; one/day", async () => {
    const ref = refFixedSends([{ ...SCOTT }], ticks, tzForOwner, () => true);
    // Exactly 7 morning sends (one per day).
    expect(ref.filter((r) => r.kind === "morning")).toHaveLength(7);
    // Exactly 6 evening sends (Sun suppressed).
    const evenings = ref.filter((r) => r.kind === "evening");
    expect(evenings).toHaveLength(6);
    expect(evenings.some((r) => r.ymd === "2026-06-07")).toBe(false); // Sunday
    // Exactly 1 weekly send, on Sunday.
    const weeklies = ref.filter((r) => r.kind === "weekly");
    expect(weeklies).toHaveLength(1);
    expect(weeklies[0].ymd).toBe("2026-06-07");
    // No duplicate (logId,kind,ymd).
    const keys = ref.map((r) => `${r.logId}:${r.kind}:${r.ymd}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a no-delivery tick retries within the ±1min window (new == old)", async () => {
    // Fail the FIRST attempt of each (kind,ymd) decision, succeed the rest. The
    // ±1min window means a failed 06:00 tick retries at 06:01 (both crons).
    function makeOnceFail() {
      const failed = new Set<string>();
      return (rec: SendRecord) => {
        const key = `${rec.logId}:${rec.kind}:${rec.ymd}`;
        if (!failed.has(key)) {
          failed.add(key);
          return false; // first attempt fails → no mark → retry next tick
        }
        return true;
      };
    }
    const ref = refFixedSends([{ ...SCOTT }], ticks, tzForOwner, makeOnceFail());
    const got = await newFixedSends([{ ...SCOTT }], ticks, usersTz, makeOnceFail());
    expect(got).toEqual(ref);
    // Still exactly one successful send per (kind,ymd) despite the retry.
    expect(ref.filter((r) => r.kind === "morning")).toHaveLength(7);
    expect(ref.filter((r) => r.kind === "weekly")).toHaveLength(1);
  });

  it("transition-safe: a legacy last_*_reminder_sent === today blocks a double-fire", async () => {
    // Simulate the deploy-day case: the legacy column says today's morning
    // reminder already went out (pre-cutover). The new cron must NOT re-send.
    const ticks1 = weekOfMinutes(WEEK_START, 1, TZ); // just Sunday
    const log: FakeLog = {
      id: "scott-log",
      owner: "scott",
      morning_reminder_time: "06:00",
      last_morning_reminder_sent: "2026-06-07", // already sent today (legacy)
    };
    const pb = makeFakePb({ logs: [log], usersTz });
    getAdminPb.mockResolvedValue(pb);
    sendPushToUser.mockResolvedValue({ sent: 1, expired: 0, failed: 0 });
    for (const now of ticks1) await runLifeReminderCheck(now);
    // No morning push should have fired (legacy guard blocks it all day).
    const morningCalls = sendPushToUser.mock.calls.filter(
      (c) => (c[2] as { data?: { type?: string } }).data?.type === "life_morning_reminder",
    );
    expect(morningCalls).toHaveLength(0);
  });
});

describe("B4 byte-parity — evening set, weekly UNSET (Sunday still suppresses evening)", () => {
  // The pre-B4 cron suppressed evening on Sunday UNCONDITIONALLY, even with no
  // weekly time. The column-derived path must reproduce this via an empty-time
  // weekly subsumer that never itself pushes.
  const LOG: FakeLog = {
    id: "ev-log",
    owner: "scott",
    evening_reminder_time: "21:00",
    // no morning, no weekly, no manifest
  };
  const usersTz = { scott: TZ };
  const tzForOwner = () => TZ;
  const ticks = weekOfMinutes(WEEK_START, 7, TZ);

  it("matches the frozen old cron (evening Mon–Sat, none Sunday, no weekly push)", async () => {
    const ref = refFixedSends([{ ...LOG }], ticks, tzForOwner, () => true);
    const got = await newFixedSends([{ ...LOG }], ticks, usersTz, () => true);
    expect(got).toEqual(ref);
    // 6 evenings (Sun suppressed), 0 weekly, 0 morning.
    expect(got.filter((r) => r.kind === "evening")).toHaveLength(6);
    expect(got.filter((r) => r.kind === "weekly")).toHaveLength(0);
    expect(got.some((r) => r.kind === "evening" && r.ymd === "2026-06-07")).toBe(false);
  });
});

describe("B4 byte-parity — Angela (manifest.notifications = [])", () => {
  it("zero fixed sends regardless of legacy columns", async () => {
    const ticks = weekOfMinutes(WEEK_START, 7, TZ);
    const angela: FakeLog = {
      id: "angela-log",
      owner: "angela",
      // Legacy columns set, but manifest.notifications = [] must win → no sends.
      morning_reminder_time: "06:00",
      evening_reminder_time: "21:00",
      weekly_reminder_time: "18:00",
      manifest: { notifications: [] },
    };
    const got = await newFixedSends([angela], ticks, { angela: TZ }, () => true);
    expect(got).toHaveLength(0);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });
});

// ─── Sampling parity (config b) ──────────────────────────────────────────────
//
// The sampler internals are unchanged; B4 only adds the "a random notification
// must be resolved" gate, which for a column-derived log is exactly
// `random_sampling_enabled`. So a `random_sampling_enabled` log must sample
// EXACTLY as before, and a disabled / Angela-`[]` log must not.

describe("B4 byte-parity — random sampling gate", () => {
  beforeEach(() => {
    expect(RANDOM_SAMPLES.enabled).toBe(true);
  });

  it("generates a schedule for a random_sampling_enabled log (unchanged)", async () => {
    const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
    const log: FakeLog = {
      id: "samp-log",
      owner: "scott",
      random_sampling_enabled: true,
      sample_schedule: null,
    };
    const pb = {
      collection(name: string) {
        if (name === "life_logs") {
          return {
            getFullList: async () => [log],
            update: async (id: string, data: Record<string, unknown>) => {
              writes.push({ id, data });
              Object.assign(log, data);
              return data;
            },
          };
        }
        if (name === "users") {
          return { getOne: async (id: string) => ({ id, timezone: TZ }) };
        }
        throw new Error(`unexpected ${name}`);
      },
    };
    getAdminPb.mockResolvedValue(pb);
    await runLifeTrackerSampling();
    const sched = writes.find((w) => w.data.sample_schedule)?.data.sample_schedule as
      | { times: number[] }
      | undefined;
    expect(sched).toBeDefined();
    expect(sched!.times.length).toBe(RANDOM_SAMPLES.timesPerDay);
  });

  it("does NOT sample a log with random_sampling_enabled off (no schedule write)", async () => {
    const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
    const log: FakeLog = {
      id: "off-log",
      owner: "scott",
      random_sampling_enabled: false,
      sample_schedule: null,
    };
    const pb = {
      collection(name: string) {
        if (name === "life_logs") {
          return {
            getFullList: async () => [log],
            update: async (id: string, data: Record<string, unknown>) => {
              writes.push({ id, data });
              return data;
            },
          };
        }
        if (name === "users") return { getOne: async (id: string) => ({ id, timezone: TZ }) };
        throw new Error(`unexpected ${name}`);
      },
    };
    getAdminPb.mockResolvedValue(pb);
    const res = await runLifeTrackerSampling();
    expect(res.sent).toBe(0);
    expect(writes.filter((w) => w.data.sample_schedule)).toHaveLength(0);
  });

  it("Angela (manifest.notifications = []) opts OUT of sampling even if the legacy flag is on", async () => {
    // Belt-and-suspenders: a manifest with no `random` notification means the
    // resolve returns no random strategy, so the sampler skips even though the
    // legacy column is true. (Go-forward behavior; existing users are unaffected
    // because they have no manifest.notifications.)
    const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
    const log: FakeLog = {
      id: "angela-log",
      owner: "angela",
      random_sampling_enabled: true,
      sample_schedule: null,
      manifest: { notifications: [] },
    };
    const pb = {
      collection(name: string) {
        if (name === "life_logs") {
          return {
            getFullList: async () => [log],
            update: async (id: string, data: Record<string, unknown>) => {
              writes.push({ id, data });
              return data;
            },
          };
        }
        if (name === "users") return { getOne: async (id: string) => ({ id, timezone: TZ }) };
        throw new Error(`unexpected ${name}`);
      },
    };
    getAdminPb.mockResolvedValue(pb);
    const res = await runLifeTrackerSampling();
    expect(res.sent).toBe(0);
    expect(writes.filter((w) => w.data.sample_schedule)).toHaveLength(0);
  });
});
