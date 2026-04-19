/// <reference path="../pb_data/types.d.ts" />

/**
 * Add "travel_log" to the sharing_invites.target_type select values,
 * enabling invite links for sharing travel logs (all trips in the log).
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("sharing_invites");
    const field = col.fields.getByName("target_type");
    if (!field) throw new Error("target_type field not found on sharing_invites");
    const current = field.values || [];
    if (!current.includes("travel_log")) {
      field.values = [...current, "travel_log"];
    }
    app.save(col);
    console.log("  sharing_invites.target_type: added 'travel_log'");
  },
  (app) => {
    const col = app.findCollectionByNameOrId("sharing_invites");
    const field = col.fields.getByName("target_type");
    if (field) {
      field.values = (field.values || []).filter((v) => v !== "travel_log");
      app.save(col);
    }
  }
);
