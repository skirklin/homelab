/// <reference path="../pb_data/types.d.ts" />

/**
 * Add created/updated autodate fields to trip_proposals.
 * PB 0.25 doesn't auto-add them on custom collections.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("trip_proposals");
    if (!col.fields.getByName("created")) {
      col.fields.add(new Field({ type: "autodate", name: "created", onCreate: true }));
    }
    if (!col.fields.getByName("updated")) {
      col.fields.add(new Field({ type: "autodate", name: "updated", onCreate: true, onUpdate: true }));
    }
    app.save(col);
    console.log("  trip_proposals: added created/updated autodate fields");
  },
  (app) => {
    const col = app.findCollectionByNameOrId("trip_proposals");
    for (const name of ["created", "updated"]) {
      const f = col.fields.getByName(name);
      if (f) col.fields.removeById(f.id);
    }
    app.save(col);
  }
);
