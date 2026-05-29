/// <reference path="../pb_data/types.d.ts" />

/**
 * Create the `user_names` read-only VIEW collection.
 *
 * The live `users` collection is strictly owner-only
 * (`listRule = viewRule = "id = @request.auth.id"`), so apps can never
 * resolve another user's display name — co-owners render as "Anonymous"
 * and even your own cooking-log entries say "Someone made this".
 *
 * This view exposes ONLY `id` + `name` — never email, fcm_tokens, slug
 * maps, or any other PII — and is readable by any authenticated user.
 * Consumed via `UserBackend.resolveNames` / the `useUserNames` hook.
 *
 * View collections derive their fields from `viewQuery`; we only select
 * id + name so nothing else is reachable through this collection.
 *
 * Idempotent: re-running is a no-op (matches 0002_sharing_invites.js).
 */

migrate(
  (app) => {
    try {
      app.findCollectionByNameOrId("user_names");
      console.log("  user_names: already exists, skipping");
      return;
    } catch {
      // Collection doesn't exist — create it.
    }

    const col = new Collection({
      type: "view",
      name: "user_names",
      // Any authenticated user may read display names. The view exposes only
      // id + name — never email, fcm_tokens, or slug maps.
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      viewQuery: "SELECT id, name FROM users",
    });

    app.save(col);
    console.log("  user_names: created view collection");
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("user_names");
      app.delete(col);
      console.log("  user_names: deleted");
    } catch {
      console.log("  user_names: already absent, skipping delete");
    }
  },
);
