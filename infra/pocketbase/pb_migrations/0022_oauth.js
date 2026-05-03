/// <reference path="../pb_data/types.d.ts" />

/**
 * OAuth 2.1 storage for the remote MCP server. Clients (e.g. Claude mobile)
 * register dynamically, the user logs in via PocketBase + approves on a
 * consent screen, and we issue short-lived access tokens + long-lived refresh
 * tokens. All token values are stored as SHA-256 hashes — the raw token is
 * only seen once when it's returned to the client.
 *
 * Collections:
 *   oauth_clients         — registered apps (DCR target)
 *   oauth_codes           — short-lived authorization codes (PKCE)
 *   oauth_access_tokens   — Bearer tokens presented at /mcp
 *   oauth_refresh_tokens  — long-lived tokens used to mint new access tokens
 */

migrate(
  (app) => {
    const usersCol = app.findCollectionByNameOrId("users");

    const adminOnly = {
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
    };

    // oauth_clients
    try {
      app.findCollectionByNameOrId("oauth_clients");
      console.log("  oauth_clients: already exists, skipping");
    } catch {
      console.log("  oauth_clients: creating");
      const col = new Collection({
        type: "base",
        name: "oauth_clients",
        ...adminOnly,
        fields: [
          { type: "text", name: "client_id", required: true },
          { type: "text", name: "client_secret_hash" },
          { type: "text", name: "client_name", required: true },
          { type: "json", name: "redirect_uris", required: true },
          { type: "text", name: "token_endpoint_auth_method", required: true },
          { type: "json", name: "grant_types" },
          { type: "json", name: "response_types" },
          { type: "text", name: "scope" },
        ],
      });
      col.indexes = [
        'CREATE UNIQUE INDEX idx_oauth_clients_client_id ON oauth_clients (client_id)',
      ];
      app.save(col);
    }

    const clientsCol = app.findCollectionByNameOrId("oauth_clients");

    // oauth_codes
    try {
      app.findCollectionByNameOrId("oauth_codes");
      console.log("  oauth_codes: already exists, skipping");
    } catch {
      console.log("  oauth_codes: creating");
      const col = new Collection({
        type: "base",
        name: "oauth_codes",
        ...adminOnly,
        fields: [
          { type: "text", name: "code_hash", required: true },
          {
            type: "relation",
            name: "client",
            collectionId: clientsCol.id,
            maxSelect: 1,
            required: true,
          },
          {
            type: "relation",
            name: "user",
            collectionId: usersCol.id,
            maxSelect: 1,
            required: true,
          },
          { type: "text", name: "redirect_uri", required: true },
          { type: "text", name: "code_challenge", required: true },
          { type: "text", name: "code_challenge_method", required: true },
          { type: "text", name: "scope" },
          { type: "text", name: "resource" },
          { type: "date", name: "expires_at", required: true },
          { type: "bool", name: "consumed" },
        ],
      });
      col.indexes = [
        'CREATE UNIQUE INDEX idx_oauth_codes_hash ON oauth_codes (code_hash)',
      ];
      app.save(col);
    }

    // oauth_access_tokens
    try {
      app.findCollectionByNameOrId("oauth_access_tokens");
      console.log("  oauth_access_tokens: already exists, skipping");
    } catch {
      console.log("  oauth_access_tokens: creating");
      const col = new Collection({
        type: "base",
        name: "oauth_access_tokens",
        ...adminOnly,
        fields: [
          { type: "text", name: "token_hash", required: true },
          { type: "text", name: "token_prefix" },
          {
            type: "relation",
            name: "client",
            collectionId: clientsCol.id,
            maxSelect: 1,
            required: true,
          },
          {
            type: "relation",
            name: "user",
            collectionId: usersCol.id,
            maxSelect: 1,
            required: true,
          },
          { type: "text", name: "scope" },
          { type: "date", name: "expires_at", required: true },
          { type: "date", name: "last_used" },
        ],
      });
      col.indexes = [
        'CREATE UNIQUE INDEX idx_oauth_access_tokens_hash ON oauth_access_tokens (token_hash)',
        'CREATE INDEX idx_oauth_access_tokens_user ON oauth_access_tokens (user)',
      ];
      app.save(col);
    }

    // oauth_refresh_tokens
    try {
      app.findCollectionByNameOrId("oauth_refresh_tokens");
      console.log("  oauth_refresh_tokens: already exists, skipping");
    } catch {
      console.log("  oauth_refresh_tokens: creating");
      const col = new Collection({
        type: "base",
        name: "oauth_refresh_tokens",
        ...adminOnly,
        fields: [
          { type: "text", name: "token_hash", required: true },
          { type: "text", name: "token_prefix" },
          {
            type: "relation",
            name: "client",
            collectionId: clientsCol.id,
            maxSelect: 1,
            required: true,
          },
          {
            type: "relation",
            name: "user",
            collectionId: usersCol.id,
            maxSelect: 1,
            required: true,
          },
          { type: "text", name: "scope" },
          { type: "date", name: "expires_at", required: true },
          { type: "bool", name: "revoked" },
        ],
      });
      col.indexes = [
        'CREATE UNIQUE INDEX idx_oauth_refresh_tokens_hash ON oauth_refresh_tokens (token_hash)',
        'CREATE INDEX idx_oauth_refresh_tokens_user ON oauth_refresh_tokens (user)',
      ];
      app.save(col);
    }
  },
  (app) => {
    for (const name of [
      "oauth_refresh_tokens",
      "oauth_access_tokens",
      "oauth_codes",
      "oauth_clients",
    ]) {
      try {
        const col = app.findCollectionByNameOrId(name);
        app.delete(col);
      } catch {
        // Already deleted
      }
    }
  }
);
