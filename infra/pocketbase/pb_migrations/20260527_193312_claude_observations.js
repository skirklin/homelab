/// <reference path="../pb_data/types.d.ts" />

/**
 * Create the `claude_observations` collection for the life-app observer.
 *
 * Stores AI-generated reflections over windows of life_events data.
 * Created by the API service on behalf of the authenticated user;
 * the frontend only reads.
 *
 * Single-owner shape (mirrors life_logs post-0028) — uses the
 * `LIFE_OWNER_RULE` form `@request.auth.id != "" && owner = @request.auth.id`
 * so the rule strings line up with the entries in
 * `lib/authz-rules.js` (PB_RULES) and the property test in
 * `services/api/src/e2e/authz-mirror.test.ts`. Direct equality on the
 * single-relation column — `?=` is the any-of operator and is for
 * multi-relations only.
 *
 * Idempotent: re-running this migration is a no-op (matches the pattern
 * established by 0002_sharing_invites.js / 0010_trip_proposals.js).
 */

migrate(
  (app) => {
    try {
      app.findCollectionByNameOrId("claude_observations");
      console.log("  claude_observations: already exists, skipping");
      return;
    } catch {
      // Collection doesn't exist, create it
    }

    const usersCol = app.findCollectionByNameOrId("users");

    const OWNER_RULE = '@request.auth.id != "" && owner = @request.auth.id';

    const col = new Collection({
      type: "base",
      name: "claude_observations",
      listRule: OWNER_RULE,
      viewRule: OWNER_RULE,
      createRule: '@request.auth.id != ""',
      updateRule: OWNER_RULE,
      deleteRule: OWNER_RULE,
      fields: [
        { type: "text", name: "content", required: true },
        {
          type: "select",
          name: "period",
          values: ["weekly", "monthly", "adhoc"],
          required: true,
          maxSelect: 1,
        },
        { type: "date", name: "data_window_start", required: true },
        { type: "date", name: "data_window_end", required: true },
        { type: "json", name: "related_event_ids", maxSize: 50000 },
        {
          type: "relation",
          name: "owner",
          collectionId: usersCol.id,
          cascadeDelete: false,
          maxSelect: 1,
          required: true,
        },
        { type: "text", name: "prompt_version" },
        {
          type: "autodate",
          name: "created",
          onCreate: true,
          onUpdate: false,
        },
        {
          type: "autodate",
          name: "updated",
          onCreate: true,
          onUpdate: true,
        },
      ],
    });

    app.save(col);
    console.log("  claude_observations: created");
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("claude_observations");
      app.delete(col);
      console.log("  claude_observations: deleted");
    } catch {
      console.log("  claude_observations: already absent, skipping delete");
    }
  },
);
