/// <reference path="../pb_data/types.d.ts" />

/**
 * recipe_events: add a `recipe_snapshot` JSON column.
 *
 * Stores the full recipe.data blob at the moment a cooking-log entry is
 * created, so the UI can later diff "the recipe as it was when I cooked it"
 * against the live recipe. Powers the "What changed?" affordance per entry on
 * the recipe detail page — the user leaves notes like "too dry, add another
 * cup of milk" and later wants to know whether the recipe already reflects
 * that adjustment.
 *
 * - Nullable. Pre-existing rows have no snapshot and the UI degrades to a
 *   disabled diff button. We deliberately do NOT backfill — there's no
 *   meaningful prior state to capture for entries that predate this field.
 * - Snapshot is written ONLY on create. update_cooking_log_entry must not
 *   re-snapshot; the snapshot represents the cook session, not the row's
 *   edit history.
 * - Storage cost: recipes are typically 1–3 KB. Cooking-log volume is bounded
 *   per recipe. No dedup / diff-against-last-snapshot — keep it simple.
 *
 * Sized at 100_000 to leave headroom for unusually large recipes (long
 * instruction text, many ingredients) — `entries` is 50_000, and a snapshot
 * is the whole recipe so it needs more.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("recipe_events");
    if (!col.fields.getByName("recipe_snapshot")) {
      col.fields.add(new Field({ type: "json", name: "recipe_snapshot", maxSize: 100000 }));
      app.save(col);
      console.log("  recipe_events: added recipe_snapshot");
    }
  },
  (app) => {
    const col = app.findCollectionByNameOrId("recipe_events");
    const f = col.fields.getByName("recipe_snapshot");
    if (f) {
      col.fields.removeById(f.id);
      app.save(col);
      console.log("  recipe_events: dropped recipe_snapshot");
    }
  },
);
