/// <reference path="../pb_data/types.d.ts" />

/**
 * Refresh token rotation hardening: tag every (access_token, refresh_token)
 * pair issued from the same authorization code with a shared `family_id`.
 *
 *  - On refresh: rotate the refresh token (revoke old, mint new), keep the
 *    family_id.
 *  - If we ever see a refresh request that presents an *already-revoked*
 *    refresh token, treat it as evidence of a leak and revoke the entire
 *    family (every access + refresh token sharing that family_id). The
 *    legitimate client is then forced to re-authorize, but no attacker keeps
 *    long-lived access from a single capture.
 *
 * Per OAuth 2.1 §6.1 / RFC 6749 §10.4. Without rotation, a 90-day refresh
 * token captured once gives 90 days of silent re-issuance.
 */

migrate(
  (app) => {
    for (const collectionName of ["oauth_access_tokens", "oauth_refresh_tokens"]) {
      const col = app.findCollectionByNameOrId(collectionName);
      if (!col.fields.getByName("family_id")) {
        col.fields.add(new Field({ type: "text", name: "family_id" }));
        console.log(`  ${collectionName}: added family_id field`);
        // Index it — revocation does a bulk lookup by family_id.
        const existingIdx = col.indexes.find((i) => i.includes("family_id"));
        if (!existingIdx) {
          col.indexes.push(`CREATE INDEX idx_${collectionName}_family ON ${collectionName} (family_id)`);
        }
      }
      app.save(col);
    }
  },
  (app) => {
    for (const collectionName of ["oauth_access_tokens", "oauth_refresh_tokens"]) {
      try {
        const col = app.findCollectionByNameOrId(collectionName);
        const field = col.fields.getByName("family_id");
        if (field) col.fields.removeById(field.id);
        col.indexes = col.indexes.filter((i) => !i.includes("family_id"));
        app.save(col);
      } catch {
        // Collection gone — fine.
      }
    }
  }
);
