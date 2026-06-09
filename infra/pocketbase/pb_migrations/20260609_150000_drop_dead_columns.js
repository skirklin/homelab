/// <reference path="../pb_data/types.d.ts" />

/**
 * Drop three dead columns superseded by other storage.
 *
 *  1. recipes.cooking_log (json) — superseded by recipe_events.entries; the
 *     recipe mapper and /fn/data routes read cooking sessions from the
 *     recipe_events collection, never this column. Only ref is the one-shot
 *     export-firestore.ts.
 *  2. users.cooking_mode_seen (bool) — superseded by last_seen_update_version.
 *     Only ref is export-firestore.ts.
 *  3. travel_activities.booking_reqs (json) — zero refs; the travel mapper
 *     omits it.
 *
 * Does not read any JSON column values, so the unwrapPbJson rule doesn't
 * apply. Each drop is idempotent: skips if the field is already absent.
 * The down-migration re-adds each field with its original 0001 definition.
 */

migrate(
  (app) => {
    const drops = [
      ["recipes", "cooking_log"],
      ["users", "cooking_mode_seen"],
      ["travel_activities", "booking_reqs"],
    ];
    for (const [collName, fieldName] of drops) {
      const col = app.findCollectionByNameOrId(collName);
      const f = col.fields.getByName(fieldName);
      if (!f) {
        console.log(`  ${collName}: ${fieldName} already absent, skipping`);
        continue;
      }
      col.fields.removeById(f.id);
      app.save(col);
      console.log(`  ${collName}: removed ${fieldName}`);
    }
  },
  (app) => {
    const readds = [
      ["recipes", { type: "json", name: "cooking_log", maxSize: 500000 }],
      ["users", { type: "bool", name: "cooking_mode_seen" }],
      ["travel_activities", { type: "json", name: "booking_reqs", maxSize: 50000 }],
    ];
    for (const [collName, fieldDef] of readds) {
      const col = app.findCollectionByNameOrId(collName);
      if (!col.fields.getByName(fieldDef.name)) {
        col.fields.add(new Field(fieldDef));
        app.save(col);
      }
    }
  }
);
