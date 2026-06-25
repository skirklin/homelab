/// <reference path="../pb_data/types.d.ts" />

/**
 * Add per-log opt-in for the Journal surface.
 *
 * `journal_enabled` (bool, DEFAULT TRUE) gates the Journal UI ONLY:
 *   - Frontend: the Journal tab, the /journal route, and every in-app nav link
 *     into it (apps/life/...). When false, the UI hides all of it and deep-links
 *     to /journal redirect to "/".
 *   - Backend: NONE. Unlike coach_enabled, Journal has no cron / api-service
 *     equivalent — it's purely frontend UI gating, so nothing in
 *     services/api consults this column.
 *
 * DEFAULT TRUE (mirrors coach_enabled): Journal is already live for existing
 * users, so a false default would silently turn it off for everyone.
 *
 * "Default true" is enforced in THREE places, because a PB bool field can only
 * schema-default to false:
 *   1. This migration backfills every EXISTING row to true after adding the
 *      column.
 *   2. getOrCreateLog() seeds `journal_enabled: true` on CREATE, so NEW rows are
 *      on (a fresh PB row would otherwise read back an explicit `false`).
 *   3. The PB mapper reads `journal_enabled ?? true`, which only rescues rows
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
    if (!col.fields.getByName("journal_enabled")) {
      // Bool field defaulting true: PB bool fields can't carry a non-false
      // schema default, so set the default by writing `true` to every existing
      // row after adding the column. The mapper's `?? true` covers any row this
      // backfill misses (and legacy rows in other environments).
      col.fields.add(new Field({ type: "bool", name: "journal_enabled" }));
      app.save(col);
      console.log("  life_logs: added journal_enabled");

      const rows = app.findRecordsByFilter("life_logs", "1=1");
      for (let i = 0; i < rows.length; i++) {
        rows[i].set("journal_enabled", true);
        app.save(rows[i]);
      }
      console.log("  life_logs: backfilled journal_enabled=true on " + rows.length + " row(s)");
    } else {
      app.save(col);
    }
  },
  (app) => {
    const col = app.findCollectionByNameOrId("life_logs");
    const f = col.fields.getByName("journal_enabled");
    if (f) col.fields.removeById(f.id);
    app.save(col);
  }
);
