/// <reference path="../pb_data/types.d.ts" />

/**
 * task_events: unify the row shape behind a single `entries` array.
 *
 * Before:
 *   { list, subject_id (task id), timestamp, created_by, data: { notes? } }
 *
 * After (matches life_events migration 20260522_221157):
 *   { list, subject_id, timestamp, created_by,
 *     entries: Array<{ name, type, value, ... }>,
 *     labels:  Record<string,string> | null,
 *     end_time: ISO | null }
 *
 * Conversion: notes string -> [{ name: "notes", type: "text", value }],
 * otherwise empty entries. No labels/end_time are populated on legacy rows
 * (labels stays null, end_time stays null). Old `data` column is dropped.
 *
 * The down() side is best-effort: reconstruct `data: { notes }` from any
 * text-typed `notes` entry. Production rollback should use a PB backup.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("task_events");
    const additions = [
      { type: "date", name: "end_time" },
      { type: "json", name: "entries", maxSize: 50000 },
      { type: "json", name: "labels", maxSize: 10000 },
    ];
    for (const f of additions) {
      if (!col.fields.getByName(f.name)) {
        col.fields.add(new Field(f));
        console.log(`  task_events: added ${f.name}`);
      }
    }
    app.save(col);

    const rows = app.findRecordsByFilter("task_events", "1=1");
    let rewritten = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let raw;
      try {
        raw = JSON.parse(JSON.stringify(r.get("data") || {}));
      } catch (e) {
        raw = {};
      }
      const entries = [];
      const notes = typeof raw.notes === "string" && raw.notes.length > 0 ? raw.notes : null;
      if (notes) entries.push({ name: "notes", type: "text", value: notes });
      r.set("entries", entries);
      r.set("labels", null);
      r.set("data", null);
      app.save(r);
      rewritten++;
    }
    console.log(`  task_events: rewrote ${rewritten} rows`);

    const col2 = app.findCollectionByNameOrId("task_events");
    const dataField = col2.fields.getByName("data");
    if (dataField) {
      col2.fields.removeById(dataField.id);
      app.save(col2);
      console.log(`  task_events: dropped data column`);
    }
  },
  (app) => {
    const col = app.findCollectionByNameOrId("task_events");
    if (!col.fields.getByName("data")) {
      col.fields.add(new Field({ type: "json", name: "data", maxSize: 50000 }));
      app.save(col);
    }

    const rows = app.findRecordsByFilter("task_events", "1=1");
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let entries;
      try {
        entries = JSON.parse(JSON.stringify(r.get("entries") || []));
      } catch (e) {
        entries = [];
      }
      const data = {};
      for (let j = 0; j < entries.length; j++) {
        const e = entries[j];
        if (!e || typeof e !== "object") continue;
        if (e.name === "notes" && e.type === "text" && typeof e.value === "string") {
          data.notes = e.value;
        }
      }
      r.set("data", data);
      app.save(r);
    }

    const col2 = app.findCollectionByNameOrId("task_events");
    for (const name of ["entries", "labels", "end_time"]) {
      const f = col2.fields.getByName(name);
      if (f) col2.fields.removeById(f.id);
    }
    app.save(col2);
  },
);
