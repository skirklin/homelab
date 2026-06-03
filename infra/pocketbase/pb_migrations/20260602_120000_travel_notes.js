/// <reference path="../pb_data/types.d.ts" />

/**
 * travel_notes — per-user, cross-visible feedback notes for the travel app.
 *
 * Phase 1 keystone. Mirrors the recipe_events / life_events / task_events
 * shape: an append-only child collection under a tenancy log, with a
 * freeform `entries[]` JSON array and a nullable `created_by` author.
 *
 * Row shape:
 *   { log, subject_type, subject_id, created_by?, entries: Array<{name,type,value,unit?,scale?}> }
 *
 *   subject_type ∈ { "activity" | "day" | "trip" } (kept as plain text, like
 *   recipe_events' subject_id — no select ceremony for a 3-value freeform tag).
 *   subject_id:  activity → activity ID
 *                trip     → trip ID
 *                day      → composite "${tripId}:${date}"
 *
 * No explicit `timestamp` field — the `created`/`updated` autodate fields
 * (declared in the schema below, the 0012 pattern) carry sort order. (Per the
 * travel-expert review: an explicit timestamp is needless ceremony for
 * feedback notes; the mirror/sort path doesn't require it.) NOTE: PB v0.25
 * base collections do NOT add created/updated implicitly — they must be
 * declared, which is why they appear in the field list.
 *
 * Access rules copy the child / cooking-log pattern exactly:
 *   list/view/update/delete = owner-of-log
 *   create                  = any authenticated user (broad child-create,
 *                             matching trips/activities/day_entries so the
 *                             wrapped-pb optimistic create path works).
 *
 * No unique index: multiple rows per (log, subject_id) is the whole point —
 * one row per author.
 *
 * --- Backfill ---
 * Legacy single-string notes are imported as UNATTRIBUTED rows (created_by
 * left empty — we never guess an author):
 *   - travel_activities: personal_notes and/or verdict
 *   - travel_day_entries: text / highlight / mood
 *   - travel_trips:       notes
 * The legacy columns are NOT modified or dropped — they stay as a read-only
 * safety net for a later phase.
 *
 * `log` resolution: every source row (activity, day_entry, trip) already
 * carries a direct `log` relation, so no parent-chain join is needed — we
 * read it straight off the row. (maxSelect:1 relations surface as the bare
 * ID string in goja, exactly what we set on the new row.)
 *
 * goja note: the backfill reads ONLY text / select / number columns
 * (personal_notes, verdict, notes, text, highlight, mood, date) and the
 * single-relation `log`. None are JSON columns, so the []byte byte-array
 * footgun does not apply here and unwrapPbJson is unnecessary.
 */

