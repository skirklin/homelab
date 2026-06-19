/// <reference path="../pb_data/types.d.ts" />

/**
 * Add per-log opt-in for the whole Coach system.
 *
 * `coach_enabled` (bool, DEFAULT TRUE) gates everything Coach:
 *   - Frontend: the Coach tab, the /coach /insights /observations routes, and
 *     every in-app nav link into them (apps/life/...). When false, the UI
 *     hides all of it and deep-links redirect to "/".
 *   - Backend: the weekly observer cron
 *     (services/api/src/lib/notifications/scheduler.ts runObserverWeekly)
 *     skips owners whose log has coach_enabled === false, so no Anthropic
 *     tokens are spent generating observations for opted-out users.
 *
 * DEFAULT TRUE (unlike random_sampling_enabled's default false): Coach is
 * already live for existing users, so flipping it to a false default would
 * silently turn it off for everyone.
 *
 * "Default true" is enforced in THREE places, because a PB bool field can only
 * schema-default to false:
 *   1. This migration backfills every EXISTING row to true after adding the
 *      column.
 *   2. getOrCreateLog() seeds `coach_enabled: true` on CREATE, so NEW rows are
 *      on (a fresh PB row would otherwise read back an explicit `false`).
 *   3. The PB mapper reads `coach_enabled ?? true`, which only rescues rows
 *      where the column is genuinely absent (e.g. a half-deployed env reading
 *      a row written before this migration ran).
 *
 * Filename uses the timestamp prefix (YYYYMMDD_HHMMSS) — see the note in
 * 20260522_221130_life_random_sampling_enabled.js about PB silently no-op'ing
 * a migration whose filename sorts before the last-applied one.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    if (!col.fields.getByName("coach_enabled")) {
      // Bool field defaulting true: PB bool fields can't carry a non-false
      // schema default, so set the default by writing `true` to every existing
      // row after adding the column. The mapper's `?? true` covers any row this
      // backfill misses (and legacy rows in other environments).
      col.fields.add(new Field({ type: "bool", name: "coach_enabled" }));
      app.save(col);
      console.log("  life_logs: added coach_enabled");

      const rows = app.findRecordsByFilter("life_logs", "1=1");
      for (let i = 0; i < rows.length; i++) {
        rows[i].set("coach_enabled", true);
        app.save(rows[i]);
      }
      console.log("  life_logs: backfilled coach_enabled=true on " + rows.length + " row(s)");
    } else {
      app.save(col);
    }
  },
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    const f = col.fields.getByName("coach_enabled");
    if (f) col.fields.removeById(f.id);
    app.save(col);
  }
);
