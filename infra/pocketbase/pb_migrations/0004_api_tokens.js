/// <reference path="../pb_data/types.d.ts" />

/**
 * Add api_tokens collection for proper API token authentication.
 * Tokens are stored as SHA-256 hashes — raw tokens are never persisted.
 */

migrate(
  (app) => {
    const usersCol = app.findCollectionByNameOrId("users");

    try {
      app.findCollectionByNameOrId("api_tokens");
      console.log("  api_tokens: already exists, skipping");
      return;
    } catch {
      // Collection doesn't exist, create it
    }

    console.log("  api_tokens: creating");
    const col = new Collection({
      type: "base",
      name: "api_tokens",
      // Only the token owner can list/view/delete their own tokens
      listRule: '@request.auth.id != "" && user = @request.auth.id',
      viewRule: '@request.auth.id != "" && user = @request.auth.id',
      createRule: '@request.auth.id != ""',
      updateRule: null, // Tokens are immutable — no updates
      deleteRule: '@request.auth.id != "" && user = @request.auth.id',
      fields: [
        {
          type: "relation",
          name: "user",
          collectionId: usersCol.id,
          maxSelect: 1,
          required: true,
        },
        { type: "text", name: "name", required: true },
        { type: "text", name: "token_hash", required: true },
        { type: "text", name: "token_prefix" },
        { type: "date", name: "last_used" },
        { type: "date", name: "expires_at" },
      ],
    });

    col.indexes = [
      'CREATE UNIQUE INDEX idx_token_hash ON api_tokens (token_hash)',
      'CREATE INDEX idx_token_user ON api_tokens (user)',
    ];

    app.save(col);
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("api_tokens");
      app.delete(col);
    } catch {
      // Already deleted
    }
  }
);
