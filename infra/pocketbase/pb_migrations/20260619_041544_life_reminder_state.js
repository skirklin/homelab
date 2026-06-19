/// <reference path="../pb_data/types.d.ts" />

/*
 * Add `life_logs.reminder_state` — the go-forward idempotency store for the
 * data-driven notification cron (Phase B4).
 *
 * Shape: Record<notificationId, "YYYY-MM-DD"> — the last owner-local day each
 * `fixed` notification was successfully delivered. Replaces the per-reminder
 * `last_{morning,evening,weekly}_reminder_sent` date columns going forward.
 *
 * The cron writes `reminder_state[id]` only; it READS both `reminder_state[id]`
 * AND the legacy `last_*_reminder_sent` columns so a deploy-day already-sent
 * reminder doesn't double-fire across the cutover. The legacy columns are LEFT
 * IN PLACE here — a later phase (D) migrates/drops them once nothing reads them.
 *
 * No data backfill: an empty/absent map reads as "nothing sent yet", and the
 * legacy-column read covers the transition window, so existing reminders stay
 * idempotent without seeding anything.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    if (!col.fields.getByName("reminder_state")) {
      col.fields.add(new Field({ type: "json", name: "reminder_state", maxSize: 50000 }));
      app.save(col);
      console.log("  life_logs: added reminder_state (json)");
    }
  },
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    const f = col.fields.getByName("reminder_state");
    if (f) {
      col.fields.removeById(f.id);
      app.save(col);
      console.log("  [down] life_logs: removed reminder_state");
    }
  },
);
