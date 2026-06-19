import { describe, expect, it } from "vitest";
import {
  EVENING_REMINDER_ID,
  MORNING_REMINDER_ID,
  SAMPLING_ID,
  WEEKLY_REMINDER_ID,
} from "../../../api/src/lib/notifications/life-notifications";
import { type RawLifeLog, planReminderMigration } from "./reminder-migration";

function migrate(log: RawLifeLog) {
  const [action] = planReminderMigration([log]);
  if (action.kind !== "migrate") throw new Error(`expected migrate, got ${action.kind}`);
  return action;
}

describe("planReminderMigration", () => {
  it("migrates a Scott-like log: *-reminder ids, real times, weekly subsumes evening, sampling on", () => {
    const action = migrate({
      id: "log_scott",
      manifest: { trackables: [{ id: "water" } as any] },
      morning_reminder_time: "08:00",
      evening_reminder_time: "21:00",
      weekly_reminder_time: "10:00",
      random_sampling_enabled: true,
    });

    const ids = action.notifications.map((n) => n.id);
    // Landmine guard: the *-reminder scheme, NOT bare morning/evening/weekly.
    expect(ids).toEqual([
      MORNING_REMINDER_ID,
      EVENING_REMINDER_ID,
      WEEKLY_REMINDER_ID,
      SAMPLING_ID,
    ]);
    expect(ids).toEqual(["morning-reminder", "evening-reminder", "weekly-reminder", "sampling"]);

    const morning = action.notifications.find((n) => n.id === MORNING_REMINDER_ID)!;
    expect(morning.strategy).toEqual({ kind: "fixed", cadence: "daily", time: "08:00" });

    const evening = action.notifications.find((n) => n.id === EVENING_REMINDER_ID)!;
    expect(evening.strategy).toEqual({ kind: "fixed", cadence: "daily", time: "21:00" });

    const weekly = action.notifications.find((n) => n.id === WEEKLY_REMINDER_ID)!;
    expect(weekly.strategy).toEqual({
      kind: "fixed",
      cadence: "weekly",
      time: "10:00",
      weekday: 0,
      subsumes: [EVENING_REMINDER_ID],
    });

    // Manifest preserved + notifications added.
    expect(action.nextManifest).toEqual({
      trackables: [{ id: "water" }],
      notifications: action.notifications,
    });
  });

  it("migrates a log with empty columns + sampling off to notifications: []", () => {
    const action = migrate({
      id: "log_empty",
      manifest: { trackables: [] },
      morning_reminder_time: "",
      evening_reminder_time: "",
      weekly_reminder_time: "",
      random_sampling_enabled: false,
    });
    expect(action.notifications).toEqual([]);
    expect(action.nextManifest).toEqual({ trackables: [], notifications: [] });
  });

  it("skips an already-migrated log (manifest.notifications is an array)", () => {
    const [action] = planReminderMigration([
      {
        id: "log_done",
        manifest: {
          trackables: [],
          notifications: [
            { id: "morning-reminder", target: "morning", strategy: { kind: "fixed", cadence: "daily", time: "08:00" } },
          ],
        },
        morning_reminder_time: "09:00",
      },
    ]);
    expect(action.kind).toBe("skip");
  });

  it("skips an already-migrated log with an explicit empty array (Angela)", () => {
    const [action] = planReminderMigration([
      {
        id: "log_angela",
        manifest: { trackables: [], notifications: [] },
        evening_reminder_time: "21:00",
      },
    ]);
    expect(action.kind).toBe("skip");
  });

  it("migrates a log with manifest: null → { trackables: [], notifications: [...] }", () => {
    const action = migrate({
      id: "log_null",
      manifest: null,
      morning_reminder_time: "07:30",
    });
    expect(action.nextManifest).toEqual({
      trackables: [],
      notifications: [
        { id: MORNING_REMINDER_ID, target: "morning", strategy: { kind: "fixed", cadence: "daily", time: "07:30" } },
      ],
    });
  });

  it("preserves existing trackables/goals/views byte-for-byte alongside the new notifications", () => {
    const trackables = [{ id: "water", label: "Water" }] as any;
    const goals = [{ id: "g1", label: "Hydrate" }] as any;
    const views = [{ id: "morning" }] as any;
    const action = migrate({
      id: "log_full",
      manifest: { trackables, goals, views, somethingElse: { nested: true } } as any,
      morning_reminder_time: "08:00",
    });
    expect(action.nextManifest).toEqual({
      trackables,
      goals,
      views,
      somethingElse: { nested: true },
      notifications: [
        { id: MORNING_REMINDER_ID, target: "morning", strategy: { kind: "fixed", cadence: "daily", time: "08:00" } },
      ],
    });
  });

  it("treats undefined manifest.notifications as not-yet-migrated", () => {
    const [action] = planReminderMigration([
      { id: "log_legacy", manifest: { trackables: [] }, evening_reminder_time: "20:00" },
    ]);
    expect(action.kind).toBe("migrate");
  });
});
