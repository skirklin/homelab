/// <reference path="../pb_data/types.d.ts" />

/**
 * Add per-log weekly review reminder time to life_logs.
 *
 * Mirrors 0027_life_reminder_times.js for the morning/evening pair. The
 * weekly review session is hardcoded in apps/life/app/src/manifest.ts; only
 * the time (and implicit enable via null vs "HH:MM") is user-configurable.
 *
 * Fields:
 *   - weekly_reminder_time: "HH:MM" 24h, nullable. Null = no weekly reminder.
 *     Fired only on Sunday in the user's timezone, matched within ±1 min.
 *   - last_weekly_reminder_sent: "YYYY-MM-DD", nullable. Server-side
 *     bookkeeping for once-per-Sunday idempotency.
 *
 * Filename uses an ISO timestamp prefix (YYYYMMDD_HHMMSS) instead of the old
 * sequential numbering. Lessens collisions when parallel sessions are
 * authoring migrations against the same trunk.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    const fields = [
      { type: "text", name: "weekly_reminder_time", max: 5 },
      { type: "text", name: "last_weekly_reminder_sent", max: 10 },
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
    for (const name of ["weekly_reminder_time", "last_weekly_reminder_sent"]) {
      const f = col.fields.getByName(name);
      if (f) col.fields.removeById(f.id);
    }
    app.save(col);
  }
);
