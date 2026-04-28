/// <reference path="../pb_data/types.d.ts" />

/**
 * Travel journaling: post-trip reflection.
 *
 *  - Adds verdict / personal_notes / experienced_at fields to travel_activities.
 *    `verdict` is one-tap signal ("loved" | "liked" | "meh" | "skip") that
 *    feeds future trip planning. `rating`/`rating_count` are kept as-is —
 *    those are Google Places aggregates, not the user's personal rating.
 *
 *  - Creates travel_day_entries: one free-form journal entry per (trip, date),
 *    separate from itineraries so it survives itinerary regenerations.
 */

migrate(
  (app) => {
    // 1. Activity reflection fields
    const activities = app.findCollectionByNameOrId("travel_activities");
    if (!activities.fields.getByName("verdict")) {
      activities.fields.add(new Field({
        type: "select",
        name: "verdict",
        values: ["loved", "liked", "meh", "skip"],
        maxSelect: 1,
      }));
    }
    if (!activities.fields.getByName("personal_notes")) {
      activities.fields.add(new Field({ type: "text", name: "personal_notes", max: 5000 }));
    }
    if (!activities.fields.getByName("experienced_at")) {
      activities.fields.add(new Field({ type: "date", name: "experienced_at" }));
    }
    app.save(activities);
    console.log("  travel_activities: added verdict/personal_notes/experienced_at");

    // 2. Day entries collection
    try {
      app.findCollectionByNameOrId("travel_day_entries");
      console.log("  travel_day_entries: already exists, skipping");
      return;
    } catch {
      // create below
    }

    const logs = app.findCollectionByNameOrId("travel_logs");
    const trips = app.findCollectionByNameOrId("travel_trips");

    // Owner-of-log rule, mirroring other travel collections.
    const ownerRule = '@request.auth.id != "" && @request.auth.id ?= log.owners.id';

    const col = new Collection({
      type: "base",
      name: "travel_day_entries",
      listRule: ownerRule,
      viewRule: ownerRule,
      createRule: '@request.auth.id != ""',
      updateRule: ownerRule,
      deleteRule: ownerRule,
      fields: [
        {
          type: "relation",
          name: "log",
          collectionId: logs.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        {
          type: "relation",
          name: "trip",
          collectionId: trips.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        // YYYY-MM-DD; matches ItineraryDay.date.
        { type: "text", name: "date", required: true, max: 10 },
        { type: "text", name: "text", max: 20000 },
        { type: "text", name: "highlight", max: 500 },
        { type: "number", name: "mood", min: 1, max: 5 },
      ],
      indexes: [
        // One entry per trip+date.
        "CREATE UNIQUE INDEX idx_day_entries_trip_date ON travel_day_entries (trip, date)",
        "CREATE INDEX idx_day_entries_log ON travel_day_entries (log)",
      ],
    });

    app.save(col);
    console.log("  travel_day_entries: created");
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("travel_day_entries");
      app.delete(col);
    } catch {
      // already gone
    }
    try {
      const activities = app.findCollectionByNameOrId("travel_activities");
      for (const name of ["verdict", "personal_notes", "experienced_at"]) {
        const f = activities.fields.getByName(name);
        if (f) activities.fields.removeById(f.id);
      }
      app.save(activities);
    } catch {
      // already gone
    }
  }
);
