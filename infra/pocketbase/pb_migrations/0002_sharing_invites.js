/// <reference path="../pb_data/types.d.ts" />

/**
 * Add sharing_invites collection for invite-link based sharing.
 * Invites are redeemed via a PocketBase hook (pb_hooks/sharing.pb.js).
 */

migrate(
  (app) => {
    const usersCol = app.findCollectionByNameOrId("users");

    try {
      app.findCollectionByNameOrId("sharing_invites");
      console.log("  sharing_invites: already exists, skipping");
      return;
    } catch {
      // Collection doesn't exist, create it
    }

    console.log("  sharing_invites: creating");
    const col = new Collection({
      type: "base",
      name: "sharing_invites",
      // Any authenticated user can list/view their own invites
      listRule: '@request.auth.id != "" && created_by = @request.auth.id',
      viewRule: '@request.auth.id != "" && (created_by = @request.auth.id || redeemed_by = @request.auth.id)',
      // Only owners of the target can create invites
      // For boxes: check if auth user is in the target box's owners
      // For recipes: check if auth user is in the target recipe's owners
      // Note: this uses a permissive rule + hook validation since PB can't cross-reference dynamic collections
      createRule: '@request.auth.id != ""',
      // Only creator can update/delete
      updateRule: '@request.auth.id != "" && created_by = @request.auth.id',
      deleteRule: '@request.auth.id != "" && created_by = @request.auth.id',
      fields: [
        // Unique invite code
        { type: "text", name: "code", required: true },
        // What type of thing is being shared: "box" or "recipe"
        { type: "select", name: "target_type", required: true, values: ["box", "recipe"] },
        // ID of the box or recipe being shared
        { type: "text", name: "target_id", required: true },
        // Who created the invite
        {
          type: "relation",
          name: "created_by",
          collectionId: usersCol.id,
          maxSelect: 1,
          required: true,
        },
        // Whether it's been redeemed
        { type: "bool", name: "redeemed" },
        // Who redeemed it
        {
          type: "relation",
          name: "redeemed_by",
          collectionId: usersCol.id,
          maxSelect: 1,
        },
        // Expiry (optional)
        { type: "date", name: "expires_at" },
      ],
    });

    // Add unique index on code
    col.indexes = ['CREATE UNIQUE INDEX idx_invite_code ON sharing_invites (code)'];

    app.save(col);
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("sharing_invites");
      app.delete(col);
    } catch {
      // Already deleted
    }
  }
);
