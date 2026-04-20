/// <reference path="../pb_data/types.d.ts" />

/**
 * Add flight_info JSON field to travel_activities so activities with
 * category "Flight" can carry structured data: airline, flight number,
 * origin/destination airport codes, departure/arrival times.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("travel_activities");
    if (!col.fields.getByName("flight_info")) {
      col.fields.add(new Field({ type: "json", name: "flight_info", maxSize: 5000 }));
      app.save(col);
      console.log("  travel_activities: added flight_info field");
    }
  },
  (app) => {
    const col = app.findCollectionByNameOrId("travel_activities");
    const field = col.fields.getByName("flight_info");
    if (field) {
      col.fields.removeById(field.id);
      app.save(col);
    }
  }
);