migrate(
  (app) => {
    const usersCol = app.findCollectionByNameOrId("users");
    const logsCol = app.findCollectionByNameOrId("travel_logs");

    // Owner-of-log rule, identical to travel_day_entries / childRules("log").
    const ownerRule = '@request.auth.id != "" && @request.auth.id ?= log.owners.id';

    // 1. Create the collection (idempotent).
    let exists = true;
    try {
      app.findCollectionByNameOrId("travel_notes");
    } catch {
      exists = false;
    }
    if (!exists) {
      const col = new Collection({
        type: "base",
        name: "travel_notes",
        listRule: ownerRule,
        viewRule: ownerRule,
        createRule: '@request.auth.id != ""',
        updateRule: ownerRule,
        deleteRule: ownerRule,
        fields: [
          {
            type: "relation",
            name: "log",
            collectionId: logsCol.id,
            maxSelect: 1,
            required: true,
            cascadeDelete: true,
          },
          { type: "text", name: "subject_type", required: true },
          { type: "text", name: "subject_id", required: true },
          {
            type: "relation",
            name: "created_by",
            collectionId: usersCol.id,
            maxSelect: 1,
            required: false,
            cascadeDelete: false,
          },
          { type: "json", name: "entries", maxSize: 50000 },
          // Auto timestamps from day one (the 0012 pattern) — these carry
          // sort/mirror order so we don't need an explicit `timestamp` field.
          // Base collections in PB v0.25 do NOT add these implicitly; the
          // sibling travel_day_entries (created post-0012) lacks them, so we
          // declare them here rather than backfill later.
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
        indexes: [
          // Not unique — multiple authors per subject is intended. Plain
          // indexes only, to keep the common access paths fast.
          "CREATE INDEX idx_travel_notes_log ON travel_notes (log)",
          "CREATE INDEX idx_travel_notes_subject ON travel_notes (subject_type, subject_id)",
        ],
      });
      app.save(col);
      console.log("  travel_notes: created");
    } else {
      console.log("  travel_notes: already exists, skipping create");
    }

    const notesCol = app.findCollectionByNameOrId("travel_notes");

    // Helper: build & save one unattributed travel_notes row.
    function createNote(logId, subjectType, subjectId, entries) {
      const rec = new Record(notesCol);
      rec.set("log", logId);
      rec.set("subject_type", subjectType);
      rec.set("subject_id", subjectId);
      rec.set("created_by", "");
      rec.set("entries", entries);
      app.save(rec);
    }

    // Re-run safety: the backfill below inserts unattributed rows with no
    // unique index to dedupe them, so a down()→up() (or an accidental second
    // up()) would double-insert. Gate the WHOLE backfill on the table being
    // empty — if any travel_notes row already exists, the backfill has run (or
    // real notes have been authored), and we must not re-seed.
    if (app.findRecordsByFilter("travel_notes", "1=1").length > 0) {
      console.log("  travel_notes: rows already exist, skipping backfill");
      return;
    }

    // 2a. Activities: personal_notes and/or verdict.
    let aCreated = 0;
    let aSkipped = 0;
    const activities = app.findRecordsByFilter("travel_activities", "1=1");
    for (let i = 0; i < activities.length; i++) {
      const r = activities[i];
      const logId = r.get("log");
      const notes = r.get("personal_notes");
      const verdict = r.get("verdict");
      const entries = [];
      if (typeof notes === "string" && notes.length > 0) {
        entries.push({ name: "notes", type: "text", value: notes });
      }
      if (typeof verdict === "string" && verdict.length > 0) {
        entries.push({ name: "verdict", type: "text", value: verdict });
      }
      if (entries.length === 0 || !logId) {
        aSkipped++;
        continue;
      }
      createNote(logId, "activity", r.get("id"), entries);
      aCreated++;
    }
    console.log(`  travel_notes: activities backfilled ${aCreated}, skipped ${aSkipped}`);

    // 2b. Day entries: text / highlight / mood.
    let dCreated = 0;
    let dSkipped = 0;
    const dayEntries = app.findRecordsByFilter("travel_day_entries", "1=1");
    for (let i = 0; i < dayEntries.length; i++) {
      const r = dayEntries[i];
      const logId = r.get("log");
      const tripId = r.get("trip");
      const date = r.get("date");
      const text = r.get("text");
      const highlight = r.get("highlight");
      const mood = r.get("mood");
      const entries = [];
      if (typeof text === "string" && text.length > 0) {
        entries.push({ name: "text", type: "text", value: text });
      }
      if (typeof highlight === "string" && highlight.length > 0) {
        entries.push({ name: "highlight", type: "text", value: highlight });
      }
      if (typeof mood === "number" && mood > 0) {
        entries.push({ name: "mood", type: "number", value: mood });
      }
      if (entries.length === 0 || !logId || !tripId || !date) {
        dSkipped++;
        continue;
      }
      createNote(logId, "day", tripId + ":" + date, entries);
      dCreated++;
    }
    console.log(`  travel_notes: day_entries backfilled ${dCreated}, skipped ${dSkipped}`);

    // 2c. Trips: notes.
    let tCreated = 0;
    let tSkipped = 0;
    const trips = app.findRecordsByFilter("travel_trips", "1=1");
    for (let i = 0; i < trips.length; i++) {
      const r = trips[i];
      const logId = r.get("log");
      const notes = r.get("notes");
      if (typeof notes !== "string" || notes.length === 0 || !logId) {
        tSkipped++;
        continue;
      }
      createNote(logId, "trip", r.get("id"), [
        { name: "notes", type: "text", value: notes },
      ]);
      tCreated++;
    }
    console.log(`  travel_notes: trips backfilled ${tCreated}, skipped ${tSkipped}`);
  },
  (app) => {
    // Revert: drop the collection. Backfilled rows go with it.
    try {
      const col = app.findCollectionByNameOrId("travel_notes");
      app.delete(col);
      console.log("  travel_notes: deleted");
    } catch {
      // already gone
    }
  },
);
