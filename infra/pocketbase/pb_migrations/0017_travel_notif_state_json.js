/// <reference path="../pb_data/types.d.ts" />

/**
 * Switch travel notification dedup from two date fields to a single JSON
 * field that carries per-trip state.
 *
 * The old fields can't represent "we sent for trip A today but not trip B"
 * — needed because we now run notifications in each trip's local timezone
 * and a user can be active on multiple trips on the same calendar day.
 *
 * Shape: { morning: { [tripId]: "YYYY-MM-DD" }, evening: { [tripId]: "..." } }
 *
 * The 0016 fields (last_travel_notif_morning, last_travel_notif_evening)
 * are dropped — they were never read by anything in production except the
 * brief earlier version of this notification flow.
 */

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    if (!users.fields.getByName("travel_notif_state")) {
      users.fields.add(new Field({ type: "json", name: "travel_notif_state", maxSize: 50000 }));
      console.log("  users: added travel_notif_state");
    }
    for (const name of ["last_travel_notif_morning", "last_travel_notif_evening"]) {
      const f = users.fields.getByName(name);
      if (f) {
        users.fields.removeById(f.id);
        console.log(`  users: removed ${name}`);
      }
    }
    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const f = users.fields.getByName("travel_notif_state");
    if (f) users.fields.removeById(f.id);
    if (!users.fields.getByName("last_travel_notif_morning")) {
      users.fields.add(new Field({ type: "date", name: "last_travel_notif_morning" }));
    }
    if (!users.fields.getByName("last_travel_notif_evening")) {
      users.fields.add(new Field({ type: "date", name: "last_travel_notif_evening" }));
    }
    app.save(users);
  }
);
