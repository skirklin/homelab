/// <reference path="../pb_data/types.d.ts" />

/**
 * Backfill empty created/updated timestamps on records that pre-date migration
 * 0012. That migration added created/updated as autodate fields but didn't
 * actually write values to existing rows — autodate only fires on new creates,
 * so every pre-migration record kept created="" / updated="". Anywhere in the
 * app that parses these with `new Date(r.created)` then gets an Invalid Date.
 *
 * We can't recover the real historical timestamps, so stamp empty rows with
 * the migration time. All old records will share that timestamp, but they'd
 * already lost chronological ordering when 0012 ran.
 */

const COLLECTIONS = [
  "shopping_lists", "shopping_items", "shopping_history", "shopping_trips",
  "recipe_boxes", "recipes", "recipe_events",
  "life_logs", "life_events",
  "task_lists", "tasks", "task_events",
  "travel_logs", "travel_trips", "travel_activities", "travel_itineraries",
  "sharing_invites", "push_subscriptions", "api_tokens",
  "trip_proposals",
];

migrate(
  (app) => {
    // PB datetime format: "YYYY-MM-DD HH:MM:SS.sssZ" (space between date/time).
    const now = new Date().toISOString().replace("T", " ");

    for (const name of COLLECTIONS) {
      try {
        app.findCollectionByNameOrId(name);
      } catch {
        console.log(`  ${name}: not found, skipping`);
        continue;
      }

      // Raw UPDATE bypasses model validation so autodate fields accept the
      // write. Use two statements so "created empty" and "updated empty" are
      // tallied independently — they won't always overlap.
      const createdRes = app.db().newQuery(
        `UPDATE {{` + name + `}} SET created = {:now} WHERE created = '' OR created IS NULL`
      ).bind({ now }).execute();

      const updatedRes = app.db().newQuery(
        `UPDATE {{` + name + `}} SET updated = {:now} WHERE updated = '' OR updated IS NULL`
      ).bind({ now }).execute();

      const createdCount = createdRes.rowsAffected ? createdRes.rowsAffected() : "?";
      const updatedCount = updatedRes.rowsAffected ? updatedRes.rowsAffected() : "?";
      console.log(`  ${name}: backfilled created=${createdCount}, updated=${updatedCount}`);
    }
  },
  (app) => {
    // No-op. We can't identify which rows we backfilled (timestamps now look
    // valid and indistinguishable from legitimate writes), and blanking them
    // again would break any UI that now depends on valid dates.
  }
);
