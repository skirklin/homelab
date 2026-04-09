/// <reference path="../pb_data/types.d.ts" />

/**
 * Add push_subscriptions collection for Web Push (VAPID) subscriptions.
 * Replaces the old FCM token storage.
 */

migrate(
  (app) => {
    const usersCol = app.findCollectionByNameOrId("users");

    try {
      app.findCollectionByNameOrId("push_subscriptions");
      console.log("  push_subscriptions: already exists, skipping");
      return;
    } catch {
      // Collection doesn't exist, create it
    }

    console.log("  push_subscriptions: creating");
    const col = new Collection({
      type: "base",
      name: "push_subscriptions",
      // Users can only see/manage their own subscriptions
      listRule: '@request.auth.id != "" && user = @request.auth.id',
      viewRule: '@request.auth.id != "" && user = @request.auth.id',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != "" && user = @request.auth.id',
      deleteRule: '@request.auth.id != "" && user = @request.auth.id',
      fields: [
        {
          type: "relation",
          name: "user",
          collectionId: usersCol.id,
          maxSelect: 1,
          required: true,
        },
        // The push subscription endpoint URL
        { type: "text", name: "endpoint", required: true },
        // The push subscription keys (p256dh, auth) as JSON
        { type: "json", name: "keys", required: true },
      ],
    });

    // Unique index on endpoint to prevent duplicate subscriptions
    col.indexes = [
      'CREATE UNIQUE INDEX idx_push_endpoint ON push_subscriptions (endpoint)',
    ];

    app.save(col);
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("push_subscriptions");
      app.delete(col);
    } catch {
      // Already deleted
    }
  }
);
