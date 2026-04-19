/// <reference path="../pb_data/types.d.ts" />

/**
 * Drop travel checklist fields — checklists now live as tagged tasks
 * in the unified task system.
 *
 * - travel_logs.checklists (JSON)
 * - travel_trips.checklist_done (JSON)
 */

migrate(
  (app) => {
    const logs = app.findCollectionByNameOrId("travel_logs");
    const checklistsField = logs.fields.getByName("checklists");
    if (checklistsField) logs.fields.removeById(checklistsField.id);
    app.save(logs);
    console.log("  travel_logs: removed checklists field");

    const trips = app.findCollectionByNameOrId("travel_trips");
    const checklistDoneField = trips.fields.getByName("checklist_done");
    if (checklistDoneField) trips.fields.removeById(checklistDoneField.id);
    app.save(trips);
    console.log("  travel_trips: removed checklist_done field");
  },
  (app) => {
    const logs = app.findCollectionByNameOrId("travel_logs");
    logs.fields.add(new Field({ type: "json", name: "checklists", maxSize: 200000 }));
    app.save(logs);

    const trips = app.findCollectionByNameOrId("travel_trips");
    trips.fields.add(new Field({ type: "json", name: "checklist_done", maxSize: 50000 }));
    app.save(trips);
  },
);
