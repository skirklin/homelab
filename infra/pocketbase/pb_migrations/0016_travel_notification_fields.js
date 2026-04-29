/// <reference path="../pb_data/types.d.ts" />

/**
 * Add per-user dedup fields for travel push notifications.
 *
 * Mirrors the existing `last_task_notification` field used by the upkeep
 * notification job. Two separate fields because morning + evening fire on
 * the same day; one combined field would let one fire suppress the other.
 */

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    let changed = false;
    if (!users.fields.getByName("last_travel_notif_morning")) {
      users.fields.add(new Field({ type: "date", name: "last_travel_notif_morning" }));
      changed = true;
    }
    if (!users.fields.getByName("last_travel_notif_evening")) {
      users.fields.add(new Field({ type: "date", name: "last_travel_notif_evening" }));
      changed = true;
    }
    if (changed) {
      app.save(users);
      console.log("  users: added last_travel_notif_morning + last_travel_notif_evening");
    }
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    for (const name of ["last_travel_notif_morning", "last_travel_notif_evening"]) {
      const f = users.fields.getByName(name);
      if (f) users.fields.removeById(f.id);
    }
    app.save(users);
  }
);
