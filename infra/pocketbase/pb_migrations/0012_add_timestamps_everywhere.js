/// <reference path="../pb_data/types.d.ts" />

/**
 * Backfill created/updated autodate fields on every custom collection.
 *
 * PB 0.25 doesn't auto-add system timestamps when you create collections
 * via JS migrations — you have to declare them explicitly. We shipped a
 * bunch of collections without them. This migration adds them everywhere
 * so sort=-created and similar queries work.
 *
 * Existing records will get the migration timestamp for created/updated
 * (we don't have the real historical values to restore).
 *
 * trip_proposals is already handled by migration 0011 — skipped here.
 */

const COLLECTIONS = [
  "shopping_lists", "shopping_items", "shopping_history", "shopping_trips",
  "recipe_boxes", "recipes", "recipe_events",
  "life_logs", "life_events",
  "task_lists", "tasks", "task_events",
  "travel_logs", "travel_trips", "travel_activities", "travel_itineraries",
  "sharing_invites", "push_subscriptions", "api_tokens",
];

migrate(
  (app) => {
    for (const name of COLLECTIONS) {
      let col;
      try {
        col = app.findCollectionByNameOrId(name);
      } catch {
        console.log(`  ${name}: not found, skipping`);
        continue;
      }
      let added = [];
      if (!col.fields.getByName("created")) {
        col.fields.add(new Field({ type: "autodate", name: "created", onCreate: true }));
        added.push("created");
      }
      if (!col.fields.getByName("updated")) {
        col.fields.add(new Field({ type: "autodate", name: "updated", onCreate: true, onUpdate: true }));
        added.push("updated");
      }
      if (added.length) {
        app.save(col);
        console.log(`  ${name}: added ${added.join(", ")}`);
      }
    }
  },
  (app) => {
    for (const name of COLLECTIONS) {
      let col;
      try {
        col = app.findCollectionByNameOrId(name);
      } catch {
        continue;
      }
      for (const field of ["created", "updated"]) {
        const f = col.fields.getByName(field);
        if (f) col.fields.removeById(f.id);
      }
      app.save(col);
    }
  }
);
