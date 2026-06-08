/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 5: retire the legacy travel-note schema, now fully superseded by the
 * per-user `travel_notes` collection (subject_type = activity | day | trip).
 *
 * The 20260602_120000_travel_notes backfill already migrated every legacy
 * value into travel_notes; the live app reads feedback exclusively from
 * travel_notes (NotesThread / noteEntries). These columns + collection are
 * dead weight.
 *
 * CRITICAL ORDERING: this filename sorts AFTER 20260602_120000_travel_notes.js,
 * so on a fresh PB the backfill runs FIRST (reading these columns) and only
 * then does this migration drop them. Never give this an earlier timestamp.
 *
 * up() drops:
 *   - travel_trips.notes        (text)
 *   - travel_activities.verdict (select)  + travel_activities.personal_notes (text)
 *   - the ENTIRE travel_day_entries collection (log/trip/date/text/highlight/mood)
 *
 * NOTE: travel_activities.experienced_at is intentionally KEPT — it still backs
 * post-trip reflection timing in the travel_notes UI.
 *
 * goja note: this migration reads NO JSON columns — it only drops schema
 * fields and a collection — so the []byte byte-array footgun does not apply and
 * unwrapPbJson is unnecessary.
 *
 * down() is best-effort: it re-adds the fields/collection so the schema shape
 * returns, but the DATA cannot be restored (it lives in travel_notes and in
 * PB backups). That is acceptable for a forward-only retirement.
 */

migrate(
  (app) => {
    // 1. travel_trips.notes
    const trips = app.findCollectionByNameOrId("travel_trips");
    const tripsNotes = trips.fields.getByName("notes");
    if (tripsNotes) {
      trips.fields.removeById(tripsNotes.id);
      app.save(trips);
      console.log("  travel_trips: dropped notes");
    } else {
      console.log("  travel_trips: notes already gone");
    }

    // 2. travel_activities.verdict + personal_notes (keep experienced_at)
    const activities = app.findCollectionByNameOrId("travel_activities");
    let droppedAct = 0;
    for (const name of ["verdict", "personal_notes"]) {
      const f = activities.fields.getByName(name);
      if (f) {
        activities.fields.removeById(f.id);
        droppedAct++;
      }
    }
    if (droppedAct > 0) {
      app.save(activities);
      console.log(`  travel_activities: dropped ${droppedAct} field(s) (verdict/personal_notes)`);
    } else {
      console.log("  travel_activities: verdict/personal_notes already gone");
    }

    // 3. travel_day_entries collection
    try {
      const col = app.findCollectionByNameOrId("travel_day_entries");
      app.delete(col);
      console.log("  travel_day_entries: deleted");
    } catch {
      console.log("  travel_day_entries: already gone");
    }
  },
  (app) => {
    // Best-effort schema restore. Data is NOT restored — it lives in
    // travel_notes and in PB backups.

    const trips = app.findCollectionByNameOrId("travel_trips");
    if (!trips.fields.getByName("notes")) {
      trips.fields.add(new Field({ type: "text", name: "notes", max: 20000 }));
      app.save(trips);
    }

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
    app.save(activities);

    let exists = true;
    try {
      app.findCollectionByNameOrId("travel_day_entries");
    } catch {
      exists = false;
    }
    if (!exists) {
      const logs = app.findCollectionByNameOrId("travel_logs");
      const tripsCol = app.findCollectionByNameOrId("travel_trips");
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
          { type: "relation", name: "log", collectionId: logs.id, maxSelect: 1, required: true, cascadeDelete: true },
          { type: "relation", name: "trip", collectionId: tripsCol.id, maxSelect: 1, required: true, cascadeDelete: true },
          { type: "text", name: "date", required: true, max: 10 },
          { type: "text", name: "text", max: 20000 },
          { type: "text", name: "highlight", max: 500 },
          { type: "number", name: "mood", min: 1, max: 5 },
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_day_entries_trip_date ON travel_day_entries (trip, date)",
          "CREATE INDEX idx_day_entries_log ON travel_day_entries (log)",
        ],
      });
      app.save(col);
    }
  },
);
