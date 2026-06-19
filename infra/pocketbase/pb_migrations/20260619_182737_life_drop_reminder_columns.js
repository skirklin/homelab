/// <reference path="../pb_data/types.d.ts" />

/*
 * Phase D — drop the now-dead legacy reminder columns from `life_logs`.
 *
 * The `*_reminder_time` + `last_*_reminder_sent` columns predate the
 * data-driven notification model. Phase D materialized every existing log's
 * `manifest.notifications[]` from these columns
 * (services/scripts/historical/migrate-reminder-columns-to-notifications.ts,
 * already applied on prod) and simplified the cron to manifest-only
 * (`resolveNotifications` reads `manifest.notifications` and the idempotency
 * store is `reminder_state`). Nothing reads these six columns anymore.
 *
 * Dropped:
 *   morning_reminder_time, evening_reminder_time, weekly_reminder_time
 *   last_morning_reminder_sent, last_evening_reminder_sent, last_weekly_reminder_sent
 *
 * KEPT (still live): reminder_state (idempotency store), random_sampling_enabled
 * (sampler opt-in), sample_schedule (per-day sample times).
 *
 * No data migration here — the data already lives in manifest.notifications;
 * dropping the columns just discards the redundant copy. The `down()` re-adds
 * the columns (empty); the original values are NOT restored — that's what the
 * pre-migration backup is for.
 */

const DROPPED = [
  "morning_reminder_time",
  "evening_reminder_time",
  "weekly_reminder_time",
  "last_morning_reminder_sent",
  "last_evening_reminder_sent",
  "last_weekly_reminder_sent",
];

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    for (const name of DROPPED) {
      const f = col.fields.getByName(name);
      if (f) {
        col.fields.removeById(f.id);
        console.log(`  life_logs: dropped ${name}`);
      }
    }
    app.save(col);
  },
  (app) => {
    // Best-effort re-add (empty columns; original data NOT restored — restore
    // from the pre-migration backup if you need the values). Matches the
    // original field defs in 0027_life_reminder_times.js +
    // 20260521_055728_life_weekly_reminder.js: "HH:MM" times (max 5),
    // "YYYY-MM-DD" sent-dates (max 10).
    const col = app.findCollectionByNameOrId("life_logs");
    const fields = [
      { type: "text", name: "morning_reminder_time", max: 5 },
      { type: "text", name: "evening_reminder_time", max: 5 },
      { type: "text", name: "weekly_reminder_time", max: 5 },
      { type: "text", name: "last_morning_reminder_sent", max: 10 },
      { type: "text", name: "last_evening_reminder_sent", max: 10 },
      { type: "text", name: "last_weekly_reminder_sent", max: 10 },
    ];
    for (const f of fields) {
      if (!col.fields.getByName(f.name)) {
        col.fields.add(new Field(f));
        console.log(`  [down] life_logs: re-added ${f.name}`);
      }
    }
    app.save(col);
  },
);
