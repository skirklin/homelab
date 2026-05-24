/// <reference path="../pb_data/types.d.ts" />

/**
 * Rebuild b-tree indexes on the four oauth_* collections.
 *
 * Symptom (surfaced 2026-05-24): any sorted query against
 *   oauth_clients / oauth_codes / oauth_access_tokens / oauth_refresh_tokens
 * returns HTTP 400 "Something went wrong" from PB. Unsorted queries return
 * rows fine, so the underlying row data is intact — only the index pages
 * are damaged. The corruption pre-dates today: it's already present in the
 * most recent pre-deploy backup we restored from, so it's been sitting
 * silent for a while (only noticed because PB Admin UI started sorting
 * these collections by default and tripping the 400).
 *
 * Fix: SQLite REINDEX rebuilds every index on the named table from the
 * row data. It's safe to run on a healthy table (just rewrites the same
 * pages), and on a corrupt one it produces a clean b-tree from scratch.
 * No schema state changes, no row writes — purely an index rebuild.
 *
 * We wrap each REINDEX in its own try/catch so one collection failing
 * (e.g. table renamed in some future migration) doesn't block the rest.
 * `down` is a no-op: REINDEX is idempotent and there's no state to revert.
 */

const OAUTH_TABLES = [
  "oauth_clients",
  "oauth_codes",
  "oauth_access_tokens",
  "oauth_refresh_tokens",
];

migrate(
  (app) => {
    for (const table of OAUTH_TABLES) {
      try {
        app.db().newQuery("REINDEX " + table).execute();
        console.log(`  ${table}: REINDEX ok`);
      } catch (e) {
        console.error(`  ${table}: REINDEX failed: ${e}`);
      }
    }
  },
  (app) => {
    // No-op — REINDEX has no schema-level inverse.
  }
);
