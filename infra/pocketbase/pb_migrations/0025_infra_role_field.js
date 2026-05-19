/// <reference path="../pb_data/types.d.ts" />

/**
 * Add a `roles` JSON field to `api_tokens` so that infra-only callers
 * (deploy.sh recording deployment history, event-watcher recording pod
 * events) can be distinguished from user-minted Settings tokens.
 *
 * Background: collections `deployments` (0019) and `pod_events` (0021)
 * are admin-only at the PB layer, but the API service's /data/deployments
 * and /data/pod_events routes use an admin-PB client and so happily wrote
 * for any hlk_ / mcpat_ token holder. The route-level gate now requires
 * `roles` to include `"infra"`. User-minted tokens don't set this field
 * and are rejected with 403.
 *
 * Rollout: after this migration ships, one PB record per real infra
 * caller must be patched to set `roles: ["infra"]`. Today that's the
 * single token stored as HOMELAB_API_TOKEN in the k8s `api-secrets`
 * Secret. Until that patch lands, deploy.sh and event-watcher POSTs
 * will 403 — keep an old api-secrets restore handy or coordinate the
 * mint with the deploy.
 */

migrate(
  (app) => {
    const col = app.findCollectionByNameOrId("api_tokens");
    if (!col.fields.getByName("roles")) {
      col.fields.add(new Field({ type: "json", name: "roles", maxSize: 1000 }));
      app.save(col);
      console.log("  api_tokens: added roles");
    }
  },
  (app) => {
    const col = app.findCollectionByNameOrId("api_tokens");
    const f = col.fields.getByName("roles");
    if (f) {
      col.fields.removeById(f.id);
      app.save(col);
    }
  }
);
