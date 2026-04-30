/// <reference path="../pb_data/types.d.ts" />

/**
 * Add a `timezone` text field to users — populated by client apps on each
 * visit from `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 *
 * Used by server-side scheduled jobs (e.g. travel push notifications) to
 * fire at the user's actual local time, regardless of trip data quality.
 */

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    if (!users.fields.getByName("timezone")) {
      users.fields.add(new Field({ type: "text", name: "timezone", max: 100 }));
      app.save(users);
      console.log("  users: added timezone");
    }
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const f = users.fields.getByName("timezone");
    if (f) {
      users.fields.removeById(f.id);
      app.save(users);
    }
  }
);
