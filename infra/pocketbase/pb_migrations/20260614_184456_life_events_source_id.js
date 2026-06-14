/// <reference path="../pb_data/types.d.ts" />

/*
 * Add `life_events.source_id` + a PARTIAL UNIQUE index for idempotent ingest.
 *
 * Background
 * ----------
 * The Phase-2 Health Connect mapper (services/api/src/routes/health-ingest.ts)
 * writes Fitbit→Health Connect data into `life_events`. Each source record gets
 * a deterministic `source_id` (e.g. `hc:weight:<time>`, `hc:steps:<local-hour>`)
 * so re-posting the same payload is a no-op: the mapper looks the row up by
 * (log, source_id) and upserts instead of inserting a duplicate.
 *
 * Why the index is (log, source_id) and PARTIAL
 * ---------------------------------------------
 * The mapper dedups per (log, source_id) — and DIFFERENT users legitimately
 * produce the SAME source_id (e.g. two people both have a
 * `hc:steps:2026-06-14T07:00:00` bucket). A unique index on `source_id` ALONE
 * is global, so the second user's row would be wrongly rejected. The index is
 * therefore unique on `(log, source_id)`, matching the mapper's lookup key.
 *
 * Manual / UI / MCP events carry NO source_id (it's empty). A plain UNIQUE
 * index would collapse all of one log's manual rows into a single allowed row.
 * SQLite supports a partial index via `WHERE source_id != ''` so the
 * uniqueness constraint only binds the ingest-stamped rows; hand-logged events
 * stay unconstrained.
 *
 * down() drops the index then the field.
 */

const INDEX_NAME = "idx_life_events_source_id";
// Partial unique on (log, source_id): only non-empty source_id values are
// constrained, and uniqueness is per-log so different users can share a key.
const INDEX_SQL =
  "CREATE UNIQUE INDEX " +
  INDEX_NAME +
  " ON life_events (log, source_id) WHERE source_id != ''";

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("life_events");

    if (!col.fields.getByName("source_id")) {
      col.fields.add(
        new Field({
          type: "text",
          name: "source_id",
          max: 200,
        }),
      );
      app.save(col);
      console.log("  life_events: added source_id field (text, max 200)");
    } else {
      console.log("  life_events: source_id field already present, skipping add");
    }

    // Re-fetch the collection so the index add sees the saved field.
    const col2 = app.findCollectionByNameOrId("life_events");
    const existing = (col2.indexes || []).find((i) => i.includes(INDEX_NAME));
    if (existing) {
      console.log("  life_events: " + INDEX_NAME + " already present, skipping");
      return;
    }
    col2.indexes = [...(col2.indexes || []), INDEX_SQL];
    app.save(col2);
    console.log("  life_events: added partial UNIQUE index on source_id");
  },
  (app) => {
    const col = app.findCollectionByNameOrId("life_events");
    const before = (col.indexes || []).length;
    col.indexes = (col.indexes || []).filter((i) => !i.includes(INDEX_NAME));
    if (col.indexes.length !== before) {
      app.save(col);
      console.log("  [down] life_events: dropped " + INDEX_NAME);
    }
    const col2 = app.findCollectionByNameOrId("life_events");
    const f = col2.fields.getByName("source_id");
    if (f) {
      col2.fields.removeById(f.id);
      app.save(col2);
      console.log("  [down] life_events: dropped source_id field");
    }
  },
);
