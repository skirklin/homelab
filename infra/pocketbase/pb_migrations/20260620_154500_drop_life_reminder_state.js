/// <reference path="../pb_data/types.d.ts" />

/*
 * Drop the now-dead `life_logs.reminder_state` json column.
 *
 * `reminder_state` was the per-log idempotency store for the life fixed-reminder
 * cron. The notification-idempotency consolidation moved every cron onto the
 * shared `notification_log` ledger via `notifyOnce` (migration 20260619_200000),
 * keyed (user, "life_reminder:<id>", owner-local-day). The life cron no longer
 * reads or writes `reminder_state`, and a repo-wide sweep confirmed NO remaining
 * code touches it (only doc comments referenced it, now corrected).
 *
 * 20260619_200500 deliberately left this column in place pending confirmation
 * from the life manifest/view workstream that nothing depends on it. That's now
 * confirmed, so the column goes.
 *
 * NOT touched: `life_logs.sample_schedule` — the random sampler still reads/writes
 * its `sentTimes` (computed per-day schedule state, not a plain idempotency
 * stamp), so it remains its own store.
 *
 * No data migration: the column is dead, so its contents are discarded. `down()`
 * re-adds an empty `reminder_state` json field for schema-rollback symmetry; the
 * original values are NOT restored (and nothing reads them anyway). This migration
 * only adds/removes a field definition — it never reads the JSON column, so there
 * is no goja byte-array unwrap to worry about.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    const f = col.fields.getByName("reminder_state");
    if (f) {
      col.fields.removeById(f.id);
      app.save(col);
      console.log("  life_logs: dropped reminder_state");
    }
  },
  (app) => {
    // Best-effort re-add (empty column; original data NOT restored). Mirrors the
    // original field def in 20260619_041544_life_reminder_state.js.
    const col = app.findCollectionByNameOrId("life_logs");
    if (!col.fields.getByName("reminder_state")) {
      col.fields.add(new Field({ type: "json", name: "reminder_state", maxSize: 50000 }));
      app.save(col);
      console.log("  [down] life_logs: re-added reminder_state");
    }
  },
);
