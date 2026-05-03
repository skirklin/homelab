/// <reference path="../pb_data/types.d.ts" />

/**
 * Add elevation_gain_feet and difficulty to travel_activities so hikes can
 * surface trail-specific info (elevation gain + a difficulty rating)
 * alongside the existing walk_miles distance field.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("travel_activities");
    if (!col.fields.getByName("elevation_gain_feet")) {
      col.fields.add(new Field({ type: "number", name: "elevation_gain_feet" }));
      console.log("  travel_activities: added elevation_gain_feet field");
    }
    if (!col.fields.getByName("difficulty")) {
      col.fields.add(new Field({ type: "text", name: "difficulty" }));
      console.log("  travel_activities: added difficulty field");
    }
    app.save(col);
  },
  (app) => {
    const col = app.findCollectionByNameOrId("travel_activities");
    for (const name of ["elevation_gain_feet", "difficulty"]) {
      const field = col.fields.getByName(name);
      if (field) col.fields.removeById(field.id);
    }
    app.save(col);
  }
);
