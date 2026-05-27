/// <reference path="../pb_data/types.d.ts" />

/**
 * Create the `claude_observations` collection for the life-app observer.
 *
 * Stores AI-generated reflections over windows of life_events data.
 * Created by the API service on behalf of the authenticated user;
 * the frontend only reads.
 */

migrate(
  (app) => {
    const usersCol = app.findCollectionByNameOrId("users");

    const col = new Collection({
      type: "base",
      name: "claude_observations",
      listRule: "owner.id = @request.auth.id",
      viewRule: "owner.id = @request.auth.id",
      createRule: '@request.auth.id != ""',
      updateRule: "owner.id = @request.auth.id",
      deleteRule: "owner.id = @request.auth.id",
      fields: [
        { type: "text", name: "content", required: true },
        { type: "text", name: "period", required: true },
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
    const col = app.findCollectionByNameOrId("claude_observations");
    app.delete(col);
    console.log("  claude_observations: deleted");
  },
);
