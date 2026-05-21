/// <reference path="../pb_data/types.d.ts" />

/**
 * Add per-log morning/evening reminder times to life_logs.
 *
 * Sessions ("morning", "evening") are hardcoded in apps/life/app/src/manifest.ts;
 * only the times (and an implicit enable via null vs "HH:MM") are user-configurable.
 *
 * Fields:
 *   - morning_reminder_time / evening_reminder_time: "HH:MM" 24h, nullable.
 *     Null = no reminder for that session.
 *   - last_morning_reminder_sent / last_evening_reminder_sent: "YYYY-MM-DD",
 *     nullable. Server-side bookkeeping for once-per-day idempotency.
 *
 * Time is interpreted in the user's timezone (users.timezone, populated by
 * the browser via Intl). The cron runs every minute and matches with a
 * ±1-minute window to absorb scheduler jitter.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    const fields = [
      { type: "text", name: "morning_reminder_time", max: 5 },
      { type: "text", name: "evening_reminder_time", max: 5 },
      { type: "text", name: "last_morning_reminder_sent", max: 10 },
      { type: "text", name: "last_evening_reminder_sent", max: 10 },
    ];
    for (const f of fields) {
      if (!col.fields.getByName(f.name)) {
        col.fields.add(new Field(f));
        console.log(`  life_logs: added ${f.name}`);
      }
    }
    app.save(col);
  },
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    for (const name of [
      "morning_reminder_time",
      "evening_reminder_time",
      "last_morning_reminder_sent",
      "last_evening_reminder_sent",
    ]) {
      const f = col.fields.getByName(name);
      if (f) col.fields.removeById(f.id);
    }
    app.save(col);
  }
);
