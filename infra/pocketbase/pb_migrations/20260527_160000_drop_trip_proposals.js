/// <reference path="../pb_data/types.d.ts" />

/**
 * Drop the `trip_proposals` collection.
 *
 * Background: the trip-proposals feature was ripped out in commit 195d7f4.
 * Zero code references remain across services/, apps/, packages/, or infra/
 * (excluding pb_migrations/). The collection holds 6 stale rows from a
 * 2026-04 planning session; the user has explicitly approved dropping
 * without an export. Pre-deploy backup (`pre-deploy-<sha>-*.zip`,
 * 14-day retention) is the recovery path if a rollback ever needs the
 * rows back.
 *
 * Notes:
 *   - One-way migration. down() throws because we have no fixture of the
 *     original schema to faithfully recreate it, and "recreate-empty"
 *     would be lying about reversibility. Restore from the pre-deploy
 *     backup if needed.
 *   - up() is idempotent: re-running on a DB where the collection is
 *     already gone is a no-op.
 */

migrate(
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("trip_proposals");
      app.delete(col);
      console.log("  trip_proposals: dropped");
    } catch (e) {
      console.log("  trip_proposals: not found, skipping");
    }
  },
  (app) => {
    throw new Error(
      "trip_proposals drop is one-way; restore via pre-deploy backup if needed",
    );
  },
);
