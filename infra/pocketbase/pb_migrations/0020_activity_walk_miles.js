/// <reference path="../pb_data/types.d.ts" />

/**
 * Add walk_miles to travel_activities for recording distance walked or
 * hiked — useful for trip-planning load estimation and posterity.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("travel_activities");
    if (!col.fields.getByName("walk_miles")) {
      col.fields.add(new Field({ type: "number", name: "walk_miles" }));
      app.save(col);
      console.log("  travel_activities: added walk_miles field");
    }
  },
  (app) => {
    const col = app.findCollectionByNameOrId("travel_activities");
    const field = col.fields.getByName("walk_miles");
    if (field) {
      col.fields.removeById(field.id);
      app.save(col);
    }
  }
);
