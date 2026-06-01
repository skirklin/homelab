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

import { runLifeTrackerSampling } from "./life";
import { RANDOM_SAMPLES } from "@homelab/backend";

// ─── Fake PB ─────────────────────────────────────────────────────────────────

interface FakeLog {
  id: string;
  owner: string;
  random_sampling_enabled: boolean;
  sample_schedule: unknown;
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
      { id: "logA", owner: "userA", random_sampling_enabled: true, sample_schedule: null },
      { id: "logB", owner: "userB", random_sampling_enabled: true, sample_schedule: null },
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
      { id: "logA", owner: "userA", random_sampling_enabled: true, sample_schedule: null },
      { id: "logB", owner: "userB", random_sampling_enabled: true, sample_schedule: null },
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
      { id: "logC", owner: "userC", random_sampling_enabled: true, sample_schedule: null },
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

  it("skips logs with random sampling disabled (no schedule write)", async () => {
    const logs: FakeLog[] = [
      { id: "logOff", owner: "userA", random_sampling_enabled: false, sample_schedule: null },
    ];
    const { pb, updates } = makeFakePb({ logs, usersTz: { userA: "America/Los_Angeles" } });
    getAdminPb.mockResolvedValue(pb);

    const res = await runLifeTrackerSampling();
    expect(res.sent).toBe(0);
    expect(scheduleFor(updates, "logOff")).toBeNull();
  });
});
