import { DEFAULT_VIEWS } from "@homelab/backend";
import { describe, expect, it } from "vitest";
import {
  EVENING_REMINDER_ID,
  MORNING_REMINDER_ID,
  SAMPLING_ID,
  WEEKLY_REMINDER_ID,
  type RawLifeLog,
  planReminderMigration,
} from "./reminder-migration";

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

    const notifications = action.notifications!;
    const ids = notifications.map((n) => n.id);
    // Landmine guard: the *-reminder scheme, NOT bare morning/evening/weekly.
    expect(ids).toEqual([
      MORNING_REMINDER_ID,
      EVENING_REMINDER_ID,
      WEEKLY_REMINDER_ID,
      SAMPLING_ID,
    ]);
    expect(ids).toEqual(["morning-reminder", "evening-reminder", "weekly-reminder", "sampling"]);

    const morning = notifications.find((n) => n.id === MORNING_REMINDER_ID)!;
    expect(morning.strategy).toEqual({ kind: "fixed", cadence: "daily", time: "08:00" });

    const evening = notifications.find((n) => n.id === EVENING_REMINDER_ID)!;
    expect(evening.strategy).toEqual({ kind: "fixed", cadence: "daily", time: "21:00" });

    const weekly = notifications.find((n) => n.id === WEEKLY_REMINDER_ID)!;
    expect(weekly.strategy).toEqual({
      kind: "fixed",
      cadence: "weekly",
      time: "10:00",
      weekday: 0,
      subsumes: [EVENING_REMINDER_ID],
    });

    // Manifest preserved + notifications added. views was undefined, so it's
    // materialized to DEFAULT_VIEWS too.
    expect(action.nextManifest).toEqual({
      trackables: [{ id: "water" }],
      notifications: action.notifications,
      views: DEFAULT_VIEWS,
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
    expect(action.nextManifest).toEqual({
      trackables: [],
      notifications: [],
      views: DEFAULT_VIEWS,
    });
  });

  it("skips a fully-migrated log (BOTH manifest.notifications + manifest.views are arrays)", () => {
    const [action] = planReminderMigration([
      {
        id: "log_done",
        manifest: {
          trackables: [],
          notifications: [
            { id: "morning-reminder", target: "morning", strategy: { kind: "fixed", cadence: "daily", time: "08:00" } },
          ],
          views: DEFAULT_VIEWS,
        },
        morning_reminder_time: "09:00",
      },
    ]);
    expect(action.kind).toBe("skip");
  });

  it("skips a fully-migrated log with explicit empty arrays for both (Angela)", () => {
    const [action] = planReminderMigration([
      {
        id: "log_angela",
        manifest: { trackables: [], notifications: [], views: [] },
        evening_reminder_time: "21:00",
      },
    ]);
    expect(action.kind).toBe("skip");
  });

  it("materializes BOTH keys when notifications + views are undefined; siblings preserved", () => {
    const trackables = [{ id: "water", label: "Water" }] as any;
    const goals = [{ id: "g1", label: "Hydrate" }] as any;
    const action = migrate({
      id: "log_both_undef",
      manifest: { trackables, goals } as any,
      morning_reminder_time: "08:00",
    });
    // Landmine guard: notifications use the *-reminder id scheme.
    expect(action.notifications!.map((n) => n.id)).toEqual([MORNING_REMINDER_ID]);
    // views materialize to DEFAULT_VIEWS verbatim.
    expect(action.views).toBe(DEFAULT_VIEWS);
    expect(action.nextManifest).toEqual({
      trackables,
      goals,
      notifications: [
        { id: MORNING_REMINDER_ID, target: "morning", strategy: { kind: "fixed", cadence: "daily", time: "08:00" } },
      ],
      views: DEFAULT_VIEWS,
    });
  });

  it("materializes ONLY views when notifications is already an array but views is undefined", () => {
    const notifications = [
      { id: "morning-reminder", target: "morning", strategy: { kind: "fixed", cadence: "daily", time: "06:00" } },
    ] as any;
    const action = migrate({
      id: "log_views_only",
      manifest: { trackables: [], notifications } as any,
      // A real column time that MUST be ignored — notifications already an array.
      morning_reminder_time: "09:00",
    });
    // notifications untouched (NOT rebuilt from the 09:00 column).
    expect(action.notifications).toBeNull();
    expect(action.views).toBe(DEFAULT_VIEWS);
    expect(action.nextManifest).toEqual({
      trackables: [],
      notifications, // preserved verbatim
      views: DEFAULT_VIEWS,
    });
  });

  it("materializes ONLY notifications when views is already an array but notifications is undefined", () => {
    const views = [{ id: "morning" }] as any;
    const action = migrate({
      id: "log_notifs_only",
      manifest: { trackables: [], views, somethingElse: { nested: true } } as any,
      morning_reminder_time: "08:00",
    });
    expect(action.views).toBeNull();
    expect(action.notifications!.map((n) => n.id)).toEqual([MORNING_REMINDER_ID]);
    expect(action.nextManifest).toEqual({
      trackables: [],
      views, // preserved verbatim — NOT overwritten with DEFAULT_VIEWS
      somethingElse: { nested: true },
      notifications: [
        { id: MORNING_REMINDER_ID, target: "morning", strategy: { kind: "fixed", cadence: "daily", time: "08:00" } },
      ],
    });
  });

  it("migrates a log with manifest: null → trackables + both keys materialized", () => {
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
      views: DEFAULT_VIEWS,
    });
  });

  it("treats undefined manifest.notifications as not-yet-migrated", () => {
    const [action] = planReminderMigration([
      { id: "log_legacy", manifest: { trackables: [] }, evening_reminder_time: "20:00" },
    ]);
    expect(action.kind).toBe("migrate");
  });
});
