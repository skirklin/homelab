/// <reference path="../pb_data/types.d.ts" />

/**
 * Drop the dead `fcm_tokens` JSON field from users.
 *
 * Legacy FCM-era field. The FCM→web-push migration moved real push
 * subscriptions to the `push_subscriptions` collection (written by
 * `/push/subscribe`); nothing writes `fcm_tokens` anymore. The home
 * Settings "Registered Devices" counter and life debug panel now read
 * `push_subscriptions` directly. This removes the orphaned column.
 *
 * Does not read any JSON column values, so the unwrapPbJson rule doesn't
 * apply. Idempotent: skips if the field is already absent.
 */

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const f = users.fields.getByName("fcm_tokens");
    if (!f) {
      console.log("  users: fcm_tokens already absent, skipping");
      return;
    }
    users.fields.removeById(f.id);
    app.save(users);
    console.log("  users: removed fcm_tokens");
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    if (!users.fields.getByName("fcm_tokens")) {
      users.fields.add(new Field({ type: "json", name: "fcm_tokens" }));
      app.save(users);
    }
  }
);
