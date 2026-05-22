/// <reference path="../pb_data/types.d.ts" />

/**
 * Add per-log opt-in for random-sample push notifications.
 *
 * Until now, services/api/src/lib/notifications/life.ts iterated EVERY life_logs
 * row and pushed to its owner — there was no per-user opt-in. Anyone whose log
 * was auto-created by `getOrCreateLog()` on first app render received random
 * check-in pushes forever, even if they only opened the life app once.
 *
 * This gate lets the api scheduler short-circuit per log:
 *   - `random_sampling_enabled` defaults to false (PocketBase bool default),
 *     so existing rows immediately stop firing.
 *   - The settings UI (apps/life/app/src/components/SettingsModal.tsx) exposes
 *     a Switch to flip it on/off.
 *   - The morning/evening/weekly reminders are already gated by their
 *     `*_reminder_time` field being non-empty, so this only affects the
 *     per-5-minute random-sample cron.
 *
 * See packages/backend/src/types/life-config.ts for the matching comment that
 * has anticipated this gate since the manifest JSON column was retired.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    const fields = [
      { type: "bool", name: "random_sampling_enabled" },
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
    for (const name of ["random_sampling_enabled"]) {
      const f = col.fields.getByName(name);
      if (f) col.fields.removeById(f.id);
    }
    app.save(col);
  }
);
