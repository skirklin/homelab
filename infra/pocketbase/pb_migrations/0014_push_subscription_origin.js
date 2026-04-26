/// <reference path="../pb_data/types.d.ts" />

/**
 * Add `origin` field to push_subscriptions so the same user's subs from
 * different origins (e.g. upkeep.kirkl.in vs kirkl.in/upkeep) can be
 * distinguished. Used at send time to deliver each notification to a single
 * preferred origin per user, eliminating cross-origin duplicate notifications.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("push_subscriptions");
    if (!col.fields.getByName("origin")) {
      col.fields.add(new Field({ type: "text", name: "origin" }));
      app.save(col);
      console.log("  push_subscriptions: added origin field");
    }
  },
  (app) => {
    const col = app.findCollectionByNameOrId("push_subscriptions");
    const field = col.fields.getByName("origin");
    if (field) {
      col.fields.removeById(field.id);
      app.save(col);
    }
  }
);
